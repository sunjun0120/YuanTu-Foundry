//! `read-refresh`: the automatic read roots, granted before the first sandboxed command of a Host process.
//!
//! The desktop side calls this once per environment (see `ensureReadRefresh` in `sandbox-account.ts`), unelevated:
//! roots are discovered from `PATH` and the toolchain variables, each new root gets one inheritable
//! `YuanTuSandboxUsers` RX ACE plus explicit denials on the credential files inside it, and a root that is no
//! longer discovered is revoked: uninstalling a toolchain shrinks the allowlist by itself.
//!
//! One journal lock covers a whole refresh, so the `_locked` primitives are called directly; every one of them still
//! writes the journal before touching an ACL.
use super::{
    credentials,
    grants::reads::{self, Mode, Source},
    read_roots,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

/// What one refresh did, for the helper's stdout and the Host's log.
#[derive(Serialize, Debug, Default)]
pub struct RefreshReport {
    pub version: u32,
    /// Roots that now carry the group's inheritable read ACE.
    pub roots: Vec<String>,
    /// Roots that could not be granted; the command still runs, without read access to them.
    pub skipped: Vec<SkippedRoot>,
}

#[derive(Serialize, Debug)]
pub struct SkippedRoot {
    pub path: String,
    pub reason: String,
}

pub fn refresh(env: &BTreeMap<String, String>, group: &str) -> crate::Result<RefreshReport> {
    let profile = credentials::profile_directory()?;
    refresh_with(env, group, &profile, &reads::journal_path()?)
}

pub(crate) fn refresh_with(
    env: &BTreeMap<String, String>,
    group: &str,
    profile: &Path,
    journal_path: &Path,
) -> crate::Result<RefreshReport> {
    let discovered = read_roots::discover(env, profile);
    let _lock = reads::journal_lock(journal_path)?;
    let mut journal = reads::load(journal_path)?;
    let mut report = RefreshReport {
        version: 1,
        roots: Vec::new(),
        skipped: Vec::new(),
    };
    // 1. Grant every discovered root, and re-run the credential guard on the ones already granted: a token file
    //    created since the last refresh must be denied too.
    for root in &discovered {
        let granted =
            match reads::grant_inherit_locked(root, profile, group, &mut journal, journal_path) {
                Ok(granted) => granted,
                Err(reason) => {
                    report.skip(root, reason);
                    continue;
                }
            };
        if !granted {
            // `Users` (or everyone) can already read it: no ACE, no journal entry, nothing to guard.
            continue;
        }
        if let Err(reason) =
            reads::guard_credentials_locked(root, group, &mut journal, journal_path)
        {
            // The root withdrew its own grant rather than stay partly readable.
            report.skip(root, reason);
            continue;
        }
        report.roots.push(display(root));
    }
    // 2. Revoke the automatic roots this environment no longer names, in reverse so the earlier indices stay valid.
    let discovered: BTreeSet<String> = discovered.iter().map(|root| reads::key(root)).collect();
    let stale: Vec<usize> = journal
        .grants
        .iter()
        .enumerate()
        .filter(|(_, grant)| {
            grant.source == Source::Auto
                && grant.mode == Mode::Inherit
                && !discovered.contains(&reads::key(&grant.root))
        })
        .map(|(index, _)| index)
        .collect();
    for index in stale.into_iter().rev() {
        let root = journal.grants[index].root.clone();
        if let Err(reason) = reads::revoke_inherit_locked(index, group, &mut journal, journal_path)
        {
            report.skip(&root, reason);
        }
    }
    // 3. `%USERPROFILE%\.gitconfig` is a file, so it keeps the snapshot grant: refresh authorizes it once and takes
    //    it back when the file disappears.
    let gitconfig = profile.join(".gitconfig");
    let recorded = journal.grants.iter().any(|grant| {
        grant.source == Source::Auto
            && grant.mode == Mode::Snapshot
            && reads::key(&grant.root) == reads::key(&gitconfig)
    });
    if gitconfig.is_file() {
        if !recorded {
            match reads::grant_snapshot_locked(
                &gitconfig,
                profile,
                group,
                Source::Auto,
                &mut journal,
                journal_path,
            ) {
                Ok(()) => report.roots.push(display(&gitconfig)),
                Err(reason) => report.skip(&gitconfig, reason),
            }
        }
    } else if recorded {
        if let Err(reason) =
            reads::revoke_snapshot_at(&gitconfig, group, &mut journal, journal_path)
        {
            report.skip(&gitconfig, reason);
        }
    }
    Ok(report)
}

impl RefreshReport {
    fn skip(&mut self, path: &Path, reason: String) {
        self.skipped.push(SkippedRoot {
            path: display(path),
            reason,
        });
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::grants::reads::Journal;
    use std::path::PathBuf;

    struct Fixture {
        base: PathBuf,
        profile: PathBuf,
        env: BTreeMap<String, String>,
        journal: PathBuf,
        group: String,
    }
    impl Fixture {
        fn new(name: &str) -> Fixture {
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("unit-tmp")
                .join(format!("read-refresh-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            let profile = base.join("Profile");
            std::fs::create_dir_all(&profile).unwrap();
            reads::make_profile_like(&base);
            Fixture {
                journal: base.join("read-grants.json"),
                base,
                profile,
                env: BTreeMap::new(),
                group: "S-1-5-21-1-2-3-9401".into(),
            }
        }
        fn tools(&self) -> PathBuf {
            let path = self.profile.join("Tools");
            std::fs::create_dir_all(&path).unwrap();
            path
        }
        fn refresh(&mut self) -> RefreshReport {
            refresh_with(&self.env, &self.group, &self.profile, &self.journal).unwrap()
        }
        fn journal(&self) -> Journal {
            reads::load(&self.journal).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn a_new_root_is_granted_guarded_and_recorded_as_automatic() {
        let mut fixture = Fixture::new("new");
        if !reads::may_change_dacl(&fixture.profile) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let tools = fixture.tools();
        std::fs::write(tools.join(".npmrc"), "token").unwrap();
        fixture.env.insert("PATH".into(), display(&tools));
        let report = fixture.refresh();
        assert_eq!(report.roots, vec![display(&tools)]);
        assert!(report.skipped.is_empty());
        let journal = fixture.journal();
        assert_eq!(journal.version, 2);
        assert_eq!(journal.grants.len(), 1);
        assert_eq!(journal.grants[0].source, Source::Auto);
        assert_eq!(journal.grants[0].mode, Mode::Inherit);
        assert_eq!(
            journal.grants[0].guards.len(),
            1,
            "{:?}",
            journal.grants[0].guards
        );
        // A second refresh with the same environment changes nothing.
        let again = fixture.refresh();
        assert_eq!(again.roots, report.roots);
        assert_eq!(fixture.journal().grants.len(), 1);
        assert_eq!(fixture.journal().grants[0].guards.len(), 1);
    }

    #[test]
    fn a_root_the_environment_stopped_naming_is_revoked() {
        let mut fixture = Fixture::new("stale");
        if !reads::may_change_dacl(&fixture.profile) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let tools = fixture.tools();
        fixture.env.insert("PATH".into(), display(&tools));
        assert_eq!(fixture.refresh().roots, vec![display(&tools)]);
        assert_eq!(fixture.journal().grants.len(), 1);
        fixture.env.remove("PATH");
        let report = fixture.refresh();
        assert!(report.roots.is_empty());
        assert!(report.skipped.is_empty());
        assert!(fixture.journal().grants.is_empty());
    }

    #[test]
    fn a_missing_gitconfig_is_granted_only_while_it_exists() {
        let mut fixture = Fixture::new("gitconfig");
        if !reads::may_change_dacl(&fixture.profile) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        let gitconfig = fixture.profile.join(".gitconfig");
        std::fs::write(&gitconfig, "[user]").unwrap();
        assert_eq!(fixture.refresh().roots, vec![display(&gitconfig)]);
        let journal = fixture.journal();
        assert_eq!(journal.grants.len(), 1);
        assert_eq!(journal.grants[0].source, Source::Auto);
        assert_eq!(journal.grants[0].mode, Mode::Snapshot);
        std::fs::remove_file(&gitconfig).unwrap();
        let report = fixture.refresh();
        assert!(report.roots.is_empty());
        assert!(fixture.journal().grants.is_empty());
    }

    #[test]
    fn a_root_outside_the_profile_is_skipped_rather_than_failing_the_refresh() {
        let mut fixture = Fixture::new("outside");
        if !reads::may_change_dacl(&fixture.profile) {
            eprintln!("this session cannot change a DACL; skipping");
            return;
        }
        // `discover` drops it, so the refresh simply has nothing to grant.
        let outside = fixture.base.join("Elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        fixture.env.insert("PATH".into(), display(&outside));
        let report = fixture.refresh();
        assert!(report.roots.is_empty());
        assert!(report.skipped.is_empty());
        assert!(fixture.journal().grants.is_empty());
    }
}
