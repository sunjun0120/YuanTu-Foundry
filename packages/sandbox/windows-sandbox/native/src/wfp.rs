//! Windows Filtering Platform plumbing shared by persistent, administrator-owned sandbox network policy:
//! engine sessions, transactions, the protected descriptor every object is installed with, and verification
//! that an installed object still carries exactly that descriptor.
use crate::{Result, wide, win};
use std::{
    ffi::c_void,
    ptr::{null, null_mut},
};
use windows_sys::{
    Win32::{
        Foundation::*,
        NetworkManagement::WindowsFilteringPlatform::*,
        Security::{Authorization::*, *},
    },
    core::GUID,
};

const DESCRIPTOR: &str = "O:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;BU)";
pub(crate) const LAYERS: [GUID; 8] = [
    FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4,
    FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6,
    FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    FWPM_LAYER_ALE_AUTH_LISTEN_V4,
    FWPM_LAYER_ALE_AUTH_LISTEN_V6,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
];

pub(crate) fn code(value: u32, operation: &str) -> Result<()> {
    if value != 0 {
        Err(format!("{operation}: WFP error {value}"))
    } else {
        Ok(())
    }
}
pub(crate) struct Engine(pub(crate) HANDLE);
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}
pub(crate) fn engine() -> Result<Engine> {
    let mut handle = null_mut();
    unsafe {
        code(
            FwpmEngineOpen0(
                null(),
                10, /* RPC_C_AUTHN_WINNT */
                null(),
                null(),
                &mut handle,
            ),
            "Open network policy engine",
        )?;
    }
    Ok(Engine(handle))
}
pub(crate) struct WfpMemory<T>(pub(crate) *mut T);
impl<T> Drop for WfpMemory<T> {
    fn drop(&mut self) {
        unsafe {
            FwpmFreeMemory0(&mut self.0 as *mut _ as *mut *mut c_void);
        }
    }
}
pub(crate) struct Descriptor(pub(crate) PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
pub(crate) fn descriptor() -> Result<Descriptor> {
    let mut result = null_mut();
    unsafe {
        win(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(DESCRIPTOR)?.as_ptr(),
                1,
                &mut result,
                null_mut(),
            ),
            "Create administrator-owned network policy descriptor",
        )?;
    }
    Ok(Descriptor(result))
}
pub(crate) struct Transaction<'a>(pub(crate) &'a Engine, pub(crate) bool);
impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if !self.1 {
            unsafe {
                FwpmTransactionAbort0(self.0.0);
            }
        }
    }
}

pub(crate) type SecurityQuery = unsafe extern "system" fn(
    HANDLE,
    *const GUID,
    u32,
    *mut PSID,
    *mut PSID,
    *mut *mut ACL,
    *mut *mut ACL,
    *mut PSECURITY_DESCRIPTOR,
) -> u32;
pub(crate) fn security_text(descriptor: PSECURITY_DESCRIPTOR) -> Result<String> {
    let mut text = null_mut();
    unsafe {
        win(
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                1,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut text,
                null_mut(),
            ),
            "Read network policy security",
        )?;
    }
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    let result = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text, length)) };
    unsafe {
        LocalFree(text as _);
    }
    Ok(result)
}
pub(crate) fn verify_security(engine: &Engine, key: &GUID, query: SecurityQuery) -> Result<()> {
    let mut sd = null_mut();
    let mut owner = null_mut();
    let mut group = null_mut();
    let mut dacl = null_mut();
    let mut sacl = null_mut();
    unsafe {
        code(
            query(
                engine.0,
                key,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                &mut group,
                &mut dacl,
                &mut sacl,
                &mut sd,
            ),
            "Check network policy ownership",
        )?;
    }
    let sd = WfpMemory(sd);
    let expected = descriptor()?;
    if !same_security(sd.0, expected.0)? {
        return Err(format!(
            "Network policy ownership/permissions changed; execution refused (found {}, expected {})",
            security_text(sd.0)?,
            security_text(expected.0)?
        ));
    }
    Ok(())
}

/// WFP's generic mapping (fwpmu.h): generic rights in the installed descriptor come back as these specific ones.
const WFP_GENERIC_MAPPING: GENERIC_MAPPING = GENERIC_MAPPING {
    GenericRead: 0x0002_01D4,
    GenericWrite: 0x0002_040B,
    GenericExecute: 0x0002_0220,
    GenericAll: 0x000F_07FF,
};

/// Whether an installed WFP descriptor grants exactly what `expected` asked for.
///
/// WFP stores a normalized copy: generic rights mapped to WFP-specific ones, and the DACL marked
/// auto-inherited. A textual comparison therefore never matches a real installation; this compares the owner,
/// the protected flag, and each ACE's type, flags, mapped mask and SID instead.
fn same_security(actual: PSECURITY_DESCRIPTOR, expected: PSECURITY_DESCRIPTOR) -> Result<bool> {
    let owner = |sd| -> Result<PSID> {
        let (mut owner, mut defaulted) = (null_mut(), 0);
        win(
            unsafe { GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted) },
            "Read network policy owner",
        )?;
        Ok(owner)
    };
    let (a, e) = (owner(actual)?, owner(expected)?);
    if a.is_null() || e.is_null() || unsafe { EqualSid(a, e) } == 0 {
        return Ok(false);
    }
    let (mut control, mut revision) = (0u16, 0u32);
    win(
        unsafe { GetSecurityDescriptorControl(actual, &mut control, &mut revision) },
        "Read network policy control",
    )?;
    if control & SE_DACL_PROTECTED == 0 {
        return Ok(false);
    }
    let dacl = |sd| -> Result<*mut ACL> {
        let (mut present, mut defaulted, mut dacl) = (0, 0, null_mut());
        win(
            unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) },
            "Read network policy ACL",
        )?;
        Ok(if present == 0 { null_mut() } else { dacl })
    };
    let (a, e) = (dacl(actual)?, dacl(expected)?);
    if a.is_null() || e.is_null() || unsafe { (*a).AceCount != (*e).AceCount } {
        return Ok(false);
    }
    for index in 0..unsafe { (*e).AceCount } as u32 {
        let (mut ace_a, mut ace_e) = (null_mut(), null_mut());
        win(
            unsafe { GetAce(a, index, &mut ace_a) },
            "Read network policy ACE",
        )?;
        win(unsafe { GetAce(e, index, &mut ace_e) }, "Read expected ACE")?;
        let (ha, he) = unsafe {
            (
                &*(ace_a as *const ACE_HEADER),
                &*(ace_e as *const ACE_HEADER),
            )
        };
        // Allow (0) and deny (1) share the ACCESS_ALLOWED_ACE layout; anything else is not ours.
        if ha.AceType != he.AceType || ha.AceType > 1 || ha.AceFlags != he.AceFlags {
            return Ok(false);
        }
        let (aa, ae) = unsafe {
            (
                &*(ace_a as *const ACCESS_ALLOWED_ACE),
                &*(ace_e as *const ACCESS_ALLOWED_ACE),
            )
        };
        let mut mask = ae.Mask;
        unsafe { MapGenericMask(&mut mask, &WFP_GENERIC_MAPPING) };
        let (sid_a, sid_e) = (
            &aa.SidStart as *const u32 as PSID,
            &ae.SidStart as *const u32 as PSID,
        );
        if aa.Mask != mask || unsafe { EqualSid(sid_a, sid_e) } == 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(sddl: &str) -> Descriptor {
        let mut sd = null_mut();
        unsafe {
            win(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(sddl).unwrap().as_ptr(),
                    1,
                    &mut sd,
                    null_mut(),
                ),
                "Parse test descriptor",
            )
            .unwrap();
        }
        Descriptor(sd)
    }
    #[test]
    fn installed_wfp_normalization_matches_and_widening_does_not() {
        let expected = descriptor().unwrap();
        // What a real WFP installation returned for DESCRIPTOR (GitHub windows-latest).
        let installed = parse("O:BAD:PAI(A;;0xf07ff;;;SY)(A;;0xf07ff;;;BA)(A;;LCRPDTLOCRRC;;;BU)");
        assert!(same_security(installed.0, expected.0).unwrap());
        let widened = parse("O:BAD:PAI(A;;0xf07ff;;;SY)(A;;0xf07ff;;;BA)(A;;0xf07ff;;;BU)");
        assert!(!same_security(widened.0, expected.0).unwrap());
        let unprotected = parse("O:BAD:AI(A;;0xf07ff;;;SY)(A;;0xf07ff;;;BA)(A;;LCRPDTLOCRRC;;;BU)");
        assert!(!same_security(unprotected.0, expected.0).unwrap());
        let owner = parse("O:BUD:PAI(A;;0xf07ff;;;SY)(A;;0xf07ff;;;BA)(A;;LCRPDTLOCRRC;;;BU)");
        assert!(!same_security(owner.0, expected.0).unwrap());
    }
}
