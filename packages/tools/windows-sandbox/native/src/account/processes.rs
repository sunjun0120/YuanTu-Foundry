//! Stops every process the sandbox accounts run and waits for their logon sessions to end, so uninstall never takes
//! the network filters away from a command that is still running. Mirrors Codex `uninstall_windows/processes.rs`
//! (openai/codex@86e17e9), without its retained SYSTEM-finalizer logons: nothing here keeps a sandbox logon open.
use crate::{Handle, Result, sid_text};
use std::{
    ffi::c_void,
    ptr::null_mut,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_INVALID_PARAMETER, ERROR_NO_SUCH_LOGON_SESSION, GetLastError, LUID, WAIT_OBJECT_0,
    },
    Security::{
        Authentication::Identity::{
            LsaEnumerateLogonSessions, LsaFreeReturnBuffer, LsaGetLogonSessionData,
            LsaNtStatusToWinError, SECURITY_LOGON_SESSION_DATA,
        },
        GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    System::{
        RemoteDesktop::{
            WTS_CURRENT_SERVER_HANDLE, WTS_PROCESS_INFOW, WTSEnumerateProcessesW, WTSFreeMemory,
        },
        Threading::{
            OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
        },
    },
};

/// LocalSystem's reserved logon ID, which has no ordinary session data.
const SYSTEM_LOGON: LUID = LUID {
    LowPart: 0x3e7,
    HighPart: 0,
};

/// Terminates every process whose token user is one of `sids`, then waits until no logon session of those users
/// remains. Fails when either is still there at `deadline`; the caller keeps the protections in place.
pub fn stop(sids: &[String], deadline: Duration) -> Result<()> {
    stop_where(
        |_, sid| sids.iter().any(|known| known == sid),
        sids,
        deadline,
    )
}

/// `select(pid, user_sid)` picks the processes to terminate; `logons` are the users whose sessions must be gone.
fn stop_where(
    select: impl Fn(u32, &str) -> bool,
    logons: &[String],
    deadline: Duration,
) -> Result<()> {
    let deadline = Instant::now() + deadline;
    loop {
        let processes = selected(&select)?;
        for process in &processes {
            if unsafe { TerminateProcess(process.0, 1) } == 0
                && unsafe { WaitForSingleObject(process.0, 0) } != WAIT_OBJECT_0
            {
                return Err(format!(
                    "Stop a sandbox process before uninstall: Windows error {}",
                    unsafe { GetLastError() }
                ));
            }
        }
        for process in &processes {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let millis = remaining.as_millis().min(u32::MAX as u128) as u32;
            if unsafe { WaitForSingleObject(process.0, millis) } != WAIT_OBJECT_0 {
                return Err("A sandbox process did not exit before the uninstall deadline".into());
            }
        }
        // A runner may start a child between two snapshots, and a token can outlive its process: only an empty
        // snapshot with no remaining logon session ends the wait.
        let blocker = if processes.is_empty() {
            match blocking_logon(logons)? {
                None => return Ok(()),
                Some(blocker) => blocker,
            }
        } else {
            "processes were still starting".to_string()
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "Sandbox processes or logons remain after the uninstall deadline: {blocker}"
            ));
        }
        std::thread::sleep(
            Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

/// Opens every running process `select` picks. The user SID is read again from the opened process, because a PID
/// from the snapshot can already belong to a different process.
fn selected(select: &impl Fn(u32, &str) -> bool) -> Result<Vec<Handle>> {
    let (mut list, mut count) = (null_mut::<WTS_PROCESS_INFOW>(), 0u32);
    if unsafe { WTSEnumerateProcessesW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &mut list, &mut count) }
        == 0
    {
        return Err(format!(
            "Enumerate processes before uninstall: Windows error {}",
            unsafe { GetLastError() }
        ));
    }
    let entries: Vec<(u32, String)> = unsafe { std::slice::from_raw_parts(list, count as usize) }
        .iter()
        .filter(|entry| !entry.pUserSid.is_null())
        .filter_map(|entry| Some((entry.ProcessId, sid_text(entry.pUserSid).ok()?)))
        .collect();
    unsafe { WTSFreeMemory(list as *mut c_void) };
    let mut handles = Vec::new();
    for (pid, sid) in entries {
        if !select(pid, &sid) {
            continue;
        }
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            let error = unsafe { GetLastError() };
            if error == ERROR_INVALID_PARAMETER {
                continue; // Exited since the snapshot.
            }
            return Err(format!(
                "Open a sandbox process before uninstall: Windows error {error}"
            ));
        }
        let process = Handle(raw);
        match process_user(&process) {
            Ok(owner) if select(pid, &owner) => handles.push(process),
            Ok(_) => {}
            Err(_) if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 => {}
            Err(error) => return Err(error),
        }
    }
    Ok(handles)
}

fn process_user(process: &Handle) -> Result<String> {
    let mut token = null_mut();
    crate::win(
        unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token) },
        "Identify a sandbox process before uninstall",
    )?;
    let token = Handle(token);
    let mut length = 0;
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut length) };
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    crate::win(
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                length,
                &mut length,
            )
        },
        "Read a sandbox process user",
    )?;
    sid_text(unsafe { (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid })
}

/// A description of the first logon session that still belongs to one of `sids`, if any.
fn blocking_logon(sids: &[String]) -> Result<Option<String>> {
    if sids.is_empty() {
        return Ok(None);
    }
    let (mut count, mut list) = (0u32, null_mut::<LUID>());
    let status = unsafe { LsaEnumerateLogonSessions(&mut count, &mut list) };
    if status != 0 {
        return Err(format!(
            "Enumerate logon sessions before uninstall: {status:#x}"
        ));
    }
    let logons: Vec<LUID> = unsafe { std::slice::from_raw_parts(list, count as usize) }.to_vec();
    unsafe { LsaFreeReturnBuffer(list as *const c_void) };
    for logon in logons {
        if logon.LowPart == SYSTEM_LOGON.LowPart && logon.HighPart == SYSTEM_LOGON.HighPart {
            continue;
        }
        let mut data = null_mut::<SECURITY_LOGON_SESSION_DATA>();
        let status = unsafe { LsaGetLogonSessionData(&logon, &mut data) };
        if status != 0 {
            if unsafe { LsaNtStatusToWinError(status) } == ERROR_NO_SUCH_LOGON_SESSION {
                continue; // Ended since the enumeration.
            }
            return Err(format!(
                "Read a logon session before uninstall: {status:#x}"
            ));
        }
        // Without session data nothing proves the session is not a sandbox one, so it blocks.
        if data.is_null() {
            return Ok(Some(format!(
                "no data for logon {:08x}:{:08x}",
                logon.HighPart, logon.LowPart
            )));
        }
        let session = unsafe { &*data };
        let owner = (!session.Sid.is_null())
            .then(|| sid_text(session.Sid).ok())
            .flatten();
        let blocker = owner.filter(|owner| sids.contains(owner)).map(|owner| {
            format!(
                "logon {:08x}:{:08x} of {owner} remains (type {}, session {})",
                logon.HighPart, logon.LowPart, session.LogonType, session.Session
            )
        });
        unsafe { LsaFreeReturnBuffer(data as *const c_void) };
        if blocker.is_some() {
            return Ok(blocker);
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn sleeper() -> std::process::Child {
        // PING.EXE itself, not through cmd: terminating cmd would orphan the ping for a minute.
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        Command::new(format!(r"{system}\System32\PING.EXE"))
            .args(["-n", "60", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn a_selected_process_is_terminated_and_waited_for() {
        let mut child = sleeper();
        let pid = child.id();
        stop_where(|candidate, _| candidate == pid, &[], Duration::from_secs(5)).unwrap();
        assert!(
            child.try_wait().unwrap().is_some(),
            "the selected process is still running"
        );
    }

    #[test]
    fn nothing_selected_stops_nothing() {
        let mut child = sleeper();
        stop_where(|_, _| false, &[], Duration::from_secs(1)).unwrap();
        assert!(
            child.try_wait().unwrap().is_none(),
            "an unselected process was stopped"
        );
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn the_selector_sees_the_process_token_user() {
        let mut child = sleeper();
        let pid = child.id();
        let me = crate::account::credentials::current_user_sid().unwrap();
        // The SID passed to the selector is read from the opened process, so it is the desktop user here.
        stop_where(
            |candidate, sid| candidate == pid && sid == me,
            &[],
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn an_unknown_user_has_no_logon_session() {
        // Reading another user's session data needs administrator rights, which uninstall always has.
        match blocking_logon(&["S-1-5-21-1-2-3-999999".into()]) {
            Ok(blocker) => assert_eq!(blocker, None),
            Err(error) => {
                eprintln!("not elevated, cannot read other logon sessions ({error}); skipping")
            }
        }
    }

    #[test]
    fn no_users_means_no_logon_check() {
        assert_eq!(blocking_logon(&[]).unwrap(), None);
    }
}
