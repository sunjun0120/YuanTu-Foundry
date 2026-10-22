//! The broker: one per host process, running as the desktop user. It owns the runner's lifetime and
//! authenticates both sides before any handle crosses between them.
//!
//! Lifetime: the host keeps the broker's stdin open; end of stdin terminates the runner's Job (and with it
//! every command) and ends the broker. If the runner dies, pending commands get `runner-lost` and the broker
//! exits non-zero so the host starts a fresh one for the next command.
use crate::{
    desktop::PrivateDesktop,
    frame::{read_frame, write_frame},
    pipe::{PipeIo, accept, client_pid, has_data, peer_disconnected, random_suffix, server},
    protocol::{ErrorKind, FromBroker, FromRunner, ToBroker, ToRunner, validate},
    win::{Handle, Result, current_user, open_process, process_token, token_user, wide, win},
};
use std::{
    collections::HashMap,
    ffi::c_void,
    io::{Read, Write},
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, RecvTimeoutError, Sender, channel},
    },
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::IsTokenRestricted,
    Storage::FileSystem::{PIPE_ACCESS_DUPLEX, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND},
    System::{JobObjects::*, Pipes::*, Threading::*},
};
use yuantu_sandbox::account::{Account, credentials, password::Secret};

/// Exit code when the runner was lost; the host restarts the broker on demand.
const RUNNER_LOST_EXIT: u32 = 3;

struct Runner {
    process: Handle,
    job: Handle,
    down: Mutex<Handle>,
    pending: Mutex<HashMap<u64, Sender<FromRunner>>>,
    next: AtomicU64,
}

/// How the runner is started.
pub enum Launch {
    /// The runner runs as the current user. Debug builds only: the token user is then the desktop user, so
    /// confinement of writes does not hold; this exists to test the execution path without an account.
    #[cfg(debug_assertions)]
    Dev,
    /// The runner runs as a sandbox account, logged on with its stored password.
    Account(Account),
}

pub fn run(launch: Launch) -> Result<u32> {
    let me = current_user()?;
    let (runner_sid, logon) = match launch {
        #[cfg(debug_assertions)]
        Launch::Dev => (me.clone(), None),
        Launch::Account(account) => {
            let (sid, secret) = credentials::load(account)?;
            (sid, Some((account, secret)))
        }
    };
    // Held until the broker exits: every command of this runner starts on it.
    let desktop = PrivateDesktop::create(&runner_sid)?;
    let control = random_suffix()?;
    let control_sddl = format!("D:P(A;;GA;;;{runner_sid})(A;;GA;;;{me})");
    let down = server(
        &format!(r"\\.\pipe\yuantu-sbx-{control}-down"),
        &control_sddl,
        PIPE_ACCESS_OUTBOUND,
        true,
        1,
    )?;
    let up = server(
        &format!(r"\\.\pipe\yuantu-sbx-{control}-up"),
        &control_sddl,
        PIPE_ACCESS_INBOUND,
        true,
        1,
    )?;
    let (process, job) = start_runner(&control, &me, desktop.name(), logon)?;
    let pid = unsafe { GetProcessId(process.0) };
    accept(&down)?;
    accept(&up)?;
    if client_pid(&down)? != pid || client_pid(&up)? != pid {
        unsafe {
            TerminateJobObject(job.0, 1);
        }
        return Err("A process other than the runner connected to its control pipe".into());
    }
    let runner = Arc::new(Runner {
        process,
        job,
        down: Mutex::new(down),
        pending: Mutex::default(),
        next: AtomicU64::new(1),
    });
    {
        let runner = runner.clone();
        std::thread::spawn(move || read_runner(&runner, up));
    }
    {
        let runner = runner.clone();
        std::thread::spawn(move || {
            let mut sink = [0u8; 256];
            while matches!(std::io::stdin().read(&mut sink), Ok(n) if n > 0) {}
            unsafe {
                TerminateJobObject(runner.job.0, 1);
                ExitProcess(0);
            }
        });
    }
    let name = format!(r"\\.\pipe\yuantu-sbx-broker-{control}");
    let exec_sddl = format!("D:P(A;;GA;;;{me})");
    let mut first = true;
    loop {
        let instance = server(
            &name,
            &exec_sddl,
            PIPE_ACCESS_DUPLEX,
            first,
            PIPE_UNLIMITED_INSTANCES,
        )?;
        if first {
            let mut stdout = std::io::stdout();
            writeln!(
                stdout,
                "{}",
                serde_json::json!({"version": 1, "pipe": name})
            )
            .and_then(|()| stdout.flush())
            .map_err(|_| "Report broker pipe failed")?;
            first = false;
        }
        accept(&instance)?;
        let runner = runner.clone();
        let me = me.clone();
        std::thread::spawn(move || {
            let _ = serve_exec(&runner, &me, instance);
        });
    }
}

fn start_runner(
    control: &str,
    owner: &str,
    desktop: &str,
    logon: Option<(Account, Secret)>,
) -> Result<(Handle, Handle)> {
    let job = Handle(unsafe { CreateJobObjectW(null(), null()) });
    if job.0.is_null() {
        return Err("Create runner Job failed".into());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    win(
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        },
        "Set runner Job limits",
    )?;
    let image = std::env::current_exe().map_err(|_| "Locate sandbox executable")?;
    let image = image.to_string_lossy().into_owned();
    let mut command = wide(&format!(
        "\"{image}\" runner --control {control} --owner {owner} --desktop {desktop}"
    ))?;
    let image = wide(&image)?;
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    let started = match &logon {
        // CreateProcessWithLogonW also grants the new logon access to this window station and desktop.
        Some((account, secret)) => {
            let directory = wide(&format!(
                r"{}\System32",
                std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
            ))?;
            unsafe {
                CreateProcessWithLogonW(
                    wide(account.name())?.as_ptr(),
                    wide(".")?.as_ptr(),
                    wide(secret.expose())?.as_ptr(),
                    LOGON_WITH_PROFILE,
                    image.as_ptr(),
                    command.as_mut_ptr(),
                    CREATE_SUSPENDED | CREATE_NO_WINDOW,
                    null(),
                    directory.as_ptr(),
                    &startup,
                    &mut info,
                )
            }
        }
        None => unsafe {
            CreateProcessW(
                image.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                null(),
                null(),
                &startup,
                &mut info,
            )
        },
    };
    drop(logon);
    win(started, "Start runner")?;
    let process = Handle(info.hProcess);
    let thread = Handle(info.hThread);
    if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
        unsafe {
            TerminateProcess(process.0, 1);
        }
        return Err("Assign runner to its Job failed".into());
    }
    unsafe {
        ResumeThread(thread.0);
    }
    Ok((process, job))
}

fn read_runner(runner: &Runner, up: Handle) {
    while let Ok(message) = read_frame::<_, FromRunner>(&mut PipeIo(&up)) {
        let id = match &message {
            FromRunner::Started { id, .. }
            | FromRunner::Exit { id, .. }
            | FromRunner::Error { id, .. } => *id,
        };
        let finished = !matches!(message, FromRunner::Started { .. });
        let mut pending = runner.pending.lock().unwrap();
        if let Some(sender) = pending.get(&id) {
            let _ = sender.send(message);
        }
        if finished {
            pending.remove(&id);
        }
    }
    // Runner lost: tell everyone waiting, then let the host start a fresh broker.
    for (id, sender) in runner.pending.lock().unwrap().drain() {
        let _ = sender.send(FromRunner::Error {
            id,
            kind: ErrorKind::RunnerLost,
            message: "The sandbox runner exited".into(),
        });
    }
    std::thread::sleep(Duration::from_millis(200));
    unsafe {
        TerminateJobObject(runner.job.0, 1);
        ExitProcess(RUNNER_LOST_EXIT);
    }
}

fn reply(pipe: &Handle, message: &FromBroker) {
    let _ = write_frame(&mut PipeIo(pipe), message);
}

/// The client must be the desktop user with an unrestricted token: a sandboxed command runs restricted (and,
/// with an account, as another user), so it can neither pass this check nor borrow its handles.
fn authenticate(pipe: &Handle, me: &str) -> Result<Handle> {
    let pid = client_pid(pipe)?;
    let process = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_DUP_HANDLE)?;
    let token = process_token(process.0)?;
    if token_user(token.0)? != me || unsafe { IsTokenRestricted(token.0) } != 0 {
        return Err("Sandbox client is not the desktop user".into());
    }
    Ok(process)
}

fn duplicate(from: &Handle, value: u64, to: &Handle) -> Result<u64> {
    if value == 0 {
        return Ok(0);
    }
    let mut target = null_mut();
    win(
        unsafe {
            DuplicateHandle(
                from.0,
                value as usize as HANDLE,
                to.0,
                &mut target,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        },
        "Pass stdio to the runner",
    )?;
    Ok(target as usize as u64)
}

fn serve_exec(runner: &Runner, me: &str, pipe: Handle) -> Result<()> {
    let refuse = |kind, message: String| {
        reply(&pipe, &FromBroker::Error { kind, message });
    };
    let client = match authenticate(&pipe, me) {
        Ok(client) => client,
        Err(message) => {
            refuse(ErrorKind::InvalidRequest, message);
            return Ok(());
        }
    };
    let (request, stdin, stdout, stderr) = match read_frame(&mut PipeIo(&pipe)) {
        Ok(ToBroker::Spawn {
            request,
            stdin,
            stdout,
            stderr,
        }) => (request, stdin, stdout, stderr),
        _ => {
            refuse(ErrorKind::InvalidRequest, "Invalid sandbox request".into());
            return Ok(());
        }
    };
    if let Err(message) = validate(&request) {
        refuse(ErrorKind::InvalidRequest, message);
        return Ok(());
    }
    let stdio = [stdin, stdout, stderr].map(|value| duplicate(&client, value, &runner.process));
    let [Ok(stdin), Ok(stdout), Ok(stderr)] = stdio else {
        refuse(
            ErrorKind::LaunchFailed,
            "Pass stdio to the runner failed".into(),
        );
        return Ok(());
    };
    let id = runner.next.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver): (Sender<FromRunner>, Receiver<FromRunner>) = channel();
    runner.pending.lock().unwrap().insert(id, sender);
    let sent = {
        let down = runner.down.lock().unwrap();
        write_frame(
            &mut PipeIo(&down),
            &ToRunner::Spawn {
                id,
                request,
                stdin,
                stdout,
                stderr,
            },
        )
    };
    if sent.is_err() {
        runner.pending.lock().unwrap().remove(&id);
        refuse(ErrorKind::RunnerLost, "The sandbox runner exited".into());
        return Ok(());
    }
    let mut cancelled = false;
    loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(FromRunner::Started { pid, .. }) => reply(&pipe, &FromBroker::Started { pid }),
            Ok(FromRunner::Exit { code, .. }) => {
                reply(&pipe, &FromBroker::Exit { code });
                return Ok(());
            }
            Ok(FromRunner::Error { kind, message, .. }) => {
                refuse(kind, message);
                return Ok(());
            }
            Err(RecvTimeoutError::Timeout) => {
                // A terminal resize from exec: only a size is accepted, and only for this command.
                while has_data(&pipe) {
                    match read_frame::<_, ToBroker>(&mut PipeIo(&pipe)) {
                        Ok(ToBroker::Resize { size }) if size.validate().is_ok() => {
                            let down = runner.down.lock().unwrap();
                            let _ = write_frame(&mut PipeIo(&down), &ToRunner::Resize { id, size });
                        }
                        _ => break,
                    }
                }
                // exec was killed (host cancel or timeout): stop the command's whole tree.
                if !cancelled && peer_disconnected(&pipe) {
                    cancelled = true;
                    let down = runner.down.lock().unwrap();
                    let _ = write_frame(&mut PipeIo(&down), &ToRunner::Cancel { id });
                }
            }
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}
