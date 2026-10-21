//! The command token, following Codex's elevated recipe (codex-rs/windows-sandbox-rs/src/token.rs).
//!
//! `WRITE_RESTRICTED` makes every write pass a second check against the restricting SIDs. The token user is
//! one of them: libuv asks for `WRITE_DAC` on the stdio pipes it creates for a child, an owner-implied right
//! that also has to pass that second check, so without the user SID every `spawn` with piped stdio fails with
//! EPERM. That is only safe because the user is the dedicated sandbox account and no ACE anywhere outside its
//! own profile names that account directly: workspace writes are granted to the sandbox group (first check)
//! and to the workspace's capability SID (second check).
use crate::win::{Descriptor, Handle, LocalSid, Result, current_token, token_logon_sid, token_user, win};
use std::{ffi::c_void, mem::size_of, ptr::null};
use windows_sys::Win32::{Foundation::*, Security::*};

const DISABLE_MAX_PRIVILEGE: u32 = 0x1;
const LUA_TOKEN: u32 = 0x4;
const WRITE_RESTRICTED: u32 = 0x8;

/// A write-restricted primary token derived from this process's own token.
///
/// Restricting SIDs, in order: `capabilities`, the token user, the logon SID, Everyone. Integrity is left
/// unchanged. The default DACL gives this logon full access and the owner only `READ_CONTROL`, so objects a
/// command creates cannot be opened by another logon of the same account.
pub fn restricted_token(capabilities: &[String]) -> Result<Handle> {
    let base = current_token(
        TOKEN_DUPLICATE
            | TOKEN_QUERY
            | TOKEN_ASSIGN_PRIMARY
            | TOKEN_ADJUST_DEFAULT
            | TOKEN_ADJUST_PRIVILEGES,
    )?;
    let logon = token_logon_sid(base.0)?;
    let mut owned = Vec::new();
    for text in capabilities {
        owned.push(LocalSid::parse(text)?);
    }
    owned.push(LocalSid::parse(&token_user(base.0)?)?);
    owned.push(LocalSid::parse(&logon)?);
    owned.push(LocalSid::parse("S-1-1-0")?);
    let entries: Vec<SID_AND_ATTRIBUTES> = owned
        .iter()
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid.0,
            Attributes: 0,
        })
        .collect();
    let mut restricted = std::ptr::null_mut();
    win(
        unsafe {
            CreateRestrictedToken(
                base.0,
                DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
                0,
                null(),
                0,
                null(),
                entries.len() as u32,
                entries.as_ptr(),
                &mut restricted,
            )
        },
        "Create restricted token",
    )?;
    let restricted = Handle(restricted);
    set_default_dacl(&restricted, &logon)?;
    enable_change_notify(&restricted)?;
    Ok(restricted)
}

fn set_default_dacl(token: &Handle, logon: &str) -> Result<()> {
    let descriptor = Descriptor::parse(&format!("D:(A;;GA;;;{logon})(A;;RC;;;OW)"))?;
    let info = TOKEN_DEFAULT_DACL {
        DefaultDacl: descriptor.dacl()?,
    };
    win(
        unsafe {
            SetTokenInformation(
                token.0,
                TokenDefaultDacl,
                &info as *const _ as *const c_void,
                size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        },
        "Set token default DACL",
    )
}

/// Bypass-traverse checking: without it, every path under a directory the account cannot list is unreachable.
fn enable_change_notify(token: &Handle) -> Result<()> {
    let name = crate::win::wide("SeChangeNotifyPrivilege")?;
    let mut luid = LUID::default();
    win(
        unsafe { LookupPrivilegeValueW(null(), name.as_ptr(), &mut luid) },
        "Look up SeChangeNotifyPrivilege",
    )?;
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    win(
        unsafe {
            AdjustTokenPrivileges(
                token.0,
                0,
                &privileges,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        },
        "Enable SeChangeNotifyPrivilege",
    )?;
    if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
        return Err("SeChangeNotifyPrivilege is not held".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::win::{current_user, sid_text, token_information};

    fn groups(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Vec<String> {
        let buffer = token_information(token, class).unwrap();
        let groups = unsafe { &*(buffer.as_ptr() as *const TOKEN_GROUPS) };
        unsafe { std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize) }
            .iter()
            .map(|entry| sid_text(entry.Sid).unwrap())
            .collect()
    }

    fn integrity(token: HANDLE) -> String {
        let buffer = token_information(token, TokenIntegrityLevel).unwrap();
        let label = unsafe { &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL) };
        sid_text(label.Label.Sid).unwrap()
    }

    #[test]
    fn follows_the_codex_recipe() {
        let token = restricted_token(&["S-1-5-21-11-22-33-44".into()]).unwrap();
        assert_ne!(unsafe { IsTokenRestricted(token.0) }, 0);
        let current = current_token(TOKEN_QUERY).unwrap();
        let logon = token_logon_sid(current.0).unwrap();
        assert_eq!(
            groups(token.0, TokenRestrictedSids),
            vec![
                "S-1-5-21-11-22-33-44".to_string(),
                current_user().unwrap(),
                logon,
                "S-1-1-0".to_string()
            ]
        );
        let buffer = token_information(token.0, TokenDefaultDacl).unwrap();
        let dacl = unsafe { &*(*(buffer.as_ptr() as *const TOKEN_DEFAULT_DACL)).DefaultDacl };
        assert_eq!(dacl.AceCount, 2);
        assert_eq!(integrity(token.0), integrity(current.0));
    }
}
