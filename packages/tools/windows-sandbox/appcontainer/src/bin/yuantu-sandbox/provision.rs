//! `account-*` subcommands: status, setup/initialize, uninstall/remove.
//!
//! Release: the unelevated `account-setup` / `account-uninstall` verify the signed, protected installation and
//! elevate this same executable for one fixed operation (`account-initialize --handoff PIPE` /
//! `account-remove --elevated`), exactly like the AppContainer initializer. The passwords travel from the
//! unelevated side over a pipe only it and Administrators can open, so they never touch a command line or disk
//! in clear, and DPAPI protects them for the desktop user — not for whichever administrator approved UAC.
//!
//! Debug builds add `--dev-direct`: no UAC and no self-elevation; it runs only in a process that is already
//! elevated and has `YUANTU_SANDBOX_DEV_PROVISION=1`. It exists for disposable CI machines.
use crate::{
    frame::{read_frame, write_frame},
    pipe::{PipeIo, accept, client_pid, connect, random_suffix, server},
    win::{Handle, Result, current_token, current_user, wide, win},
};
use serde::{Deserialize, Serialize};
use std::{ffi::c_void, mem::size_of, ptr::null};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    Storage::FileSystem::{FILE_GENERIC_READ, FILE_GENERIC_WRITE, PIPE_ACCESS_DUPLEX},
    System::{Com::*, Threading::*},
    UI::{Shell::*, WindowsAndMessaging::SW_HIDE},
};
use yuantu_appcontainer::account::{
    Account, credentials, firewall, grants,
    password::{self, Secret},
    status, users,
};

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

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum HandoffReply {
    Provisioned { version: u32, sids: Vec<HandoffSid> },
    Failed { version: u32, message: String },
}

pub fn print_status() -> Result<u32> {
    let report = status::status();
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

#[cfg(debug_assertions)]
fn require_dev_direct() -> Result<()> {
    if std::env::var("YUANTU_SANDBOX_DEV_PROVISION").as_deref() != Ok("1") {
        return Err("--dev-direct requires YUANTU_SANDBOX_DEV_PROVISION=1".into());
    }
    require_elevated()
}

/// Accounts, group, rights, sign-in hiding, Secondary Logon, then the offline account's network filters.
fn provision(passwords: &[(Account, Secret)]) -> Result<Vec<(Account, String)>> {
    let sids = users::provision(passwords)?;
    let offline = sids
        .iter()
        .find(|(account, _)| *account == Account::Offline)
        .map(|(_, sid)| sid.clone())
        .ok_or("Offline account SID missing")?;
    firewall::install_offline_filter(&offline)?;
    Ok(sids)
}

fn remove_everything() -> Result<()> {
    firewall::remove_filters()?;
    users::remove()
}

fn remove_user_grants() -> Result<()> {
    // This journal belongs to the desktop user. Never interpret user-selected ACL paths in the UAC half,
    // which may be running as a different administrator with a different profile.
    if let Some(group) = users::lookup_sid(yuantu_appcontainer::account::GROUP)? {
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

#[cfg(debug_assertions)]
pub fn initialize_direct() -> Result<u32> {
    require_dev_direct()?;
    let passwords = generate_all()?;
    let sids = provision(&passwords)?;
    store(passwords, &sids)?;
    grants::reads::grant_defaults(&group_sid()?)?;
    print_status()
}

#[cfg(debug_assertions)]
pub fn remove_direct() -> Result<u32> {
    require_dev_direct()?;
    remove_user_grants()?;
    remove_everything()?;
    credentials::remove()?;
    print_status()
}

/// Elevated half of `account-setup`.
pub fn initialize_handoff(pipe: &str) -> Result<u32> {
    let _installation = yuantu_appcontainer::maintenance::preflight()?;
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
    let reply = match provision(&passwords) {
        Ok(sids) => HandoffReply::Provisioned {
            version: 1,
            sids: sids
                .into_iter()
                .map(|(account, sid)| HandoffSid { account, sid })
                .collect(),
        },
        Err(message) => HandoffReply::Failed {
            version: 1,
            message,
        },
    };
    let failed = matches!(reply, HandoffReply::Failed { .. });
    write_frame(&mut PipeIo(&channel), &reply).map_err(|_| "Send handoff reply failed")?;
    Ok(if failed { 1 } else { 0 })
}

/// Elevated half of `account-uninstall`.
pub fn remove_elevated() -> Result<u32> {
    let _installation = yuantu_appcontainer::maintenance::preflight()?;
    require_elevated()?;
    remove_everything()?;
    Ok(0)
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

/// `account-setup`: the unelevated, user-facing initialization.
pub fn setup() -> Result<u32> {
    let _installation = yuantu_appcontainer::maintenance::preflight()?;
    let passwords = generate_all()?;
    let name = format!(r"\\.\pipe\yuantu-sbx-handoff-{}", random_suffix()?);
    let channel = server(
        &name,
        &format!("D:P(A;;GA;;;{})(A;;GA;;;BA)", current_user()?),
        PIPE_ACCESS_DUPLEX,
        true,
        1,
    )?;
    let process = elevate(&format!("account-initialize --handoff {name}"))?;
    accept(&channel)?;
    if client_pid(&channel)? != unsafe { GetProcessId(process.0) } {
        return Err("A process other than the elevated initializer opened the handoff pipe".into());
    }
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
    write_frame(&mut PipeIo(&channel), &request).map_err(|_| "Send handoff request failed")?;
    drop(request);
    let reply: HandoffReply =
        read_frame(&mut PipeIo(&channel)).map_err(|_| "The elevated initializer did not reply")?;
    let sids = match reply {
        HandoffReply::Provisioned { version: 1, sids } => sids
            .into_iter()
            .map(|entry| (entry.account, entry.sid))
            .collect::<Vec<_>>(),
        HandoffReply::Failed { message, .. } => return Err(message),
        _ => return Err("Unsupported handoff reply".into()),
    };
    wait_success(&process)?;
    store(passwords, &sids)?;
    grants::reads::grant_defaults(&group_sid()?)?;
    let report = status::status();
    let ready = report.ready;
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|_| "Serialize status")?
    );
    if !ready {
        return Err("Initialization finished but the sandbox accounts are not ready".into());
    }
    Ok(0)
}

/// `account-uninstall`: the unelevated, user-facing removal.
pub fn uninstall() -> Result<u32> {
    let _installation = yuantu_appcontainer::maintenance::preflight()?;
    remove_user_grants()?;
    let process = elevate("account-remove --elevated")?;
    wait_success(&process)?;
    credentials::remove()?;
    print_status()
}

fn group_sid() -> Result<String> {
    users::lookup_sid(yuantu_appcontainer::account::GROUP)?
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
            serde_json::from_str::<HandoffReply>(
                r#"{"type":"provisioned","version":1,"sids":[],"x":1}"#
            )
            .is_err()
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_direct_requires_the_explicit_variable() {
        if std::env::var("YUANTU_SANDBOX_DEV_PROVISION").is_ok() {
            return;
        }
        assert!(require_dev_direct().is_err());
    }
}
