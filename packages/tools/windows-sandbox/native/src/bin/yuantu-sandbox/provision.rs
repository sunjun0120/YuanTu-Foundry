//! `account-*` subcommands: status, setup/initialize, uninstall/remove.
//!
//! `account-setup` / `account-uninstall` are the user-facing entries. When the current process is already
//! elevated they run in-process; otherwise they elevate this same executable for one fixed operation
//! (`account-initialize --handoff PIPE` / `account-remove --handoff PIPE`). The passwords travel from the unelevated
//! side over a pipe only it and Administrators can open, so they never touch a command line or disk in clear, and
//! DPAPI protects them for the desktop user — not for whichever administrator approved UAC.
use crate::{
    frame::{read_frame, write_frame},
    maintenance_handoff,
    pipe::{PipeIo, accept, client_pid, connect, random_suffix, server},
    win::{Handle, Result, current_token, current_user, wide, win},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, ffi::c_void, mem::size_of, ptr::null};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    Storage::FileSystem::{FILE_GENERIC_READ, FILE_GENERIC_WRITE, PIPE_ACCESS_DUPLEX},
    System::{Com::*, Threading::*},
    UI::{Shell::*, WindowsAndMessaging::SW_HIDE},
};
use yuantu_sandbox::account::{
    Account, credentials, firewall, grants,
    password::{self, Secret},
    processes, read_refresh, setup_lock, setup_marker, status, users,
};

/// How long an elevated setup or uninstall waits for another one to finish before giving up.
const SETUP_LOCK_TIMEOUT_MS: u32 = 30_000;
/// How long uninstall waits for the sandbox accounts' processes and logons to end.
const STOP_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RefreshRequest {
    version: u32,
    env: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffPassword {
    account: Account,
    password: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffRequest {
    version: u32,
    passwords: Vec<HandoffPassword>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffSid {
    account: Account,
    sid: String,
}

pub fn print_status() -> Result<u32> {
    let report = status::status();
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|_| "Serialize status")?
    );
    Ok(0)
}

/// `account-status --verify`: the live diagnostic answer, for the settings page and logs.
pub fn print_verify() -> Result<u32> {
    let report = status::verify();
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|_| "Serialize status")?
    );
    Ok(0)
}

fn elevated() -> Result<bool> {
    let token = current_token(TOKEN_QUERY)?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut length = 0;
    win(
        unsafe {
            GetTokenInformation(
                token.0,
                TokenElevation,
                &mut elevation as *mut _ as *mut c_void,
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut length,
            )
        },
        "Check elevation",
    )?;
    Ok(elevation.TokenIsElevated == 1)
}

fn require_elevated() -> Result<()> {
    if !elevated()? {
        return Err("This operation must run as administrator".into());
    }
    Ok(())
}

/// Accounts, group, rights, sign-in hiding, Secondary Logon, then the offline account's network filters.
fn provision(
    _lock: &setup_lock::SetupLock,
    passwords: &[(Account, Secret)],
) -> Result<Vec<(Account, String)>> {
    let sids = users::provision(passwords)?;
    let offline = sids
        .iter()
        .find(|(account, _)| *account == Account::Offline)
        .map(|(_, sid)| sid.clone())
        .ok_or("Offline account SID missing")?;
    firewall::install_offline_filter(&offline)?;
    Ok(sids)
}

/// Stops the sandbox before taking its protections away: accounts disabled, their processes ended and their logons
/// gone, and only then the offline account's network filters and the accounts themselves. Removing the filters
/// first would put a still-running offline command on the network.
fn remove_everything(_lock: &setup_lock::SetupLock) -> Result<()> {
    let disabled = users::disable()?;
    if let Err(error) = processes::stop(&disabled.sids(), STOP_DEADLINE) {
        // The filters and accounts are still in place, so restoring the flags returns to a safe, working sandbox.
        return Err(match disabled.restore() {
            Ok(()) => error,
            Err(restore) => {
                format!("{error}; restoring the sandbox accounts also failed: {restore}")
            }
        });
    }
    firewall::remove_filters()?;
    users::remove()
}

fn remove_user_grants() -> Result<()> {
    // This journal belongs to the desktop user. Never interpret user-selected ACL paths in the UAC half,
    // which may be running as a different administrator with a different profile.
    if let Some(group) = users::lookup_sid(yuantu_sandbox::account::GROUP)? {
        grants::ungrant_all(&group)?;
    }
    grants::reads::revoke_all()?;
    Ok(())
}

fn generate_all() -> Result<Vec<(Account, Secret)>> {
    Account::ALL
        .iter()
        .map(|account| Ok((*account, password::generate()?)))
        .collect()
}

fn store(passwords: Vec<(Account, Secret)>, sids: &[(Account, String)]) -> Result<()> {
    let entries = passwords
        .into_iter()
        .map(|(account, secret)| {
            let sid = sids
                .iter()
                .find(|(a, _)| *a == account)
                .map(|(_, sid)| sid.clone())
                .ok_or("Account SID missing")?;
            Ok((account, sid, secret))
        })
        .collect::<Result<Vec<_>>>()?;
    credentials::store(&entries)
}

/// Shared tail of both initialization paths: credentials, the automatic read roots, and the readiness report.
fn finish_initialization(
    passwords: Vec<(Account, Secret)>,
    sids: &[(Account, String)],
) -> Result<u32> {
    for (account, password) in &passwords {
        if let Err(error) = create_profile(*account, password) {
            eprintln!("Profile for {} not created ahead: {error}", account.name());
        }
    }
    store(passwords, sids)?;
    let group = group_sid()?;
    // A root that cannot be granted must not fail initialization: the workspace grant is what commands need, and
    // the next refresh retries the toolchain roots.
    match read_refresh::refresh(&environment(), &group) {
        Ok(report) => {
            for skipped in &report.skipped {
                eprintln!("Skipped read root {}: {}", skipped.path, skipped.reason);
            }
        }
        Err(error) => eprintln!("Read refresh failed: {error}"),
    }
    setup_marker::write(&setup_marker::build(sids, &group)?)?;
    let report = status::status();
    let ready = report.ready;
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|_| "Serialize status")?
    );
    if !ready {
        setup_marker::remove()?;
        return Err("Initialization finished but the sandbox accounts are not ready".into());
    }
    Ok(0)
}

/// Signs the account in once with its profile, so Windows creates the profile now rather than on the first command.
/// A first `LOGON_WITH_PROFILE` builds the whole profile directory and registry hive, which on a busy machine
/// outlasts the Host's broker start timeout; real acceptance saw a first offline command time out that way.
/// Failure is reported, not fatal: the first command then only pays that cost itself.
fn create_profile(account: Account, password: &Secret) -> Result<()> {
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let image = wide(&format!(r"{system}\System32\cmd.exe"))?;
    let mut command = wide("cmd.exe /d /c exit 0")?;
    let directory = wide(&format!(r"{system}\System32"))?;
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    win(
        unsafe {
            CreateProcessWithLogonW(
                wide(account.name())?.as_ptr(),
                wide(".")?.as_ptr(),
                wide(password.expose())?.as_ptr(),
                LOGON_WITH_PROFILE,
                image.as_ptr(),
                command.as_mut_ptr(),
                CREATE_NO_WINDOW,
                null(),
                directory.as_ptr(),
                &startup,
                &mut info,
            )
        },
        "Sign the sandbox account in",
    )?;
    let (process, _thread) = (Handle(info.hProcess), Handle(info.hThread));
    if unsafe { WaitForSingleObject(process.0, 120_000) } != WAIT_OBJECT_0 {
        return Err("The first sign-in did not finish in time".into());
    }
    Ok(())
}

/// The current process environment, as the refresh request carries it.
fn environment() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// `read-refresh --env FILE`: authorize the toolchain roots one environment names. Never elevates.
pub fn read_refresh(file: &str) -> Result<u32> {
    let request = refresh_request(file)?;
    if request.version != 1 {
        return Err("Unsupported read refresh request".into());
    }
    let report = read_refresh::refresh(&request.env, &group_sid()?)?;
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|_| "Serialize read refresh")?
    );
    Ok(0)
}

/// The request is a one-shot message from the Host, in a file only the desktop user can read. It is deleted before
/// it is parsed: a rejected request must not be retried forever.
fn refresh_request(file: &str) -> Result<RefreshRequest> {
    let path = std::path::Path::new(file);
    let metadata = std::fs::metadata(path).map_err(|_| "Read refresh request is missing")?;
    if metadata.len() > 1 << 20 {
        let _ = std::fs::remove_file(path);
        return Err("Read refresh request is too large".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Read refresh request failed")?;
    let _ = std::fs::remove_file(path);
    serde_json::from_slice(&bytes).map_err(|_| "Invalid read refresh request".into())
}

/// Elevated half of `account-setup`.
pub fn initialize_handoff(pipe: &str) -> Result<u32> {
    require_elevated()?;
    if !pipe.starts_with(r"\\.\pipe\yuantu-sbx-handoff-") {
        return Err("Invalid handoff pipe".into());
    }
    let channel = connect(pipe, FILE_GENERIC_READ | FILE_GENERIC_WRITE)?;
    let request: HandoffRequest =
        read_frame(&mut PipeIo(&channel)).map_err(|_| "Invalid handoff request")?;
    if request.version != 1 || request.passwords.len() != Account::ALL.len() {
        return Err("Invalid handoff request".into());
    }
    let passwords: Vec<(Account, Secret)> = request
        .passwords
        .into_iter()
        .map(|entry| (entry.account, Secret::new(entry.password)))
        .collect();
    maintenance_handoff::serve(
        &mut PipeIo(&channel),
        || setup_lock::acquire(SETUP_LOCK_TIMEOUT_MS),
        |lock| {
            Ok(provision(lock, &passwords)?
                .into_iter()
                .map(|(account, sid)| HandoffSid { account, sid })
                .collect::<Vec<_>>())
        },
    )
}

/// Elevated half of `account-uninstall`.
pub fn remove_elevated() -> Result<u32> {
    require_elevated()?;
    let lock = setup_lock::acquire(SETUP_LOCK_TIMEOUT_MS)?;
    remove_everything(&lock)?;
    Ok(0)
}

/// Holds the same lease for removal, including desktop-owned ACL and credential cleanup.
pub fn remove_handoff(pipe: &str) -> Result<u32> {
    require_elevated()?;
    if !pipe.starts_with(r"\\.\pipe\yuantu-sbx-handoff-") {
        return Err("Invalid handoff pipe".into());
    }
    let channel = connect(pipe, FILE_GENERIC_READ | FILE_GENERIC_WRITE)?;
    maintenance_handoff::serve(
        &mut PipeIo(&channel),
        || setup_lock::acquire(SETUP_LOCK_TIMEOUT_MS),
        remove_everything,
    )
}

struct ComApartment;
impl ComApartment {
    fn enter() -> Result<Self> {
        let hr = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
        if hr < 0 {
            return Err(format!("Initialize shell: {hr:#x}"));
        }
        Ok(ComApartment)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

/// Starts this executable elevated with fixed arguments. UAC cancellation is an error.
fn elevate(arguments: &str) -> Result<Handle> {
    let executable = std::env::current_exe().map_err(|_| "Locate sandbox executable")?;
    let file = wide(executable.to_str().ok_or("Invalid executable path")?)?;
    let directory = wide(
        executable
            .parent()
            .and_then(|p| p.to_str())
            .ok_or("Invalid executable directory")?,
    )?;
    let verb = wide("runas")?;
    let parameters = wide(arguments)?;
    let _com = ComApartment::enter()?;
    let mut execute = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: parameters.as_ptr(),
        lpDirectory: directory.as_ptr(),
        nShow: SW_HIDE,
        ..Default::default()
    };
    win(
        unsafe { ShellExecuteExW(&mut execute) },
        "Administrator approval was cancelled or failed",
    )?;
    if execute.hProcess.is_null() {
        return Err("Elevated operation did not return a process".into());
    }
    Ok(Handle(execute.hProcess))
}

fn wait_success(process: &Handle) -> Result<()> {
    if unsafe { WaitForSingleObject(process.0, INFINITE) } != WAIT_OBJECT_0 {
        return Err("Elevated operation completion is unknown".into());
    }
    let mut code = 0;
    win(
        unsafe { GetExitCodeProcess(process.0, &mut code) },
        "Read elevated operation result",
    )?;
    if code != 0 {
        return Err(format!("Elevated operation failed with exit code {code}"));
    }
    Ok(())
}

/// Starts the fixed elevated half, verifies its PID, and waits for it only after the user's completion reply.
fn with_elevated_handoff<T>(command: &str, run: impl FnOnce(&Handle) -> Result<T>) -> Result<T> {
    let name = format!(r"\\.\pipe\yuantu-sbx-handoff-{}", random_suffix()?);
    let channel = server(
        &name,
        &format!("D:P(A;;GA;;;{})(A;;GA;;;BA)", current_user()?),
        PIPE_ACCESS_DUPLEX,
        true,
        1,
    )?;
    let process = elevate(&format!("{command} --handoff {name}"))?;
    accept(&channel)?;
    if client_pid(&channel)? != unsafe { GetProcessId(process.0) } {
        return Err("A process other than the elevated maintainer opened the handoff pipe".into());
    }
    let result = run(&channel);
    // An early user-side failure must close the pipe before waiting, so the helper can release its lock.
    drop(channel);
    let exited = wait_success(&process);
    let value = result?;
    exited?;
    Ok(value)
}

/// `account-setup`: every mutation, including desktop-owned state, is covered by the same setup lock.
pub fn setup() -> Result<u32> {
    let passwords = generate_all()?;
    if elevated()? {
        let lock = setup_lock::acquire(SETUP_LOCK_TIMEOUT_MS)?;
        setup_marker::remove()?;
        let sids = provision(&lock, &passwords)?;
        return finish_initialization(passwords, &sids);
    }
    with_elevated_handoff("account-initialize", |channel| {
        let request = HandoffRequest {
            version: 1,
            passwords: passwords
                .iter()
                .map(|(account, secret)| HandoffPassword {
                    account: *account,
                    password: secret.expose().to_string(),
                })
                .collect(),
        };
        write_frame(&mut PipeIo(channel), &request).map_err(|_| "Send handoff request failed")?;
        drop(request);
        maintenance_handoff::run(
            &mut PipeIo(channel),
            setup_marker::remove,
            |sids: Vec<HandoffSid>| {
                let sids = sids
                    .into_iter()
                    .map(|entry| (entry.account, entry.sid))
                    .collect::<Vec<_>>();
                finish_initialization(passwords, &sids)
            },
        )
    })
}

/// `account-uninstall`: user-facing removal; UAC only when the current process is not elevated.
pub fn uninstall() -> Result<u32> {
    let prepare = || {
        setup_marker::remove()?;
        remove_user_grants()
    };
    let finish = |()| {
        credentials::remove()?;
        print_status()
    };
    if elevated()? {
        let lock = setup_lock::acquire(SETUP_LOCK_TIMEOUT_MS)?;
        prepare()?;
        remove_everything(&lock)?;
        return finish(());
    }
    with_elevated_handoff("account-remove", |channel| {
        maintenance_handoff::run(&mut PipeIo(channel), prepare, finish)
    })
}

fn group_sid() -> Result<String> {
    users::lookup_sid(yuantu_sandbox::account::GROUP)?
        .ok_or_else(|| "The sandbox accounts are not initialized".to_string())
}

/// `grant --root R --capability S`: the desktop user grants its own workspace; no elevation.
pub fn grant(root: &str, capability: &str) -> Result<u32> {
    if !crate::protocol::is_capability_sid(capability) {
        return Err("Invalid capability SID".into());
    }
    let grant = grants::grant(root, &group_sid()?, capability)?;
    grants::reads::grant_metadata(std::path::Path::new(&grant.root), &group_sid()?)?;
    println!(
        "{}",
        serde_json::json!({"version": 1, "root": grant.root, "capability": grant.capability})
    );
    Ok(0)
}

/// `ungrant --root R`: takes back a standing workspace grant.
pub fn ungrant(root: &str) -> Result<u32> {
    grants::ungrant(root, &group_sid()?)?;
    Ok(0)
}

pub fn read_grant(root: &str, remove: bool) -> Result<u32> {
    if remove {
        grants::reads::revoke(std::path::Path::new(root), &group_sid()?)?;
    } else {
        grants::reads::grant(std::path::Path::new(root), &group_sid()?)?;
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_messages_refuse_unknown_fields() {
        assert!(
            serde_json::from_str::<HandoffRequest>(r#"{"version":1,"passwords":[],"path":"x"}"#)
                .is_err()
        );
        assert!(
            serde_json::from_str::<HandoffSid>(
                r#"{"account":"offline","sid":"S-1-5-21-1-2-3-4","x":1}"#
            )
            .is_err()
        );
    }
}
