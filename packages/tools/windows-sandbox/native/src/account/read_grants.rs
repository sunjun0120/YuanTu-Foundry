//! Read allowlist. Validate and lock the entire tree before changing any DACL; journal before applying.
//! Use handle security APIs so inheritance cannot walk unvalidated descendants during a grant/revoke.
//!
//! Two grant shapes share one journal. A **snapshot** grant (`mode: snapshot`) validates and locks every existing
//! object and gives each one a non-inheriting group RX ACE: nothing created later is readable, which is what a
//! path the user picked needs. An **auto** grant (`source: auto`, `mode: inherit`) is one inheritable RX ACE on the
//! root of a discovered toolchain directory, kept to a fixed set of credential files by an explicit deny: a
//! toolchain root is re-validated by a targeted check instead of a full tree walk, so refresh can run before every
//! first command.
use super::{Sid, sid};
use crate::{Handle, Result, wide, win};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::c_void,
    io::Write,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
};

pub const READ_EXECUTE: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
const TRAVERSE_METADATA: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES;
/// A copy of an ACE placed on a child object by inheritance. It is not ours to remove from the child.
const INHERITED_ACE_FLAG: u32 = 0x10;
const MAX_OBJECTS: usize = 100_000;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
const SECRET_NAMES: &[&str] = &[
    ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".yuantu", ".codex",
];
const PROFILE_SECRETS: &[&str] = &[
    r"AppData\Roaming\Microsoft\Credentials",
    r"AppData\Local\Microsoft\Credentials",
    r"AppData\Roaming\Microsoft\Protect",
    r"AppData\Local\Microsoft\Protect",
    r"AppData\Local\Microsoft\Vault",
    r"AppData\Roaming\Microsoft\Vault",
    r"AppData\Local\Google\Chrome",
    r"AppData\Local\Microsoft\Edge",
    r"AppData\Roaming\Mozilla",
    r"AppData\Local\Mozilla",
    r"AppData\Roaming\Opera Software",
    r"AppData\Local\BraveSoftware",
    r"AppData\Local\Chromium",
    r"AppData\Roaming\YuanTu Agent",
    r"AppData\Local\YuanTu Agent",
];
/// Credential files, relative to the profile or to an automatically granted root. A path equal to one of these,
/// below one, or above one is never granted, and each one that exists inside an auto root gets an explicit deny.
pub const CREDENTIAL_FILES: &[&str] = &[
    r".cargo\credentials.toml",
    r".cargo\credentials",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    r".docker\config.json",
];
/// The file names distinctive enough to deny wherever they appear inside a granted root. `credentials` and
/// `config.json` are not here: they are ordinary names for a toolchain, and only their `.cargo` / `.docker` paths
/// are credentials.
const CREDENTIAL_NAMES: &[&str] = &[
    "credentials.toml",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
];
/// Groups whose read access makes a grant unnecessary: the system directory is already open to everyone.
const BROAD_READERS: &[&str] = &["S-1-5-32-545", "S-1-5-11", "S-1-1-0"];

pub(crate) fn key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}
pub(crate) fn under(path: &str, parent: &str) -> bool {
    path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|tail| tail.starts_with('\\'))
}
pub fn allowed(path: &Path, profile: &Path) -> bool {
    let value = key(path);
    if !path.is_absolute()
        || value.starts_with(r"\\")
        || value.len() <= 3
        || value[2..].contains(':')
    {
        return false;
    }
    if value.split('\\').any(|part| SECRET_NAMES.contains(&part)) {
        return false;
    }
    let denied = SECRET_NAMES
        .iter()
        .map(|name| profile.join(name))
        .chain(PROFILE_SECRETS.iter().map(|name| profile.join(name)))
        .chain(CREDENTIAL_FILES.iter().map(|name| profile.join(name)));
    !denied.into_iter().any(|denied| {
        let denied = key(&denied);
        under(&value, &denied) || under(&denied, &value)
    })
}

struct Object {
    path: PathBuf,
    handle: Handle,
    directory: bool,
    volume: u32,
    id: u64,
    created: u64,
}
fn open(path: &Path, profile: &Path) -> Result<Object> {
    if !allowed(path, profile) {
        return Err("Read allowlist path intersects a protected location".into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| "Resolve read allowlist path")?;
    if key(&canonical) != key(path) || !allowed(&canonical, profile) {
        return Err("Read allowlist requires a canonical path without aliases".into());
    }
    // Reject a junction in any ancestor, not merely at the requested root.
    for ancestor in path.ancestors() {
        let meta =
            std::fs::symlink_metadata(ancestor).map_err(|_| "Inspect read allowlist ancestor")?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Read allowlist refuses reparse points".into());
        }
    }
    open_object(path)
}
/// A path inside a granted root that must be *denied*: the read policy refuses some of these names by design, so
/// the policy check is skipped, but the alias check is not.
fn guarded(path: &Path) -> Result<Object> {
    let canonical = std::fs::canonicalize(path).map_err(|_| "Resolve credential path")?;
    let text = canonical.to_string_lossy();
    let canonical = PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text));
    if key(&canonical) != key(path) {
        return Err("Credential path must not be an alias".into());
    }
    open_object_links(&canonical, false)
}
fn open_object(path: &Path) -> Result<Object> {
    open_object_links(path, true)
}
fn open_object_links(path: &Path, refuse_links: bool) -> Result<Object> {
    let name = wide(path.to_str().ok_or("Invalid allowlist path")?)?;
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err("Lock read allowlist object failed".into());
    }
    let handle = Handle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "Inspect allowlist object",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (refuse_links && info.nNumberOfLinks > 1)
    {
        return Err("Read allowlist refuses reparse points and hard links".into());
    }
    Ok(Object {
        path: path.to_path_buf(),
        handle,
        directory: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        volume: info.dwVolumeSerialNumber,
        id: (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64,
        created: (info.ftCreationTime.dwHighDateTime as u64) << 32
            | info.ftCreationTime.dwLowDateTime as u64,
    })
}
fn walk(root: &Path, profile: &Path) -> Result<Vec<Object>> {
    let mut pending = vec![root.to_path_buf()];
    let mut objects = Vec::new();
    while let Some(path) = pending.pop() {
        if objects.len() + pending.len() >= MAX_OBJECTS {
            return Err("Read allowlist exceeds 100000 objects".into());
        }
        let object = open(&path, profile)?;
        if object.directory {
            for entry in std::fs::read_dir(&path).map_err(|_| "Enumerate read allowlist")? {
                pending.push(entry.map_err(|_| "Enumerate read allowlist entry")?.path());
                if objects.len() + pending.len() > MAX_OBJECTS {
                    return Err("Read allowlist exceeds 100000 objects".into());
                }
            }
        }
        objects.push(object);
    }
    Ok(objects)
}

struct Descriptor(Vec<usize>);
impl Descriptor {
    fn pointer(&self) -> PSECURITY_DESCRIPTOR {
        self.0.as_ptr() as *mut c_void
    }
    fn dacl(&self) -> Result<*mut ACL> {
        let (mut present, mut defaulted, mut acl) = (0, 0, null_mut());
        win(
            unsafe {
                GetSecurityDescriptorDacl(self.pointer(), &mut present, &mut acl, &mut defaulted)
            },
            "Read allowlist DACL",
        )?;
        if present == 0 || acl.is_null() {
            return Err("Allowlist refuses a missing DACL".into());
        }
        Ok(acl)
    }
}
fn descriptor(object: &Object) -> Result<Descriptor> {
    let mut size = 0;
    unsafe {
        GetKernelObjectSecurity(
            object.handle.0,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            0,
            &mut size,
        )
    };
    if size == 0 {
        return Err("Read allowlist permissions failed".into());
    }
    let mut data = Descriptor(vec![
        0;
        (size as usize).div_ceil(std::mem::size_of::<usize>())
    ]);
    win(
        unsafe {
            GetKernelObjectSecurity(
                object.handle.0,
                DACL_SECURITY_INFORMATION,
                data.0.as_mut_ptr() as _,
                size,
                &mut size,
            )
        },
        "Read allowlist permissions",
    )?;
    Ok(data)
}
fn sddl(descriptor: &Descriptor) -> Result<String> {
    let (mut text, mut length) = (null_mut(), 0);
    win(
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor.pointer(),
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                &mut length,
            )
        },
        "Serialize allowlist permissions",
    )?;
    let value = String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(text, length.saturating_sub(1) as usize)
    });
    unsafe { LocalFree(text as _) };
    Ok(value)
}
/// Every ACE whose trustee is `group`, as `(allowed, mask, flags)`.
fn group_ace_list(acl: *mut ACL, group: &Sid) -> Result<Vec<(bool, u32, u32)>> {
    let mut aces = Vec::new();
    for index in 0..unsafe { (*acl).AceCount } as u32 {
        let mut ace = null_mut();
        win(
            unsafe { GetAce(acl, index, &mut ace) },
            "Inspect allowlist ACE",
        )?;
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE && header.AceType != ACCESS_DENIED_ACE_TYPE {
            continue;
        }
        let access = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        if unsafe { EqualSid(&access.SidStart as *const _ as _, group.0) } != 0 {
            aces.push((
                header.AceType == ACCESS_ALLOWED_ACE_TYPE,
                access.Mask,
                header.AceFlags as u32,
            ));
        }
    }
    Ok(aces)
}
/// The group's ACEs that this object owns rather than inherits: only those may be judged or removed here.
fn explicit_aces(aces: Vec<(bool, u32, u32)>) -> Vec<(bool, u32, u32)> {
    aces.into_iter()
        .filter(|(_, _, flags)| flags & INHERITED_ACE_FLAG == 0)
        .collect()
}
fn group_aces(acl: *mut ACL, group: &Sid) -> Result<Vec<u32>> {
    let mut rights = Vec::new();
    for (allowed, mask, _) in group_ace_list(acl, group)? {
        if !allowed {
            return Err("Conflicting allowlist deny ACE".into());
        }
        rights.push(mask);
    }
    Ok(rights)
}
fn apply_acl(
    object: &Object,
    acl: *const ACL,
    original: &Descriptor,
    propagate: bool,
) -> Result<()> {
    let (mut control, mut revision) = (0, 0);
    win(
        unsafe { GetSecurityDescriptorControl(original.pointer(), &mut control, &mut revision) },
        "Read allowlist inheritance",
    )?;
    if propagate {
        // Only the auto-inheritance API re-derives the inherited ACEs of existing children: that is how an
        // inheritable root grant reaches files that were there before the refresh, and how its revoke clears them.
        // It walks the whole subtree, so the per-object snapshot writes below stay on the plain handle write.
        let protection = if control & SE_DACL_PROTECTED != 0 {
            PROTECTED_DACL_SECURITY_INFORMATION
        } else {
            UNPROTECTED_DACL_SECURITY_INFORMATION
        };
        let status = unsafe {
            SetSecurityInfo(
                object.handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | protection,
                null_mut(),
                null_mut(),
                acl,
                null(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Apply inheritable allowlist permissions: Windows error {status}"
            ));
        }
        return Ok(());
    }
    let mut updated = SECURITY_DESCRIPTOR::default();
    win(
        unsafe {
            InitializeSecurityDescriptor(&mut updated as *mut _ as _, SECURITY_DESCRIPTOR_REVISION)
        },
        "Initialize allowlist descriptor",
    )?;
    win(
        unsafe { SetSecurityDescriptorDacl(&mut updated as *mut _ as _, 1, acl as *mut ACL, 0) },
        "Set allowlist DACL",
    )?;
    win(
        unsafe {
            SetSecurityDescriptorControl(
                &mut updated as *mut _ as _,
                SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED,
                control & (SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED),
            )
        },
        "Preserve allowlist inheritance",
    )?;
    win(
        unsafe {
            SetKernelObjectSecurity(
                object.handle.0,
                DACL_SECURITY_INFORMATION,
                &updated as *const _ as _,
            )
        },
        "Apply allowlist permissions",
    )
}
/// Adds one explicit ACE for the group. `inheritance` 0 is the snapshot shape: a credential subtree created later
/// must never become readable just because an ancestor was granted.
fn add_ace(object: &Object, group: &Sid, rights: u32, inheritance: u32, deny: bool) -> Result<()> {
    let original = descriptor(object)?;
    let acl = original.dacl()?;
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: rights,
        grfAccessMode: if deny { DENY_ACCESS } else { GRANT_ACCESS },
        grfInheritance: inheritance,
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: group.0 as _,
            ..Default::default()
        },
    };
    let mut merged = null_mut();
    let status = unsafe { SetEntriesInAclW(1, &entry, acl, &mut merged) };
    if status != ERROR_SUCCESS {
        return Err("Merge allowlist permissions failed".into());
    }
    let result = apply_acl(object, merged, &original, inheritance != 0);
    unsafe { LocalFree(merged as _) };
    result
}
/// Removes every ACE the group owns on this object, leaving other trustees byte-for-byte. `remove_denies` also
/// withdraws a credential denial, which only a full revoke does.
fn remove_aces(object: &Object, group: &Sid, remove_denies: bool) -> Result<()> {
    let original = descriptor(object)?;
    let acl = original.dacl()?;
    let mut filtered = Vec::<u32>::new();
    filtered.resize((unsafe { (*acl).AclSize } as usize).div_ceil(4), 0);
    let merged = filtered.as_mut_ptr() as *mut ACL;
    win(
        unsafe { InitializeAcl(merged, (filtered.len() * 4) as u32, 2) },
        "Initialize revoked allowlist ACL",
    )?;
    let mut propagate = false;
    for index in 0..unsafe { (*acl).AceCount } as u32 {
        let mut ace = null_mut();
        win(
            unsafe { GetAce(acl, index, &mut ace) },
            "Read revoked allowlist ACE",
        )?;
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        let ours_type = header.AceType == ACCESS_ALLOWED_ACE_TYPE
            || (remove_denies && header.AceType == ACCESS_DENIED_ACE_TYPE);
        let ours = ours_type
            && unsafe {
                EqualSid(
                    &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const _ as _,
                    group.0,
                )
            } != 0;
        if ours {
            // Withdrawing an inheritable ACE must also clear the copies its children inherited.
            propagate |= header.AceFlags as u32 & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) != 0
                && header.AceFlags as u32 & INHERITED_ACE_FLAG == 0;
            continue;
        }
        win(
            unsafe { AddAce(merged, 2, u32::MAX, ace, header.AceSize as u32) },
            "Preserve other allowlist ACEs",
        )?;
    }
    apply_acl(object, merged, &original, propagate)
}

/// Who owns a read root: the automatic discovery, or a path the user added.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Auto,
    User,
}
/// How the root is granted: one inheritable ACE on the root, or a snapshot of every object that existed.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    Inherit,
    Snapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Entry {
    pub(crate) path: PathBuf,
    before: String,
    volume: u32,
    id: u64,
    created: u64,
}

/// Reopen the recorded object itself, including after a same-volume move. Never follow its new name or links.
fn recorded(entry: &Entry) -> Result<Option<Object>> {
    let volume = entry
        .path
        .ancestors()
        .last()
        .ok_or("Missing allowlist volume")?;
    let name = wide(volume.to_str().ok_or("Invalid allowlist volume")?)?;
    let hint = unsafe {
        CreateFileW(
            name.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if hint == INVALID_HANDLE_VALUE {
        return Err("Cannot open recorded allowlist volume; recovery retained".into());
    }
    let hint = Handle(hint);
    let mut hint_info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(hint.0, &mut hint_info) },
        "Inspect allowlist volume",
    )?;
    if hint_info.dwVolumeSerialNumber != entry.volume {
        return Err("Allowlist volume identity changed; recovery retained".into());
    }
    let identity = FILE_ID_DESCRIPTOR {
        dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
        Type: FileIdType,
        Anonymous: FILE_ID_DESCRIPTOR_0 {
            FileId: entry.id as i64,
        },
    };
    let raw = unsafe {
        OpenFileById(
            hint.0,
            &identity,
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            null(),
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        let error = unsafe { GetLastError() };
        // NTFS answers a file id that no longer exists with ERROR_INVALID_PARAMETER, not ERROR_FILE_NOT_FOUND.
        if error == ERROR_FILE_NOT_FOUND || error == ERROR_INVALID_PARAMETER {
            return Ok(None);
        }
        return Err(format!(
            "Cannot reopen allowlist object by identity ({error}); recovery retained"
        ));
    }
    let handle = Handle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "Verify recorded allowlist identity",
    )?;
    let id = (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64;
    let created = (info.ftCreationTime.dwHighDateTime as u64) << 32
        | info.ftCreationTime.dwLowDateTime as u64;
    if info.dwVolumeSerialNumber != entry.volume || id != entry.id || created != entry.created {
        return Err("Recorded allowlist object was replaced; recovery retained".into());
    }
    Ok(Some(Object {
        path: entry.path.clone(),
        handle,
        directory: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        volume: entry.volume,
        id,
        created,
    }))
}
fn entry(object: &Object) -> Result<Entry> {
    let entry = Entry {
        path: object.path.clone(),
        before: sddl(&descriptor(object)?)?,
        volume: object.volume,
        id: object.id,
        created: object.created,
    };
    if recorded(&entry)?.is_none() {
        return Err("Read allowlist object cannot be recovered by identity".into());
    }
    Ok(entry)
}
fn same_object(entry: &Entry, other: &Entry) -> bool {
    entry.volume == other.volume && entry.id == other.id && entry.created == other.created
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadGrant {
    pub(crate) root: PathBuf,
    pub(crate) group: String,
    pub(crate) source: Source,
    pub(crate) mode: Mode,
    /// The root itself first, then every object a snapshot grant locked (empty for `inherit`).
    pub(crate) entries: Vec<Entry>,
    /// Credential files inside an `inherit` root that carry the group's explicit deny.
    pub(crate) guards: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Journal {
    pub(crate) version: u32,
    pub(crate) grants: Vec<ReadGrant>,
}

/// The pre-`source`/`mode` journal: every grant was a user snapshot.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalV1 {
    version: u32,
    grants: Vec<ReadGrantV1>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadGrantV1 {
    root: PathBuf,
    group: String,
    entries: Vec<Entry>,
}

fn empty_journal() -> Journal {
    Journal {
        version: 2,
        grants: Vec::new(),
    }
}

pub(crate) fn load(path: &Path) -> Result<Journal> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid read allowlist journal")?;
            match value.get("version").and_then(serde_json::Value::as_u64) {
                Some(1) => {
                    let old: JournalV1 = serde_json::from_value(value)
                        .map_err(|_| "Invalid read allowlist journal")?;
                    if old.version != 1 {
                        return Err("Unsupported read allowlist journal".into());
                    }
                    Ok(Journal {
                        version: 2,
                        grants: old
                            .grants
                            .into_iter()
                            .map(|grant| ReadGrant {
                                root: grant.root,
                                group: grant.group,
                                source: Source::User,
                                mode: Mode::Snapshot,
                                entries: grant.entries,
                                guards: Vec::new(),
                            })
                            .collect(),
                    })
                }
                Some(2) => serde_json::from_value(value)
                    .map_err(|_| "Invalid read allowlist journal".into()),
                _ => Err("Unsupported read allowlist journal".into()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_journal()),
        Err(_) => Err("Read allowlist journal failed".into()),
    }
}
pub(crate) fn save(path: &Path, journal: &Journal) -> Result<()> {
    std::fs::create_dir_all(path.parent().ok_or("Invalid read journal path")?)
        .map_err(|_| "Create read journal directory")?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = std::fs::File::create(&temporary).map_err(|_| "Create read journal")?;
    super::super::credentials::protect_path(&temporary)?;
    file.write_all(&serde_json::to_vec(journal).map_err(|_| "Serialize read journal")?)
        .map_err(|_| "Write read journal")?;
    file.sync_all().map_err(|_| "Flush read journal")?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|_| "Replace read journal failed".into())
}

pub(crate) fn journal_lock(path: &Path) -> Result<std::fs::File> {
    std::fs::create_dir_all(path.parent().ok_or("Invalid read journal path")?)
        .map_err(|_| "Create read journal directory")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(0)
            .access_mode(DELETE | FILE_READ_DATA | FILE_WRITE_DATA)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path.with_extension("lock"))
        {
            Ok(file) => return Ok(file),
            Err(error)
                if matches!(error.raw_os_error(), Some(5 | 32 | 33 | 303))
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => {
                return Err(format!(
                    "Cannot acquire sandbox grant journal lock: {error}"
                ));
            }
        }
    }
}

/// A snapshot grant of every object that exists under `root` right now.
pub(crate) fn grant_snapshot_locked(
    root: &Path,
    profile: &Path,
    group: &str,
    source: Source,
    journal: &mut Journal,
    journal_path: &Path,
) -> Result<()> {
    if journal
        .grants
        .iter()
        .any(|g| g.group == group && g.mode == Mode::Inherit && under(&key(root), &key(&g.root)))
    {
        return Err("Path is already readable through an automatic read root".into());
    }
    if super::super::ssh_config::dependencies(profile)
        .iter()
        .any(|file| under(&key(file), &key(root)))
    {
        return Err("Path holds a file the SSH configuration uses".into());
    }
    let existing = journal.grants.iter().position(|g| {
        g.group == group && g.mode == Mode::Snapshot && under(&key(root), &key(&g.root))
    });
    let objects = walk(root, profile)?;
    let group_sid = sid(group)?;
    let mut entries = Vec::new();
    for object in &objects {
        let descriptor = descriptor(object)?;
        let rights = group_aces(descriptor.dacl()?, &group_sid)?;
        if (!rights.is_empty() && existing.is_none())
            || rights.iter().any(|mask| *mask != READ_EXECUTE)
        {
            return Err("Read allowlist has an unrecorded or widened sandbox group grant".into());
        }
        let entry = Entry {
            path: object.path.clone(),
            before: sddl(&descriptor)?,
            volume: object.volume,
            id: object.id,
            created: object.created,
        };
        if recorded(&entry)?.is_none() {
            return Err("Read allowlist object cannot be recovered by identity".into());
        }
        entries.push(entry);
    }
    if let Some(index) = existing {
        for entry in entries {
            if !journal.grants[index]
                .entries
                .iter()
                .any(|known| same_object(known, &entry))
            {
                journal.grants[index].entries.push(entry);
            }
        }
    } else {
        journal.grants.push(ReadGrant {
            root: root.to_path_buf(),
            group: group.into(),
            source,
            mode: Mode::Snapshot,
            entries,
            guards: Vec::new(),
        });
    }
    save(journal_path, journal)?; // durable intent BEFORE the first ACL change, including partial failures
    for object in &objects {
        if group_aces(descriptor(object)?.dacl()?, &group_sid)?.is_empty() {
            add_ace(object, &group_sid, READ_EXECUTE, 0, false)?;
        }
    }
    Ok(())
}

pub(crate) fn grant_at(
    root: &Path,
    profile: &Path,
    group: &str,
    journal_path: &Path,
) -> Result<()> {
    let _lock = journal_lock(journal_path)?;
    let mut journal = load(journal_path)?;
    grant_snapshot_locked(
        root,
        profile,
        group,
        Source::User,
        &mut journal,
        journal_path,
    )
}

/// One inheritable RX ACE on a discovered toolchain root. Answers `false` when a broad group can already read it,
/// in which case nothing is recorded and no ACE is added.
pub(crate) fn grant_inherit_locked(
    root: &Path,
    profile: &Path,
    group: &str,
    journal: &mut Journal,
    journal_path: &Path,
) -> Result<bool> {
    let object = open(root, profile)?;
    if !object.directory {
        return Err("A read root must be a directory".into());
    }
    let group_sid = sid(group)?;
    let descriptor = descriptor(&object)?;
    let acl = descriptor.dacl()?;
    if broadly_readable(acl)? {
        return Ok(false);
    }
    let inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    let aces = explicit_aces(group_ace_list(acl, &group_sid)?);
    let matches = |(allowed, mask, flags): &(bool, u32, u32)| {
        *allowed && *mask == READ_EXECUTE && flags & inherit == inherit
    };
    if aces.iter().any(matches) {
        // Idempotent, but the journal may be missing the entry after a manual state reset: record it.
        record_inherit_root(root, group, &object, journal)?;
        save(journal_path, journal)?;
        return Ok(true);
    }
    if !aces.is_empty() {
        return Err("Read root has a conflicting sandbox group grant".into());
    }
    record_inherit_root(root, group, &object, journal)?;
    save(journal_path, journal)?; // durable intent BEFORE the ACL change
    add_ace(&object, &group_sid, READ_EXECUTE, inherit, false)?;
    // The traverse journal sits beside the read journal (`metadata_path`), so a test's journals stay together.
    grant_metadata_at(
        root,
        profile,
        group,
        &journal_path.with_file_name("traverse-grants.json"),
    )?;
    Ok(true)
}

fn record_inherit_root(
    root: &Path,
    group: &str,
    object: &Object,
    journal: &mut Journal,
) -> Result<()> {
    let entry = entry(object)?;
    match journal.grants.iter_mut().find(|grant| {
        grant.group == group && grant.mode == Mode::Inherit && key(&grant.root) == key(root)
    }) {
        Some(grant) => {
            // A recreated root has a new identity, and the denials recorded for the old one no longer apply.
            if grant
                .entries
                .first()
                .is_none_or(|known| !same_object(known, &entry))
            {
                grant.entries = vec![entry];
                grant.guards.clear();
            }
        }
        None => journal.grants.push(ReadGrant {
            root: root.to_path_buf(),
            group: group.into(),
            source: Source::Auto,
            mode: Mode::Inherit,
            entries: vec![entry],
            guards: Vec::new(),
        }),
    }
    Ok(())
}

/// Skips a root that `Users`, `Authenticated Users` or `Everyone` can already read, like Codex does: adding an ACE
/// to the Windows directory would widen what is already open, and the discovery list never names it anyway.
fn broadly_readable(acl: *mut ACL) -> Result<bool> {
    for broad in BROAD_READERS {
        let broad = sid(broad)?;
        for (allowed, mask, _) in group_ace_list(acl, &broad)? {
            if allowed && mask & READ_EXECUTE == READ_EXECUTE {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// The credential files `guard_credentials_locked` denies under one root: the fixed relative paths, plus the
/// distinctive names wherever they appear inside the root.
fn guard_paths(root: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = CREDENTIAL_FILES
        .iter()
        .map(|name| root.join(name))
        .collect();
    paths.extend(CREDENTIAL_NAMES.iter().map(|name| root.join(name)));
    paths.sort();
    paths.dedup();
    paths
}

/// Deny the group read access to every credential file that exists under an automatically granted root.
///
/// A root that cannot be fully guarded is withdrawn instead of left partly readable: the caller skips it and the
/// command falls back to the toolchains that need no read access at all.
pub(crate) fn guard_credentials_locked(
    root: &Path,
    group: &str,
    journal: &mut Journal,
    journal_path: &Path,
) -> Result<()> {
    match guard_credentials_inner(root, group, journal, journal_path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let index = journal.grants.iter().position(|grant| {
                grant.group == group && grant.mode == Mode::Inherit && key(&grant.root) == key(root)
            });
            if let Some(index) = index {
                if let Err(withdraw) = revoke_inherit_locked(index, group, journal, journal_path) {
                    return Err(format!("{error}; withdrawal also failed: {withdraw}"));
                }
            }
            Err(error)
        }
    }
}
fn guard_credentials_inner(
    root: &Path,
    group: &str,
    journal: &mut Journal,
    journal_path: &Path,
) -> Result<()> {
    let Some(index) = journal.grants.iter().position(|grant| {
        grant.group == group && grant.mode == Mode::Inherit && key(&grant.root) == key(root)
    }) else {
        return Err("Read root is not recorded".into());
    };
    let group_sid = sid(group)?;
    let mut additions: Vec<Entry> = Vec::new();
    let mut objects: Vec<Object> = Vec::new();
    for path in guard_paths(root) {
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        // Anything else under a credential name (a directory, a link) cannot take a file denial, and whatever it
        // holds would stay readable through the root's inheritance.
        if !meta.is_file() {
            return Err("Credential path is not a regular file".into());
        }
        let object = guarded(&path)?;
        let descriptor = descriptor(&object)?;
        let aces = explicit_aces(group_ace_list(descriptor.dacl()?, &group_sid)?);
        // An explicit deny for the group is idempotent: a second refresh adds nothing.
        if aces.iter().any(|(allowed, mask, flags)| {
            !*allowed && *mask & READ_EXECUTE == READ_EXECUTE && *flags == 0
        }) {
            continue;
        }
        if !aces.is_empty() {
            return Err("Credential file has a conflicting sandbox group grant".into());
        }
        let entry = Entry {
            path: object.path.clone(),
            before: sddl(&descriptor)?,
            volume: object.volume,
            id: object.id,
            created: object.created,
        };
        if recorded(&entry)?.is_none() {
            return Err("Credential file cannot be recovered by identity".into());
        }
        additions.push(entry);
        objects.push(object);
    }
    if objects.is_empty() {
        return Ok(());
    }
    for addition in additions {
        if !journal.grants[index]
            .guards
            .iter()
            .any(|known| same_object(known, &addition))
        {
            journal.grants[index].guards.push(addition);
        }
    }
    save(journal_path, journal)?; // durable intent BEFORE the first deny
    for object in &objects {
        add_ace(object, &group_sid, READ_EXECUTE, 0, true)?;
    }
    Ok(())
}

/// Withdraws one `inherit` grant by journal index: the root's ACE first, so inheritance stops before the explicit
/// denials are lifted.
pub(crate) fn revoke_inherit_locked(
    index: usize,
    group: &str,
    journal: &mut Journal,
    journal_path: &Path,
) -> Result<()> {
    let group_sid = sid(group)?;
    let inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    let grant = &journal.grants[index];
    let root_entry = grant
        .entries
        .first()
        .ok_or("Read root record is incomplete")?;
    let root_object = recorded(root_entry)?;
    if let Some(object) = &root_object {
        let aces = explicit_aces(group_ace_list(descriptor(object)?.dacl()?, &group_sid)?);
        if aces.iter().any(|(allowed, mask, flags)| {
            !*allowed || *mask != READ_EXECUTE || flags & inherit != inherit
        }) {
            return Err("Read root permissions changed; recovery requires review".into());
        }
    }
    let guards = grant
        .guards
        .iter()
        .map(|entry| Ok((recorded(entry)?, entry)))
        .collect::<Result<Vec<_>>>()?;
    for (object, _) in &guards {
        let Some(object) = object else { continue };
        let aces = explicit_aces(group_ace_list(descriptor(object)?.dacl()?, &group_sid)?);
        if aces.iter().any(|(allowed, mask, flags)| {
            *allowed || *mask & READ_EXECUTE != READ_EXECUTE || *flags != 0
        }) {
            return Err("Credential denial changed; recovery requires review".into());
        }
    }
    if let Some(object) = &root_object {
        remove_aces(object, &group_sid, true)?;
    }
    for (object, _) in &guards {
        if let Some(object) = object {
            remove_aces(object, &group_sid, true)?;
        }
    }
    journal.grants.remove(index);
    save(journal_path, journal)
}

fn revoke_snapshot_locked(
    index: usize,
    group: &Sid,
    rights: u32,
    journal: &mut Journal,
    journal_path: &Path,
) -> Result<()> {
    {
        // Recovery follows recorded identities, not a mutable tree walk. New unsafe paths are never traversed.
        let objects: Vec<Object> = journal.grants[index]
            .entries
            .iter()
            .map(recorded)
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        // Preflight the entire tree before revoking. Preserve independently added ACEs and retain the journal on conflict.
        for object in &objects {
            if group_aces(descriptor(object)?.dacl()?, group)?
                .iter()
                .any(|mask| *mask != rights)
            {
                return Err("Read allowlist permissions changed; recovery requires review".into());
            }
        }
        for object in &objects {
            remove_aces(object, group, false)?;
        }
    }
    journal.grants.remove(index);
    save(journal_path, journal)
}

/// Withdraws the `snapshot` grant for one root, if one is recorded. Used for the automatic `.gitconfig` entry,
/// which is a single file and therefore never inherits.
pub(crate) fn revoke_snapshot_at(
    root: &Path,
    group: &str,
    journal: &mut Journal,
    journal_path: &Path,
) -> Result<()> {
    let Some(index) = journal
        .grants
        .iter()
        .position(|grant| key(&grant.root) == key(root) && grant.group == group)
    else {
        return Ok(());
    };
    revoke_snapshot_locked(index, &sid(group)?, READ_EXECUTE, journal, journal_path)
}

pub(crate) fn revoke_at(
    root: &Path,
    _profile: &Path,
    group: &str,
    journal_path: &Path,
) -> Result<()> {
    let _lock = journal_lock(journal_path)?;
    let mut journal = load(journal_path)?;
    let Some(index) = journal
        .grants
        .iter()
        .position(|grant| key(&grant.root) == key(root) && grant.group == group)
    else {
        return Ok(());
    };
    if journal.grants[index].source == Source::Auto {
        return Err("Automatic read roots are managed by refresh".into());
    }
    revoke_snapshot_locked(
        index,
        &sid(group)?,
        READ_EXECUTE,
        &mut journal,
        journal_path,
    )
}

pub(crate) fn journal_path() -> Result<PathBuf> {
    Ok(super::super::credentials::state_directory()?.join("read-grants.json"))
}
pub fn grant(root: &Path, group: &str) -> Result<()> {
    grant_at(
        root,
        &super::super::credentials::profile_directory()?,
        group,
        &journal_path()?,
    )?;
    grant_metadata(root, group)
}
pub fn revoke(root: &Path, group: &str) -> Result<()> {
    revoke_at(
        root,
        &super::super::credentials::profile_directory()?,
        group,
        &journal_path()?,
    )
}
pub fn revoke_all() -> Result<()> {
    let path = journal_path()?;
    {
        let _lock = journal_lock(&path)?;
        let mut journal = load(&path)?;
        while !journal.grants.is_empty() {
            let group = journal.grants[0].group.clone();
            let mode = journal.grants[0].mode;
            match mode {
                Mode::Inherit => revoke_inherit_locked(0, &group, &mut journal, &path)?,
                Mode::Snapshot => {
                    revoke_snapshot_locked(0, &sid(&group)?, READ_EXECUTE, &mut journal, &path)?
                }
            }
        }
    }
    let metadata = metadata_path()?;
    for grant in load(&metadata)?.grants {
        revoke_metadata_at(&grant.root, &grant.group, &metadata)?;
    }
    Ok(())
}

pub(crate) fn metadata_path() -> Result<PathBuf> {
    Ok(super::super::credentials::state_directory()?.join("traverse-grants.json"))
}
pub fn grant_metadata(root: &Path, group: &str) -> Result<()> {
    grant_metadata_at(
        root,
        &super::super::credentials::profile_directory()?,
        group,
        &metadata_path()?,
    )
}
pub(crate) fn grant_metadata_at(
    root: &Path,
    profile: &Path,
    group: &str,
    journal_path: &Path,
) -> Result<()> {
    if !under(&key(root), &key(profile)) || key(root) == key(profile) {
        return Ok(());
    }
    let _lock = journal_lock(journal_path)?;
    let mut journal = load(journal_path)?;
    let existing = journal
        .grants
        .iter()
        .position(|grant| key(&grant.root) == key(profile) && grant.group == group);
    let mut recorded_ids: BTreeSet<(u32, u64, u64)> = existing
        .map(|index| {
            journal.grants[index]
                .entries
                .iter()
                .map(|entry| (entry.volume, entry.id, entry.created))
                .collect()
        })
        .unwrap_or_default();
    let group_sid = sid(group)?;
    let mut additions = Vec::new();
    let mut objects = Vec::new();
    for ancestor in root.parent().ok_or("Invalid metadata root")?.ancestors() {
        if !under(&key(ancestor), &key(profile)) {
            break;
        }
        let canonical = std::fs::canonicalize(ancestor).map_err(|_| "Resolve metadata ancestor")?;
        if key(&canonical) != key(ancestor) {
            return Err("Metadata ancestors must not be aliases".into());
        }
        let object = open_object(ancestor)?;
        if !object.directory {
            return Err("Metadata ancestor must be a directory".into());
        }
        let descriptor = descriptor(&object)?;
        let rights = group_aces(descriptor.dacl()?, &group_sid)?;
        if rights
            .iter()
            .any(|mask| *mask & TRAVERSE_METADATA == TRAVERSE_METADATA)
        {
            continue;
        }
        if !rights.is_empty() {
            return Err("Conflicting metadata ancestor permissions".into());
        }
        let entry = Entry {
            path: object.path.clone(),
            before: sddl(&descriptor)?,
            volume: object.volume,
            id: object.id,
            created: object.created,
        };
        if recorded(&entry)?.is_none() {
            return Err("Metadata ancestor cannot be recovered by identity".into());
        }
        if recorded_ids.insert((entry.volume, entry.id, entry.created)) {
            additions.push(entry);
        }
        objects.push(object);
    }
    if objects.is_empty() {
        return Ok(());
    }
    if let Some(index) = existing {
        journal.grants[index].entries.extend(additions);
    } else {
        journal.grants.push(ReadGrant {
            root: profile.to_path_buf(),
            group: group.into(),
            source: Source::User,
            mode: Mode::Snapshot,
            entries: additions,
            guards: Vec::new(),
        });
    }
    save(journal_path, &journal)?;
    for object in &objects {
        add_ace(object, &group_sid, TRAVERSE_METADATA, 0, false)?;
    }
    Ok(())
}
pub(crate) fn revoke_metadata_at(profile: &Path, group: &str, path: &Path) -> Result<()> {
    let _lock = journal_lock(path)?;
    let mut journal = load(path)?;
    let Some(index) = journal
        .grants
        .iter()
        .position(|grant| key(&grant.root) == key(profile) && grant.group == group)
    else {
        return Ok(());
    };
    revoke_snapshot_locked(index, &sid(group)?, TRAVERSE_METADATA, &mut journal, path)
}

/// A read root as the settings page shows it.
#[derive(Serialize, Debug)]
pub struct ReadRootView {
    pub path: String,
    pub source: Source,
}

/// Whether this process may write a DACL on `path`, which is what every grant below does.
///
/// A low-integrity token (an agent sandbox, a short-lived CI token) cannot: the tests that prove ACL behaviour skip
/// on that answer, and the production path reports the same refusal as a skipped read root instead of a failure.
#[cfg(test)]
pub(crate) fn may_change_dacl(path: &Path) -> bool {
    open_object(path).is_ok()
}

/// Gives a test directory the DACL of a real `%USERPROFILE%`: protected, and only SYSTEM, Administrators and the
/// desktop user, all inheritable. Without it the directory inherits whatever its drive grants, and a data drive
/// that lets `Users` read everything makes every root look broadly readable, so no grant is ever made.
#[cfg(test)]
pub(crate) fn make_profile_like(path: &Path) {
    let sddl = format!(
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{})",
        super::super::credentials::current_user_sid().unwrap()
    );
    let mut descriptor = null_mut();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(&sddl).unwrap().as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        );
    }
    let (mut present, mut defaulted, mut dacl) = (0, 0, null_mut());
    unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) };
    // A token that may not write DACLs fails here; the tests check `may_change_dacl` and skip.
    unsafe {
        SetNamedSecurityInfoW(
            wide(path.to_str().unwrap()).unwrap().as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null(),
        );
        LocalFree(descriptor);
    }
}

/// Every journaled read root. An unreadable journal is an empty answer here: `audit` is what reports it.
pub fn read_roots() -> Result<Vec<ReadRootView>> {
    Ok(load(&journal_path()?)?
        .grants
        .into_iter()
        .map(|grant| ReadRootView {
            path: grant.root.to_string_lossy().into_owned(),
            source: grant.source,
        })
        .collect())
}

pub fn audit(group: &str, accounts: &[String]) -> Result<()> {
    let profile = super::super::credentials::profile_directory()?;
    let path = journal_path()?;
    if !path.is_file() {
        return Err("Read allowlist journal is missing".into());
    }
    let group_sid = sid(group)?;
    let inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    for grant in load(&path)?.grants {
        if grant.group != group || !allowed(&grant.root, &profile) {
            return Err("Read allowlist identity or policy mismatch".into());
        }
        // A toolchain uninstalled since the last refresh leaves a stale record; that is refresh's business, not a
        // broken installation.
        if !grant.root.exists() {
            continue;
        }
        match grant.mode {
            Mode::Inherit => {
                let object = open(&grant.root, &profile)?;
                let root_descriptor = descriptor(&object)?;
                let aces = explicit_aces(group_ace_list(root_descriptor.dacl()?, &group_sid)?);
                if aces.len() != 1
                    || !aces[0].0
                    || aces[0].1 != READ_EXECUTE
                    || aces[0].2 & inherit != inherit
                {
                    return Err("Read root RX grant is missing or widened".into());
                }
                for account in accounts {
                    if !group_ace_list(root_descriptor.dacl()?, &sid(account)?)?.is_empty() {
                        return Err("Read allowlist must not grant an account SID directly".into());
                    }
                }
                for guard in &grant.guards {
                    let Some(object) = recorded(guard)? else {
                        continue;
                    };
                    let aces =
                        explicit_aces(group_ace_list(descriptor(&object)?.dacl()?, &group_sid)?);
                    if !aces.iter().any(|(allowed, mask, flags)| {
                        !*allowed && *mask & READ_EXECUTE == READ_EXECUTE && *flags == 0
                    }) {
                        return Err("Read root credential denial is missing".into());
                    }
                }
            }
            Mode::Snapshot => {
                for object in walk(&grant.root, &profile)? {
                    let descriptor = descriptor(&object)?;
                    let rights = group_aces(descriptor.dacl()?, &group_sid)?;
                    if rights.is_empty() || rights.iter().any(|mask| *mask != READ_EXECUTE) {
                        return Err("Read allowlist RX grant is missing or widened".into());
                    }
                    for account in accounts {
                        if !group_aces(descriptor.dacl()?, &sid(account)?)?.is_empty() {
                            return Err(
                                "Read allowlist must not grant an account SID directly".into()
                            );
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod lock_tests {
    use super::*;
    #[test]
    fn a_concurrent_grant_waits_for_the_journal_owner_instead_of_failing() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/unit-tmp")
            .join(format!("journal-lock-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("grants.json");
        let guard = journal_lock(&path).unwrap();
        let (started, ready) = std::sync::mpsc::channel();
        let (finished, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            finished.send(journal_lock(&path).map(drop)).unwrap();
        });
        ready.recv().unwrap();
        assert!(
            result
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err()
        );
        drop(guard);
        assert!(
            result
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap()
                .is_ok()
        );
        worker.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A low-integrity token (an agent sandbox, some CI runners) cannot write any DACL, so the ACL tests below skip
    /// there instead of failing: the production path reports the same refusal as a skipped read root.
    fn acl_available(base: &Path) -> bool {
        match open_object(base) {
            Ok(_) => true,
            Err(error) => {
                eprintln!("this session cannot change a DACL ({error}); skipping");
                false
            }
        }
    }

    fn aces(path: &Path) -> Vec<(u8, u8, u32, String)> {
        let name = wide(path.to_str().unwrap()).unwrap();
        let (mut dacl, mut descriptor) = (null_mut(), null_mut());
        unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            );
        }
        let mut out = Vec::new();
        for index in 0..unsafe { (*dacl).AceCount } as u32 {
            let mut ace = null_mut();
            unsafe { GetAce(dacl, index, &mut ace) };
            let header = unsafe { &*(ace as *const ACE_HEADER) };
            let allow = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
            let sid = crate::sid_text(&allow.SidStart as *const u32 as PSID).unwrap();
            out.push((header.AceType, header.AceFlags, allow.Mask, sid));
        }
        unsafe { LocalFree(descriptor) };
        out
    }

    fn group_grants(path: &Path, group: &str) -> Vec<(u8, u8, u32)> {
        aces(path)
            .into_iter()
            .filter(|(_, _, _, sid)| sid == group)
            .map(|(kind, flags, mask, _)| (kind, flags, mask))
            .collect()
    }

    fn scratch(name: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("unit-tmp")
            .join(format!("read-grants-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        make_profile_like(&root);
        root
    }

    #[test]
    fn a_version_one_journal_migrates_to_user_snapshots() {
        let base = scratch("journal-v1");
        if !acl_available(&base) {
            return;
        }
        let path = base.join("reads.json");
        std::fs::write(
            &path,
            br#"{"version":1,"grants":[{"root":"C:\\Users\\Alice\\tool","group":"S-1-5-21-1-2-3-1","entries":[]}]}"#,
        )
        .unwrap();
        let journal = load(&path).unwrap();
        assert_eq!(journal.version, 2);
        assert_eq!(journal.grants[0].source, Source::User);
        assert_eq!(journal.grants[0].mode, Mode::Snapshot);
        assert!(journal.grants[0].guards.is_empty());
        save(&path, &journal).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(r#""version":2"#), "{text}");
        assert!(text.contains(r#""source":"user""#), "{text}");
        assert!(text.contains(r#""mode":"snapshot""#), "{text}");
        // Unknown fields stay refused in either version.
        std::fs::write(&path, br#"{"version":2,"grants":[],"path":"C:\\Windows"}"#).unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn an_inheritable_root_grant_is_idempotent_is_inherited_and_revokes_cleanly() {
        let base = scratch("inherit");
        if !acl_available(&base) {
            return;
        }
        let profile = base.join("profile");
        let root = profile.join("tool");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("bin/tool.cmd"), "echo ok").unwrap();
        let journal_path = base.join("reads.json");
        let group = "S-1-5-21-1-2-3-9301";
        let before = sddl(&descriptor(&open(&root, &profile).unwrap()).unwrap()).unwrap();
        let mut journal = load(&journal_path).unwrap();
        assert!(grant_inherit_locked(&root, &profile, group, &mut journal, &journal_path).unwrap());
        let grants = group_grants(&root, group);
        assert_eq!(grants.len(), 1, "{grants:?}");
        let (kind, flags, mask) = grants[0];
        assert_eq!(kind, 0);
        assert_eq!(
            flags as u32 & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE),
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
        );
        assert_eq!(mask, READ_EXECUTE);
        // Existing children inherit the ACE, and so do files created afterwards without another refresh.
        assert!(!group_grants(&root.join("bin/tool.cmd"), group).is_empty());
        std::fs::write(root.join("bin/later.cmd"), "echo later").unwrap();
        assert!(!group_grants(&root.join("bin/later.cmd"), group).is_empty());
        // A second refresh changes neither the ACE nor the record.
        assert!(grant_inherit_locked(&root, &profile, group, &mut journal, &journal_path).unwrap());
        assert_eq!(group_grants(&root, group), grants);
        assert_eq!(journal.grants.len(), 1);
        assert_eq!(journal.grants[0].entries.len(), 1);
        // Nothing here is a credential, so the guard records no denial.
        guard_credentials_locked(&root, group, &mut journal, &journal_path).unwrap();
        assert!(journal.grants[0].guards.is_empty());
        revoke_inherit_locked(0, group, &mut journal, &journal_path).unwrap();
        assert!(group_grants(&root, group).is_empty());
        assert!(group_grants(&root.join("bin/later.cmd"), group).is_empty());
        assert_eq!(
            sddl(&descriptor(&open(&root, &profile).unwrap()).unwrap()).unwrap(),
            before
        );
        assert!(journal.grants.is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_conflicting_group_ace_on_a_root_is_refused() {
        let base = scratch("conflict");
        if !acl_available(&base) {
            return;
        }
        let profile = base.join("profile");
        let root = profile.join("tool");
        std::fs::create_dir_all(&root).unwrap();
        let journal_path = base.join("reads.json");
        let group = "S-1-5-21-1-2-3-9302";
        let group_sid = sid(group).unwrap();
        add_ace(
            &open(&root, &profile).unwrap(),
            &group_sid,
            FILE_GENERIC_READ,
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            false,
        )
        .unwrap();
        let mut journal = load(&journal_path).unwrap();
        let error =
            grant_inherit_locked(&root, &profile, group, &mut journal, &journal_path).unwrap_err();
        assert_eq!(error, "Read root has a conflicting sandbox group grant");
        assert!(!journal_path.exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_broadly_readable_root_needs_no_ace_and_no_record() {
        let base = scratch("broad");
        if !acl_available(&base) {
            return;
        }
        let profile = base.join("profile");
        let root = profile.join("tool");
        std::fs::create_dir_all(&root).unwrap();
        add_ace(
            &open(&root, &profile).unwrap(),
            &sid("S-1-5-32-545").unwrap(),
            READ_EXECUTE,
            0,
            false,
        )
        .unwrap();
        let journal_path = base.join("reads.json");
        let group = "S-1-5-21-1-2-3-9303";
        let mut journal = load(&journal_path).unwrap();
        assert!(
            !grant_inherit_locked(&root, &profile, group, &mut journal, &journal_path).unwrap()
        );
        assert!(group_grants(&root, group).is_empty());
        assert!(journal.grants.is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_credential_file_inside_a_root_is_denied_and_the_denial_survives_refresh() {
        let base = scratch("guard");
        if !acl_available(&base) {
            return;
        }
        let profile = base.join("profile");
        let root = profile.join("tool");
        std::fs::create_dir_all(root.join(".cargo")).unwrap();
        std::fs::write(root.join(".npmrc"), "token").unwrap();
        std::fs::write(root.join(".cargo/credentials.toml"), "token").unwrap();
        // `config.json` is an ordinary name for a toolchain and must stay readable.
        std::fs::write(root.join("config.json"), "{}").unwrap();
        let journal_path = base.join("reads.json");
        let group = "S-1-5-21-1-2-3-9304";
        let mut journal = load(&journal_path).unwrap();
        grant_inherit_locked(&root, &profile, group, &mut journal, &journal_path).unwrap();
        guard_credentials_locked(&root, group, &mut journal, &journal_path).unwrap();
        assert_eq!(
            journal.grants[0].guards.len(),
            2,
            "{:?}",
            journal.grants[0].guards
        );
        for path in [root.join(".npmrc"), root.join(".cargo/credentials.toml")] {
            let grants = group_grants(&path, group);
            assert!(
                grants.iter().any(|(kind, flags, mask)| *kind == 1
                    && *flags as u32 & INHERITED_ACE_FLAG == 0
                    && *mask & READ_EXECUTE == READ_EXECUTE),
                "{path:?}: {grants:?}"
            );
        }
        assert!(
            group_grants(&root.join("config.json"), group)
                .iter()
                .all(|(kind, _, _)| *kind == 0)
        );
        // A second guard is idempotent, and a credential added later is caught by the next refresh.
        guard_credentials_locked(&root, group, &mut journal, &journal_path).unwrap();
        assert_eq!(journal.grants[0].guards.len(), 2);
        std::fs::write(root.join(".netrc"), "machine").unwrap();
        guard_credentials_locked(&root, group, &mut journal, &journal_path).unwrap();
        assert_eq!(journal.grants[0].guards.len(), 3);
        // The audit accepts the root, its denial and the group ACEs.
        revoke_inherit_locked(0, group, &mut journal, &journal_path).unwrap();
        assert!(journal.grants.is_empty());
        for path in [
            root.join(".npmrc"),
            root.join(".cargo/credentials.toml"),
            root.join(".netrc"),
        ] {
            assert!(group_grants(&path, group).is_empty(), "{path:?}");
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_failed_guard_withdraws_the_root_grant() {
        let base = scratch("guard-fail");
        if !acl_available(&base) {
            return;
        }
        let profile = base.join("profile");
        let root = profile.join("tool");
        std::fs::create_dir_all(&root).unwrap();
        let journal_path = base.join("reads.json");
        let group = "S-1-5-21-1-2-3-9305";
        let mut journal = load(&journal_path).unwrap();
        grant_inherit_locked(&root, &profile, group, &mut journal, &journal_path).unwrap();
        // A directory named `.npmrc` cannot be opened as a file, so the guard must not leave the root readable.
        std::fs::create_dir(root.join(".npmrc")).unwrap();
        assert!(guard_credentials_locked(&root, group, &mut journal, &journal_path).is_err());
        assert!(group_grants(&root, group).is_empty());
        assert!(journal.grants.is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_user_path_holding_a_file_the_ssh_config_uses_is_refused() {
        let base = scratch("ssh-user");
        if !acl_available(&base) {
            return;
        }
        let profile = base.join("profile");
        let picked = profile.join("deploy");
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::write(picked.join("id_ed25519"), "PRIVATE").unwrap();
        std::fs::create_dir_all(profile.join(".ssh")).unwrap();
        std::fs::write(
            profile.join(r".ssh\config"),
            "IdentityFile ~/deploy/id_ed25519\n",
        )
        .unwrap();
        let journal_path = base.join("reads.json");
        let group = "S-1-5-21-1-2-3-9308";
        let error = grant_at(&picked, &profile, group, &journal_path).unwrap_err();
        assert_eq!(error, "Path holds a file the SSH configuration uses");
        assert!(group_grants(&picked, group).is_empty());
        assert!(load(&journal_path).unwrap().grants.is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn automatic_roots_may_not_be_revoked_as_user_paths() {
        let base = scratch("auto-revoke");
        if !acl_available(&base) {
            return;
        }
        let profile = base.join("profile");
        let root = profile.join("tool");
        std::fs::create_dir_all(&root).unwrap();
        let journal_path = base.join("reads.json");
        let group = "S-1-5-21-1-2-3-9306";
        let mut journal = load(&journal_path).unwrap();
        grant_inherit_locked(&root, &profile, group, &mut journal, &journal_path).unwrap();
        let error = revoke_at(&root, &profile, group, &journal_path).unwrap_err();
        assert_eq!(error, "Automatic read roots are managed by refresh");
        revoke_inherit_locked(0, &group, &mut journal, &journal_path).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn revoking_everything_empties_both_journals() {
        let base = scratch("revoke-all");
        if !acl_available(&base) {
            return;
        }
        let profile = base.join("profile");
        let root = profile.join("tool");
        let user = profile.join("picked");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(user.join("bin")).unwrap();
        let journal_path = base.join("reads.json");
        let group = "S-1-5-21-1-2-3-9307";
        let mut journal = load(&journal_path).unwrap();
        grant_inherit_locked(&root, &profile, group, &mut journal, &journal_path).unwrap();
        guard_credentials_locked(&root, group, &mut journal, &journal_path).unwrap();
        // A user path inside an automatic root is already readable, and is refused rather than layered on it.
        let error = grant_snapshot_locked(
            &root.join("bin"),
            &profile,
            group,
            Source::User,
            &mut journal,
            &journal_path,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "Path is already readable through an automatic read root"
        );
        grant_snapshot_locked(
            &user,
            &profile,
            group,
            Source::User,
            &mut journal,
            &journal_path,
        )
        .unwrap();
        // Both shapes of grant are recorded, and a full revoke takes both roots down to their original DACLs.
        assert_eq!(journal.grants.len(), 2);
        revoke_inherit_locked(0, &group, &mut journal, &journal_path).unwrap();
        revoke_snapshot_locked(
            0,
            &sid(group).unwrap(),
            READ_EXECUTE,
            &mut journal,
            &journal_path,
        )
        .unwrap();
        assert!(journal.grants.is_empty());
        for path in [&root, &root.join("bin"), &user, &user.join("bin")] {
            assert!(group_grants(path, group).is_empty(), "{path:?}");
        }
        std::fs::remove_dir_all(&base).unwrap();
    }
}
