//! exec: what the host actually spawns for one sandboxed command. It hands its own stdio to the broker,
//! waits, and exits with the command's exit code — so callers treat it like the command itself.
use crate::{
    frame::{read_frame, write_frame},
    pipe::{PipeIo, connect, has_data, peer_disconnected, server_pid},
    protocol::{ErrorKind, FromBroker, Request, ToBroker, validate},
    terminal::Terminal,
    win::{Result, current_user, image_path, open_process, process_token, token_user},
};
use std::path::Path;
use windows_sys::Win32::{
    Security::IsTokenRestricted,
    Storage::FileSystem::{FILE_GENERIC_READ, FILE_GENERIC_WRITE},
    System::{Console::*, Threading::PROCESS_QUERY_LIMITED_INFORMATION},
};

/// Protocol with the verifier: see packages/tools/sandbox-launch-failure.ts.
pub const LAUNCH_FAILED_EXIT: u32 = 125;
pub const LAUNCH_FAILED_PREFIX: &str = "YuantuSandbox launch failed: ";

pub fn launch_failed(message: &str) -> u32 {
    eprintln!("{LAUNCH_FAILED_PREFIX}{message}");
    LAUNCH_FAILED_EXIT
}

fn same_path(a: &str, b: &Path) -> bool {
    let canonical = |p: &Path| std::fs::canonicalize(p).ok();
    match (canonical(Path::new(a)), canonical(b)) {
        (Some(a), Some(b)) => a
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy()),
        _ => false,
    }
}

fn read_request(file: &str) -> Result<Request> {
    let bytes = std::fs::read(file).map_err(|_| "Read sandbox request failed")?;
    let _ = std::fs::remove_file(file);
    if bytes.len() > crate::frame::MAX_FRAME {
        return Err("Sandbox request exceeds 1 MiB".into());
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "Invalid sandbox request")?;
    validate(&request)?;
    Ok(request)
}

/// The server must be our own broker: same user, unrestricted, same executable.
fn verify_broker(pipe: &crate::win::Handle) -> Result<()> {
    let process = open_process(server_pid(pipe)?, PROCESS_QUERY_LIMITED_INFORMATION)?;
    let token = process_token(process.0)?;
    let own = std::env::current_exe().map_err(|_| "Locate sandbox executable")?;
    if token_user(token.0)? != current_user()?
        || unsafe { IsTokenRestricted(token.0) } != 0
        || !same_path(&image_path(process.0)?, &own)
    {
        return Err("The sandbox broker pipe is not served by this product's broker".into());
    }
    Ok(())
}

pub fn run(broker: &str, request_file: &str) -> u32 {
    match exec(broker, request_file) {
        Ok(code) => code,
        Err(message) => launch_failed(&message),
    }
}

fn exec(broker: &str, request_file: &str) -> Result<u32> {
    let mut request = read_request(request_file)?;
    if !broker.starts_with(r"\\.\pipe\yuantu-sbx-broker-") {
        return Err("Invalid broker pipe name".into());
    }
    let pipe = connect(broker, FILE_GENERIC_READ | FILE_GENERIC_WRITE)?;
    verify_broker(&pipe)?;
    // A TTY command run from a console gets pipes and a relay; from pipes, exec's own handles serve as they are.
    let mut terminal = match request.tty {
        Some(_) => Terminal::attach()?,
        None => None,
    };
    if let Some(size) = terminal.as_ref().and_then(Terminal::size) {
        request.tty = Some(size);
    }
    let handle = |which| unsafe { GetStdHandle(which) } as usize as u64;
    let [stdin, stdout, stderr] = terminal.as_ref().map_or(
        [
            handle(STD_INPUT_HANDLE),
            handle(STD_OUTPUT_HANDLE),
            handle(STD_ERROR_HANDLE),
        ],
        Terminal::handles,
    );
    write_frame(
        &mut PipeIo(&pipe),
        &ToBroker::Spawn {
            request,
            stdin,
            stdout,
            stderr,
        },
    )
    .map_err(|_| "Send sandbox request failed")?;
    loop {
        if let Some(terminal) = terminal.as_mut() {
            // Poll instead of blocking on the reply, so resizes can be sent on the same synchronous pipe.
            if let Some(size) = terminal.resized() {
                let _ = write_frame(&mut PipeIo(&pipe), &ToBroker::Resize { size });
            }
            if !has_data(&pipe) && !peer_disconnected(&pipe) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
        }
        match read_frame::<_, FromBroker>(&mut PipeIo(&pipe)) {
            Ok(FromBroker::Started { .. }) => {
                if let Some(terminal) = terminal.as_mut() {
                    terminal.handed_over();
                }
                continue;
            }
            Ok(FromBroker::Exit { code }) => {
                if let Some(terminal) = terminal.as_mut() {
                    terminal.finish();
                }
                return Ok(code);
            }
            Ok(FromBroker::Error { kind, message }) => {
                let kind = serde_json::to_value(kind).unwrap_or_default();
                return Err(format!("{} ({message})", kind.as_str().unwrap_or("error")));
            }
            Err(_) => {
                return Err(format!(
                    "{} (the sandbox broker closed the connection)",
                    serde_json::to_value(ErrorKind::RunnerLost)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default()
                ));
            }
        }
    }
}
