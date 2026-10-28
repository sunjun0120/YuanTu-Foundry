//! Keeps the elevated maintenance lock while the desktop user invalidates and commits its own state.
//! The desktop user cannot acquire the administrator-only mutex itself; closing the pipe aborts the lease.
use crate::{
    frame::{read_frame, write_frame},
    win::Result,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io::{Read, Write};

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Reply<T> {
    Locked,
    Applied { value: T },
    Completed,
    Failed { message: String },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Acknowledgement {
    Proceed { success: bool },
    Finished { success: bool },
}

/// The lock's owner waits for both the user preparation and final commit. In particular, returning from the
/// machine operation does not release it. A failure or disconnect unwinds this stack and drops the guard.
pub fn serve<C: Read + Write, L, T: Serialize>(
    channel: &mut C,
    acquire: impl FnOnce() -> Result<L>,
    operation: impl FnOnce(&L) -> Result<T>,
) -> Result<u32> {
    let lock = match acquire() {
        Ok(lock) => lock,
        Err(message) => {
            write_frame(channel, &Reply::<T>::Failed { message })
                .map_err(|_| "Send maintenance lock failure")?;
            return Ok(1);
        }
    };
    write_frame(channel, &Reply::<T>::Locked)
        .map_err(|_| "Send maintenance lock acknowledgement")?;
    match read_frame(channel).map_err(|_| "Read user preparation acknowledgement")? {
        Acknowledgement::Proceed { success: true } => {}
        Acknowledgement::Proceed { success: false } => return Ok(1),
        _ => return Err("Expected user preparation acknowledgement".into()),
    }
    let reply = match operation(&lock) {
        Ok(value) => Reply::Applied { value },
        Err(message) => Reply::Failed { message },
    };
    let failed = matches!(reply, Reply::Failed { .. });
    write_frame(channel, &reply).map_err(|_| "Send maintenance result")?;
    if failed {
        return Ok(1);
    }
    match read_frame(channel).map_err(|_| "Read user commit acknowledgement")? {
        Acknowledgement::Finished { success } => {
            write_frame(channel, &Reply::<T>::Completed)
                .map_err(|_| "Confirm user commit receipt")?;
            Ok(if success { 0 } else { 1 })
        }
        _ => Err("Expected user commit acknowledgement".into()),
    }
}

/// Runs user-owned filesystem/DPAPI work only after the helper holds the global lock, and confirms completion
/// before allowing it to release the lock. Never wait for the helper's process exit before sending this reply.
pub fn run<C: Read + Write, T: DeserializeOwned, R>(
    channel: &mut C,
    prepare: impl FnOnce() -> Result<()>,
    finish: impl FnOnce(T) -> Result<R>,
) -> Result<R> {
    match read_frame::<_, Reply<T>>(channel)
        .map_err(|_| "The elevated maintainer did not acquire its lock")?
    {
        Reply::Locked => {}
        Reply::Failed { message } => return Err(message),
        _ => return Err("Expected maintenance lock acknowledgement".into()),
    }
    let prepared = prepare();
    let sent = write_frame(
        channel,
        &Acknowledgement::Proceed {
            success: prepared.is_ok(),
        },
    );
    prepared?;
    sent.map_err(|_| "Send user preparation acknowledgement")?;
    let value = match read_frame(channel).map_err(|_| "The elevated maintainer did not reply")? {
        Reply::Applied { value } => value,
        Reply::Failed { message } => return Err(message),
        _ => return Err("Expected maintenance result".into()),
    };
    let result = finish(value);
    let sent = write_frame(
        channel,
        &Acknowledgement::Finished {
            success: result.is_ok(),
        },
    );
    // The user owns the server end: do not close it while its last outgoing frame may still be unread.
    let confirmed = sent
        .map_err(|_| "Send user commit acknowledgement".to_string())
        .and_then(|()| {
            match read_frame::<_, Reply<T>>(channel)
                .map_err(|_| "The elevated maintainer did not confirm the commit")?
            {
                Reply::Completed => Ok(()),
                _ => Err("Expected user commit receipt".into()),
            }
        });
    let value = result?;
    confirmed?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipe::{self, PipeIo};
    use std::sync::{Arc, Mutex};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, PIPE_ACCESS_DUPLEX,
    };

    fn pair() -> (crate::win::Handle, crate::win::Handle) {
        let name = format!(
            r"\\.\pipe\yuantu-sbx-handoff-test-{}",
            pipe::random_suffix().unwrap()
        );
        let listener = pipe::server(
            &name,
            &format!("D:P(A;;GA;;;{})", crate::win::current_user().unwrap()),
            PIPE_ACCESS_DUPLEX,
            true,
            1,
        )
        .unwrap();
        let connecting = std::thread::spawn(move || {
            pipe::connect(&name, FILE_GENERIC_READ | FILE_GENERIC_WRITE).unwrap()
        });
        pipe::accept(&listener).unwrap();
        (connecting.join().unwrap(), listener)
    }

    #[test]
    fn the_lock_covers_user_preparation_and_credential_commit() {
        let (elevated, desktop) = pair();
        let lock = Arc::new(Mutex::new(()));
        let held = lock.clone();
        let helper = std::thread::spawn(move || {
            serve(
                &mut PipeIo(&elevated),
                || Ok(held.lock().unwrap()),
                |_| Ok(7u32),
            )
        });
        let result = run::<_, u32, _>(
            &mut PipeIo(&desktop),
            || {
                assert!(
                    lock.try_lock().is_err(),
                    "marker removal ran outside the lock"
                );
                Ok(())
            },
            |value| {
                assert_eq!(value, 7);
                assert!(
                    lock.try_lock().is_err(),
                    "credentials were committed outside the lock"
                );
                Ok(())
            },
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(helper.join().unwrap().unwrap(), 0);
        assert!(lock.try_lock().is_ok());
    }

    #[test]
    fn failed_user_preparation_stops_machine_changes_and_releases_the_lock() {
        let (elevated, desktop) = pair();
        let lock = Arc::new(Mutex::new(()));
        let held = lock.clone();
        let helper = std::thread::spawn(move || {
            serve(
                &mut PipeIo(&elevated),
                || Ok(held.lock().unwrap()),
                |_| -> Result<()> {
                    panic!("machine changes started after user preparation failed")
                },
            )
        });
        let result = run::<_, (), ()>(
            &mut PipeIo(&desktop),
            || Err("cannot remove marker".into()),
            |_| panic!("commit started after user preparation failed"),
        );
        assert_eq!(result.unwrap_err(), "cannot remove marker");
        assert_eq!(helper.join().unwrap().unwrap(), 1);
        assert!(lock.try_lock().is_ok());
    }

    #[test]
    fn a_failed_credential_commit_reports_failure_and_releases_the_lock() {
        let (elevated, desktop) = pair();
        let lock = Arc::new(Mutex::new(()));
        let held = lock.clone();
        let helper = std::thread::spawn(move || {
            serve(
                &mut PipeIo(&elevated),
                || Ok(held.lock().unwrap()),
                |_| Ok(()),
            )
        });
        let result = run::<_, (), ()>(
            &mut PipeIo(&desktop),
            || Ok(()),
            |_| {
                assert!(lock.try_lock().is_err());
                Err("credential write failed".into())
            },
        );
        assert_eq!(result.unwrap_err(), "credential write failed");
        assert_eq!(helper.join().unwrap().unwrap(), 1);
        assert!(lock.try_lock().is_ok());
    }

    #[test]
    fn a_disconnected_user_releases_the_lock_without_a_commit() {
        let (elevated, desktop) = pair();
        let lock = Arc::new(Mutex::new(()));
        let held = lock.clone();
        let helper = std::thread::spawn(move || {
            serve(
                &mut PipeIo(&elevated),
                || Ok(held.lock().unwrap()),
                |_| Ok(()),
            )
        });
        let reply: Reply<()> = crate::frame::read_frame(&mut PipeIo(&desktop)).unwrap();
        assert!(matches!(reply, Reply::Locked));
        assert!(lock.try_lock().is_err());
        drop(desktop);
        assert!(helper.join().unwrap().is_err());
        assert!(lock.try_lock().is_ok());
    }

    #[test]
    fn the_user_waits_until_the_helper_has_consumed_the_commit_reply() {
        let (elevated, desktop) = pair();
        let helper = std::thread::spawn(move || {
            let mut io = PipeIo(&elevated);
            write_frame(&mut io, &Reply::<()>::Locked).unwrap();
            assert!(matches!(
                read_frame(&mut io).unwrap(),
                Acknowledgement::Proceed { success: true }
            ));
            write_frame(&mut io, &Reply::Applied { value: () }).unwrap();
            assert!(matches!(
                read_frame(&mut io).unwrap(),
                Acknowledgement::Finished { success: true }
            ));
            // A helper lost after applying the machine changes must not be reported as a successful transaction.
        });
        let result = run::<_, (), ()>(&mut PipeIo(&desktop), || Ok(()), |_| Ok(()));
        helper.join().unwrap();
        assert!(
            result.is_err(),
            "success was returned before the helper confirmed receipt"
        );
    }

    #[test]
    fn disconnecting_after_machine_changes_releases_the_lock() {
        let (elevated, desktop) = pair();
        let lock = Arc::new(Mutex::new(()));
        let held = lock.clone();
        let helper = std::thread::spawn(move || {
            serve(
                &mut PipeIo(&elevated),
                || Ok(held.lock().unwrap()),
                |_| Ok(()),
            )
        });
        let mut io = PipeIo(&desktop);
        assert!(matches!(
            read_frame::<_, Reply<()>>(&mut io).unwrap(),
            Reply::Locked
        ));
        write_frame(&mut io, &Acknowledgement::Proceed { success: true }).unwrap();
        assert!(matches!(
            read_frame::<_, Reply<()>>(&mut io).unwrap(),
            Reply::Applied { .. }
        ));
        assert!(lock.try_lock().is_err());
        drop(desktop);
        assert!(helper.join().unwrap().is_err());
        assert!(lock.try_lock().is_ok());
    }

    #[test]
    fn a_machine_failure_reaches_the_user_without_starting_the_commit() {
        let (elevated, desktop) = pair();
        let helper = std::thread::spawn(move || {
            serve(
                &mut PipeIo(&elevated),
                || Ok(()),
                |_| -> Result<()> { Err("provision failed".into()) },
            )
        });
        let result = run::<_, (), ()>(
            &mut PipeIo(&desktop),
            || Ok(()),
            |_| panic!("committed after failure"),
        );
        assert_eq!(result.unwrap_err(), "provision failed");
        assert_eq!(helper.join().unwrap().unwrap(), 1);
    }
}
