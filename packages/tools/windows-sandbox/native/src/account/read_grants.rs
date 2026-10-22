//! Read allowlist. Validate and lock the entire tree before changing any DACL; journal before applying.
//! Use handle security APIs so inheritance cannot walk unvalidated descendants during a grant/revoke.
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

fn key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}
fn under(path: &str, parent: &str) -> bool {
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
        .chain(PROFILE_SECRETS.iter().map(|name| profile.join(name)));
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
fn open_object(path: &Path) -> Result<Object> {
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
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.nNumberOfLinks > 1 {
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
fn group_aces(acl: *mut ACL, group: &Sid) -> Result<Vec<u32>> {
    let mut rights = Vec::new();
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
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                return Err("Conflicting allowlist deny ACE".into());
            }
            rights.push(access.Mask);
        }
    }
    Ok(rights)
}
fn change(object: &Object, group: &Sid, revoke: bool, rights: u32) -> Result<()> {
    let original = descriptor(object)?;
    let acl = original.dacl()?;
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: if revoke { 0 } else { rights },
        grfAccessMode: if revoke { REVOKE_ACCESS } else { GRANT_ACCESS },
        // Snapshot RX: inherited RX would expose a future credential subtree before revalidation.
        grfInheritance: 0,
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: group.0 as _,
            ..Default::default()
        },
    };
    let mut merged = null_mut();
    let mut filtered = Vec::<u32>::new();
    if revoke {
        // REVOKE_ACCESS deliberately leaves inherited ACEs behind. Remove our trustee's RX ACEs explicitly,
        // including those inherited by files created after initialization; other trustees stay byte-for-byte.
        filtered.resize((unsafe { (*acl).AclSize } as usize).div_ceil(4), 0);
        merged = filtered.as_mut_ptr() as *mut ACL;
        win(
            unsafe { InitializeAcl(merged, (filtered.len() * 4) as u32, 2) },
            "Initialize revoked allowlist ACL",
        )?;
        for index in 0..unsafe { (*acl).AceCount } as u32 {
            let mut ace = null_mut();
            win(
                unsafe { GetAce(acl, index, &mut ace) },
                "Read revoked allowlist ACE",
            )?;
            let header = unsafe { &*(ace as *const ACE_HEADER) };
            if header.AceType == ACCESS_ALLOWED_ACE_TYPE {
                let access = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
                if unsafe { EqualSid(&access.SidStart as *const _ as _, group.0) } != 0 {
                    continue;
                }
            }
            win(
                unsafe { AddAce(merged, 2, u32::MAX, ace, header.AceSize as u32) },
                "Preserve other allowlist ACEs",
            )?;
        }
    } else {
        let result = unsafe { SetEntriesInAclW(1, &entry, acl, &mut merged) };
        if result != ERROR_SUCCESS {
            return Err("Merge allowlist permissions failed".into());
        }
    }
    let mut updated = SECURITY_DESCRIPTOR::default();
    let result = (|| {
        win(
            unsafe {
                InitializeSecurityDescriptor(
                    &mut updated as *mut _ as _,
                    SECURITY_DESCRIPTOR_REVISION,
                )
            },
            "Initialize allowlist descriptor",
        )?;
        win(
            unsafe { SetSecurityDescriptorDacl(&mut updated as *mut _ as _, 1, merged, 0) },
            "Set allowlist DACL",
        )?;
        let (mut control, mut revision) = (0, 0);
        win(
            unsafe {
                GetSecurityDescriptorControl(original.pointer(), &mut control, &mut revision)
            },
            "Read allowlist inheritance",
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
    })();
    if !revoke {
        unsafe { LocalFree(merged as _) };
    }
    result
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: PathBuf,
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
        if error == ERROR_FILE_NOT_FOUND {
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
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadGrant {
    root: PathBuf,
    group: String,
    entries: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    grants: Vec<ReadGrant>,
}
fn load(path: &Path) -> Result<Journal> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let journal: Journal =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid read allowlist journal")?;
            if journal.version != 1 {
                return Err("Unsupported read allowlist journal".into());
            }
            Ok(journal)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Journal {
            version: 1,
            grants: Vec::new(),
        }),
        Err(_) => Err("Read allowlist journal failed".into()),
    }
}
fn save(path: &Path, journal: &Journal) -> Result<()> {
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

pub(super) fn journal_lock(path: &Path) -> Result<std::fs::File> {
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

pub(crate) fn grant_at(
    root: &Path,
    profile: &Path,
    group: &str,
    journal_path: &Path,
) -> Result<()> {
    let _lock = journal_lock(journal_path)?;
    let mut journal = load(journal_path)?;
    let existing = journal
        .grants
        .iter()
        .position(|g| g.group == group && under(&key(root), &key(&g.root)));
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
        let recorded: BTreeSet<(u32, u64, u64)> = journal.grants[index]
            .entries
            .iter()
            .map(|entry| (entry.volume, entry.id, entry.created))
            .collect();
        for entry in entries {
            if !recorded.contains(&(entry.volume, entry.id, entry.created)) {
                journal.grants[index].entries.push(entry);
            }
        }
    } else {
        journal.grants.push(ReadGrant {
            root: root.to_path_buf(),
            group: group.into(),
            entries,
        });
    }
    save(journal_path, &journal)?; // durable intent BEFORE the first ACL change, including partial failures
    for object in &objects {
        if group_aces(descriptor(object)?.dacl()?, &group_sid)?.is_empty() {
            change(object, &group_sid, false, READ_EXECUTE)?;
        }
    }
    Ok(())
}

pub(crate) fn revoke_at(
    root: &Path,
    profile: &Path,
    group: &str,
    journal_path: &Path,
) -> Result<()> {
    let _lock = journal_lock(journal_path)?;
    revoke_locked(root, profile, group, journal_path, READ_EXECUTE)
}
fn revoke_locked(
    root: &Path,
    _profile: &Path,
    group: &str,
    journal_path: &Path,
    rights: u32,
) -> Result<()> {
    let mut journal = load(journal_path)?;
    let Some(index) = journal
        .grants
        .iter()
        .position(|g| key(&g.root) == key(root) && g.group == group)
    else {
        return Ok(());
    };
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
        let group_sid = sid(group)?;
        // Preflight the entire tree before revoking. Preserve independently added ACEs and retain the journal on conflict.
        for object in &objects {
            if group_aces(descriptor(object)?.dacl()?, &group_sid)?
                .iter()
                .any(|mask| *mask != rights)
            {
                return Err("Read allowlist permissions changed; recovery requires review".into());
            }
        }
        for object in &objects {
            change(object, &group_sid, true, rights)?;
        }
    }
    journal.grants.remove(index);
    save(journal_path, &journal)
}

fn journal_path() -> Result<PathBuf> {
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
    let _lock = journal_lock(&path)?;
    for grant in load(&path)?.grants {
        revoke_locked(
            &grant.root,
            &super::super::credentials::profile_directory()?,
            &grant.group,
            &path,
            READ_EXECUTE,
        )?;
    }
    let metadata = metadata_path()?;
    for grant in load(&metadata)?.grants {
        revoke_metadata_at(&grant.root, &grant.group, &metadata)?;
    }
    Ok(())
}

fn metadata_path() -> Result<PathBuf> {
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
            entries: additions,
        });
    }
    save(journal_path, &journal)?;
    for object in &objects {
        change(object, &group_sid, false, TRAVERSE_METADATA)?;
    }
    Ok(())
}
pub(crate) fn revoke_metadata_at(profile: &Path, group: &str, path: &Path) -> Result<()> {
    let _lock = journal_lock(path)?;
    revoke_locked(profile, profile, group, path, TRAVERSE_METADATA)
}
pub fn grant_defaults(group: &str) -> Result<()> {
    let profile = super::super::credentials::profile_directory()?;
    let mut defaults = BTreeSet::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            if directory.is_dir()
                && under(&key(&directory), &key(&profile))
                && allowed(&directory, &profile)
            {
                defaults.insert(directory);
            }
        }
    }
    let gitconfig = profile.join(".gitconfig");
    if gitconfig.is_file() {
        defaults.insert(gitconfig);
    }
    for path in defaults {
        // An unsafe default toolchain is left inaccessible, never partially granted. Explicit custom paths
        // fail with an error; defaults may include OS-managed WindowsApps junctions and rustup hard links.
        if walk(&path, &profile).is_err() {
            eprintln!(
                "Skipped unsafe default read allowlist path: {}",
                path.display()
            );
            continue;
        }
        grant(&path, group)?;
    }
    let path = journal_path()?;
    save(&path, &load(&path)?)?;
    Ok(())
}

pub fn audit(group: &str, accounts: &[String]) -> Result<()> {
    let profile = super::super::credentials::profile_directory()?;
    if !journal_path()?.is_file() {
        return Err("Read allowlist journal is missing".into());
    }
    for grant in load(&journal_path()?)?.grants {
        if grant.group != group || !allowed(&grant.root, &profile) {
            return Err("Read allowlist identity or policy mismatch".into());
        }
        for object in walk(&grant.root, &profile)? {
            let descriptor = descriptor(&object)?;
            let rights = group_aces(descriptor.dacl()?, &sid(group)?)?;
            if rights.is_empty() || rights.iter().any(|mask| *mask != READ_EXECUTE) {
                return Err("Read allowlist RX grant is missing or widened".into());
            }
            for account in accounts {
                if !group_aces(descriptor.dacl()?, &sid(account)?)?.is_empty() {
                    return Err("Read allowlist must not grant an account SID directly".into());
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
