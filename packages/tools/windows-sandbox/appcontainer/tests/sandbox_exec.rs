//! End-to-end: broker --dev, runner, and exec as the host would drive them. The runner runs as the current
//! user here, so these tests cover the execution path (IPC, stdio, Job, token recipe, fork, cancel), not write
//! confinement — that needs a real sandbox account (plan 2b acceptance).
#![cfg(all(windows, debug_assertions))]
use serde_json::json;
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
    let mut child = Command::new(EXE)
        .args(["broker", "--dev"])
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
    let started = Instant::now();
    let threads: Vec<_> = ["A", "B"]
        .into_iter()
        .map(|name| {
            let value = request(
                &[
                    &node,
                    "-e",
                    "setTimeout(() => console.log(process.argv[1]), 700)",
                    name,
                ],
                r"C:\",
            );
            let pipe = broker.pipe.clone();
            std::thread::spawn(move || {
                let output = exec(&pipe, &value, "");
                (name, stdout(&output))
            })
        })
        .collect();
    for thread in threads {
        let (name, output) = thread.join().unwrap();
        assert_eq!(output, name);
    }
    assert!(
        started.elapsed() < Duration::from_millis(1400),
        "{:?}",
        started.elapsed()
    );
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
