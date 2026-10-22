//! Standing workspace grants, the way Codex grants them: the sandbox group and the workspace's capability SID
//! each get an inheritable Modify ACE on the workspace root, kept until the workspace is ungranted or the
//! backend is uninstalled. Only a write-restricted token that carries this workspace's capability — which only
//! the runner creates — passes both access checks, so the ACEs do nothing for any other process.
//! Every grant is recorded in `grants.json` so uninstall can take it back.
use super::credentials::state_directory;
use crate::{Result, wide};
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

/// Directories a sandboxed command must never write, even inside its workspace.
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
const INHERIT: u32 = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
const FILE_ATTRIBUTE_REPARSE: u32 = 0x400;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub root: String,
    pub capability: String,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
struct GrantFile {
    version: u32,
    grants: Vec<Grant>,
}

fn grants_path() -> Result<PathBuf> {
    Ok(state_directory()?.join("grants.json"))
}

fn load() -> Result<GrantFile> {
    match std::fs::read(grants_path()?) {
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
    let path = grants_path()?;
    let directory = path.parent().ok_or("Invalid grant record path")?;
    std::fs::create_dir_all(directory).map_err(|_| "Create sandbox state directory failed")?;
    let temporary = directory.join(format!("grants.{}.tmp", std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec(file).map_err(|_| "Serialize grants")?,
    )
    .map_err(|_| "Write sandbox grant record failed")?;
    std::fs::rename(&temporary, &path).map_err(|_| "Replace sandbox grant record failed".into())
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

/// Merges explicit entries into a path's DACL. `SetNamedSecurityInfoW` propagates inheritable ACEs to
/// existing children.
fn apply(path: &Path, entries: &[(&str, ACCESS_MODE, u32)]) -> Result<()> {
    let name = wide(path.to_str().ok_or("Invalid path")?)?;
    let (mut dacl, mut descriptor) = (null_mut(), null_mut());
    let status = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Read permissions of {}: Windows error {status}",
            path.display()
        ));
    }
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
            grfInheritance: INHERIT,
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
    let status =
        unsafe { SetEntriesInAclW(explicit.len() as u32, explicit.as_ptr(), dacl, &mut merged) };
    let result = if status != ERROR_SUCCESS {
        Err(format!("Merge permissions: Windows error {status}"))
    } else {
        let status = unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                merged,
                null(),
            )
        };
        if status != ERROR_SUCCESS {
            Err(format!(
                "Write permissions of {}: Windows error {status}",
                path.display()
            ))
        } else {
            Ok(())
        }
    };
    unsafe {
        LocalFree(merged as _);
        LocalFree(descriptor);
    }
    result
}

fn reserved_under(root: &Path) -> Vec<PathBuf> {
    RESERVED
        .iter()
        .map(|name| root.join(name))
        .filter(|path| {
            std::fs::symlink_metadata(path)
                .map(|m| m.is_dir() && m.file_attributes() & FILE_ATTRIBUTE_REPARSE == 0)
                .unwrap_or(false)
        })
        .collect()
}

/// Grants `group_sid` and `capability_sid` Modify on `root`, denies the group writes to reserved directories,
/// and records the grant. Granting the same root again only refreshes it.
pub fn grant(root: &str, group_sid: &str, capability_sid: &str) -> Result<Grant> {
    let _lock = reads::journal_lock(&grants_path()?)?;
    let root = workspace_root(root)?;
    for reserved in reserved_under(&root) {
        apply(&reserved, &[(group_sid, DENY_ACCESS, DENIED_WRITE)])?;
    }
    apply(
        &root,
        &[
            (group_sid, GRANT_ACCESS, MODIFY),
            (capability_sid, GRANT_ACCESS, MODIFY),
        ],
    )?;
    let grant = Grant {
        root: root.to_string_lossy().into_owned(),
        capability: capability_sid.to_string(),
    };
    let mut file = load()?;
    file.version = 1;
    file.grants
        .retain(|existing| !existing.root.eq_ignore_ascii_case(&grant.root));
    file.grants.push(grant.clone());
    save(&file)?;
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
    let path = Path::new(&grant.root);
    if path.exists() {
        for reserved in reserved_under(path) {
            apply(&reserved, &[(group_sid, REVOKE_ACCESS, 0)])?;
        }
        apply(
            path,
            &[
                (group_sid, REVOKE_ACCESS, 0),
                (&grant.capability, REVOKE_ACCESS, 0),
            ],
        )?;
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
        apply(
            &root,
            &[(group, GRANT_ACCESS, MODIFY), (cap, GRANT_ACCESS, MODIFY)],
        )
        .unwrap();
        apply(&root.join(".git"), &[(group, DENY_ACCESS, DENIED_WRITE)]).unwrap();
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
        apply(&root, &[(group, REVOKE_ACCESS, 0), (cap, REVOKE_ACCESS, 0)]).unwrap();
        assert!(
            !aces(&root)
                .iter()
                .any(|(_, _, _, s)| s == group || s == cap)
        );
        std::fs::remove_dir_all(&root).unwrap();
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
        apply(&root, &[(group, REVOKE_ACCESS, 0)]).unwrap();
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
        apply(&root, &[(foreign, GRANT_ACCESS, FILE_GENERIC_READ)]).unwrap();
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
