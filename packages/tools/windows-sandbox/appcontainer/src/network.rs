//! Persistent per-AppContainer network denial. Installation is explicitly
//! elevated and release-signed; status/launch checks never change system policy.
use crate::{Result, Sid, profile_name, sid_text, wide, win};
use serde::{Deserialize, Serialize};
use std::{
    ffi::c_void,
    mem::size_of,
    ptr::{null, null_mut},
};
use windows_sys::{
    Win32::{
        Foundation::*,
        NetworkManagement::WindowsFilteringPlatform::*,
        Security::{Authorization::*, Cryptography::*, Isolation::*, WinTrust::*, *},
        System::{Rpc::UuidCreate, Threading::GetCurrentProcess},
    },
    core::GUID,
};

const PROVIDER: GUID = GUID::from_u128(0x9cfe0294_1d02_49dd_b930_5559414e5455);
const SUBLAYER: GUID = GUID::from_u128(0x45ce4c21_e8b2_4c87_b830_5559414e5455);
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub name: String,
    pub sid: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub version: u32,
    pub profiles: Vec<Profile>,
}
impl Inventory {
    fn validate(&self) -> Result<()> {
        if self.version != 1 || self.profiles.is_empty() || self.profiles.len() > 16 {
            return Err("Network policy must contain 1..16 versioned isolation identities".into());
        }
        let mut names = std::collections::HashSet::new();
        let mut sids = std::collections::HashSet::new();
        for profile in &self.profiles {
            profile_name(&profile.name)?;
            if !names.insert(&profile.name) || !sids.insert(&profile.sid) {
                return Err("Network isolation identities must be distinct".into());
            }
            let sid = derive(&profile.name)?;
            if sid_text(sid.0)? != profile.sid {
                return Err("Network policy identity belongs to another account or profile".into());
            }
        }
        Ok(())
    }
}
fn derive(name: &str) -> Result<Sid> {
    let mut sid = null_mut();
    let hr = unsafe {
        DeriveAppContainerSidFromAppContainerName(profile_name(name)?.as_ptr(), &mut sid)
    };
    if hr < 0 {
        return Err(format!("Derive network policy identity: {hr:#x}"));
    }
    Ok(Sid(sid))
}
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
fn key(profile: usize, layer: usize) -> GUID {
    GUID::from_u128(
        0xbfe82791_6b51_4d0e_aa11_5559414e0000u128 + ((profile as u128) << 8) + layer as u128,
    )
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

/// No external executable or script can be invoked by this elevated operation.
/// An unsigned development helper, or a helper without a compile-time publisher
/// pin, is refused before opening an engine capable of changing policy.
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

pub fn initialize() -> Result<()> {
    // Keep verified executable and ancestor handles open during all mutations.
    // Even direct administrator invocation cannot bypass installation checks.
    let _installation = crate::maintenance::preflight()?;
    let mut token = null_mut();
    unsafe {
        win(
            windows_sys::Win32::System::Threading::OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY,
                &mut token,
            ),
            "Check administrator initialization token",
        )?;
    }
    let token = crate::Handle(token);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut length = 0;
    unsafe {
        win(
            GetTokenInformation(
                token.0,
                TokenElevation,
                &mut elevation as *mut _ as *mut c_void,
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut length,
            ),
            "Check explicit administrator elevation",
        )?;
    }
    if elevation.TokenIsElevated != 1 {
        return Err(
            "First network initialization must be explicitly launched as administrator".into(),
        );
    }
    // Only fresh identities owned by this application can be provisioned. The
    // elevated protocol accepts no profile SID, path, command, or environment.
    struct Created {
        profiles: Vec<Profile>,
        committed: bool,
    }
    impl Drop for Created {
        fn drop(&mut self) {
            if !self.committed {
                for profile in &self.profiles {
                    if let Ok(name) = profile_name(&profile.name) {
                        unsafe {
                            DeleteAppContainerProfile(name.as_ptr());
                        }
                    }
                }
            }
        }
    }
    let mut created = Created {
        profiles: vec![],
        committed: false,
    };
    for _ in 0..16 {
        let mut guid = GUID::default();
        let status = unsafe { UuidCreate(&mut guid) };
        if status != 0 && status != 1824 {
            return Err("Generate fresh isolation identity failed".into());
        }
        let name = format!(
            "Yuantu.Sandbox.{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            guid.data1,
            guid.data2,
            guid.data3,
            guid.data4[0],
            guid.data4[1],
            guid.data4[2],
            guid.data4[3],
            guid.data4[4],
            guid.data4[5],
            guid.data4[6],
            guid.data4[7]
        );
        let wide = profile_name(&name)?;
        let mut sid = null_mut();
        let hr = unsafe {
            CreateAppContainerProfile(
                wide.as_ptr(),
                wide.as_ptr(),
                wide.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if hr < 0 {
            return Err(format!("Create fresh initialization identity: {hr:#x}"));
        }
        let sid = Sid(sid);
        // Record creation before any subsequent fallible validation/serialization.
        created.profiles.push(Profile {
            name,
            sid: String::new(),
        });
        created.profiles.last_mut().unwrap().sid = sid_text(sid.0)?;
    }
    let inventory = Inventory {
        version: 1,
        profiles: created
            .profiles
            .iter()
            .map(|profile| Profile {
                name: profile.name.clone(),
                sid: profile.sid.clone(),
            })
            .collect(),
    };
    install_inventory(&inventory)?;
    created.committed = true;
    Ok(())
}

fn install_inventory(inventory: &Inventory) -> Result<()> {
    inventory.validate()?;
    let engine = engine()?;
    unsafe {
        code(
            FwpmTransactionBegin0(engine.0, 0),
            "Begin network initialization transaction",
        )?;
    }
    let mut transaction = Transaction(&engine, false);
    let security = descriptor()?;
    let mut provider_key = PROVIDER;
    let mut title = wide("YuanTu native sandbox network denial v1")?;
    let mut payload =
        serde_json::to_vec(inventory).map_err(|_| "Serialize isolation inventory failed")?;
    let provider = FWPM_PROVIDER0 {
        providerKey: PROVIDER,
        displayData: FWPM_DISPLAY_DATA0 {
            name: title.as_mut_ptr(),
            description: title.as_mut_ptr(),
        },
        flags: FWPM_PROVIDER_FLAG_PERSISTENT,
        providerData: FWP_BYTE_BLOB {
            size: payload.len() as u32,
            data: payload.as_mut_ptr(),
        },
        ..Default::default()
    };
    // Existing identities are never overwritten. Failed/duplicate installation
    // aborts the entire native transaction, including all new provider objects.
    unsafe {
        code(
            FwpmProviderAdd0(engine.0, &provider, security.0),
            "Install protected network provider",
        )?;
    }
    let layer = FWPM_SUBLAYER0 {
        subLayerKey: SUBLAYER,
        displayData: provider.displayData,
        flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
        providerKey: &mut provider_key,
        weight: u16::MAX,
        ..Default::default()
    };
    unsafe {
        code(
            FwpmSubLayerAdd0(engine.0, &layer, security.0),
            "Install protected network sublayer",
        )?;
    }
    for (index, profile) in inventory.profiles.iter().enumerate() {
        let sid = derive(&profile.name)?;
        let mut condition = FWPM_FILTER_CONDITION0 {
            fieldKey: FWPM_CONDITION_ALE_PACKAGE_ID,
            matchType: FWP_MATCH_EQUAL,
            conditionValue: FWP_CONDITION_VALUE0 {
                r#type: FWP_SID,
                Anonymous: FWP_CONDITION_VALUE0_0 {
                    sid: sid.0 as *mut SID,
                },
            },
        };
        for (offset, layer) in LAYERS.iter().enumerate() {
            let filter = FWPM_FILTER0 {
                filterKey: key(index, offset),
                displayData: provider.displayData,
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
            unsafe {
                code(
                    FwpmFilterAdd0(engine.0, &filter, security.0, null_mut()),
                    "Install identity-bound IPv4/IPv6 deny filter",
                )?;
            }
        }
    }
    unsafe {
        code(
            FwpmTransactionCommit0(engine.0),
            "Commit network initialization transaction",
        )?;
    }
    transaction.1 = true;
    Ok(())
}

fn same_guid(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
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

pub fn status() -> Result<Inventory> {
    let engine = engine()?;
    verify_security(&engine, &PROVIDER, FwpmProviderGetSecurityInfoByKey0)?;
    verify_security(&engine, &SUBLAYER, FwpmSubLayerGetSecurityInfoByKey0)?;
    let mut provider = null_mut();
    unsafe {
        code(
            FwpmProviderGetByKey0(engine.0, &PROVIDER, &mut provider),
            "Read installed network identity inventory",
        )?;
    }
    let provider = WfpMemory(provider);
    let value = unsafe { &*provider.0 };
    if value.flags != FWPM_PROVIDER_FLAG_PERSISTENT
        || value.providerData.size == 0
        || value.providerData.size > 65536
        || value.providerData.data.is_null()
    {
        return Err("Installed network inventory has an invalid schema".into());
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(value.providerData.data, value.providerData.size as usize)
    };
    let inventory: Inventory =
        serde_json::from_slice(bytes).map_err(|_| "Installed network inventory is invalid")?;
    inventory.validate()?;
    let mut sublayer = null_mut();
    unsafe {
        code(
            FwpmSubLayerGetByKey0(engine.0, &SUBLAYER, &mut sublayer),
            "Read installed network sublayer",
        )?;
    }
    let sublayer = WfpMemory(sublayer);
    let value = unsafe { &*sublayer.0 };
    if value.flags != FWPM_SUBLAYER_FLAG_PERSISTENT
        || value.providerKey.is_null()
        || !same_guid(unsafe { &*value.providerKey }, &PROVIDER)
        || value.weight != u16::MAX
    {
        return Err("Installed network sublayer differs from the supported policy".into());
    }
    for (index, profile) in inventory.profiles.iter().enumerate() {
        let sid = derive(&profile.name)?;
        for (offset, layer) in LAYERS.iter().enumerate() {
            verify_security(
                &engine,
                &key(index, offset),
                FwpmFilterGetSecurityInfoByKey0,
            )?;
            let mut filter = null_mut();
            unsafe {
                code(
                    FwpmFilterGetByKey0(engine.0, &key(index, offset), &mut filter),
                    "Read active identity-bound deny filter",
                )?;
            }
            let filter = WfpMemory(filter);
            let value = unsafe { &*filter.0 };
            if value.flags != FWPM_FILTER_FLAG_PERSISTENT
                || value.providerKey.is_null()
                || !same_guid(unsafe { &*value.providerKey }, &PROVIDER)
                || !same_guid(&value.subLayerKey, &SUBLAYER)
                || !same_guid(&value.layerKey, layer)
                || value.action.r#type != FWP_ACTION_BLOCK
                || value.numFilterConditions != 1
                || value.filterCondition.is_null()
                || value.weight.r#type != FWP_UINT8
                || unsafe { value.weight.Anonymous.uint8 } != 15
            {
                return Err("Active network deny filter differs from the installed schema".into());
            }
            let condition = unsafe { &*value.filterCondition };
            if !same_guid(&condition.fieldKey, &FWPM_CONDITION_ALE_PACKAGE_ID)
                || condition.matchType != FWP_MATCH_EQUAL
                || condition.conditionValue.r#type != FWP_SID
                || unsafe {
                    condition.conditionValue.Anonymous.sid.is_null()
                        || EqualSid(condition.conditionValue.Anonymous.sid as PSID, sid.0) == 0
                }
            {
                return Err(
                    "Active network deny filter does not match its sandbox identity".into(),
                );
            }
        }
    }
    Ok(inventory)
}

pub fn require_profile(name: &str) -> Result<()> {
    if !status()?
        .profiles
        .iter()
        .any(|profile| profile.name == name)
    {
        return Err("This sandbox identity has no installed network deny policy".into());
    }
    Ok(())
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
    #[test]
    fn no_duplicate_filter_keys_across_profile_pool_or_families() {
        let mut keys = std::collections::HashSet::new();
        for profile in 0..16 {
            for layer in 0..8 {
                let key = key(profile, layer);
                assert!(keys.insert((key.data1, key.data2, key.data3, key.data4)));
            }
        }
    }
    #[test]
    fn empty_or_unknown_inventory_is_refused_before_system_mutation() {
        assert!(
            Inventory {
                version: 1,
                profiles: vec![]
            }
            .validate()
            .is_err()
        );
        assert!(
            serde_json::from_str::<Inventory>(r#"{"version":1,"profiles":[],"command":"cmd.exe"}"#)
                .is_err()
        );
    }
    #[test]
    fn development_initializer_refuses_before_any_wfp_mutation() {
        if option_env!("YUANTU_WINDOWS_SANDBOX_SIGNER_SHA256").is_none() {
            assert!(verify_release().unwrap_err().contains("pinned signer"));
        }
    }
}
