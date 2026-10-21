//! Small Win32 helpers shared by the sandbox account executable.
use std::{
    ffi::c_void,
    mem::size_of,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    System::Threading::*,
};

pub type Result<T> = std::result::Result<T, String>;

pub fn wide(text: &str) -> Result<Vec<u16>> {
    if text.contains('\0') {
        return Err("NUL in sandbox input".into());
    }
    Ok(text.encode_utf16().chain(Some(0)).collect())
}

pub fn win(result: i32, operation: &str) -> Result<()> {
    if result == 0 {
        Err(format!("{operation}: Windows error {}", unsafe {
            GetLastError()
        }))
    } else {
        Ok(())
    }
}

/// An owned kernel handle, closed on drop.
pub struct Handle(pub HANDLE);
// Kernel handles may be used and closed from any thread.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// A SID allocated by `ConvertStringSidToSidW`, freed with `LocalFree`.
pub struct LocalSid(pub PSID);
impl Drop for LocalSid {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0 as _);
        }
    }
}
impl LocalSid {
    pub fn parse(text: &str) -> Result<Self> {
        let text = wide(text)?;
        let mut sid = null_mut();
        win(
            unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) },
            "Parse SID",
        )?;
        Ok(Self(sid))
    }
}

pub fn sid_text(sid: PSID) -> Result<String> {
    let mut text = null_mut();
    win(
        unsafe { ConvertSidToStringSidW(sid, &mut text) },
        "Format SID",
    )?;
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    let value = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text, length)) };
    unsafe {
        LocalFree(text as _);
    }
    Ok(value)
}

/// Reads one variable-length token information class into pointer-aligned storage.
pub fn token_information(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut length);
    }
    if length == 0 {
        return Err(format!(
            "Token information {class} size: Windows error {}",
            unsafe { GetLastError() }
        ));
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    win(
        unsafe {
            GetTokenInformation(
                token,
                class,
                buffer.as_mut_ptr() as *mut c_void,
                length,
                &mut length,
            )
        },
        "Read token information",
    )?;
    Ok(buffer)
}

pub fn token_user(token: HANDLE) -> Result<String> {
    let buffer = token_information(token, TokenUser)?;
    let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    sid_text(user.User.Sid)
}

/// The logon SID: the group whose attributes carry `SE_GROUP_LOGON_ID`.
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

pub fn token_logon_sid(token: HANDLE) -> Result<String> {
    let buffer = token_information(token, TokenGroups)?;
    let groups = unsafe { &*(buffer.as_ptr() as *const TOKEN_GROUPS) };
    let entries =
        unsafe { std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize) };
    for entry in entries {
        if entry.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID {
            return sid_text(entry.Sid);
        }
    }
    Err("Token has no logon SID".into())
}

pub fn current_token(access: u32) -> Result<Handle> {
    let mut token = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) },
        "Open process token",
    )?;
    Ok(Handle(token))
}

pub fn current_user() -> Result<String> {
    token_user(current_token(TOKEN_QUERY)?.0)
}

/// Opens another process's primary token for inspection.
pub fn process_token(process: HANDLE) -> Result<Handle> {
    let mut token = null_mut();
    win(
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) },
        "Open peer token",
    )?;
    Ok(Handle(token))
}

pub fn open_process(pid: u32, access: u32) -> Result<Handle> {
    let process = unsafe { OpenProcess(access, 0, pid) };
    if process.is_null() {
        return Err(format!("Open process {pid}: Windows error {}", unsafe {
            GetLastError()
        }));
    }
    Ok(Handle(process))
}

pub fn image_path(process: HANDLE) -> Result<String> {
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    win(
        unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) },
        "Read peer image path",
    )?;
    Ok(String::from_utf16_lossy(&buffer[..length as usize]))
}

/// A security descriptor parsed from SDDL, freed with `LocalFree`.
pub struct Descriptor(pub PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0 as _);
        }
    }
}
impl Descriptor {
    pub fn parse(sddl: &str) -> Result<Self> {
        let text = wide(sddl)?;
        let mut descriptor = null_mut();
        win(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    text.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            },
            "Parse security descriptor",
        )?;
        Ok(Self(descriptor))
    }
    pub fn dacl(&self) -> Result<*mut ACL> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        win(
            unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) },
            "Read security descriptor DACL",
        )?;
        if present == 0 || dacl.is_null() {
            return Err("Security descriptor has no DACL".into());
        }
        Ok(dacl)
    }
}

/// Replaces the DACL of a kernel object this process holds `WRITE_DAC` on.
pub fn set_object_dacl(object: HANDLE, sddl: &str) -> Result<()> {
    let descriptor = Descriptor::parse(sddl)?;
    let status = unsafe {
        SetSecurityInfo(
            object,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            descriptor.dacl()?,
            null(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("Set object DACL: Windows error {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_user_and_logon_sid_are_readable() {
        let token = current_token(TOKEN_QUERY).unwrap();
        assert!(token_user(token.0).unwrap().starts_with("S-1-5-"));
        assert!(token_logon_sid(token.0).unwrap().starts_with("S-1-5-5-"));
    }

    #[test]
    fn sid_round_trips() {
        let sid = LocalSid::parse("S-1-5-21-1-2-3-4").unwrap();
        assert_eq!(sid_text(sid.0).unwrap(), "S-1-5-21-1-2-3-4");
    }

    #[test]
    fn nul_is_refused() {
        assert!(wide("a\0b").is_err());
    }
}
