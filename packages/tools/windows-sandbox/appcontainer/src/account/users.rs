//! Local account and group provisioning. Every mutating function here needs an elevated administrator token;
//! `lookup_sid` and `group_members` only read.
use super::{Account, GROUP, password::Secret};
use crate::{Result, sid_text, wide, win};
use std::{
    ffi::c_void,
    mem::size_of,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    NetworkManagement::NetManagement::*,
    Security::{Authentication::Identity::*, Authorization::ConvertStringSidToSidW, *},
    System::{Registry::*, Services::*},
    UI::Shell::DeleteProfileW,
};

const HIDE_KEY: &str =
    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList";
const DENIED_RIGHTS: [&str; 2] = [
    "SeDenyNetworkLogonRight",
    "SeDenyRemoteInteractiveLogonRight",
];
const ERROR_ALIAS_EXISTS: u32 = 1379;
const ERROR_MEMBER_IN_ALIAS: u32 = 1378;
const ERROR_MEMBER_NOT_IN_ALIAS: u32 = 1377;
const ERROR_NO_SUCH_ALIAS: u32 = 1376;
const NERR_GROUP_EXISTS: u32 = 2223;
const NERR_USER_EXISTS: u32 = 2224;
const NERR_USER_NOT_FOUND: u32 = 2221;
const NERR_GROUP_NOT_FOUND: u32 = 2220;

fn net(status: u32, operation: &str) -> Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation}: error {status}"))
    }
}

/// The account's SID, or `None` when no such account exists.
pub fn lookup_sid(name: &str) -> Result<Option<String>> {
    let name = wide(name)?;
    let (mut sid_size, mut domain_size, mut kind) = (0u32, 0u32, 0);
    unsafe {
        LookupAccountNameW(
            null(),
            name.as_ptr(),
            null_mut(),
            &mut sid_size,
            null_mut(),
            &mut domain_size,
            &mut kind,
        );
    }
    if sid_size == 0 {
        return Ok(None);
    }
    let mut sid = vec![0u8; sid_size as usize];
    let mut domain = vec![0u16; domain_size as usize];
    win(
        unsafe {
            LookupAccountNameW(
                null(),
                name.as_ptr(),
                sid.as_mut_ptr() as PSID,
                &mut sid_size,
                domain.as_mut_ptr(),
                &mut domain_size,
                &mut kind,
            )
        },
        "Look up sandbox account",
    )?;
    Ok(Some(sid_text(sid.as_mut_ptr() as PSID)?))
}

fn ensure_user(account: Account, password: &Secret) -> Result<()> {
    let mut name = wide(account.name())?;
    let mut secret = wide(password.expose())?;
    let mut comment = wide("YuanTu Agent sandbox account")?;
    let info = USER_INFO_1 {
        usri1_name: name.as_mut_ptr(),
        usri1_password: secret.as_mut_ptr(),
        usri1_password_age: 0,
        usri1_priv: USER_PRIV_USER,
        usri1_home_dir: null_mut(),
        usri1_comment: comment.as_mut_ptr(),
        usri1_flags: UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE,
        usri1_script_path: null_mut(),
    };
    let status = unsafe { NetUserAdd(null(), 1, &info as *const _ as *const u8, null_mut()) };
    let result = if status == NERR_USER_EXISTS {
        // Reset only the password; the account's other settings stay as an administrator may have set them.
        let reset = USER_INFO_1003 {
            usri1003_password: secret.as_mut_ptr(),
        };
        net(
            unsafe {
                NetUserSetInfo(
                    null(),
                    name.as_ptr(),
                    1003,
                    &reset as *const _ as *const u8,
                    null_mut(),
                )
            },
            "Reset sandbox account password",
        )
    } else {
        net(status, "Create sandbox account")
    };
    secret.iter_mut().for_each(|c| *c = 0);
    result
}

/// The SIDs currently in the sandbox group, or `None` when the group does not exist.
pub fn group_members() -> Result<Option<Vec<String>>> {
    let group = wide(GROUP)?;
    let mut buffer = null_mut();
    let (mut read, mut total) = (0, 0);
    let status = unsafe {
        NetLocalGroupGetMembers(
            null(),
            group.as_ptr(),
            0,
            &mut buffer,
            u32::MAX,
            &mut read,
            &mut total,
            null_mut(),
        )
    };
    if status == NERR_GROUP_NOT_FOUND || status == ERROR_NO_SUCH_ALIAS {
        return Ok(None);
    }
    net(status, "Read sandbox group members")?;
    // An empty group comes back as a null buffer, which `from_raw_parts` must never see.
    if buffer.is_null() || read == 0 {
        if !buffer.is_null() {
            unsafe {
                NetApiBufferFree(buffer as *const c_void);
            }
        }
        return Ok(Some(Vec::new()));
    }
    let entries = unsafe {
        std::slice::from_raw_parts(buffer as *const LOCALGROUP_MEMBERS_INFO_0, read as usize)
    };
    let members = entries
        .iter()
        .map(|entry| sid_text(entry.lgrmi0_sid))
        .collect::<Result<Vec<_>>>();
    unsafe {
        NetApiBufferFree(buffer as *const c_void);
    }
    members.map(Some)
}

fn ensure_group(sids: &[String]) -> Result<()> {
    let mut name = wide(GROUP)?;
    let mut comment = wide("YuanTu Agent sandbox accounts")?;
    let info = LOCALGROUP_INFO_1 {
        lgrpi1_name: name.as_mut_ptr(),
        lgrpi1_comment: comment.as_mut_ptr(),
    };
    let status = unsafe { NetLocalGroupAdd(null(), 1, &info as *const _ as *const u8, null_mut()) };
    if status != ERROR_ALIAS_EXISTS && status != NERR_GROUP_EXISTS {
        net(status, "Create sandbox group")?;
    }
    // Workspace grants go to this group. A foreign member would inherit every workspace's write access.
    if let Some(members) = group_members()? {
        if let Some(foreign) = members.iter().find(|sid| !sids.contains(sid)) {
            return Err(format!(
                "The {GROUP} group contains an unexpected member {foreign}; remove it before initializing"
            ));
        }
    }
    for account in Account::ALL {
        let mut member = wide(account.name())?;
        let entry = LOCALGROUP_MEMBERS_INFO_3 {
            lgrmi3_domainandname: member.as_mut_ptr(),
        };
        let status = unsafe {
            NetLocalGroupAddMembers(null(), name.as_ptr(), 3, &entry as *const _ as *const u8, 1)
        };
        if status != ERROR_MEMBER_IN_ALIAS {
            net(status, "Add sandbox account to its group")?;
        }
    }
    Ok(())
}

struct Policy(LSA_HANDLE);
impl Drop for Policy {
    fn drop(&mut self) {
        unsafe {
            LsaClose(self.0);
        }
    }
}

fn policy() -> Result<Policy> {
    let attributes = LSA_OBJECT_ATTRIBUTES {
        Length: size_of::<LSA_OBJECT_ATTRIBUTES>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut handle: LSA_HANDLE = 0;
    let status = unsafe {
        LsaOpenPolicy(
            null(),
            &attributes,
            (POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES) as u32,
            &mut handle,
        )
    };
    if status != 0 {
        return Err(format!("Open local security policy: error {}", unsafe {
            LsaNtStatusToWinError(status)
        }));
    }
    Ok(Policy(handle))
}

/// A SID parsed from text, freed on drop.
pub struct ParsedSid(pub PSID);
impl Drop for ParsedSid {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0 as _);
        }
    }
}

pub fn parse_sid(text: &str) -> Result<ParsedSid> {
    let mut parsed = null_mut();
    win(
        unsafe { ConvertStringSidToSidW(wide(text)?.as_ptr(), &mut parsed) },
        "Parse account SID",
    )?;
    Ok(ParsedSid(parsed))
}

fn with_sid<T>(sid: &str, use_sid: impl FnOnce(PSID) -> Result<T>) -> Result<T> {
    let mut parsed = null_mut();
    win(
        unsafe { ConvertStringSidToSidW(wide(sid)?.as_ptr(), &mut parsed) },
        "Parse account SID",
    )?;
    let result = use_sid(parsed);
    unsafe {
        LocalFree(parsed as _);
    }
    result
}

fn rights() -> Result<(Vec<Vec<u16>>, Vec<LSA_UNICODE_STRING>)> {
    let mut texts: Vec<Vec<u16>> = DENIED_RIGHTS
        .iter()
        .map(|right| right.encode_utf16().collect())
        .collect();
    let strings = texts
        .iter_mut()
        .map(|text| LSA_UNICODE_STRING {
            Length: (text.len() * 2) as u16,
            MaximumLength: (text.len() * 2) as u16,
            Buffer: text.as_mut_ptr(),
        })
        .collect();
    Ok((texts, strings))
}

fn deny_remote_logon(sid: &str) -> Result<()> {
    let policy = policy()?;
    let (_texts, strings) = rights()?;
    with_sid(sid, |sid| {
        let status =
            unsafe { LsaAddAccountRights(policy.0, sid, strings.as_ptr(), strings.len() as u32) };
        if status != 0 {
            return Err(format!("Deny remote logon: error {}", unsafe {
                LsaNtStatusToWinError(status)
            }));
        }
        Ok(())
    })
}

fn registry(status: WIN32_ERROR, operation: &str) -> Result<()> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("{operation}: Windows error {status}"))
    }
}

/// Keeps the accounts off the sign-in screen.
fn hide(account: Account) -> Result<()> {
    let mut key = null_mut();
    registry(
        unsafe {
            RegCreateKeyExW(
                HKEY_LOCAL_MACHINE,
                wide(HIDE_KEY)?.as_ptr(),
                0,
                null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                null(),
                &mut key,
                null_mut(),
            )
        },
        "Open sign-in screen account list",
    )?;
    let zero = 0u32.to_le_bytes();
    let result = registry(
        unsafe {
            RegSetValueExW(
                key,
                wide(account.name())?.as_ptr(),
                0,
                REG_DWORD,
                zero.as_ptr(),
                zero.len() as u32,
            )
        },
        "Hide sandbox account from sign-in",
    );
    unsafe {
        RegCloseKey(key);
    }
    result
}

struct Service(SC_HANDLE);
impl Drop for Service {
    fn drop(&mut self) {
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}

/// Start type of Secondary Logon, which `CreateProcessWithLogonW` needs.
pub fn seclogon_start_type(access: u32) -> Result<(u32, OpenedService)> {
    let manager = unsafe { OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT) };
    if manager.is_null() {
        return Err("Open service manager failed".into());
    }
    let manager = Service(manager);
    let service = unsafe { OpenServiceW(manager.0, wide("seclogon")?.as_ptr(), access) };
    if service.is_null() {
        return Err("Open Secondary Logon service failed".into());
    }
    let service = Service(service);
    let mut needed = 0;
    unsafe {
        QueryServiceConfigW(service.0, null_mut(), 0, &mut needed);
    }
    let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    win(
        unsafe {
            QueryServiceConfigW(
                service.0,
                buffer.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW,
                needed,
                &mut needed,
            )
        },
        "Read Secondary Logon configuration",
    )?;
    let start = unsafe { (*(buffer.as_ptr() as *const QUERY_SERVICE_CONFIGW)).dwStartType };
    Ok((
        start,
        OpenedService {
            service,
            _manager: manager,
        },
    ))
}

/// A service handle, with the manager handle it was opened from kept alive beside it.
pub struct OpenedService {
    service: Service,
    _manager: Service,
}

fn enable_seclogon() -> Result<()> {
    let (start, service) = seclogon_start_type(SERVICE_QUERY_CONFIG | SERVICE_CHANGE_CONFIG)?;
    if start != SERVICE_DISABLED {
        return Ok(());
    }
    win(
        unsafe {
            ChangeServiceConfigW(
                service.service.0,
                SERVICE_NO_CHANGE,
                SERVICE_DEMAND_START,
                SERVICE_NO_CHANGE,
                null(),
                null(),
                null_mut(),
                null(),
                null(),
                null(),
                null(),
            )
        },
        "Enable Secondary Logon",
    )
}

/// Creates or repairs both accounts, the group, denied logon rights, sign-in hiding, and Secondary Logon.
/// Returns each account's SID.
pub fn provision(passwords: &[(Account, Secret)]) -> Result<Vec<(Account, String)>> {
    if passwords.len() != Account::ALL.len() {
        return Err("Both sandbox account passwords are required".into());
    }
    let mut sids = Vec::new();
    for (account, password) in passwords {
        ensure_user(*account, password)?;
        let sid = lookup_sid(account.name())?.ok_or("Sandbox account vanished after creation")?;
        deny_remote_logon(&sid)?;
        hide(*account)?;
        sids.push((*account, sid));
    }
    ensure_group(&sids.iter().map(|(_, sid)| sid.clone()).collect::<Vec<_>>())?;
    enable_seclogon()?;
    Ok(sids)
}

/// Removes everything `provision` created. Missing pieces are not errors, so a partial install can be cleaned.
pub fn remove() -> Result<()> {
    let group = wide(GROUP)?;
    for account in Account::ALL {
        let Some(sid) = lookup_sid(account.name())? else {
            continue;
        };
        let policy = policy()?;
        with_sid(&sid, |psid| {
            // STATUS_OBJECT_NAME_NOT_FOUND (no rights left) is fine.
            unsafe {
                LsaRemoveAccountRights(policy.0, psid, true, null(), 0);
            }
            Ok(())
        })?;
        let mut member = wide(account.name())?;
        let entry = LOCALGROUP_MEMBERS_INFO_3 {
            lgrmi3_domainandname: member.as_mut_ptr(),
        };
        let status = unsafe {
            NetLocalGroupDelMembers(
                null(),
                group.as_ptr(),
                3,
                &entry as *const _ as *const u8,
                1,
            )
        };
        if ![
            0,
            ERROR_MEMBER_NOT_IN_ALIAS,
            ERROR_NO_SUCH_ALIAS,
            NERR_GROUP_NOT_FOUND,
        ]
        .contains(&status)
        {
            net(status, "Remove sandbox account from its group")?;
        }
        // The profile can only be deleted while its owner still resolves; a loaded profile fails here and is
        // left for the next removal rather than blocking the account deletion.
        unsafe {
            DeleteProfileW(wide(&sid)?.as_ptr(), null(), null());
        }
        let status = unsafe { NetUserDel(null(), wide(account.name())?.as_ptr()) };
        if status != NERR_USER_NOT_FOUND {
            net(status, "Delete sandbox account")?;
        }
        unsafe {
            RegDeleteKeyValueW(
                HKEY_LOCAL_MACHINE,
                wide(HIDE_KEY)?.as_ptr(),
                wide(account.name())?.as_ptr(),
            );
        }
    }
    let status = unsafe { NetLocalGroupDel(null(), group.as_ptr()) };
    if ![0, ERROR_NO_SUCH_ALIAS, NERR_GROUP_NOT_FOUND].contains(&status) {
        net(status, "Delete sandbox group")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_accounts_have_no_sid() {
        assert_eq!(lookup_sid("YuanTuSandboxDoesNotExist").unwrap(), None);
    }

    #[test]
    fn well_known_accounts_resolve() {
        assert_eq!(lookup_sid("SYSTEM").unwrap().as_deref(), Some("S-1-5-18"));
    }

    #[test]
    fn secondary_logon_is_readable_without_elevation() {
        seclogon_start_type(SERVICE_QUERY_CONFIG).unwrap();
    }
}
