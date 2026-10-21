//! The sandbox account passwords, DPAPI-protected for the desktop user, in a file only that user and SYSTEM
//! can open. Only the broker (running as the desktop user) ever decrypts them.
use super::{Account, password::Secret};
use crate::{Handle, Result, sid_text, wide, win};
use serde::{Deserialize, Serialize};
use std::{
    ffi::c_void,
    mem::size_of,
    path::PathBuf,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Cryptography::*, *},
    System::{Com::CoTaskMemFree, Threading::*},
    UI::Shell::{FOLDERID_Profile, SHGetKnownFolderPath},
};

pub const VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoredAccount {
    pub account: Account,
    pub sid: String,
    /// DPAPI blob, lowercase hex.
    pub blob: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CredentialFile {
    pub version: u32,
    pub accounts: Vec<StoredAccount>,
}

fn entropy(sid: &str) -> Vec<u8> {
    format!("YuanTu.SandboxAccount.v1:{sid}").into_bytes()
}

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

fn take(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as _);
    }
    bytes
}

pub fn protect(secret: &Secret, sid: &str) -> Result<Vec<u8>> {
    let entropy = entropy(sid);
    let mut output = CRYPT_INTEGER_BLOB::default();
    win(
        unsafe {
            CryptProtectData(
                &blob(secret.expose().as_bytes()),
                null(),
                &blob(&entropy),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        },
        "Protect sandbox account password",
    )?;
    Ok(take(output))
}

pub fn unprotect(data: &[u8], sid: &str) -> Result<Secret> {
    let entropy = entropy(sid);
    let mut output = CRYPT_INTEGER_BLOB::default();
    win(
        unsafe {
            CryptUnprotectData(
                &blob(data),
                null_mut(),
                &blob(&entropy),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        },
        "Decrypt sandbox account password",
    )?;
    let mut bytes = take(output);
    let text = String::from_utf8(std::mem::take(&mut bytes))
        .map_err(|_| "Sandbox account password is not text")?;
    Ok(Secret::new(text))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>> {
    if text.len() % 2 != 0 {
        return Err("Invalid credential encoding".into());
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&text[i..i + 2], 16)
                .map_err(|_| "Invalid credential encoding".into())
        })
        .collect()
}

/// The token user's profile, from the token rather than `USERPROFILE`, so environment overrides cannot move it.
pub fn profile_directory() -> Result<PathBuf> {
    let mut path = null_mut();
    let hr = unsafe { SHGetKnownFolderPath(&FOLDERID_Profile, 0, null_mut(), &mut path) };
    if hr < 0 {
        return Err(format!("Locate user profile: {hr:#x}"));
    }
    let mut length = 0;
    while unsafe { *path.add(length) } != 0 {
        length += 1;
    }
    let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(path, length) });
    unsafe {
        CoTaskMemFree(path as *const c_void);
    }
    Ok(PathBuf::from(text))
}

pub fn state_directory() -> Result<PathBuf> {
    Ok(profile_directory()?
        .join(".yuantu")
        .join("sandbox-state")
        .join("windows-account"))
}

pub fn credentials_path() -> Result<PathBuf> {
    Ok(state_directory()?.join("credentials.json"))
}

pub fn current_user_sid() -> Result<String> {
    let mut token = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
        "Open process token",
    )?;
    let token = Handle(token);
    let mut length = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut length);
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    win(
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                length,
                &mut length,
            )
        },
        "Read token user",
    )?;
    sid_text(unsafe { (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid })
}

/// Only the desktop user and SYSTEM, no inherited entries.
fn protect_path(path: &std::path::Path) -> Result<()> {
    let sddl = format!("D:P(A;;FA;;;SY)(A;;FA;;;{})", current_user_sid()?);
    let mut descriptor = null_mut();
    win(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&sddl)?.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        },
        "Build credential permissions",
    )?;
    let (mut present, mut defaulted, mut dacl) = (0, 0, null_mut());
    let result = (|| {
        win(
            unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            },
            "Read credential permissions",
        )?;
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide(path.to_str().ok_or("Invalid credential path")?)?.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("Protect credential path: Windows error {status}"));
        }
        Ok(())
    })();
    unsafe {
        LocalFree(descriptor);
    }
    result
}

pub fn store(accounts: &[(Account, String, Secret)]) -> Result<()> {
    let file = CredentialFile {
        version: VERSION,
        accounts: accounts
            .iter()
            .map(|(account, sid, secret)| {
                Ok(StoredAccount {
                    account: *account,
                    sid: sid.clone(),
                    blob: hex(&protect(secret, sid)?),
                })
            })
            .collect::<Result<_>>()?,
    };
    let directory = state_directory()?;
    std::fs::create_dir_all(&directory).map_err(|_| "Create credential directory failed")?;
    protect_path(&directory)?;
    let path = credentials_path()?;
    let temporary = directory.join(format!("credentials.{}.tmp", std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec(&file).map_err(|_| "Serialize credentials")?,
    )
    .map_err(|_| "Write credentials failed")?;
    protect_path(&temporary)?;
    std::fs::rename(&temporary, &path).map_err(|_| "Replace credentials failed")?;
    Ok(())
}

pub fn read() -> Result<CredentialFile> {
    let bytes = std::fs::read(credentials_path()?).map_err(|_| "credentials-missing")?;
    let file: CredentialFile = serde_json::from_slice(&bytes).map_err(|_| "credentials-invalid")?;
    if file.version != VERSION {
        return Err("credentials-invalid".into());
    }
    Ok(file)
}

pub fn load(account: Account) -> Result<(String, Secret)> {
    let file = read()?;
    let stored = file
        .accounts
        .iter()
        .find(|stored| stored.account == account)
        .ok_or("credentials-missing")?;
    let secret =
        unprotect(&unhex(&stored.blob)?, &stored.sid).map_err(|_| "credentials-invalid")?;
    Ok((stored.sid.clone(), secret))
}

pub fn remove() -> Result<()> {
    match std::fs::remove_file(credentials_path()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Remove credentials failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trips_and_binds_the_account_sid() {
        let secret = Secret::new("p@ss-Word-1".into());
        let data = protect(&secret, "S-1-5-21-1-2-3-1001").unwrap();
        assert_eq!(
            unprotect(&data, "S-1-5-21-1-2-3-1001").unwrap().expose(),
            "p@ss-Word-1"
        );
        assert!(unprotect(&data, "S-1-5-21-1-2-3-1002").is_err());
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(
            unhex(&hex(&[0, 1, 254, 255])).unwrap(),
            vec![0, 1, 254, 255]
        );
        assert!(unhex("abc").is_err());
        assert!(unhex("zz").is_err());
    }

    #[test]
    fn credential_file_refuses_unknown_fields() {
        let text = r#"{"version":1,"accounts":[],"password":"x"}"#;
        assert!(serde_json::from_str::<CredentialFile>(text).is_err());
    }

    #[test]
    fn state_lives_under_the_token_profile() {
        let path = credentials_path().unwrap();
        assert!(path.ends_with(r".yuantu\sandbox-state\windows-account\credentials.json"));
    }
}
