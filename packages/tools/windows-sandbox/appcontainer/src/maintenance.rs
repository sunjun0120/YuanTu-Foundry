//! Fixed-operation UAC entry. Never elevate a script, shell, user-supplied path,
//! source checkout, per-user installation, or unsigned development executable.
use crate::{Handle, Result, network, sid_text, wide, win};
use std::{
    mem::size_of,
    path::Path,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Com::*, Threading::*},
    UI::{Shell::*, WindowsAndMessaging::SW_HIDE},
};

fn trusted(sid: PSID) -> Result<bool> {
    if sid.is_null() {
        return Ok(false);
    }
    let text = sid_text(sid)?;
    Ok(matches!(
        text.as_str(),
        "S-1-5-18"
            | "S-1-5-32-544"
            | "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
    ))
}

/// Conservative allow-ACE inspection: deny ACEs do not excuse an untrusted
/// write grant; unknown conditional/object ACE forms are refused.
#[derive(Clone, Copy, PartialEq)]
enum InstallationPart {
    Executable,
    ExecutableDirectory,
    Ancestor,
}

fn protected_descriptor(sd: PSECURITY_DESCRIPTOR, part: InstallationPart) -> Result<()> {
    let mut owner = null_mut();
    let mut defaulted = 0;
    unsafe {
        win(
            GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted),
            "Read installation owner",
        )?;
    }
    if !trusted(owner)? {
        return Err("Initializer installation must have a system/administrator owner".into());
    }
    let mut present = 0;
    let mut dacl = null_mut();
    unsafe {
        win(
            GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted),
            "Read installation ACL",
        )?;
    }
    if present == 0 || dacl.is_null() {
        return Err("Initializer installation has an unrestricted ACL".into());
    }
    let mut writes = GENERIC_ALL
        | GENERIC_WRITE
        | DELETE
        | WRITE_DAC
        | WRITE_OWNER
        | FILE_WRITE_EA
        | FILE_WRITE_ATTRIBUTES
        | FILE_DELETE_CHILD;
    if part != InstallationPart::Ancestor {
        writes |= FILE_WRITE_DATA | FILE_APPEND_DATA;
    }
    for index in 0..unsafe { (*dacl).AceCount } {
        let mut ace = null_mut();
        unsafe {
            win(
                GetAce(dacl, index as u32, &mut ace),
                "Inspect installation ACL",
            )?;
        }
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        if header.AceFlags as u32 & INHERIT_ONLY_ACE != 0 {
            continue;
        }
        match header.AceType {
            0 => {
                let allow = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
                if allow.Mask & writes != 0 && !trusted(&allow.SidStart as *const _ as PSID)? {
                    return Err(
                        "Initializer installation permits non-administrator modification".into(),
                    );
                }
            }
            1 => {} // A deny can only make this conservative check stricter.
            _ => return Err("Initializer installation uses an unsupported ACL entry".into()),
        }
    }
    Ok(())
}

fn protected_handle(path: &Path, part: InstallationPart) -> Result<Handle> {
    let directory = part != InstallationPart::Executable;
    let filename = wide(path.to_str().ok_or("Invalid installation path")?)?;
    let handle = unsafe {
        CreateFileW(
            filename.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            if directory {
                FILE_SHARE_READ | FILE_SHARE_WRITE
            } else {
                FILE_SHARE_READ
            },
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err("Cannot lock initializer installation for verification".into());
    }
    let handle = Handle(handle);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        win(
            GetFileInformationByHandle(handle.0, &mut info),
            "Inspect installation file",
        )?;
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err("Initializer installation contains a link or unexpected file type".into());
    }
    let mut sd = null_mut();
    let error = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut sd,
        )
    };
    if error != 0 {
        return Err(format!(
            "Inspect installation permissions: Windows error {error}"
        ));
    }
    let result = protected_descriptor(sd, part);
    unsafe {
        LocalFree(sd);
    }
    result?;
    Ok(handle)
}

pub fn preflight() -> Result<Vec<Handle>> {
    // Missing compile-time pin refuses before any shell/UAC operation.
    network::verify_release()?;
    let executable =
        std::env::current_exe().map_err(|_| "Cannot locate initializer installation")?;
    // Only local drive paths. A network-share ACL is not a machine trust root.
    match executable.components().next() {
        Some(std::path::Component::Prefix(prefix))
            if matches!(
                prefix.kind(),
                std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
            ) => {}
        _ => return Err("Initializer requires a protected local installation".into()),
    }
    let mut handles = vec![];
    // Root to executable, pinning each component against rename/deletion while
    // checking the next. Existing child replacement is covered by DELETE_CHILD;
    // ancestor creation-only rights do not permit replacing an installed child.
    let mut paths: Vec<_> = executable.ancestors().collect();
    paths.reverse();
    for path in paths {
        let part = if path == executable {
            InstallationPart::Executable
        } else if Some(path) == executable.parent() {
            InstallationPart::ExecutableDirectory
        } else {
            InstallationPart::Ancestor
        };
        handles.push(protected_handle(path, part)?);
    }
    // Recheck the signature once path components and file are pinned.
    network::verify_release()?;
    Ok(handles)
}

pub fn setup() -> Result<u32> {
    let _installation = preflight()?;
    let executable = std::env::current_exe().map_err(|_| "Cannot locate initializer")?;
    let filename = wide(executable.to_str().ok_or("Invalid initializer path")?)?;
    let directory = wide(
        executable
            .parent()
            .and_then(Path::to_str)
            .ok_or("Invalid initializer directory")?,
    )?;
    let verb = wide("runas")?;
    let operation = wide("network-initialize")?;
    let com = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
    if com < 0 {
        return Err(format!("Initialize maintenance shell: {com:#x}"));
    }
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let _com = Com;
    let mut execute = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: verb.as_ptr(),
        lpFile: filename.as_ptr(),
        lpParameters: operation.as_ptr(),
        lpDirectory: directory.as_ptr(),
        nShow: SW_HIDE,
        ..Default::default()
    };
    unsafe {
        win(
            ShellExecuteExW(&mut execute),
            "Administrator initialization was cancelled or failed",
        )?;
    }
    if execute.hProcess.is_null() {
        return Err("Initializer did not return a process handle".into());
    }
    let process = Handle(execute.hProcess);
    if unsafe { WaitForSingleObject(process.0, INFINITE) } != WAIT_OBJECT_0 {
        return Err(
            "Administrator initialization completion is unknown; inspect policy status".into(),
        );
    }
    let mut exit = 0;
    unsafe {
        win(
            GetExitCodeProcess(process.0, &mut exit),
            "Read initializer completion",
        )?;
    }
    if exit != 0 {
        return Err(format!(
            "Administrator initialization failed with exit code {exit}; existing policy was not replaced"
        ));
    }
    // Do not report success merely because the elevated process exited zero.
    network::status()?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn check(sddl: &str, directory: bool) -> Result<()> {
        let mut sd = null_mut();
        unsafe {
            win(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(sddl)?.as_ptr(),
                    1,
                    &mut sd,
                    null_mut(),
                ),
                "Create test descriptor",
            )?;
        }
        let result = protected_descriptor(
            sd,
            if directory {
                InstallationPart::Ancestor
            } else {
                InstallationPart::Executable
            },
        );
        unsafe {
            LocalFree(sd);
        }
        result
    }
    #[test]
    fn system_owned_read_only_user_access_is_allowed() {
        assert!(check("O:BAD:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;FRFX;;;BU)", false).is_ok());
    }
    #[test]
    fn user_owned_or_user_writable_installer_is_refused() {
        assert!(check("O:BUD:P(A;;FA;;;BA)(A;;FR;;;BU)", false).is_err());
        for right in ["FW", "FA", "WD", "WO", "DE", "0x40", "0x100"] {
            assert!(
                check(&format!("O:BAD:P(A;;FA;;;BA)(A;;{right};;;BU)"), false).is_err(),
                "{right}"
            );
        }
    }
    #[test]
    fn denies_do_not_hide_mutation_grants_and_parent_delete_is_refused() {
        assert!(check("O:BAD:P(D;;FW;;;BU)(A;;FA;;;BA)(A;;FW;;;BU)", false).is_err());
        assert!(check("O:BAD:P(A;;FA;;;BA)(A;;0x40;;;BU)", true).is_err());
        assert!(check("O:BAD:P(A;;FA;;;BA)(A;;0x4;;;BU)", true).is_ok());
        assert!(check("O:BAD:P(A;;FA;;;BA)(A;OIIO;FA;;;CO)", true).is_ok());
    }
    #[test]
    fn null_and_conditional_acls_fail_closed() {
        assert!(check("O:BAD:NO_ACCESS_CONTROL", false).is_err());
        assert!(
            check(
                "O:BAD:P(A;;FA;;;BA)(XA;;FW;;;BU;(@User.Title == \"admin\"))",
                false
            )
            .is_err()
        );
    }
    #[test]
    fn helper_directory_refuses_untrusted_dll_creation() {
        let mut sd = null_mut();
        unsafe {
            win(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide("O:BAD:P(A;;FA;;;BA)(A;;0x2;;;BU)").unwrap().as_ptr(),
                    1,
                    &mut sd,
                    null_mut(),
                ),
                "Create DLL planting descriptor",
            )
            .unwrap();
        }
        // Strict checks apply to the executable's immediate parent too.
        let result = protected_descriptor(sd, InstallationPart::ExecutableDirectory);
        unsafe {
            LocalFree(sd);
        }
        assert!(
            result.is_err(),
            "ordinary users must not add DLLs beside an elevated helper"
        );
    }
}
