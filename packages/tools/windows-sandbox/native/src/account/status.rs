//! Whether the sandbox account backend can run, and if not, every reason why. Never changes the system.
//!
//! `status` is the fast readiness answer: the setup marker plus the DPAPI credentials. `verify` is the diagnostic
//! answer for settings and logs: it also checks the live accounts, group membership, logon, WFP filters, Secondary
//! Logon and read allowlist.
use super::{Account, credentials, firewall, grants, setup_marker, users};
use crate::{Handle, wide};
use serde::Serialize;
use windows_sys::Win32::{Security::*, System::Services::*};

#[derive(Serialize, Debug)]
pub struct AccountStatus {
    pub account: Account,
    pub sid: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Status {
    pub version: u32,
    pub ready: bool,
    /// Stable codes; the host maps them to messages.
    pub problems: Vec<&'static str>,
    /// Diagnostic text for the problems above; not stable, for logs only.
    pub details: Vec<String>,
    pub accounts: Vec<AccountStatus>,
    /// SID of the sandbox group, the trustee of every workspace grant.
    pub group: Option<String>,
    /// Directories a sandboxed command may read, and who added them: the settings page lists these.
    #[serde(rename = "readRoots")]
    pub read_roots: Vec<grants::reads::ReadRootView>,
}

/// The journal is the only source of read roots; an unreadable one is a diagnostic, not a failed status.
fn read_roots(details: &mut Vec<String>) -> Vec<grants::reads::ReadRootView> {
    match grants::reads::read_roots() {
        Ok(roots) => roots,
        Err(error) => {
            details.push(format!("read roots: {error}"));
            Vec::new()
        }
    }
}

fn push(code: &'static str, problems: &mut Vec<&'static str>) {
    if !problems.contains(&code) {
        problems.push(code);
    }
}

fn marker_code(error: &str) -> &'static str {
    match error {
        "setup-marker-missing" => "setup-marker-missing",
        "setup-marker-version" => "setup-marker-version",
        _ => "setup-marker-invalid",
    }
}

fn read_marker(
    problems: &mut Vec<&'static str>,
    details: &mut Vec<String>,
) -> Option<setup_marker::SetupMarker> {
    match setup_marker::read() {
        Ok(marker) => Some(marker),
        Err(error) => {
            push(marker_code(&error), problems);
            details.push(format!("setup marker: {error}"));
            None
        }
    }
}

/// The marker path only checks that each credential still decrypts for its user and matches the marker SIDs.
fn check_credentials(
    marker: Option<&setup_marker::SetupMarker>,
    problems: &mut Vec<&'static str>,
    details: &mut Vec<String>,
) {
    match credentials::read() {
        Ok(file) => {
            for account in Account::ALL {
                let Some(stored) = file
                    .accounts
                    .iter()
                    .find(|stored| stored.account == account)
                else {
                    push("credentials-missing", problems);
                    details.push(format!("credentials: missing {}", account.name()));
                    continue;
                };
                if let Some(marker) = marker {
                    if marker.sid_for(account) != Some(stored.sid.as_str()) {
                        push("credentials-invalid", problems);
                        details.push(format!(
                            "credentials: {} SID differs from the setup marker",
                            account.name()
                        ));
                        continue;
                    }
                }
                if credentials::load(account).is_err() {
                    push("credentials-invalid", problems);
                    details.push(format!("credentials: cannot decrypt {}", account.name()));
                }
            }
        }
        Err(error) if error == "credentials-missing" => push("credentials-missing", problems),
        Err(error) => {
            push("credentials-invalid", problems);
            details.push(format!("credentials: {error}"));
        }
    }
}

/// Proves the stored password still logs the account on (an administrator may have reset it).
fn logon_works(account: Account) -> Result<(), &'static str> {
    let (_, secret) = credentials::load(account).map_err(|e| {
        if e == "credentials-missing" {
            "credentials-missing"
        } else {
            "credentials-invalid"
        }
    })?;
    let mut token = std::ptr::null_mut();
    let ok = unsafe {
        LogonUserW(
            wide(account.name()).map_err(|_| "logon-failed")?.as_ptr(),
            wide(".").map_err(|_| "logon-failed")?.as_ptr(),
            wide(secret.expose()).map_err(|_| "logon-failed")?.as_ptr(),
            LOGON32_LOGON_INTERACTIVE,
            LOGON32_PROVIDER_DEFAULT,
            &mut token,
        )
    };
    if ok == 0 {
        return Err("logon-failed");
    }
    drop(Handle(token));
    Ok(())
}

/// Fast readiness: the marker exists, its version is current, the credentials decrypt and their SIDs match it.
pub fn status() -> Status {
    let mut problems = Vec::new();
    let mut details = Vec::new();
    let marker = read_marker(&mut problems, &mut details);
    let accounts: Vec<AccountStatus> = Account::ALL
        .iter()
        .map(|account| AccountStatus {
            account: *account,
            sid: marker
                .as_ref()
                .and_then(|marker| marker.sid_for(*account))
                .map(str::to_string),
        })
        .collect();
    let group = marker.as_ref().map(|marker| marker.group.clone());
    check_credentials(marker.as_ref(), &mut problems, &mut details);
    let read_roots = read_roots(&mut details);
    Status {
        version: 1,
        ready: problems.is_empty(),
        problems,
        details,
        accounts,
        group,
        read_roots,
    }
}

/// Live diagnostics for the settings page and logs. Never changes the system.
pub fn verify() -> Status {
    let mut problems = Vec::new();
    let mut details = Vec::new();
    let marker = read_marker(&mut problems, &mut details);
    let accounts: Vec<AccountStatus> = Account::ALL
        .iter()
        .map(|account| AccountStatus {
            account: *account,
            sid: users::lookup_sid(account.name()).ok().flatten(),
        })
        .collect();
    if accounts.iter().any(|account| account.sid.is_none()) {
        push("accounts-missing", &mut problems);
    }
    let sids: Vec<String> = accounts.iter().filter_map(|a| a.sid.clone()).collect();
    match users::group_members() {
        Ok(None) | Err(_) => push("group-missing", &mut problems),
        Ok(Some(members)) => {
            if members.len() != sids.len() || !members.iter().all(|member| sids.contains(member)) {
                push("group-membership", &mut problems);
            }
        }
    }
    if let Ok(file) = credentials::read() {
        for account in &accounts {
            let stored = file
                .accounts
                .iter()
                .find(|stored| stored.account == account.account);
            if stored
                .map(|stored| Some(&stored.sid) != account.sid.as_ref())
                .unwrap_or(true)
            {
                push("credentials-invalid", &mut problems);
            }
        }
    } else {
        push("credentials-missing", &mut problems);
    }
    if !problems.contains(&"accounts-missing") && !problems.contains(&"credentials-missing") {
        for account in Account::ALL {
            if let Err(code) = logon_works(account) {
                push(code, &mut problems);
            }
        }
    }
    let offline = accounts[0].sid.clone();
    match offline.map(|sid| firewall::filter_problem(&sid)) {
        Some(Ok(None)) => {}
        Some(Ok(Some(problem))) | Some(Err(problem)) => {
            details.push(format!("firewall: {problem}"));
            push("firewall-missing", &mut problems);
        }
        None => push("firewall-missing", &mut problems),
    }
    match users::seclogon_start_type(SERVICE_QUERY_CONFIG) {
        Ok((start, _)) if start != SERVICE_DISABLED => {}
        _ => push("seclogon-disabled", &mut problems),
    }
    let group = users::lookup_sid(super::GROUP).ok().flatten();
    if let Some(ref group) = group {
        if let Err(problem) = grants::reads::audit(group, &sids) {
            push("read-allowlist-invalid", &mut problems);
            details.push(format!("read allowlist: {problem}"));
        }
    }
    if let Some(marker) = &marker {
        for account in &accounts {
            if let (Some(expected), Some(actual)) =
                (marker.sid_for(account.account), account.sid.as_deref())
            {
                if expected != actual {
                    push("setup-marker-invalid", &mut problems);
                    details.push(format!(
                        "setup marker: {} SID differs from the installed account",
                        account.account.name()
                    ));
                }
            }
        }
    }
    let read_roots = read_roots(&mut details);
    Status {
        version: 1,
        ready: problems.is_empty(),
        problems,
        details,
        accounts,
        group,
        read_roots,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_uninitialized_machine_is_not_ready_and_says_why() {
        if users::lookup_sid(super::super::OFFLINE).unwrap().is_some() {
            eprintln!("sandbox accounts exist on this machine; skipping");
            return;
        }
        let report = verify();
        assert!(!report.ready);
        assert!(report.problems.contains(&"accounts-missing"));
        serde_json::to_string(&report).unwrap();
    }

    #[test]
    fn the_status_names_its_read_roots_the_way_the_host_parses_them() {
        let report = Status {
            version: 1,
            ready: false,
            problems: Vec::new(),
            details: Vec::new(),
            accounts: Vec::new(),
            group: None,
            read_roots: Vec::new(),
        };
        let json = serde_json::to_value(&report).unwrap();
        assert!(json.get("readRoots").is_some(), "{json}");
        assert!(json.get("read_roots").is_none(), "{json}");
    }
}
