//! WFP filters that block every IPv4/IPv6 connect, listen, accept, and port assignment by the offline sandbox
//! account — any program it runs, including loopback. Kept apart from the AppContainer policy: its own
//! provider, sublayer, and filter keys.
use crate::{
    Result,
    network::{
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

/// One key per layer, in a range disjoint from the AppContainer filters (`0xbfe82791_…`).
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
    let engine = engine()?;
    if verify_security(&engine, &PROVIDER, FwpmProviderGetSecurityInfoByKey0).is_err()
        || verify_security(&engine, &SUBLAYER, FwpmSubLayerGetSecurityInfoByKey0).is_err()
    {
        return Ok(false);
    }
    let expected = user_condition(offline_sid)?;
    let expected_length = unsafe { GetSecurityDescriptorLength(expected.0) } as usize;
    let expected_bytes =
        unsafe { std::slice::from_raw_parts(expected.0 as *const u8, expected_length) };
    for (index, layer) in LAYERS.iter().enumerate() {
        if verify_security(&engine, &key(index), FwpmFilterGetSecurityInfoByKey0).is_err() {
            return Ok(false);
        }
        let mut filter = null_mut();
        if unsafe { FwpmFilterGetByKey0(engine.0, &key(index), &mut filter) } != 0 {
            return Ok(false);
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
            return Ok(false);
        }
        let condition = unsafe { &*f.filterCondition };
        if !same(&condition.fieldKey, &FWPM_CONDITION_ALE_USER_ID)
            || condition.matchType != FWP_MATCH_EQUAL
            || condition.conditionValue.r#type != FWP_SECURITY_DESCRIPTOR_TYPE
        {
            return Ok(false);
        }
        let blob = unsafe { &*condition.conditionValue.Anonymous.sd };
        let actual = unsafe { std::slice::from_raw_parts(blob.data, blob.size as usize) };
        if actual != expected_bytes {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn condition_grants_only_the_match_right_to_the_offline_account() {
        assert_eq!(
            user_condition_sddl("S-1-5-21-1-2-3-1001"),
            "O:SYD:(A;;CC;;;S-1-5-21-1-2-3-1001)"
        );
        user_condition("S-1-5-21-1-2-3-1001").unwrap();
    }

    #[test]
    fn keys_are_distinct_and_apart_from_the_appcontainer_range() {
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
        assert!(keys.iter().all(|k| (k >> 96) as u32 != 0xbfe82791));
    }

    #[test]
    fn absent_filters_read_as_not_installed() {
        // Nothing on a development machine owns this provider; the read must not need elevation.
        assert!(!filters_installed("S-1-5-21-1-2-3-1001").unwrap_or(false));
    }
}
