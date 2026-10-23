//! The runner: started by its broker as the sandbox account, it creates each command under the restricted
//! token. Commands run concurrently; the broker multiplexes them by id.
use crate::{
    desktop,
    frame::{read_frame, write_frame},
    pipe::{PipeIo, connect},
    protocol::{ErrorKind, FromRunner, ToRunner, validate},
    spawn::{Running, sandbox_environment, start},
    token::restricted_token,
    win::{Handle, Result, open_process, set_object_dacl},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::{FILE_GENERIC_READ, FILE_GENERIC_WRITE, READ_CONTROL, WRITE_DAC},
    System::{Console::SetConsoleCtrlHandler, Threading::*},
};

type Writer = Arc<Mutex<Handle>>;

fn send(writer: &Writer, message: &FromRunner) {
    let pipe = writer.lock().unwrap();
    // A failed write means the broker is gone; the reader sees EOF and ends the runner.
    let _ = write_frame(&mut PipeIo(&pipe), message);
}

/// Only SYSTEM and the desktop user may open the runner: a command runs as the same account and must not be
/// able to read the runner's memory or inject into it.
fn protect_self(owner: &str) -> Result<()> {
    let process = open_process(std::process::id(), WRITE_DAC | READ_CONTROL)?;
    set_object_dacl(process.0, &format!("D:P(A;;GA;;;SY)(A;;GA;;;{owner})"))
}

/// Removes scratch left by runners that were killed with their Job (a broker exit ends them before they can
/// clean up). Several runners can share this account's TEMP, so only directories whose runner process is gone
/// are removed.
fn remove_stale_scratch() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = name
            .strip_prefix("yuantu-sbx-")
            .and_then(|rest| rest.split('-').next())
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid != std::process::id()
            && open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION).is_err()
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

pub fn run(control: &str, owner: &str, desktop: &str) -> Result<u32> {
    // Account logon and detached process groups can start with Ctrl+C ignored. The flag is inherited by
    // commands even when they attach to a fresh pseudo console, so reset it before creating any children.
    crate::win::win(
        unsafe { SetConsoleCtrlHandler(None, 0) },
        "Reset command Ctrl+C handling",
    )?;
    protect_self(owner)?;
    // The broker's private desktop; a missing one stops the runner rather than putting commands on `Default`.
    let desktop = desktop::open(desktop)?;
    remove_stale_scratch();
    let down = connect(
        &format!(r"\\.\pipe\yuantu-sbx-{control}-down"),
        FILE_GENERIC_READ,
    )?;
    let up = connect(
        &format!(r"\\.\pipe\yuantu-sbx-{control}-up"),
        FILE_GENERIC_WRITE,
    )?;
    let writer: Writer = Arc::new(Mutex::new(up));
    let running: Arc<Mutex<HashMap<u64, Arc<Running>>>> = Arc::default();
    loop {
        let message: ToRunner = match read_frame(&mut PipeIo(&down)) {
            Ok(message) => message,
            Err(_) => break,
        };
        match message {
            ToRunner::Spawn {
                id,
                request,
                stdin,
                stdout,
                stderr,
            } => {
                // The broker duplicated these into this process; they are ours to close whatever happens.
                let stdio = [stdin, stdout, stderr].map(|value| Handle(value as usize as HANDLE));
                let failure = move |kind, message: String| FromRunner::Error { id, kind, message };
                if let Err(message) = validate(&request) {
                    send(&writer, &failure(ErrorKind::InvalidRequest, message));
                    continue;
                }
                let scratch =
                    std::env::temp_dir().join(format!("yuantu-sbx-{}-{id}", std::process::id()));
                if std::fs::create_dir_all(&scratch).is_err() {
                    send(
                        &writer,
                        &failure(
                            ErrorKind::LaunchFailed,
                            "Create command scratch failed".into(),
                        ),
                    );
                    continue;
                }
                let mut request = request;
                request.env = sandbox_environment(
                    &request.env,
                    &|name| std::env::var(name).ok(),
                    &scratch.to_string_lossy(),
                );
                let started = restricted_token(&request.capabilities).and_then(|token| {
                    start(
                        &token,
                        &request,
                        stdio.each_ref().map(|h| h.0),
                        Some(&desktop),
                    )
                });
                drop(stdio);
                let command = match started {
                    Ok(command) => Arc::new(command),
                    Err(message) => {
                        let _ = std::fs::remove_dir_all(&scratch);
                        send(&writer, &failure(ErrorKind::LaunchFailed, message));
                        continue;
                    }
                };
                running.lock().unwrap().insert(id, command.clone());
                send(
                    &writer,
                    &FromRunner::Started {
                        id,
                        pid: command.pid,
                    },
                );
                let writer = writer.clone();
                let running = running.clone();
                std::thread::spawn(move || {
                    let message = match command.wait() {
                        Ok(code) => FromRunner::Exit { id, code },
                        Err(message) => failure(ErrorKind::LaunchFailed, message),
                    };
                    running.lock().unwrap().remove(&id);
                    // The whole tree has ended (wait drains the Job), so nothing still holds the scratch.
                    let _ = std::fs::remove_dir_all(&scratch);
                    send(&writer, &message);
                });
            }
            ToRunner::Cancel { id } => {
                if let Some(command) = running.lock().unwrap().get(&id) {
                    command.cancel();
                }
            }
            ToRunner::Resize { id, size } => {
                if let Some(command) = running.lock().unwrap().get(&id) {
                    let _ = command.resize(size);
                }
            }
        }
    }
    // The broker is gone: nobody can receive these commands' output or exit codes.
    for command in running.lock().unwrap().values() {
        command.cancel();
    }
    unsafe {
        ExitProcess(0);
    }
}
