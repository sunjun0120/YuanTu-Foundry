//! Whether the sandbox account backend can run, and if not, every reason why. Never changes the system.
use super::{Account, credentials, firewall, grants, users};
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
    /// A debug build: usable for tests, never an installed product.
    pub development: bool,
    /// Stable codes; the host maps them to messages.
    pub problems: Vec<&'static str>,
    /// Diagnostic text for the problems above; not stable, for logs only.
    pub details: Vec<String>,
    pub accounts: Vec<AccountStatus>,
    /// SID of the sandbox group, the trustee of every workspace grant.
    pub group: Option<String>,
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

pub fn status() -> Status {
    let mut problems: Vec<&'static str> = Vec::new();
    let push = |code: &'static str, problems: &mut Vec<&'static str>| {
        if !problems.contains(&code) {
            problems.push(code);
        }
    };
    if !cfg!(debug_assertions) && crate::maintenance::preflight().is_err() {
        push("installation-unverified", &mut problems);
    }
    let accounts: Vec<AccountStatus> = Account::ALL
        .iter()
        .map(|account| AccountStatus {
            account: *account,
            sid: users::lookup_sid(account.name()).ok().flatten(),
        })
        .collect();
    if accounts.iter().any(|a| a.sid.is_none()) {
        push("accounts-missing", &mut problems);
    }
    let sids: Vec<String> = accounts.iter().filter_map(|a| a.sid.clone()).collect();
    match users::group_members() {
        Ok(None) | Err(_) => push("group-missing", &mut problems),
        Ok(Some(members)) => {
            if members.len() != sids.len() || !members.iter().all(|m| sids.contains(m)) {
                push("group-membership", &mut problems);
            }
        }
    }
    if let Ok(file) = credentials::read() {
        for account in &accounts {
            let stored = file.accounts.iter().find(|s| s.account == account.account);
            if stored
                .map(|s| Some(&s.sid) != account.sid.as_ref())
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
    let mut details = Vec::new();
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
    Status {
        version: 1,
        ready: problems.is_empty(),
        development: cfg!(debug_assertions),
        problems,
        details,
        accounts,
        group,
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
        let status = status();
        assert!(!status.ready);
        assert!(status.development);
        assert!(status.problems.contains(&"accounts-missing"));
        assert!(status.problems.contains(&"firewall-missing"));
        serde_json::to_string(&status).unwrap();
    }
}
