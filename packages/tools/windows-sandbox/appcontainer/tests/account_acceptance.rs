//! Real acceptance of the sandbox account backend. It creates local accounts, a group, logon rights, and WFP
//! filters, so it runs only on a disposable elevated machine (CI) that sets
//! `YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE=1` and `YUANTU_SANDBOX_DEV_PROVISION=1`. Everything is removed at the end,
//! also when an assertion fails.
#![cfg(all(windows, debug_assertions))]
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

const EXE: &str = env!("CARGO_BIN_EXE_yuantu-sandbox");

fn enabled() -> bool {
    std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
        && std::env::var("YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE").as_deref() == Ok("1")
}

/// GitHub Actions workflow command: shows up as a run annotation, readable without downloading logs.
fn annotate(kind: &str, title: &str, message: &str) {
    if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true") {
        return;
    }
    let escape = |text: &str| {
        text.chars()
            .take(3500)
            .collect::<String>()
            .replace('%', "%25")
            .replace('\r', "%0D")
            .replace('\n', "%0A")
    };
    println!(
        "::{kind} title={}::{}",
        escape(title).replace(':', "%3A").replace(',', "%2C"),
        escape(message)
    );
}

fn report_panics() {
    std::panic::set_hook(Box::new(|info| {
        let message = info
            .payload()
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| info.payload().downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        let location = info
            .location()
            .map(|l| format!("line {}", l.line()))
            .unwrap_or_default();
        eprintln!("panicked at {location}: {message}");
        annotate("error", &format!("account acceptance {location}"), &message);
    }));
}

fn run(args: &[&str]) -> Output {
    Command::new(EXE).args(args).output().unwrap()
}

fn status() -> Value {
    let output = run(&["account-status"]);
    serde_json::from_slice(&output.stdout).unwrap()
}

/// Removes everything on drop, so a failed assertion still leaves a clean machine.
struct Provisioned;
impl Drop for Provisioned {
    fn drop(&mut self) {
        let output = run(&["account-remove", "--dev-direct"]);
        let text = format!(
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        eprintln!("account-remove: {text}");
        annotate("notice", "account-remove (cleanup)", &text);
    }
}

fn icacls(path: &Path, grant: &str) {
    let output = Command::new("icacls")
        .arg(path)
        .args(["/grant", grant])
        .output()
        .unwrap();
    assert!(output.status.success(), "icacls {grant}: {output:?}");
}

/// The product's own workspace grant: group + capability Modify, reserved directories denied.
fn grant_workspace(path: &Path, sid: &str) {
    let output = Command::new(EXE)
        .args(["grant", "--root"])
        .arg(path)
        .args(["--capability", sid])
        .output()
        .unwrap();
    assert!(output.status.success(), "grant {sid}: {}", text(&output));
}

fn capability() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    format!(
        "S-1-5-21-{}-{}-{}-{}",
        std::process::id(),
        7001,
        7002,
        7000 + n
    )
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

fn broker(account: &str) -> Broker {
    let mut child = Command::new(EXE)
        .args(["broker", "--account", account])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let Ok(reply) = serde_json::from_str::<Value>(&line) else {
        let _ = child.kill();
        let output = child.wait_with_output().unwrap();
        panic!(
            "broker --account {account} did not start: {line:?} {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    Broker {
        child,
        pipe: reply["pipe"].as_str().unwrap().to_string(),
    }
}

fn scratch() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("account-acceptance-{}", std::process::id()))
}

fn exec(pipe: &str, argv: &[&str], cwd: &Path, capabilities: &[&str], verbatim: bool) -> Output {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let file = scratch().join(format!(
        "request-{}.json",
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let env: serde_json::Map<String, Value> =
        ["SystemRoot", "ComSpec", "PATH", "PATHEXT", "WINDIR"]
            .iter()
            .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), json!(v))))
            .collect();
    let request = json!({
        "version": 1, "argv": argv, "cwd": cwd, "env": env,
        "capabilities": capabilities, "verbatim": verbatim,
    });
    std::fs::write(&file, serde_json::to_vec(&request).unwrap()).unwrap();
    let mut child = Command::new(EXE)
        .args(["exec", "--broker", pipe, "--request"])
        .arg(&file)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"").unwrap();
    child.wait_with_output().unwrap()
}

fn cmd() -> String {
    format!(r"{}\System32\cmd.exe", std::env::var("SystemRoot").unwrap())
}

fn shell(pipe: &str, line: &str, cwd: &Path, capabilities: &[&str]) -> Output {
    exec(
        pipe,
        &[&cmd(), &format!("/d /s /c \"{line}\"")],
        cwd,
        capabilities,
        true,
    )
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn node() -> String {
    let output = Command::new("where").arg("node").output().unwrap();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .expect("node on PATH")
        .trim()
        .to_string()
}

const CONNECT: &str = "const s=require('net').connect({host:process.argv[1],port:443,family:process.argv[2]==='6'?6:4});\
s.setTimeout(4000);s.on('connect',()=>{console.log('CONNECTED');s.destroy()});\
s.on('timeout',()=>{console.log('BLOCKED timeout');s.destroy()});s.on('error',e=>console.log('BLOCKED '+e.code));";
const LISTEN: &str = "const v=require('net').createServer();v.on('error',e=>console.log('LISTEN-FAIL '+e.code));\
v.listen(0,'127.0.0.1',()=>{console.log('LISTENING');v.close()});";

#[test]
fn sandbox_accounts_confine_writes_reads_and_network() {
    if !enabled() {
        eprintln!(
            "YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE is not 1; skipping (this test changes the machine)"
        );
        return;
    }
    report_panics();
    let root = scratch();
    std::fs::create_dir_all(&root).unwrap();

    // 1. Provision.
    let output = run(&["account-initialize", "--dev-direct"]);
    let _cleanup = Provisioned;
    annotate("notice", "account-initialize", &text(&output));
    assert!(output.status.success(), "initialize: {}", text(&output));
    let report = status();
    assert_eq!(report["ready"], json!(true), "{report}");

    // The accounts must be able to run this executable, node, and the fixtures.
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures");
    let node = node();
    for path in [
        Path::new(EXE).parent().unwrap(),
        fixtures.as_path(),
        Path::new(&node).parent().unwrap(),
        root.as_path(),
    ] {
        icacls(path, "YuanTuSandboxUsers:(OI)(CI)RX");
    }

    // 2. Two workspaces, each writable through the group plus its own capability.
    let (a, b) = (root.join("A"), root.join("B"));
    let (cap_a, cap_b) = (capability(), capability());
    for (dir, cap) in [(&a, &cap_a), (&b, &cap_b)] {
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        grant_workspace(dir, cap);
    }
    let profile = PathBuf::from(std::env::var("USERPROFILE").unwrap());
    let secret = profile.join("yuantu-acceptance-secret.txt");
    std::fs::write(&secret, "desktop-user-only").unwrap();

    let offline = broker("offline");

    // 3. Writes and reads.
    let wrote = shell(&offline.pipe, "echo ok> A\\own.txt", &root, &[&cap_a]);
    assert!(
        wrote.status.success() && a.join("own.txt").exists(),
        "{}",
        text(&wrote)
    );
    let crossed = shell(&offline.pipe, "echo x> B\\foreign.txt", &root, &[&cap_a]);
    assert!(!b.join("foreign.txt").exists(), "{}", text(&crossed));
    let target = profile.join("yuantu-acceptance-write.txt");
    let _ = shell(
        &offline.pipe,
        &format!("echo x> \"{}\"", target.display()),
        &root,
        &[&cap_a],
    );
    assert!(!target.exists());
    let read = shell(
        &offline.pipe,
        &format!("type \"{}\"", secret.display()),
        &root,
        &[&cap_a],
    );
    assert!(
        !text(&read).contains("desktop-user-only"),
        "{}",
        text(&read)
    );
    let tool = profile.join("yuantu-acceptance-tool");
    std::fs::create_dir_all(&tool).unwrap();
    let readable = tool.join("tool.cmd");
    std::fs::write(&readable, "allowlisted-tool-only").unwrap();
    let granted = Command::new(EXE)
        .args(["read-grant", "--root"])
        .arg(&tool)
        .output()
        .unwrap();
    assert!(granted.status.success(), "{}", text(&granted));
    assert_eq!(status()["ready"], json!(true));
    let read = shell(
        &offline.pipe,
        &format!("type \"{}\"", readable.display()),
        &root,
        &[&cap_a],
    );
    assert!(
        text(&read).contains("allowlisted-tool-only"),
        "{}",
        text(&read)
    );
    let write = tool.join("sandbox-write.txt");
    let _ = shell(
        &offline.pipe,
        &format!("echo x> \"{}\"", write.display()),
        &root,
        &[&cap_a],
    );
    assert!(!write.exists());
    let new_secret = tool.join(".ssh");
    std::fs::create_dir(&new_secret).unwrap();
    std::fs::write(new_secret.join("key"), "new-private-key").unwrap();
    let read = shell(
        &offline.pipe,
        &format!("type \"{}\"", new_secret.join("key").display()),
        &root,
        &[&cap_a],
    );
    assert!(!text(&read).contains("new-private-key"));
    for denied in [
        profile.clone(),
        profile.join(".ssh"),
        profile.join(r"AppData\Roaming\Microsoft\Protect"),
    ] {
        let reply = Command::new(EXE)
            .args(["read-grant", "--root"])
            .arg(denied)
            .output()
            .unwrap();
        assert!(!reply.status.success());
    }
    let revoked = Command::new(EXE)
        .args(["read-ungrant", "--root"])
        .arg(&tool)
        .output()
        .unwrap();
    assert!(revoked.status.success(), "{}", text(&revoked));
    std::fs::remove_dir_all(&new_secret).unwrap();
    let read = shell(
        &offline.pipe,
        &format!("type \"{}\"", readable.display()),
        &root,
        &[&cap_a],
    );
    assert!(!text(&read).contains("allowlisted-tool-only"));
    // Leave a fresh grant for uninstall to revoke, including files created since setup.
    assert!(
        Command::new(EXE)
            .args(["read-grant", "--root"])
            .arg(&tool)
            .status()
            .unwrap()
            .success()
    );
    let readonly = shell(&offline.pipe, "echo x> A\\readonly.txt", &root, &[]);
    assert!(!a.join("readonly.txt").exists(), "{}", text(&readonly));
    let metadata = shell(&offline.pipe, "echo x> A\\.git\\config", &root, &[&cap_a]);
    assert!(
        !a.join(".git").join("config").exists(),
        "{}",
        text(&metadata)
    );

    // 4. Concurrency across workspaces with one broker.
    let (pipe_a, pipe_b, root_a, root_b) = (
        offline.pipe.clone(),
        offline.pipe.clone(),
        root.clone(),
        root.clone(),
    );
    let (ca, cb) = (cap_a.clone(), cap_b.clone());
    let first = std::thread::spawn(move || {
        shell(
            &pipe_a,
            "ping -n 2 127.0.0.1 >nul & echo a> A\\a.txt & echo a> B\\a.txt",
            &root_a,
            &[&ca],
        )
    });
    let second = std::thread::spawn(move || {
        shell(
            &pipe_b,
            "ping -n 2 127.0.0.1 >nul & echo b> B\\b.txt & echo b> A\\b.txt",
            &root_b,
            &[&cb],
        )
    });
    first.join().unwrap();
    second.join().unwrap();
    assert!(a.join("a.txt").exists() && b.join("b.txt").exists());
    assert!(!b.join("a.txt").exists() && !a.join("b.txt").exists());

    // 5. Fork with piped stdio, and a forking test runner.
    let fork = exec(
        &offline.pipe,
        &[&node, fixtures.join("fork.cjs").to_str().unwrap()],
        &a,
        &[&cap_a],
        false,
    );
    assert!(text(&fork).contains("FORK-OK"), "{}", text(&fork));
    let tests = exec(
        &offline.pipe,
        &[&node, "--test"],
        &fixtures.join("forks"),
        &[&cap_a],
        false,
    );
    assert!(
        tests.status.success() && text(&tests).contains("pass 2"),
        "{}",
        text(&tests)
    );

    // 6. Network: offline is blocked everywhere, online is not.
    for (host, family) in [("1.1.1.1", "4"), ("2606:4700:4700::1111", "6")] {
        let output = exec(
            &offline.pipe,
            &[&node, "-e", CONNECT, host, family],
            &a,
            &[&cap_a],
            false,
        );
        assert!(
            !text(&output).contains("CONNECTED"),
            "offline reached {host}: {}",
            text(&output)
        );
    }
    let listen = exec(&offline.pipe, &[&node, "-e", LISTEN], &a, &[&cap_a], false);
    assert!(!text(&listen).contains("LISTENING"), "{}", text(&listen));
    drop(offline);
    let online = broker("online");
    let output = exec(
        &online.pipe,
        &[&node, "-e", CONNECT, "1.1.1.1", "4"],
        &a,
        &[&cap_a],
        false,
    );
    assert!(
        text(&output).contains("CONNECTED"),
        "online blocked: {}",
        text(&output)
    );
    drop(online);

    // 7. Removal leaves nothing behind.
    let _ = std::fs::remove_file(&secret);
    let removed = run(&["account-remove", "--dev-direct"]);
    assert!(removed.status.success(), "{}", text(&removed));
    let journal = yuantu_appcontainer::account::credentials::state_directory()
        .unwrap()
        .join("read-grants.json");
    let reads: Value = serde_json::from_slice(&std::fs::read(journal).unwrap()).unwrap();
    assert_eq!(reads["grants"], json!([]));
    std::fs::remove_dir_all(&tool).unwrap();
    let report = status();
    let problems = report["problems"].as_array().unwrap();
    for code in [
        "accounts-missing",
        "group-missing",
        "credentials-missing",
        "firewall-missing",
    ] {
        assert!(problems.contains(&json!(code)), "{report}");
    }
    let net = Command::new("net")
        .args(["user", "YuanTuSandboxOffline"])
        .output()
        .unwrap();
    assert!(!net.status.success());
}
