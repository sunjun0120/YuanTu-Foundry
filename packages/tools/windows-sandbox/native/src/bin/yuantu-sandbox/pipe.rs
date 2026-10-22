//! Local named pipes with explicit DACLs, and the peer identity they report.
use crate::win::{Descriptor, Handle, Result, wide, win};
use std::{
    io,
    mem::size_of,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    Storage::FileSystem::*,
    System::{IO::*, Pipes::*},
};

const BUFFER: u32 = 64 * 1024;

/// Creates one blocking, local-only pipe instance whose DACL is exactly `sddl`.
///
/// `first` adds `FILE_FLAG_FIRST_PIPE_INSTANCE`, so creation fails if anyone already owns the name — a squatter
/// cannot sit in front of us. Later instances of the same name pass `first = false`.
pub fn server(name: &str, sddl: &str, access: u32, first: bool, instances: u32) -> Result<Handle> {
    let descriptor = Descriptor::parse(sddl)?;
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let name = wide(name)?;
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            access
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                },
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            instances,
            BUFFER,
            BUFFER,
            0,
            &security,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!("Create pipe: Windows error {}", unsafe {
            GetLastError()
        }));
    }
    Ok(Handle(handle))
}

/// Waits for one client on a server instance.
pub fn accept(pipe: &Handle) -> Result<()> {
    if unsafe { ConnectNamedPipe(pipe.0, null_mut()) } == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_PIPE_CONNECTED {
            return Err(format!("Accept pipe client: Windows error {error}"));
        }
    }
    Ok(())
}

/// Opens a client end. Identification-level impersonation only: the server may learn who we are, never act as us.
pub fn connect(name: &str, access: u32) -> Result<Handle> {
    let wide_name = wide(name)?;
    for _ in 0..50 {
        let handle = unsafe {
            CreateFileW(
                wide_name.as_ptr(),
                access,
                0,
                null(),
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            return Ok(Handle(handle));
        }
        let error = unsafe { GetLastError() };
        if error != ERROR_PIPE_BUSY {
            return Err(format!("Connect pipe: Windows error {error}"));
        }
        unsafe {
            WaitNamedPipeW(wide_name.as_ptr(), 100);
        }
    }
    Err("Connect pipe: all instances busy".into())
}

pub fn client_pid(pipe: &Handle) -> Result<u32> {
    let mut pid = 0;
    win(
        unsafe { GetNamedPipeClientProcessId(pipe.0, &mut pid) },
        "Read pipe client process",
    )?;
    Ok(pid)
}

pub fn server_pid(pipe: &Handle) -> Result<u32> {
    let mut pid = 0;
    win(
        unsafe { GetNamedPipeServerProcessId(pipe.0, &mut pid) },
        "Read pipe server process",
    )?;
    Ok(pid)
}

/// Whether the other end has gone. Only for a pipe no other thread is reading.
pub fn peer_disconnected(pipe: &Handle) -> bool {
    let mut available = 0;
    if unsafe {
        PeekNamedPipe(
            pipe.0,
            null_mut(),
            0,
            null_mut(),
            &mut available,
            null_mut(),
        )
    } != 0
    {
        return false;
    }
    matches!(
        unsafe { GetLastError() },
        ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA
    )
}

/// `Read`/`Write` over a borrowed pipe handle. A broken pipe reads as end of file.
pub struct PipeIo<'a>(pub &'a Handle);
impl io::Read for PipeIo<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut read = 0;
        let ok = unsafe {
            ReadFile(
                self.0.0,
                buffer.as_mut_ptr(),
                buffer.len().min(u32::MAX as usize) as u32,
                &mut read,
                null_mut::<OVERLAPPED>(),
            )
        };
        if ok == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED {
                return Ok(0);
            }
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        Ok(read as usize)
    }
}
impl io::Write for PipeIo<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut written = 0;
        let ok = unsafe {
            WriteFile(
                self.0.0,
                buffer.as_ptr(),
                buffer.len().min(u32::MAX as usize) as u32,
                &mut written,
                null_mut::<OVERLAPPED>(),
            )
        };
        if ok == 0 {
            return Err(io::Error::from_raw_os_error(
                unsafe { GetLastError() } as i32
            ));
        }
        Ok(written as usize)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// `\\.\pipe\yuantu-sbx-<32 hex>`-style suffix from the OS random generator.
pub fn random_suffix() -> Result<String> {
    let mut bytes = [0u8; 16];
    let status = unsafe {
        windows_sys::Win32::Security::Cryptography::BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            windows_sys::Win32::Security::Cryptography::BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(format!("Generate pipe name: status {status:#x}"));
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{read_frame, write_frame};
    use crate::protocol::FromRunner;
    use crate::win::current_user;

    fn name() -> String {
        format!(r"\\.\pipe\yuantu-sbx-test-{}", random_suffix().unwrap())
    }

    fn sddl() -> String {
        format!("D:P(A;;GA;;;{})", current_user().unwrap())
    }

    #[test]
    fn first_instance_refuses_a_second_owner() {
        let name = name();
        let _first = server(&name, &sddl(), PIPE_ACCESS_DUPLEX, true, 1).unwrap();
        assert!(server(&name, &sddl(), PIPE_ACCESS_DUPLEX, true, 1).is_err());
    }

    #[test]
    fn reports_peers_and_carries_frames() {
        let name = name();
        let listener = server(&name, &sddl(), PIPE_ACCESS_DUPLEX, true, 1).unwrap();
        let client_name = name.clone();
        let client = std::thread::spawn(move || {
            let client = connect(&client_name, FILE_GENERIC_READ | FILE_GENERIC_WRITE).unwrap();
            assert_eq!(server_pid(&client).unwrap(), std::process::id());
            write_frame(&mut PipeIo(&client), &FromRunner::Started { id: 1, pid: 2 }).unwrap();
            client
        });
        accept(&listener).unwrap();
        assert_eq!(client_pid(&listener).unwrap(), std::process::id());
        let message: FromRunner = read_frame(&mut PipeIo(&listener)).unwrap();
        assert!(matches!(message, FromRunner::Started { id: 1, pid: 2 }));
        assert!(!peer_disconnected(&listener));
        drop(client.join().unwrap());
        assert!(peer_disconnected(&listener));
    }
}
