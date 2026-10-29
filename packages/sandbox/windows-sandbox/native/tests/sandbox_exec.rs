//! End-to-end: broker --dev, runner, and exec as the host would drive them. The runner runs as the current
//! user here, so these tests cover the execution path (IPC, stdio, Job, token recipe, fork, cancel), not write
//! confinement — that needs a real sandbox account (plan 2b acceptance).
#![cfg(all(windows, debug_assertions))]
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

const EXE: &str = env!("CARGO_BIN_EXE_yuantu-sandbox");

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn node() -> Option<String> {
    let output = Command::new("where").arg("node").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .map(|line| line.trim().to_string())
        .filter(|l| !l.is_empty())
}

macro_rules! require_node {
    () => {
        match node() {
            Some(node) => node,
            None => {
                eprintln!("node is not on PATH; skipping");
                return;
            }
        }
    };
}

struct Broker {
    child: Child,
    pipe: String,
}
impl Drop for Broker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn broker() -> Broker {
    broker_with_flags(0)
}

fn broker_with_flags(flags: u32) -> Broker {
    // The dev runner inherits this environment and makes per-command scratch under its TEMP; point it at the
    // test target directory so the tests do not depend on the machine's TEMP being writable.
    let temp = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("runner-temp");
    std::fs::create_dir_all(&temp).unwrap();
    let mut child = Command::new(EXE)
        .args(["broker", "--dev"])
        .creation_flags(flags)
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
    Broker {
        child,
        pipe: reply["pipe"].as_str().unwrap().to_string(),
    }
}

fn request(argv: &[&str], cwd: &str) -> serde_json::Value {
    let env: serde_json::Map<String, serde_json::Value> =
        std::env::vars().map(|(k, v)| (k, json!(v))).collect();
    json!({
        "version": 1,
        "argv": argv,
        "cwd": cwd,
        "env": env,
        "capabilities": ["S-1-5-21-11-22-33-44"],
    })
}

fn request_file(value: &serde_json::Value) -> PathBuf {
    let file = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "yuantu-sbx-test-{}-{}.json",
        std::process::id(),
        rand_suffix()
    ));
    std::fs::write(&file, serde_json::to_vec(value).unwrap()).unwrap();
    file
}

fn rand_suffix() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed) as u128 * 1_000_003
}

fn exec_command(pipe: &str, value: &serde_json::Value) -> Command {
    let mut command = Command::new(EXE);
    command
        .arg("exec")
        .arg("--broker")
        .arg(pipe)
        .arg("--request")
        .arg(request_file(value));
    command
}

fn exec(pipe: &str, value: &serde_json::Value, input: &str) -> Output {
    let mut child = exec_command(pipe, value)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn cmd() -> String {
    format!(r"{}\System32\cmd.exe", std::env::var("SystemRoot").unwrap())
}

fn verbatim(mut value: serde_json::Value) -> serde_json::Value {
    value["verbatim"] = json!(true);
    value
}

/// Waits for a process to end, given its PID while it is still alive.
struct Watch(windows_sys::Win32::Foundation::HANDLE);
impl Watch {
    fn new(pid: u32) -> Self {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null(), "process {pid} already gone");
        Self(handle)
    }
    fn ended_within(&self, timeout: Duration) -> bool {
        unsafe { WaitForSingleObject(self.0, timeout.as_millis() as u32) == WAIT_OBJECT_0 }
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Starts a long-running node command and returns (exec child, watch on the command's own process).
fn long_running(broker: &Broker, node: &str) -> (Child, Watch) {
    let script = "console.log(process.pid); setInterval(() => {}, 1000)";
    let mut child = exec_command(&broker.pipe, &request(&[node, "-e", script], r"C:\"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let pid: u32 = line.trim().parse().unwrap();
    (child, Watch::new(pid))
}

#[test]
fn commands_run_on_a_private_desktop_not_the_users_own() {
    let broker = broker();
    let probe = exec(
        &broker.pipe,
        &request(&[env!("CARGO_BIN_EXE_desktop-probe")], r"C:\"),
        "",
    );
    assert_eq!(probe.status.code(), Some(0), "{probe:?}");
    let desktop = stdout(&probe);
    assert!(
        desktop.starts_with("YuanTuSandboxDesktop-"),
        "the command ran on {desktop:?}"
    );
}

fn with_tty(mut value: serde_json::Value, columns: u16, rows: u16) -> serde_json::Value {
    value["tty"] = json!({ "columns": columns, "rows": rows });
    value
}

#[test]
fn a_tty_request_runs_on_a_pseudo_console_and_a_plain_one_on_pipes() {
    let broker = broker();
    let probe = env!("CARGO_BIN_EXE_console-probe");
    let tty = exec(
        &broker.pipe,
        &with_tty(request(&[probe], r"C:\"), 100, 30),
        "",
    );
    assert_eq!(tty.status.code(), Some(0), "{tty:?}");
    assert!(
        stdout(&tty).contains("console 100"),
        "a TTY command did not see a 100-column console: {:?}",
        stdout(&tty)
    );
    let plain = exec(&broker.pipe, &request(&[probe], r"C:\"), "");
    assert_eq!(stdout(&plain), "redirected");
}

#[test]
fn a_tty_command_output_reaches_exec() {
    let broker = broker();
    let echo = exec(
        &broker.pipe,
        &with_tty(
            verbatim(request(&[&cmd(), "/c echo tty-hello"], r"C:\")),
            80,
            24,
        ),
        "",
    );
    assert_eq!(echo.status.code(), Some(0), "{echo:?}");
    assert!(stdout(&echo).contains("tty-hello"), "{:?}", stdout(&echo));
}

#[test]
fn a_tty_command_does_not_inherit_ignored_ctrl_c_from_its_runner() {
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};
    let node = require_node!();
    let broker = broker_with_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    let script = "process.on('SIGINT',()=>process.exit(0));console.log('INTERRUPT_READY');setTimeout(()=>process.exit(2),4000);";
    let mut child = exec_command(
        &broker.pipe,
        &with_tty(request(&[&node, "-e", script], r"C:\"), 80, 24),
    )
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut transcript = String::new();
    while !transcript.contains("INTERRUPT_READY") {
        assert_ne!(
            reader.read_line(&mut transcript).unwrap(),
            0,
            "{transcript}"
        );
    }
    child.stdin.as_mut().unwrap().write_all(b"\x03").unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "Ctrl+C was ignored: {output:?}"
    );
}

#[test]
fn echoes_and_reports_exit_codes() {
    let broker = broker();
    let echo = exec(
        &broker.pipe,
        &verbatim(request(&[&cmd(), "/c echo hello"], r"C:\")),
        "",
    );
    assert_eq!(stdout(&echo), "hello");
    assert_eq!(echo.status.code(), Some(0));
    let exit = exec(
        &broker.pipe,
        &verbatim(request(&[&cmd(), "/c exit 9"], r"C:\")),
        "",
    );
    assert_eq!(exit.status.code(), Some(9));
}

#[test]
fn passes_stdin_through() {
    let node = require_node!();
    let broker = broker();
    let output = exec(
        &broker.pipe,
        &request(&[&node, "-e", "process.stdin.pipe(process.stdout)"], r"C:\"),
        "ping",
    );
    assert_eq!(stdout(&output), "ping");
}

#[test]
fn commands_can_fork_with_piped_stdio() {
    let node = require_node!();
    let broker = broker();
    let fork = fixtures().join("fork.cjs");
    let output = exec(
        &broker.pipe,
        &request(&[&node, fork.to_str().unwrap()], r"C:\"),
        "",
    );
    assert_eq!(stdout(&output), "FORK-OK", "{output:?}");
    let forks = fixtures().join("forks");
    let output = exec(
        &broker.pipe,
        &request(&[&node, "--test"], forks.to_str().unwrap()),
        "",
    );
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(stdout(&output).contains("pass 2"), "{output:?}");
}

#[test]
fn runs_commands_concurrently() {
    let node = require_node!();
    let broker = broker();
    struct RunningCommand(Child);
    impl Drop for RunningCommand {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    // Neither command can exit until both have started. Serializing broker requests
    // therefore fails at the readiness barrier, regardless of machine speed.
    let script = r#"
        process.stdin.once('data', data => {
            if (data.toString().trim() !== 'release') process.exit(2);
            console.log(process.argv[1]);
            process.exit(0);
        });
        console.log('READY');
    "#;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let mut commands: Vec<_> = ["A", "B"]
        .into_iter()
        .map(|name| {
            let value = request(&[&node, "-e", script, name], r"C:\");
            let mut child = RunningCommand(
                exec_command(&broker.pipe, &value)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap(),
            );
            let mut reader = BufReader::new(child.0.stdout.take().unwrap());
            let ready_tx = ready_tx.clone();
            std::thread::spawn(move || {
                let mut line = String::new();
                let read = reader.read_line(&mut line);
                let _ = ready_tx.send((name, read, line, reader));
            });
            child
        })
        .collect();
    drop(ready_tx);
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut readers = Vec::new();
    for _ in 0..commands.len() {
        let (name, read, line, reader) = ready_rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("both commands must reach READY before either is released");
        assert!(read.unwrap() > 0, "command {name} exited before READY");
        assert_eq!(line.trim(), "READY", "command {name}");
        readers.push((name, reader));
    }
    for child in &mut commands {
        child
            .0
            .stdin
            .take()
            .unwrap()
            .write_all(b"release\n")
            .unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    for child in &mut commands {
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "command did not exit after release"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.code(), Some(0));
    }
    for (name, mut reader) in readers {
        let mut output = String::new();
        reader.read_to_string(&mut output).unwrap();
        assert_eq!(output.trim(), name);
    }
}

#[test]
fn killing_exec_cancels_the_command_tree() {
    let node = require_node!();
    let broker = broker();
    let (mut exec, command) = long_running(&broker, &node);
    exec.kill().unwrap();
    assert!(command.ended_within(Duration::from_secs(2)));
}

#[test]
fn closing_broker_stdin_ends_every_command() {
    let node = require_node!();
    let mut broker = broker();
    let (_exec, command) = long_running(&broker, &node);
    drop(broker.child.stdin.take());
    assert!(command.ended_within(Duration::from_secs(2)));
    let deadline = Instant::now() + Duration::from_secs(2);
    while broker.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "broker kept running");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_sandboxed_command_cannot_forge_requests() {
    let node = require_node!();
    let broker = broker();
    let marker = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("yuantu-sbx-forged-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let forge = fixtures().join("forge.cjs");
    let output = exec(
        &broker.pipe,
        &request(
            &[
                &node,
                forge.to_str().unwrap(),
                &broker.pipe,
                marker.to_str().unwrap(),
            ],
            r"C:\",
        ),
        "",
    );
    let text = stdout(&output);
    assert!(
        text.contains("CONNECT-REFUSED") || text.contains("invalid-request"),
        "{text}"
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(!marker.exists());
}

#[test]
fn a_bad_request_is_a_launch_failure() {
    let broker = broker();
    let output = exec(
        &broker.pipe,
        &request(&["cmd.exe", "/c", "exit"], r"C:\"),
        "",
    );
    assert_eq!(output.status.code(), Some(125));
    let mut stderr = String::new();
    output
        .stderr
        .as_slice()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(
        stderr.starts_with("YuantuSandbox launch failed: "),
        "{stderr}"
    );
}
