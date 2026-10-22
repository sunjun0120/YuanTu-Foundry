//! The setup marker: written only after a fully successful initialization.
//!
//! Readiness trusts this marker plus the DPAPI-protected credentials instead of re-checking accounts, logon
//! rights, WFP filters and read ACLs on every `account-status` call. `account-status --verify` runs those live
//! checks for the settings page and logs. Removing or corrupting the marker makes the backend not ready even when
//! its accounts still exist.
use super::{Account, credentials, users};
use crate::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const SETUP_VERSION: u32 = 1;
const FILE: &str = "setup_marker.json";

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MarkerAccount {
    pub account: Account,
    pub sid: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OfflineFilter {
    pub version: u32,
    pub offline_sid: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SetupMarker {
    pub version: u32,
    pub accounts: Vec<MarkerAccount>,
    pub group: String,
    pub offline_filter: OfflineFilter,
}

impl SetupMarker {
    pub fn sid_for(&self, account: Account) -> Option<&str> {
        self.accounts
            .iter()
            .find(|entry| entry.account == account)
            .map(|entry| entry.sid.as_str())
    }
}

pub fn path() -> Result<PathBuf> {
    Ok(credentials::state_directory()?.join(FILE))
}

/// Build the marker from the SIDs the elevated half returned. The offline filter schema is part of the marker so
/// a future change can invalidate an old initialization instead of trusting it silently.
pub fn build(sids: &[(Account, String)], group: &str) -> Result<SetupMarker> {
    let offline = sids
        .iter()
        .find(|(account, _)| *account == Account::Offline)
        .map(|(_, sid)| sid.clone())
        .ok_or("Offline account SID missing")?;
    let accounts = Account::ALL
        .iter()
        .map(|account| {
            let sid = sids
                .iter()
                .find(|(candidate, _)| candidate == account)
                .map(|(_, sid)| sid.clone())
                .ok_or("Account SID missing")?;
            Ok(MarkerAccount {
                account: *account,
                sid,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(SetupMarker {
        version: SETUP_VERSION,
        accounts,
        group: group.to_string(),
        offline_filter: OfflineFilter {
            version: 1,
            offline_sid: offline,
        },
    })
}

pub fn read() -> Result<SetupMarker> {
    let bytes = std::fs::read(path()?).map_err(|_| "setup-marker-missing")?;
    let marker: SetupMarker = serde_json::from_slice(&bytes).map_err(|_| "setup-marker-invalid")?;
    if marker.version != SETUP_VERSION {
        return Err("setup-marker-version".into());
    }
    if marker.accounts.len() != Account::ALL.len()
        || Account::ALL
            .iter()
            .any(|account| marker.sid_for(*account).is_none())
        || marker
            .accounts
            .iter()
            .any(|entry| users::parse_sid(&entry.sid).is_err())
        || users::parse_sid(&marker.group).is_err()
        || users::parse_sid(&marker.offline_filter.offline_sid).is_err()
    {
        return Err("setup-marker-invalid".into());
    }
    Ok(marker)
}

/// Write the marker last, after accounts, WFP, credentials and default read grants all succeeded.
pub fn write(marker: &SetupMarker) -> Result<()> {
    let directory = credentials::state_directory()?;
    std::fs::create_dir_all(&directory).map_err(|_| "Create sandbox state directory failed")?;
    credentials::protect_path(&directory)?;
    let path = path()?;
    let temporary = directory.join(format!("setup_marker.{}.tmp", std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec(marker).map_err(|_| "Serialize setup marker")?,
    )
    .map_err(|_| "Write setup marker failed")?;
    credentials::protect_path(&temporary)?;
    std::fs::rename(&temporary, &path).map_err(|_| "Replace setup marker failed")?;
    Ok(())
}

/// Remove the marker first during uninstall, so an interrupted uninstall is still not ready.
pub fn remove() -> Result<()> {
    match std::fs::remove_file(path()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Remove setup marker failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_round_trips_and_refuses_unknown_fields() {
        let sids = [
            (Account::Offline, "S-1-5-21-1-2-3-1001".to_string()),
            (Account::Online, "S-1-5-21-1-2-3-1002".to_string()),
        ];
        let marker = build(&sids, "S-1-5-21-1-2-3-1003").unwrap();
        assert_eq!(marker.version, SETUP_VERSION);
        assert_eq!(
            marker.sid_for(Account::Offline),
            Some("S-1-5-21-1-2-3-1001")
        );
        let text = serde_json::to_string(&marker).unwrap();
        let parsed: SetupMarker = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed, marker);
        let unknown = text.replace('{', r#"{"password":"x","#);
        assert!(serde_json::from_str::<SetupMarker>(&unknown).is_err());
    }

    #[test]
    fn marker_build_requires_both_accounts() {
        let sids = [(Account::Offline, "S-1-5-21-1-2-3-1001".to_string())];
        assert!(build(&sids, "S-1-5-21-1-2-3-1003").is_err());
    }
}
