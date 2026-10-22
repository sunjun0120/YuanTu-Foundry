//! Sandbox account provisioning and status used by `yuantu-sandbox`.
pub mod account;
pub(crate) mod wfp;

use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
};

pub type Result<T> = std::result::Result<T, String>;
pub fn wide(text: &str) -> Result<Vec<u16>> {
    if text.contains('\0') {
        return Err("NUL in launcher input".into());
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
pub struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub struct Sid(pub PSID);
impl Drop for Sid {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.0);
        }
    }
}
pub fn sid_text(sid: PSID) -> Result<String> {
    let mut text = null_mut();
    unsafe {
        win(ConvertSidToStringSidW(sid, &mut text), "Format sandbox SID")?;
    }
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
