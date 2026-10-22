//! Protected-installation checks for every elevated operation. Never elevate a script, shell,
//! user-supplied path, source checkout, per-user installation, or unsigned development executable.
use crate::{Handle, Result, sid_text, wide, win};
use std::{
    ffi::c_void,
    mem::size_of,
    path::Path,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Cryptography::*, WinTrust::*, *},
    Storage::FileSystem::*,
};

/// No external executable or script can be invoked by an elevated operation.
/// An unsigned development helper, or a helper without a compile-time publisher
/// pin, is refused before any system policy can change.
pub fn verify_release() -> Result<()> {
    let expected = option_env!("YUANTU_WINDOWS_SANDBOX_SIGNER_SHA256").unwrap_or("");
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Administrator initialization requires a release helper with a pinned signer certificate".into());
    }
    let executable = std::env::current_exe().map_err(|_| "Cannot locate signed initializer")?;
    let filename = wide(executable.to_str().ok_or("Invalid initializer path")?)?;
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: filename.as_ptr(),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_WHOLECHAIN,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let verified =
        unsafe { WinVerifyTrust(null_mut(), &mut action, &mut data as *mut _ as *mut c_void) };
    let result = (|| {
        if verified != 0 {
            return Err(format!(
                "Initializer Authenticode verification failed: {verified:#x}"
            ));
        }
        let provider = unsafe { WTHelperProvDataFromStateData(data.hWVTStateData) };
        if provider.is_null() {
            return Err("Initializer signature state is unavailable".into());
        }
        let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, 0, 0) };
        if signer.is_null() {
            return Err("Initializer signer is unavailable".into());
        }
        let certificate = unsafe { WTHelperGetProvCertFromChain(signer, 0) };
        if certificate.is_null() || unsafe { (*certificate).pCert.is_null() } {
            return Err("Initializer signer certificate is unavailable".into());
        }
        let certificate = unsafe { &*(*certificate).pCert };
        let mut digest = [0u8; 32];
        let mut length = digest.len() as u32;
        unsafe {
            win(
                CryptHashCertificate2(
                    wide("SHA256")?.as_ptr(),
                    0,
                    null(),
                    certificate.pbCertEncoded,
                    certificate.cbCertEncoded,
                    digest.as_mut_ptr(),
                    &mut length,
                ),
                "Hash release signer certificate",
            )?;
        }
        let actual: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        if length != 32 || !actual.eq_ignore_ascii_case(expected) {
            return Err("Initializer publisher differs from the signed release pin".into());
        }
        Ok(())
    })();
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(null_mut(), &mut action, &mut data as *mut _ as *mut c_void);
    }
    result
}

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
    verify_release()?;
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
    verify_release()?;
    Ok(handles)
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
    fn development_initializer_refuses_before_any_system_mutation() {
        if option_env!("YUANTU_WINDOWS_SANDBOX_SIGNER_SHA256").is_none() {
            assert!(verify_release().unwrap_err().contains("pinned signer"));
            assert!(preflight().is_err());
        }
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
