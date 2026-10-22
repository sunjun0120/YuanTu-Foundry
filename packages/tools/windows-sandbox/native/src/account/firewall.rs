//! WFP filters that block every IPv4/IPv6 connect, listen, accept, and port assignment by the offline sandbox
//! account — any program it runs, including loopback.
use crate::{
    Result,
    wfp::{
        Descriptor, Engine, LAYERS, Transaction, WfpMemory, code, descriptor, engine,
        verify_security,
    },
    wide, win,
};
use std::ptr::null_mut;
use windows_sys::{
    Win32::{
        Foundation::*, NetworkManagement::WindowsFilteringPlatform::*, Security::Authorization::*,
        Security::*,
    },
    core::GUID,
};

const PROVIDER: GUID = GUID::from_u128(0x2f0c1a7e_83d4_4b1c_9e61_5559414e5501);
const SUBLAYER: GUID = GUID::from_u128(0x6b9d3e52_1f7a_4c0e_a3b8_5559414e5501);
const FWP_E_NOT_FOUND: [u32; 4] = [0x8032_0002, 0x8032_0003, 0x8032_0005, 0x8032_0007];

/// One key per layer.
pub fn key(layer: usize) -> GUID {
    GUID::from_u128(0x7a1c0f3e_2b44_4c55_9d10_5559414e5500u128 + layer as u128)
}

/// The ALE user condition matches when an access check of the connecting token grants
/// `FWP_ACTRL_MATCH_FILTER` (CC) against this descriptor.
pub fn user_condition_sddl(sid: &str) -> String {
    format!("O:SYD:(A;;CC;;;{sid})")
}

struct SelfRelative(PSECURITY_DESCRIPTOR);
impl Drop for SelfRelative {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn user_condition(sid: &str) -> Result<SelfRelative> {
    let mut descriptor = null_mut();
    win(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&user_condition_sddl(sid))?.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        },
        "Build offline account network condition",
    )?;
    Ok(SelfRelative(descriptor))
}

fn ignore_missing(status: u32, operation: &str) -> Result<()> {
    if FWP_E_NOT_FOUND.contains(&status) {
        Ok(())
    } else {
        code(status, operation)
    }
}

fn delete_all(engine: &Engine) -> Result<()> {
    for index in 0..LAYERS.len() {
        ignore_missing(
            unsafe { FwpmFilterDeleteByKey0(engine.0, &key(index)) },
            "Remove offline account filter",
        )?;
    }
    ignore_missing(
        unsafe { FwpmSubLayerDeleteByKey0(engine.0, &SUBLAYER) },
        "Remove offline account sublayer",
    )?;
    ignore_missing(
        unsafe { FwpmProviderDeleteByKey0(engine.0, &PROVIDER) },
        "Remove offline account provider",
    )
}

/// Replaces any previous filters with ones for `offline_sid`, in one transaction. Needs elevation.
pub fn install_offline_filter(offline_sid: &str) -> Result<()> {
    let engine = engine()?;
    code(
        unsafe { FwpmTransactionBegin0(engine.0, 0) },
        "Begin offline account network transaction",
    )?;
    let mut transaction = Transaction(&engine, false);
    delete_all(&engine)?;
    let security: Descriptor = descriptor()?;
    let mut provider_key = PROVIDER;
    let mut title = wide("YuanTu sandbox account network denial v1")?;
    let display = FWPM_DISPLAY_DATA0 {
        name: title.as_mut_ptr(),
        description: title.as_mut_ptr(),
    };
    let provider = FWPM_PROVIDER0 {
        providerKey: PROVIDER,
        displayData: display,
        flags: FWPM_PROVIDER_FLAG_PERSISTENT,
        ..Default::default()
    };
    code(
        unsafe { FwpmProviderAdd0(engine.0, &provider, security.0) },
        "Install offline account network provider",
    )?;
    let sublayer = FWPM_SUBLAYER0 {
        subLayerKey: SUBLAYER,
        displayData: display,
        flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
        providerKey: &mut provider_key,
        weight: u16::MAX,
        ..Default::default()
    };
    code(
        unsafe { FwpmSubLayerAdd0(engine.0, &sublayer, security.0) },
        "Install offline account network sublayer",
    )?;
    let condition_sd = user_condition(offline_sid)?;
    let mut blob = FWP_BYTE_BLOB {
        size: unsafe { GetSecurityDescriptorLength(condition_sd.0) },
        data: condition_sd.0 as *mut u8,
    };
    let mut condition = FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_ALE_USER_ID,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: FWP_SECURITY_DESCRIPTOR_TYPE,
            Anonymous: FWP_CONDITION_VALUE0_0 { sd: &mut blob },
        },
    };
    for (index, layer) in LAYERS.iter().enumerate() {
        let filter = FWPM_FILTER0 {
            filterKey: key(index),
            displayData: display,
            flags: FWPM_FILTER_FLAG_PERSISTENT,
            providerKey: &mut provider_key,
            layerKey: *layer,
            subLayerKey: SUBLAYER,
            weight: FWP_VALUE0 {
                r#type: FWP_UINT8,
                Anonymous: FWP_VALUE0_0 { uint8: 15 },
            },
            numFilterConditions: 1,
            filterCondition: &mut condition,
            action: FWPM_ACTION0 {
                r#type: FWP_ACTION_BLOCK,
                ..Default::default()
            },
            ..Default::default()
        };
        code(
            unsafe { FwpmFilterAdd0(engine.0, &filter, security.0, null_mut()) },
            "Install offline account deny filter",
        )?;
    }
    code(
        unsafe { FwpmTransactionCommit0(engine.0) },
        "Commit offline account network transaction",
    )?;
    transaction.1 = true;
    Ok(())
}

/// Removes the provider, sublayer, and filters. Missing objects are not errors. Needs elevation.
pub fn remove_filters() -> Result<()> {
    let engine = engine()?;
    code(
        unsafe { FwpmTransactionBegin0(engine.0, 0) },
        "Begin offline account network removal",
    )?;
    let mut transaction = Transaction(&engine, false);
    delete_all(&engine)?;
    code(
        unsafe { FwpmTransactionCommit0(engine.0) },
        "Commit offline account network removal",
    )?;
    transaction.1 = true;
    Ok(())
}

/// Whether every filter exists, belongs to our provider, blocks, and matches exactly `offline_sid`, with the
/// administrator-only security the installer set. Readable without elevation.
pub fn filters_installed(offline_sid: &str) -> Result<bool> {
    Ok(filter_problem(offline_sid)?.is_none())
}

/// The first way the installed filters differ from what `install_offline_filter` writes, if any.
pub fn filter_problem(offline_sid: &str) -> Result<Option<String>> {
    match check(offline_sid) {
        Ok(()) => Ok(None),
        Err(problem) => Ok(Some(problem)),
    }
}

fn check(offline_sid: &str) -> std::result::Result<(), String> {
    let engine = engine()?;
    verify_security(&engine, &PROVIDER, FwpmProviderGetSecurityInfoByKey0)
        .map_err(|e| format!("provider: {e}"))?;
    verify_security(&engine, &SUBLAYER, FwpmSubLayerGetSecurityInfoByKey0)
        .map_err(|e| format!("sublayer: {e}"))?;
    let offline = crate::account::users::parse_sid(offline_sid)?;
    for (index, layer) in LAYERS.iter().enumerate() {
        verify_security(&engine, &key(index), FwpmFilterGetSecurityInfoByKey0)
            .map_err(|e| format!("filter {index}: {e}"))?;
        let mut filter = null_mut();
        if unsafe { FwpmFilterGetByKey0(engine.0, &key(index), &mut filter) } != 0 {
            return Err("filter missing".to_string());
        }
        let filter = WfpMemory(filter);
        let f = unsafe { &*filter.0 };
        let same = |a: &GUID, b: &GUID| {
            a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
        };
        if f.providerKey.is_null()
            || !same(unsafe { &*f.providerKey }, &PROVIDER)
            || !same(&f.layerKey, layer)
            || !same(&f.subLayerKey, &SUBLAYER)
            || f.action.r#type != FWP_ACTION_BLOCK
            || f.numFilterConditions != 1
        {
            return Err(
                "filter provider/layer/sublayer/action/condition count differs".to_string(),
            );
        }
        let condition = unsafe { &*f.filterCondition };
        if !same(&condition.fieldKey, &FWPM_CONDITION_ALE_USER_ID)
            || condition.matchType != FWP_MATCH_EQUAL
            || condition.conditionValue.r#type != FWP_SECURITY_DESCRIPTOR_TYPE
        {
            return Err("condition field/match/type differs".to_string());
        }
        let blob = unsafe { &*condition.conditionValue.Anonymous.sd };
        if blob.data.is_null()
            || !grants_only_match_to(blob.data as PSECURITY_DESCRIPTOR, offline.0)
        {
            return Err(format!(
                "condition descriptor differs: {}",
                crate::wfp::security_text(blob.data as _).unwrap_or_default()
            ));
        }
    }
    Ok(())
}

/// Whether a condition descriptor is a single allow ACE granting `FWP_ACTRL_MATCH_FILTER` to `sid` — compared by
/// meaning, since WFP may store a normalized copy of the descriptor it was given.
fn grants_only_match_to(
    descriptor: PSECURITY_DESCRIPTOR,
    sid: windows_sys::Win32::Security::PSID,
) -> bool {
    let (mut present, mut defaulted, mut dacl) = (0, 0, null_mut());
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
        || dacl.is_null()
        || unsafe { (*dacl).AceCount } != 1
    {
        return false;
    }
    let mut ace = null_mut();
    if unsafe { GetAce(dacl, 0, &mut ace) } == 0 {
        return false;
    }
    let header = unsafe { &*(ace as *const ACE_HEADER) };
    if header.AceType != 0 {
        return false;
    }
    let allow = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
    allow.Mask == 0x1 && unsafe { EqualSid(&allow.SidStart as *const u32 as _, sid) } != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn condition_grants_only_the_match_right_to_the_offline_account() {
        let built = user_condition("S-1-5-21-1-2-3-1001").unwrap();
        let sid = crate::account::users::parse_sid("S-1-5-21-1-2-3-1001").unwrap();
        assert!(grants_only_match_to(built.0, sid.0));
        let other = crate::account::users::parse_sid("S-1-5-21-1-2-3-1002").unwrap();
        assert!(!grants_only_match_to(built.0, other.0));
        assert_eq!(
            user_condition_sddl("S-1-5-21-1-2-3-1001"),
            "O:SYD:(A;;CC;;;S-1-5-21-1-2-3-1001)"
        );
        user_condition("S-1-5-21-1-2-3-1001").unwrap();
    }

    #[test]
    fn keys_are_distinct() {
        let keys: Vec<u128> = (0..LAYERS.len())
            .map(|i| {
                let k = key(i);
                ((k.data1 as u128) << 96)
                    | ((k.data2 as u128) << 80)
                    | ((k.data3 as u128) << 64)
                    | u64::from_be_bytes(k.data4) as u128
            })
            .collect();
        let unique: std::collections::HashSet<_> = keys.iter().collect();
        assert_eq!(unique.len(), LAYERS.len());
    }

    #[test]
    fn absent_filters_read_as_not_installed() {
        // Nothing on a development machine owns this provider; the read must not need elevation.
        assert!(!filters_installed("S-1-5-21-1-2-3-1001").unwrap_or(false));
    }
}
