//! The sandbox account backend: two dedicated local accounts (offline/online) in one local group, their
//! DPAPI-protected credentials, and the WFP filters that take the offline account off the network.
//! See docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md §4.
pub mod credentials;
pub mod firewall;
pub mod grants;
pub mod password;
pub mod read_refresh;
pub mod read_roots;
pub mod setup_lock;
pub mod setup_marker;
pub mod status;
pub mod users;

use serde::{Deserialize, Serialize};

pub const OFFLINE: &str = "YuanTuSandboxOffline";
pub const ONLINE: &str = "YuanTuSandboxOnline";
pub const GROUP: &str = "YuanTuSandboxUsers";

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Account {
    Offline,
    Online,
}

impl Account {
    pub const ALL: [Account; 2] = [Account::Offline, Account::Online];

    pub fn name(self) -> &'static str {
        match self {
            Account::Offline => OFFLINE,
            Account::Online => ONLINE,
        }
    }

    pub fn parse(text: &str) -> Option<Account> {
        match text {
            "offline" => Some(Account::Offline),
            "online" => Some(Account::Online),
            _ => None,
        }
    }
}
