//! The private desktop sandboxed commands run on. The runner is started by `CreateProcessWithLogonW`, which shares
//! the caller's logon SID with it, and every command token keeps that logon SID as a restricting SID: on the user's
//! own desktop, a command could enumerate its windows, send them messages, hook them or synthesize input — the
//! approval UI included. On a desktop of its own it reaches none of them.
//!
//! The broker (the desktop user) creates the desktop and holds it for its lifetime; the runner opens it by name and
//! starts each command there. Mirrors Codex `desktop.rs` (openai/codex@86e17e9).
use crate::{
    pipe::random_suffix,
    win::{Result, current_user, wide},
};
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::{GetLastError, LocalFree},
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        SECURITY_ATTRIBUTES,
    },
    System::StationsAndDesktops::*,
};

const PREFIX: &str = "YuanTuSandboxDesktop-";
const ALL_ACCESS: u32 = DESKTOP_READOBJECTS
    | DESKTOP_CREATEWINDOW
    | DESKTOP_CREATEMENU
    | DESKTOP_HOOKCONTROL
    | DESKTOP_JOURNALRECORD
    | DESKTOP_JOURNALPLAYBACK
    | DESKTOP_ENUMERATE
    | DESKTOP_WRITEOBJECTS
    | DESKTOP_SWITCHDESKTOP
    | DESKTOP_DELETE
    | DESKTOP_READ_CONTROL
    | DESKTOP_WRITE_DAC
    | DESKTOP_WRITE_OWNER;
/// Everything a command needs to run windows on the desktop, but not to re-permission, take over or delete it.
const PARTICIPANT_ACCESS: u32 =
    ALL_ACCESS & !(DESKTOP_WRITE_DAC | DESKTOP_WRITE_OWNER | DESKTOP_DELETE);

/// A desktop this process created. Windows destroys it once the last handle closes and no thread uses it.
pub struct PrivateDesktop {
    handle: HDESK,
    name: String,
}

impl PrivateDesktop {
    /// Creates a desktop the current user fully controls and `participant` (a sandbox account, or the current user
    /// in `--dev`) may use but not re-permission or delete. The owner is named by user SID, not logon SID: the
    /// sandbox shares the caller's logon SID, so a logon-SID entry would grant the sandbox full control too.
    pub fn create(participant: &str) -> Result<PrivateDesktop> {
        let name = format!("{PREFIX}{}", random_suffix()?);
        let sddl = format!(
            "D:P(A;;0x{ALL_ACCESS:x};;;{})(A;;0x{PARTICIPANT_ACCESS:x};;;{participant})",
            current_user()?
        );
        let mut descriptor = null_mut();
        crate::win::win(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(&sddl)?.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            },
            "Build private desktop permissions",
        )?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = unsafe {
            CreateDesktopW(
                wide(&name)?.as_ptr(),
                null(),
                null(),
                0,
                ALL_ACCESS,
                &attributes,
            )
        };
        let error = unsafe { GetLastError() };
        unsafe { LocalFree(descriptor) };
        if handle.is_null() {
            return Err(format!("Create private desktop: Windows error {error}"));
        }
        Ok(PrivateDesktop { handle, name })
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for PrivateDesktop {
    fn drop(&mut self) {
        unsafe {
            CloseDesktop(self.handle);
        }
    }
}

/// A runner's handle on the broker's desktop: holding it proves the name resolved to an existing desktop, and keeps
/// the desktop alive while commands start on it.
pub struct OpenedDesktop {
    handle: HDESK,
    startup: Vec<u16>,
}

impl Drop for OpenedDesktop {
    fn drop(&mut self) {
        unsafe {
            CloseDesktop(self.handle);
        }
    }
}

impl OpenedDesktop {
    /// `Winsta0\<name>`, for `STARTUPINFO.lpDesktop`. Valid as long as `self` is.
    pub fn startup_name(&self) -> *mut u16 {
        self.startup.as_ptr() as *mut u16
    }
}

/// `YuanTuSandboxDesktop-` followed by 32 hexadecimal digits: the only names a runner accepts.
pub fn validate_name(name: &str) -> bool {
    name.strip_prefix(PREFIX).is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

/// Opens an existing private desktop. A missing desktop is an error, never a fallback to `Default`.
pub fn open(name: &str) -> Result<OpenedDesktop> {
    if !validate_name(name) {
        return Err("Invalid private desktop name".into());
    }
    let handle = unsafe { OpenDesktopW(wide(name)?.as_ptr(), 0, 0, PARTICIPANT_ACCESS) };
    if handle.is_null() {
        return Err(format!("Open private desktop: Windows error {}", unsafe {
            GetLastError()
        }));
    }
    Ok(OpenedDesktop {
        handle,
        startup: wide(&format!(r"Winsta0\{name}"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_created_desktop_can_be_opened_by_name_until_it_is_dropped() {
        let desktop = PrivateDesktop::create(&crate::win::current_user().unwrap()).unwrap();
        assert!(validate_name(desktop.name()), "{}", desktop.name());
        let name = desktop.name().to_string();
        let opened = open(&name).unwrap();
        drop(opened);
        drop(desktop);
        assert!(open(&name).is_err(), "the desktop outlived its creator");
    }

    #[test]
    fn only_private_desktop_names_are_accepted() {
        let good = format!("{PREFIX}{}", "0123456789abcdef".repeat(2));
        assert!(validate_name(&good));
        for bad in [
            "Default".to_string(),
            "Winlogon".to_string(),
            PREFIX.to_string(),
            format!("{PREFIX}{}", "g".repeat(32)),
            format!("{PREFIX}{}", "a".repeat(31)),
            format!("{PREFIX}{}", "a".repeat(33)),
            format!(r"Winsta0\{good}"),
        ] {
            assert!(!validate_name(&bad), "{bad}");
        }
    }

    #[test]
    fn a_name_that_does_not_exist_is_not_opened() {
        assert!(open(&format!("{PREFIX}{}", "0".repeat(32))).is_err());
        assert!(open("Default").is_err());
    }
}
