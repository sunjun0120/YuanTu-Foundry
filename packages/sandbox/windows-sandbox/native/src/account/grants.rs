//! Standing workspace grants, the way Codex grants them: the sandbox group and the workspace's capability SID
//! each get an inheritable Modify ACE on the workspace root, kept until the workspace is ungranted or the
//! backend is uninstalled. Only a write-restricted token that carries this workspace's capability — which only
//! the runner creates — passes both access checks, so the ACEs do nothing for any other process.
//! Every grant is recorded in `grants.json` so uninstall can take it back.
use super::credentials::{current_user_sid, state_directory};
use crate::{Handle, Result, wide, win};
use serde::{Deserialize, Serialize};
use std::{
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
};
#[path = "read_grants.rs"]
pub mod reads;

/// Names a sandboxed command must never write, even inside its workspace: directories, and `.git` as a worktree's
/// file too.
pub const RESERVED: [&str; 7] = [
    ".git", ".yuantu", ".agents", ".codex", ".aws", ".ssh", ".gnupg",
];
/// Read, write, execute and delete-self: what `icacls /grant :M` grants. No WRITE_DAC, no DELETE_CHILD.
pub const MODIFY: u32 = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
/// Everything that changes a reserved directory or its contents.
const DENIED_WRITE: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | FILE_DELETE_CHILD
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER;
/// What the group may never do anywhere in the workspace, so it cannot take a denial back.
const DENIED_CONTROL: u32 = WRITE_DAC | WRITE_OWNER;
/// The `OWNER RIGHTS` trustee: an ACE for it replaces the owner's implicit `READ_CONTROL | WRITE_DAC`.
const OWNER_RIGHTS: &str = "S-1-3-4";
/// The owner's implicit rights, granted as an ordinary ACE instead.
const OWNER_ACCESS: u32 = READ_CONTROL | WRITE_DAC;
const ACCESS_DENIED_ACE_TYPE: u32 = 1;
const INHERIT: u32 = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
const FILE_ATTRIBUTE_REPARSE: u32 = 0x400;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub root: String,
    pub capability: String,
    #[serde(default)]
    complete: bool,
    #[serde(default)]
    identity: Option<[u32; 3]>,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(deny_unknown_fields)]
struct GrantFile {
    version: u32,
    grants: Vec<Grant>,
}

fn grants_path() -> Result<PathBuf> {
    Ok(state_directory()?.join("grants.json"))
}

fn load() -> Result<GrantFile> {
    load_at(&grants_path()?)
}
fn load_at(path: &Path) -> Result<GrantFile> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Invalid sandbox grant record".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(GrantFile {
            version: 1,
            grants: Vec::new(),
        }),
        Err(_) => Err("Read sandbox grant record failed".into()),
    }
}

fn save(file: &GrantFile) -> Result<()> {
    save_at(file, &grants_path()?)
}
fn save_at(file: &GrantFile, path: &Path) -> Result<()> {
    let directory = path.parent().ok_or("Invalid grant record path")?;
    std::fs::create_dir_all(directory).map_err(|_| "Create sandbox state directory failed")?;
    let temporary = directory.join(format!("grants.{}.tmp", std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec(file).map_err(|_| "Serialize grants")?,
    )
    .map_err(|_| "Write sandbox grant record failed")?;
    std::fs::rename(&temporary, path).map_err(|_| "Replace sandbox grant record failed".into())
}

/// A workspace root this backend may grant: an existing, local, non-root directory that is not a link.
pub fn workspace_root(root: &str) -> Result<PathBuf> {
    let path = Path::new(root);
    if !path.is_absolute() {
        return Err("Workspace root must be absolute".into());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Workspace root does not exist")?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE != 0 || !metadata.is_dir() {
        return Err("Workspace root must be a real directory, not a link".into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| "Resolve workspace root failed")?;
    if canonical.parent().is_none() || canonical.parent() == Some(Path::new(r"\\?\")) {
        return Err("A volume root cannot be a sandbox workspace".into());
    }
    let text = canonical.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    if Path::new(text).parent().is_none() || text.ends_with(":\\") {
        return Err("A volume root cannot be a sandbox workspace".into());
    }
    Ok(PathBuf::from(text))
}

struct Sid(PSID);
impl Drop for Sid {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0 as _);
        }
    }
}
fn sid(text: &str) -> Result<Sid> {
    let mut parsed = null_mut();
    if unsafe { ConvertStringSidToSidW(wide(text)?.as_ptr(), &mut parsed) } == 0 {
        return Err(format!("Invalid SID {text}"));
    }
    Ok(Sid(parsed))
}

/// A file or directory opened without following a reparse point at its name. The handle pins the object that was
/// checked: a sandboxed command may rename it and put a junction in its place, but a DACL written through the handle
/// still lands on the checked object, never on the junction's target.
struct Pinned {
    path: PathBuf,
    handle: Handle,
    directory: bool,
}

/// Opens `path` with `access`. A missing name or a reparse point is `None`; a refusal is the Windows error code.
fn open_pinned(path: &Path, access: u32) -> std::result::Result<Option<Pinned>, String> {
    let name = wide(path.to_str().ok_or("Invalid path")?)?;
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            access | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        let error = unsafe { GetLastError() };
        if error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND {
            return Ok(None);
        }
        return Err(format!("Open {}: Windows error {error}", path.display()));
    }
    let handle = Handle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "Inspect reserved path",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(None);
    }
    Ok(Some(Pinned {
        path: path.to_path_buf(),
        handle,
        directory: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
    }))
}

/// Opens `path` as a real directory whose DACL this user may change. Anything else is `None`.
fn open_directory(path: &Path) -> Result<Option<Pinned>> {
    Ok(open_pinned(path, READ_CONTROL | WRITE_DAC)?.filter(|object| object.directory))
}

/// The object's DACL, read through its handle.
struct Dacl {
    acl: *mut ACL,
    descriptor: PSECURITY_DESCRIPTOR,
}
impl Drop for Dacl {
    fn drop(&mut self) {
        unsafe { LocalFree(self.descriptor) };
    }
}
fn dacl(object: &Pinned) -> Result<Dacl> {
    let (mut acl, mut descriptor) = (null_mut(), null_mut());
    let status = unsafe {
        GetSecurityInfo(
            object.handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Read permissions of {}: Windows error {status}",
            object.path.display()
        ));
    }
    Ok(Dacl { acl, descriptor })
}

/// Merges explicit entries into an object's DACL through its handle, keeping its inheritance protection. On a
/// directory the entries are inheritable, and `SetSecurityInfo` propagates them to existing children.
fn apply(object: &Pinned, entries: &[(&str, ACCESS_MODE, u32)]) -> Result<()> {
    let current = dacl(object)?;
    let inheritance = if object.directory { INHERIT } else { 0 };
    let sids: Vec<Sid> = entries
        .iter()
        .map(|(text, _, _)| sid(text))
        .collect::<Result<_>>()?;
    let explicit: Vec<EXPLICIT_ACCESS_W> = entries
        .iter()
        .zip(&sids)
        .map(|((_, mode, mask), sid)| EXPLICIT_ACCESS_W {
            grfAccessPermissions: *mask,
            grfAccessMode: *mode,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid.0 as *mut u16,
            },
        })
        .collect();
    let mut merged = null_mut();
    let status = unsafe {
        SetEntriesInAclW(
            explicit.len() as u32,
            explicit.as_ptr(),
            current.acl,
            &mut merged,
        )
    };
    let result = if status != ERROR_SUCCESS {
        Err(format!("Merge permissions: Windows error {status}"))
    } else {
        write_dacl(object, &current, merged)
    };
    unsafe { LocalFree(merged as _) };
    result
}

/// Removes every explicit ACE, allow or deny, whose trustee is one of `trustees`, keeping the others in order.
/// `REVOKE_ACCESS` cannot do this: it removes only allow ACEs, so a denial would outlive its grant.
fn remove(object: &Pinned, trustees: &[&str]) -> Result<()> {
    let current = dacl(object)?;
    if current.acl.is_null() {
        return Ok(());
    }
    let sids: Vec<Sid> = trustees
        .iter()
        .map(|text| sid(text))
        .collect::<Result<_>>()?;
    let revision = unsafe { (*current.acl).AclRevision } as u32;
    let mut buffer = vec![0u32; (unsafe { (*current.acl).AclSize } as usize).div_ceil(4)];
    let kept = buffer.as_mut_ptr() as *mut ACL;
    win(
        unsafe { InitializeAcl(kept, (buffer.len() * 4) as u32, revision) },
        "Initialize revoked permissions",
    )?;
    for index in 0..unsafe { (*current.acl).AceCount } as u32 {
        let mut ace = null_mut();
        win(
            unsafe { GetAce(current.acl, index, &mut ace) },
            "Read revoked ACE",
        )?;
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        let ours = header.AceFlags as u32 & INHERITED_ACE == 0
            && (header.AceType as u32 == ACCESS_DENIED_ACE_TYPE || header.AceType == 0)
            && sids.iter().any(|sid| unsafe {
                EqualSid(
                    &(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as PSID,
                    sid.0,
                ) != 0
            });
        if ours {
            continue;
        }
        win(
            unsafe { AddAce(kept, revision, u32::MAX, ace, header.AceSize as u32) },
            "Keep other ACEs",
        )?;
    }
    write_dacl(object, &current, kept)
}

/// Writes `acl` through the object's handle, keeping whether its DACL inherits from its parent. `SetSecurityInfo`
/// re-derives the inherited ACEs of existing children.
fn write_dacl(object: &Pinned, current: &Dacl, acl: *const ACL) -> Result<()> {
    let path = &object.path;
    let (mut control, mut revision) = (0, 0);
    if unsafe { GetSecurityDescriptorControl(current.descriptor, &mut control, &mut revision) } == 0
    {
        return Err(format!("Read inheritance of {}", path.display()));
    }
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
            "Write permissions of {}: Windows error {status}",
            path.display()
        ));
    }
    Ok(())
}

/// Whether the group's explicit write denial comes before every allow ACE: then no sandboxed command can write the
/// object, and nothing needs rewriting. A denial placed after an allow, as a hand-made DACL could hold it, does not
/// count: the allow is checked first.
fn denied_first(object: &Pinned, group: &Sid) -> Result<bool> {
    let current = dacl(object)?;
    if current.acl.is_null() {
        return Ok(false);
    }
    let required = if object.directory { INHERIT } else { 0 };
    for index in 0..unsafe { (*current.acl).AceCount } as u32 {
        let mut ace = null_mut();
        win(
            unsafe { GetAce(current.acl, index, &mut ace) },
            "Inspect reserved ACE",
        )?;
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        if header.AceType as u32 != ACCESS_DENIED_ACE_TYPE {
            return Ok(false);
        }
        let entry = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        let flags = header.AceFlags as u32;
        if unsafe { EqualSid(&entry.SidStart as *const u32 as PSID, group.0) } != 0
            && flags & INHERITED_ACE == 0
            && flags & required == required
            && entry.Mask & DENIED_WRITE == DENIED_WRITE
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Denies the group writes to one reserved name: a directory inheritably, a file (a worktree's `.git`) on itself.
/// Returns whether it changed anything. A reserved object this user may not change and that is not already denied
/// is an error: a sandboxed command made it with permissions of its own, and no command may run beside it.
fn protect_reserved(path: &Path, group_sid: &str, group: &Sid) -> Result<bool> {
    match open_pinned(path, READ_CONTROL | WRITE_DAC) {
        Ok(None) => Ok(false),
        Ok(Some(object)) => {
            if denied_first(&object, group)? {
                return Ok(false);
            }
            apply(&object, &[(group_sid, DENY_ACCESS, DENIED_WRITE)])?;
            Ok(true)
        }
        Err(_) => match open_pinned(path, READ_CONTROL) {
            Ok(None) => Ok(false),
            Ok(Some(object)) if denied_first(&object, group)? => Ok(false),
            _ => Err(format!(
                "{} cannot be protected: this user may not change its permissions. A sandboxed command may have \
                 created it; check it and remove it before running sandboxed commands in this workspace again.",
                path.display()
            )),
        },
    }
}

fn is_granted(root: &Path) -> Result<bool> {
    let text = root.to_string_lossy();
    Ok(load()?
        .grants
        .iter()
        .any(|grant| grant.root.eq_ignore_ascii_case(&text)))
}

/// Protects every reserved name under a granted workspace root. Run before each sandboxed command, so a reserved
/// directory or `.git` file that appeared since the last command is denied before the next one; an already denied
/// one is only read. Returns the paths it changed.
pub fn protect(root: &str, group_sid: &str) -> Result<Vec<String>> {
    let _lock = reads::journal_lock(&grants_path()?)?;
    let root = workspace_root(root)?;
    if !is_granted(&root)? {
        return Err("The workspace is not granted to the sandbox".into());
    }
    let group = sid(group_sid)?;
    let mut changed = Vec::new();
    for name in RESERVED {
        let path = root.join(name);
        if protect_reserved(&path, group_sid, &group)? {
            changed.push(path.to_string_lossy().into_owned());
        }
    }
    Ok(changed)
}

fn root_entries<'a>(
    group_sid: &'a str,
    capability_sid: &'a str,
    user_sid: &'a str,
) -> [(&'a str, ACCESS_MODE, u32); 5] {
    [
        (group_sid, GRANT_ACCESS, MODIFY),
        (capability_sid, GRANT_ACCESS, MODIFY),
        (group_sid, DENY_ACCESS, DENIED_CONTROL),
        (OWNER_RIGHTS, GRANT_ACCESS, OWNER_ACCESS),
        (user_sid, GRANT_ACCESS, OWNER_ACCESS),
    ]
}

/// Whose ACEs `ungrant` takes back from a root. The desktop user's `READ_CONTROL | WRITE_DAC` stays: it may have merged
/// with an ACE the user had before, and on the user's own workspace it gives nothing an owner does not already have.
fn root_trustees<'a>(group_sid: &'a str, capability_sid: &'a str) -> [&'a str; 3] {
    [group_sid, capability_sid, OWNER_RIGHTS]
}

/// Only explicit ACEs applying to both the root and descendants satisfy a standing grant.
/// The control denial must precede any allows, and sandbox trustees must not acquire DELETE_CHILD or control.
fn root_permissions_match(object: &Pinned, entries: &[(&str, ACCESS_MODE, u32)]) -> Result<bool> {
    let current = dacl(object)?;
    if current.acl.is_null() {
        return Ok(false);
    }
    let sids = entries
        .iter()
        .map(|(text, _, _)| sid(text))
        .collect::<Result<Vec<_>>>()?;
    let mut masks = vec![0u32; entries.len()];
    let mut seen_allow = false;
    for index in 0..unsafe { (*current.acl).AceCount } as u32 {
        let mut ace = null_mut();
        win(
            unsafe { GetAce(current.acl, index, &mut ace) },
            "Inspect workspace ACE",
        )?;
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        if header.AceType as u32 != ACCESS_DENIED_ACE_TYPE && header.AceType != 0 {
            continue;
        }
        let entry = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        let flags = header.AceFlags as u32;
        let allow = header.AceType == 0;
        for (i, ((_, mode, _), sid)) in entries.iter().zip(&sids).enumerate() {
            if unsafe { EqualSid(&entry.SidStart as *const u32 as PSID, sid.0) } == 0 {
                continue;
            }
            if i < 2
                && allow
                && entry.Mask & (WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD | GENERIC_ALL) != 0
            {
                return Ok(false);
            }
            if allow == (*mode == GRANT_ACCESS)
                && flags & (INHERITED_ACE | INHERIT_ONLY_ACE | NO_PROPAGATE_INHERIT_ACE) == 0
                && flags & INHERIT == INHERIT
                && (allow || !seen_allow)
            {
                masks[i] |= entry.Mask;
            }
        }
        seen_allow |= allow;
    }
    Ok(entries
        .iter()
        .zip(masks)
        .all(|((_, _, required), actual)| actual & required == *required))
}

fn grant_step<T>(stage: &str, path: &Path, result: Result<T>) -> Result<T> {
    result.map_err(|message| {
        serde_json::json!({
            "version": 1, "stage": stage, "path": path.to_string_lossy(), "message": message
        })
        .to_string()
    })
}

/// Whether a recorded completion describes this exact object, so the root DACL still has to be checked and
/// nothing else can be skipped.
///
/// Every field is required: `complete` is written only after propagation and reserved-name protection ended, the
/// identity names the directory instance (a replaced directory reused at the same path is a new object), and the
/// capability is the SID the ACL currently grants. A record from before completion journaling has neither field
/// and is never reused — an interrupted authorization wrote no completion, and guessing from a legacy row is
/// exactly the stale-success reading this exists to prevent.
fn grant_reusable(
    file: &GrantFile,
    root: &Path,
    capability: &str,
    identity: Option<[u32; 3]>,
) -> bool {
    file.grants.iter().any(|grant| {
        grant.complete
            && grant.identity == identity
            && grant.root.eq_ignore_ascii_case(&root.to_string_lossy())
            && grant.capability == capability
    })
}

/// Grants `group_sid` and `capability_sid` Modify on `root`, denies the group writes to reserved names, and records
/// the grant. Granting the same root again only refreshes it.
///
/// Three more inheritable ACEs keep a reserved directory a sandboxed command created protectable. The group may not
/// change any DACL or owner in the workspace; `OWNER RIGHTS` turns the owner's implicit `WRITE_DAC` into an ordinary
/// ACE that this denial comes before, so owning an object no longer lets the sandbox account rewrite its DACL; and
/// the desktop user gets `READ_CONTROL | WRITE_DAC` on everything, which a data drive granting only Modify would not
/// give it on an object it does not own.
pub fn grant(root: &str, group_sid: &str, capability_sid: &str) -> Result<Grant> {
    grant_at(root, group_sid, capability_sid, &grants_path()?)
}

fn grant_at(root: &str, group_sid: &str, capability_sid: &str, journal: &Path) -> Result<Grant> {
    let _lock = grant_step("lock-grant-record", journal, reads::journal_lock(journal))?;
    let root = grant_step("resolve-workspace", Path::new(root), workspace_root(root))?;
    let directory = grant_step(
        "open-workspace",
        &root,
        open_directory(&root).and_then(|entry| {
            entry.ok_or("Workspace root must be a real directory, not a link".into())
        }),
    )?;
    let user = grant_step("resolve-owner", &root, current_user_sid())?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    grant_step(
        "inspect-workspace",
        &root,
        win(
            unsafe { GetFileInformationByHandle(directory.handle.0, &mut info) },
            "Workspace identity",
        ),
    )?;
    let identity = Some([
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ]);
    let mut file = grant_step("read-grant-record", journal, load_at(journal))?;
    let entries = root_entries(group_sid, capability_sid, &user);
    let recorded = grant_reusable(&file, &root, capability_sid, identity);
    let matched = grant_step(
        "check-workspace-acl",
        &root,
        root_permissions_match(&directory, &entries),
    )?;
    let mut grant = Grant {
        root: root.to_string_lossy().into_owned(),
        capability: capability_sid.to_string(),
        complete: false,
        identity,
    };
    // Persist an incomplete record BEFORE any propagation. A killed helper must never leave a stale success.
    file.version = 1;
    file.grants
        .retain(|existing| !existing.root.eq_ignore_ascii_case(&grant.root));
    file.grants.push(grant.clone());
    grant_step(
        "record-authorization-start",
        journal,
        save_at(&file, journal),
    )?;
    if !recorded || !matched {
        grant_step(
            "propagate-workspace-acl",
            &root,
            apply(&directory, &entries),
        )?;
    }
    let group = sid(group_sid)?;
    for name in RESERVED {
        let path = root.join(name);
        grant_step(
            "protect-reserved",
            &path,
            protect_reserved(&path, group_sid, &group),
        )?;
    }
    grant.complete = true;
    *file.grants.last_mut().unwrap() = grant.clone();
    grant_step(
        "record-authorization-complete",
        journal,
        save_at(&file, journal),
    )?;
    Ok(grant)
}

/// Takes back what `grant` added to one root. An unrecorded root is not an error.
pub fn ungrant(root: &str, group_sid: &str) -> Result<()> {
    let _lock = reads::journal_lock(&grants_path()?)?;
    ungrant_locked(root, group_sid)
}
fn ungrant_locked(root: &str, group_sid: &str) -> Result<()> {
    let mut file = load()?;
    let position = file
        .grants
        .iter()
        .position(|grant| grant.root.eq_ignore_ascii_case(root));
    let Some(position) = position else {
        return Ok(());
    };
    let grant = file.grants[position].clone();
    // A root that is gone, or is now a link, is not the directory that was granted: nothing to take back there.
    if let Some(directory) = open_directory(Path::new(&grant.root))? {
        for name in RESERVED {
            // A reserved object this user may not change cannot hold a denial it wrote; the group goes with
            // uninstall anyway, so it must not block the rest.
            if let Ok(Some(reserved)) =
                open_pinned(&directory.path.join(name), READ_CONTROL | WRITE_DAC)
            {
                remove(&reserved, &[group_sid])?;
            }
        }
        remove(&directory, &root_trustees(group_sid, &grant.capability))?;
    }
    file.grants.remove(position);
    save(&file)
}

/// Takes back every recorded grant; used by uninstall. Stops at the first failure and keeps the record.
pub fn ungrant_all(group_sid: &str) -> Result<()> {
    let _lock = reads::journal_lock(&grants_path()?)?;
    for grant in load()?.grants {
        ungrant_locked(&grant.root, group_sid)?;
    }
    Ok(())
}

pub fn grants() -> Result<Vec<Grant>> {
    Ok(load()?.grants)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_complete_record_and_a_matching_root_acl_reuse_a_grant() {
        let root = scratch("reuse");
        let journal = root.with_extension("json");
        let (group, cap) = ("S-1-5-21-1-2-3-9301", "S-1-5-21-1-2-3-9302");
        if !reads::may_change_dacl(&root) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let grant = grant_at(root.to_str().unwrap(), group, cap, &journal).unwrap();
        let root_text = root.to_string_lossy().into_owned();
        let user = current_user_sid().unwrap();
        let entries = root_entries(group, cap, &user);
        let directory = open_directory(&root).unwrap().unwrap();
        let exact = load_at(&journal).unwrap();
        assert!(grant_reusable(&exact, &root, cap, grant.identity));
        assert!(root_permissions_match(&directory, &entries).unwrap());

        // Every way the record can be incomplete or about a different object has to force the propagation again.
        let mut interrupted = exact.clone();
        interrupted.grants[0].complete = false;
        assert!(!grant_reusable(&interrupted, &root, cap, grant.identity));
        let mut replaced = exact.clone();
        replaced.grants[0].identity = Some([0, 0, 0]);
        assert!(!grant_reusable(&replaced, &root, cap, grant.identity));
        let mut other_capability = exact.clone();
        other_capability.grants[0].capability = "S-1-5-21-1-2-3-9303".into();
        assert!(!grant_reusable(
            &other_capability,
            &root,
            cap,
            grant.identity
        ));
        let mut other_root = exact.clone();
        other_root.grants[0].root = root_text.clone() + "-elsewhere";
        assert!(!grant_reusable(&other_root, &root, cap, grant.identity));
        // A row written before completions were journalled has neither field, and must never be read as success.
        let legacy: Grant = serde_json::from_value(serde_json::json!({
            "root": root_text,
            "capability": cap,
        }))
        .unwrap();
        assert!(!legacy.complete && legacy.identity.is_none());
        let mut legacy_file = exact.clone();
        legacy_file.grants = vec![legacy];
        assert!(!grant_reusable(&legacy_file, &root, cap, grant.identity));

        // The ACL side is checked too: a complete record over a root that lost an ACE must repair, not skip.
        remove(&directory, &[cap]).unwrap();
        assert!(!root_permissions_match(&directory, &entries).unwrap());
        grant_at(root.to_str().unwrap(), group, cap, &journal).unwrap();
        assert!(root_permissions_match(&directory, &entries).unwrap());

        // An interrupted authorization repairs on the next command and ends with a complete record.
        let mut file = load_at(&journal).unwrap();
        file.grants[0].complete = false;
        save_at(&file, &journal).unwrap();
        assert!(!grant_reusable(
            &load_at(&journal).unwrap(),
            &root,
            cap,
            grant.identity
        ));
        grant_at(root.to_str().unwrap(), group, cap, &journal).unwrap();
        assert!(load_at(&journal).unwrap().grants[0].complete);

        // Reusing a completed grant still protects a reserved directory created since the last command.
        std::fs::create_dir(root.join(".aws")).unwrap();
        grant_at(root.to_str().unwrap(), group, cap, &journal).unwrap();
        assert!(
            aces(&root.join(".aws"))
                .iter()
                .any(|(kind, _, mask, sid)| *kind == 1 && sid == group && *mask == DENIED_WRITE)
        );
        drop(directory);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_file(journal).unwrap();
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

    fn scratch(name: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("unit-tmp")
            .join(format!("grants-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        root
    }

    #[test]
    fn grant_adds_inheritable_modify_and_reserved_denies_without_recording_elsewhere() {
        let root = scratch("apply");
        if !reads::may_change_dacl(&root) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let (group, cap) = ("S-1-5-21-1-2-3-9001", "S-1-5-21-1-2-3-9002");
        let directory = open_directory(&root).unwrap().unwrap();
        apply(
            &directory,
            &[(group, GRANT_ACCESS, MODIFY), (cap, GRANT_ACCESS, MODIFY)],
        )
        .unwrap();
        let git = open_directory(&root.join(".git")).unwrap().unwrap();
        apply(&git, &[(group, DENY_ACCESS, DENIED_WRITE)]).unwrap();
        drop(git);
        let top = aces(&root);
        for sid in [group, cap] {
            assert!(top.iter().any(|(kind, flags, mask, s)| *kind == 0
                && *flags as u32 & INHERIT == INHERIT
                && *mask == MODIFY
                && s == sid));
        }
        // Children inherit the grant.
        assert!(
            aces(&root.join("src"))
                .iter()
                .any(|(_, _, mask, s)| s == cap && *mask == MODIFY)
        );
        assert!(
            aces(&root.join(".git"))
                .iter()
                .any(|(kind, _, _, s)| *kind == 1 && s == group)
        );
        remove(&directory, &[group, cap]).unwrap();
        // The reserved directory's denial goes too, not only the allow ACEs.
        let git = open_directory(&root.join(".git")).unwrap().unwrap();
        remove(&git, &[group]).unwrap();
        drop(git);
        assert!(
            !aces(&root.join(".git"))
                .iter()
                .any(|(_, _, _, s)| s == group)
        );
        drop(directory);
        assert!(
            !aces(&root)
                .iter()
                .any(|(_, _, _, s)| s == group || s == cap)
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J failed");
    }

    fn set_dacl(path: &Path, sddl: &str) {
        let mut descriptor = null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(sddl).unwrap().as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            },
            0
        );
        let (mut present, mut defaulted, mut dacl) = (0, 0, null_mut());
        unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) };
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide(path.to_str().unwrap()).unwrap().as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            )
        };
        unsafe { LocalFree(descriptor) };
        assert_eq!(status, ERROR_SUCCESS);
    }

    /// The group's explicit deny is the first ACE, ahead of every allow.
    fn denied_ahead(path: &Path, group: &str) -> bool {
        matches!(aces(path).first(), Some((1, flags, mask, s))
            if s == group && *flags as u32 & INHERITED_ACE == 0 && mask & DENIED_WRITE == DENIED_WRITE)
    }

    #[test]
    fn reserved_junctions_are_skipped() {
        let root = scratch("junction");
        if !reads::may_change_dacl(&root) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let outside = root.with_file_name(format!("grants-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        junction(&root.join(".ssh"), &outside);
        let group = "S-1-5-21-1-2-3-9004";
        let parsed = sid(group).unwrap();
        assert!(!protect_reserved(&root.join(".ssh"), group, &parsed).unwrap());
        assert!(!aces(&outside).iter().any(|(_, _, _, s)| s == group));
        std::fs::remove_dir(root.join(".ssh")).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    /// Before each command: a reserved directory created since the last one and a worktree's `.git` file are denied,
    /// and a second pass only reads them.
    #[test]
    fn reserved_directories_and_git_files_are_denied_once_and_then_left_alone() {
        let root = scratch("protect");
        if !reads::may_change_dacl(&root) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let worktree = root.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../.git/worktrees/w").unwrap();
        let group = "S-1-5-21-1-2-3-9005";
        let parsed = sid(group).unwrap();
        assert!(protect_reserved(&root.join(".git"), group, &parsed).unwrap());
        assert!(protect_reserved(&worktree.join(".git"), group, &parsed).unwrap());
        assert!(!protect_reserved(&root.join(".ssh"), group, &parsed).unwrap());
        assert!(denied_ahead(&root.join(".git"), group));
        assert!(denied_ahead(&worktree.join(".git"), group));
        // The directory's denial reaches what is created inside it later.
        std::fs::write(root.join(".git").join("HEAD"), "ref").unwrap_or(());
        assert!(
            aces(&root.join(".git").join("HEAD"))
                .iter()
                .any(|(kind, flags, _, s)| *kind == 1
                    && s == group
                    && *flags as u32 & INHERITED_ACE != 0)
        );
        assert!(!protect_reserved(&root.join(".git"), group, &parsed).unwrap());
        assert!(!protect_reserved(&worktree.join(".git"), group, &parsed).unwrap());
        // Created after the grant: the next pass catches it.
        std::fs::create_dir(root.join(".ssh")).unwrap();
        assert!(protect_reserved(&root.join(".ssh"), group, &parsed).unwrap());
        assert!(denied_ahead(&root.join(".ssh"), group));
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A denial placed after an allow is not a denial, and a reserved object this user may not change cannot be
    /// protected: both must be refused, never reported as protected.
    #[test]
    fn a_reserved_object_with_permissions_of_its_own_is_refused() {
        let root = scratch("foreign");
        if !reads::may_change_dacl(&root) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let user = current_user_sid().unwrap();
        let group = "S-1-5-21-1-2-3-9006";
        let parsed = sid(group).unwrap();
        // The owner keeps only READ_CONTROL, the allow comes first, and nobody else may rewrite the DACL.
        let path = root.join(".agents");
        std::fs::create_dir(&path).unwrap();
        set_dacl(
            &path,
            &format!(
                "D:P(A;OICI;FA;;;SY)(A;OICI;0x1300a9;;;{user})(D;OICI;0x{DENIED_WRITE:x};;;{group})(A;OICI;RC;;;OW)"
            ),
        );
        let error = protect_reserved(&path, group, &parsed).unwrap_err();
        assert!(error.contains("cannot be protected"), "{error}");
        std::fs::remove_dir(&path).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// The root keeps the group from changing any DACL or owner in the workspace, and makes the owner's rights an
    /// ordinary ACE that the denial comes before; revoking takes the added entries back and preserves inherited rights.
    #[test]
    fn the_root_denies_the_group_dacl_changes_ahead_of_owner_rights() {
        let root = scratch("root-control");
        if !reads::may_change_dacl(&root) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let user = current_user_sid().unwrap();
        let (group, cap) = ("S-1-5-21-1-2-3-9007", "S-1-5-21-1-2-3-9008");
        std::fs::write(root.join("src").join("made-before"), "x").unwrap();
        let inherited_owner_rights: Vec<_> = aces(&root.join("src").join("made-before"))
            .into_iter()
            .filter(|(_, _, _, sid)| sid == OWNER_RIGHTS)
            .collect();
        let directory = open_directory(&root).unwrap().unwrap();
        apply(&directory, &root_entries(group, cap, &user)).unwrap();
        // Applying it twice (one grant per Host process) keeps the denial.
        apply(&directory, &root_entries(group, cap, &user)).unwrap();
        std::fs::write(root.join("src").join("made-later"), "x").unwrap();
        for path in [
            root.clone(),
            root.join("src"),
            root.join("src").join("made-later"),
        ] {
            let list = aces(&path);
            let deny = list
                .iter()
                .position(|(kind, _, mask, s)| *kind == 1 && s == group && *mask == DENIED_CONTROL)
                .unwrap_or_else(|| panic!("no control denial on {}", path.display()));
            let owner = list
                .iter()
                .position(|(kind, _, mask, s)| {
                    *kind == 0 && s == OWNER_RIGHTS && *mask == OWNER_ACCESS
                })
                .unwrap_or_else(|| panic!("no owner rights on {}", path.display()));
            assert!(deny < owner, "{}: {list:?}", path.display());
            assert!(list.iter().any(|(kind, _, mask, s)| *kind == 0
                && *s == user
                && mask & OWNER_ACCESS == OWNER_ACCESS));
        }
        remove(&directory, &root_trustees(group, cap)).unwrap();
        let list = aces(&root.join("src").join("made-later"));
        assert!(
            !list.iter().any(|(_, _, _, s)| s == group || s == cap),
            "{list:?}"
        );
        // The parent may already grant OWNER RIGHTS (for example in an agent workspace).
        // Revocation must remove our grant without removing those pre-existing inherited entries.
        assert_eq!(
            list.into_iter()
                .filter(|(_, _, _, sid)| sid == OWNER_RIGHTS)
                .collect::<Vec<_>>(),
            inherited_owner_rights
        );
        drop(directory);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A sandboxed command can rename a reserved directory away and put a junction in its place between the check
    /// and the DACL write. The write must still land on the directory that was checked, never on the link target.
    #[test]
    fn a_reserved_directory_swapped_for_a_junction_keeps_the_acl_on_the_checked_directory() {
        let root = scratch("swap");
        if !reads::may_change_dacl(&root) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let outside = root.with_file_name(format!("grants-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        let group = "S-1-5-21-1-2-3-9003";
        let checked = [open_pinned(&root.join(".git"), READ_CONTROL | WRITE_DAC)
            .unwrap()
            .unwrap()];
        std::fs::rename(root.join(".git"), root.join("moved")).unwrap();
        junction(&root.join(".git"), &outside);
        for directory in &checked {
            apply(directory, &[(group, DENY_ACCESS, DENIED_WRITE)]).unwrap();
        }
        assert!(!aces(&outside).iter().any(|(_, _, _, s)| s == group));
        assert!(
            aces(&root.join("moved"))
                .iter()
                .any(|(kind, _, _, s)| *kind == 1 && s == group)
        );
        drop(checked);
        std::fs::remove_dir(root.join(".git")).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn links_relative_paths_and_volume_roots_are_refused() {
        assert!(workspace_root("relative").is_err());
        assert!(workspace_root(r"C:\").is_err());
        assert!(workspace_root(r"C:\does-not-exist-yuantu").is_err());
        let root = scratch("ok");
        assert!(workspace_root(root.to_str().unwrap()).is_ok());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_policy_denies_secrets_and_ancestors_before_defaults_or_custom_paths() {
        let profile = Path::new(r"C:\Users\Alice");
        for relative in [
            ".ssh",
            ".AWS",
            ".gnupg",
            ".azure",
            ".kube",
            ".docker",
            r"AppData\Local\Google\Chrome\User Data",
            r"AppData\Roaming\Microsoft\Protect",
            r"AppData\Local\Microsoft\Credentials",
            ".yuantu",
            ".codex",
            "AppData",
        ] {
            assert!(
                !reads::allowed(&profile.join(relative), profile),
                "{relative}"
            );
        }
        assert!(!reads::allowed(profile, profile));
        assert!(!reads::allowed(Path::new(r"C:\Users"), profile));
        assert!(reads::allowed(
            &profile.join(r"AppData\Roaming\npm"),
            profile
        ));
        assert!(reads::allowed(&profile.join(".gitconfig"), profile));
        assert!(reads::allowed(Path::new(r"D:\Tools"), profile));
    }

    #[test]
    fn read_grants_are_rx_snapshots_and_revoke_preserves_foreign_aces() {
        let base = scratch("read");
        if !reads::may_change_dacl(&base) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let root = base.join("tool");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("bin/tool.cmd"), "echo ok").unwrap();
        let journal = base.join("reads.json");
        let profile = base.join("profile");
        let group = "S-1-5-21-1-2-3-9201";
        reads::grant_at(&root, &profile, group, &journal).unwrap();
        for file in [&root, &root.join("bin"), &root.join("bin/tool.cmd")] {
            assert!(aces(file).iter().any(|(kind, _, mask, s)| *kind == 0
                && s == group
                && *mask == reads::READ_EXECUTE));
            assert!(
                !aces(file)
                    .iter()
                    .any(|(_, _, mask, s)| s == group && *mask & DENIED_WRITE != 0)
            );
        }
        assert!(
            aces(&root)
                .iter()
                .any(|(_, flags, _, s)| s == group && *flags as u32 & INHERIT == 0)
        );
        assert!(journal.exists());
        apply(
            &open_directory(&root).unwrap().unwrap(),
            &[(group, REVOKE_ACCESS, 0)],
        )
        .unwrap();
        reads::grant_at(&root, &profile, group, &journal).unwrap();
        assert!(
            aces(&root)
                .iter()
                .any(|(_, _, mask, s)| s == group && *mask == reads::READ_EXECUTE)
        );
        // Newly created secrets must not inherit any read grant.
        std::fs::write(root.join("later"), "ok").unwrap();
        assert!(
            !aces(&root.join("later"))
                .iter()
                .any(|(_, _, _, s)| s == group)
        );
        std::fs::create_dir(root.join(".ssh")).unwrap();
        std::fs::write(root.join(".ssh/key"), "secret").unwrap();
        assert!(
            !aces(&root.join(".ssh/key"))
                .iter()
                .any(|(_, _, _, s)| s == group)
        );
        let foreign = "S-1-5-21-1-2-3-9202";
        let directory = open_directory(&root).unwrap().unwrap();
        apply(&directory, &[(foreign, GRANT_ACCESS, FILE_GENERIC_READ)]).unwrap();
        drop(directory);
        reads::revoke_at(&root, &profile, group, &journal).unwrap();
        assert!(
            !aces(&root.join("later"))
                .iter()
                .any(|(_, _, _, s)| s == group)
        );
        assert!(aces(&root).iter().any(|(_, _, _, s)| s == foreign));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_revoke_finds_renamed_roots_and_files_moved_outside_the_allowlist() {
        let base = scratch("read-moved");
        if !reads::may_change_dacl(&base) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let root = base.join("tool");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("file"), "tool").unwrap();
        let group = "S-1-5-21-1-2-3-9204";
        let journal = base.join("reads.json");
        reads::grant_at(&root, &base.join("profile"), group, &journal).unwrap();
        let moved_file = base.join("moved-file");
        std::fs::rename(root.join("file"), &moved_file).unwrap();
        // A tool updater can replace the old path; both identities must remain recoverable.
        std::fs::write(root.join("file"), "replacement").unwrap();
        reads::grant_at(&root, &base.join("profile"), group, &journal).unwrap();
        let moved_root = base.join("renamed-tool");
        std::fs::rename(&root, &moved_root).unwrap();
        reads::revoke_at(&root, &base.join("profile"), group, &journal).unwrap();
        for path in [&moved_file, &moved_root, &moved_root.join("file")] {
            assert!(!aces(path).iter().any(|(_, _, _, s)| s == group));
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn profile_ancestors_get_only_noninheritable_metadata_access_and_are_recoverable() {
        let base = scratch("metadata");
        if !reads::may_change_dacl(&base) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let profile = base.join("profile");
        let root = profile.join("AppData/Local/Temp/workspace");
        std::fs::create_dir_all(&root).unwrap();
        let secret = profile.join("secret");
        std::fs::write(&secret, "private").unwrap();
        let group = "S-1-5-21-1-2-3-9205";
        let journal = base.join("metadata.json");
        reads::grant_metadata_at(&root, &profile, group, &journal).unwrap();
        for parent in root
            .parent()
            .unwrap()
            .ancestors()
            .take_while(|parent| parent.starts_with(&profile))
        {
            assert!(aces(parent).iter().any(|(_, flags, mask, sid)| sid == group
                && *flags as u32 & INHERIT == 0
                && *mask == FILE_TRAVERSE | FILE_READ_ATTRIBUTES));
            assert!(
                !aces(parent)
                    .iter()
                    .any(|(_, _, mask, sid)| sid == group && *mask & FILE_LIST_DIRECTORY != 0)
            );
        }
        assert!(!aces(&secret).iter().any(|(_, _, _, sid)| sid == group));
        reads::revoke_metadata_at(&profile, group, &journal).unwrap();
        assert!(!aces(&profile).iter().any(|(_, _, _, sid)| sid == group));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_grants_refuse_hardlinks_and_nested_secret_directories_before_any_acl_change() {
        let base = scratch("read-refuse");
        let root = base.join("tool");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("file");
        std::fs::write(&file, "secret").unwrap();
        std::fs::hard_link(&file, root.join("alias")).unwrap();
        let group = "S-1-5-21-1-2-3-9203";
        let journal = base.join("reads.json");
        assert!(reads::grant_at(&root, &base.join("profile"), group, &journal).is_err());
        assert!(!journal.exists());
        assert!(!aces(&root).iter().any(|(_, _, _, s)| s == group));
        std::fs::remove_file(root.join("alias")).unwrap();
        std::fs::create_dir(root.join(".ssh")).unwrap();
        assert!(reads::grant_at(&root, &base.join("profile"), group, &journal).is_err());
        assert!(!journal.exists());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
