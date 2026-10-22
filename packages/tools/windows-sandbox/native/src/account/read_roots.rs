//! Which toolchain roots a sandboxed command may read without anybody naming them.
//!
//! `discover` is a pure function of the desktop user's environment and profile: `PATH` and the usual toolchain
//! variables name the candidates, and everything missing, outside the profile, or refused by the read policy is
//! dropped. `read_grants::grant_inherit_at` turns each surviving root into one inheritable read ACE, so a tool
//! installed under a listed root later is readable without another refresh.
//!
//! Only roots are discovered here. A single file (`%USERPROFILE%\.gitconfig`) keeps the snapshot grant instead,
//! because nothing under a file can be inherited.
use super::grants::reads::{allowed, key, under};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// Directories a sandboxed command may read, deduplicated, canonical, and reduced to the outermost roots.
pub fn discover(env: &BTreeMap<String, String>, profile: &Path) -> Vec<PathBuf> {
    let home = profile;
    let local = variable(env, "LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local"));
    let roaming = variable(env, "APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming"));
    let path: Vec<PathBuf> = variable(env, "PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    let mut candidates: Vec<PathBuf> = Vec::new();
    // 1. PATH entries under the profile: the toolchain the user's shell already finds.
    candidates.extend(path.iter().filter(|directory| under(&key(directory), &key(home))).cloned());
    // 2. Toolchains whose executables live in `bin`, and whose own root holds credentials: grant only `bin`.
    candidates.push(variable(env, "CARGO_HOME").unwrap_or_else(|| home.join(".cargo")).join("bin"));
    candidates.push(variable(env, "GOPATH").unwrap_or_else(|| home.join("go")).join("bin"));
    candidates.push(home.join(".bun").join("bin"));
    candidates.push(home.join(".deno").join("bin"));
    // 3. Self-contained roots: the toolchain is the directory, and its layout is not a credential store.
    candidates.push(variable(env, "RUSTUP_HOME").unwrap_or_else(|| home.join(".rustup")));
    candidates.extend(variable(env, "NVM_HOME"));
    candidates.extend(variable(env, "NVM_SYMLINK"));
    candidates.push(variable(env, "PNPM_HOME").unwrap_or_else(|| local.join("pnpm")));
    candidates.push(roaming.join("npm"));
    let scoop = variable(env, "SCOOP").unwrap_or_else(|| home.join("scoop"));
    candidates.push(scoop.join("shims"));
    candidates.push(scoop.join("apps"));
    // 4. Per-user program installations: the entries PATH already names, never `Programs` itself.
    if let Ok(entries) = std::fs::read_dir(local.join("Programs")) {
        for entry in entries.flatten() {
            let installed = entry.path();
            if path.iter().any(|directory| under(&key(directory), &key(&installed))) {
                candidates.push(installed);
            }
        }
    }
    let mut roots: Vec<PathBuf> = candidates
        .iter()
        .filter_map(|candidate| root(candidate, home))
        .collect();
    roots.sort();
    roots.dedup();
    // One ACE on a parent covers every child: grant the outermost root only, or the child's ACE would be a
    // second, redundant grant that refresh then has to keep in step.
    let mut kept: Vec<PathBuf> = Vec::new();
    for root in roots {
        if kept.iter().any(|parent| under(&key(&root), &key(parent))) {
            continue;
        }
        kept.retain(|child| !under(&key(child), &key(&root)));
        kept.push(root);
    }
    kept
}

/// One environment value. Windows stores names in whatever case the writer used (`Path` is the usual spelling of
/// `PATH`), and the environment itself is case-insensitive, so the lookup has to be too.
fn variable(env: &BTreeMap<String, String>, name: &str) -> Option<PathBuf> {
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// A candidate as the one path the read grant will use: resolved, under the profile, and allowed by the policy.
fn root(candidate: &Path, profile: &Path) -> Option<PathBuf> {
    if !candidate.is_absolute() {
        return None;
    }
    let canonical = std::fs::canonicalize(candidate).ok()?;
    let text = canonical.to_string_lossy();
    let canonical = PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text));
    let value = key(&canonical);
    if !under(&value, &key(profile)) || value == key(profile) || !canonical.is_dir() {
        return None;
    }
    allowed(&canonical, profile).then_some(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        profile: PathBuf,
        env: BTreeMap<String, String>,
    }
    impl Fixture {
        fn new(name: &str) -> Fixture {
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/unit-tmp")
                .join(format!("read-roots-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            let profile = base.join("Profile");
            std::fs::create_dir_all(&profile).unwrap();
            Fixture {
                profile,
                env: BTreeMap::new(),
            }
        }
        fn dir(&mut self, relative: &str) -> PathBuf {
            let path = self.profile.join(relative);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
        /// Absolute form of a directory that lives outside any profile.
        fn outside(&self, name: &str) -> PathBuf {
            let path = self.profile.parent().unwrap().join(name);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
        fn discover(&self) -> Vec<PathBuf> {
            discover(&self.env, &self.profile)
        }
        fn has(&self, roots: &[PathBuf], relative: &str) -> bool {
            let want = key(&self.profile.join(relative));
            roots.iter().any(|root| key(root) == want)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.profile.parent().unwrap());
        }
    }

    #[test]
    fn only_path_entries_inside_the_profile_are_read_roots() {
        let mut fixture = Fixture::new("path");
        let inside = fixture.dir(r"Tools\bin");
        let outside = fixture.outside("Elsewhere");
        fixture.env.insert(
            "PATH".into(),
            std::env::join_paths([inside.clone(), outside, PathBuf::from(r"C:\Windows\System32")])
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        let roots = fixture.discover();
        assert!(roots.contains(&inside));
        assert_eq!(roots.len(), 1, "{roots:?}");
        // A relative PATH entry may not depend on the helper's working directory.
        fixture.env.insert("PATH".into(), r"Tools\bin".into());
        assert!(fixture.discover().is_empty());
    }

    #[test]
    fn the_defaults_are_used_when_the_variables_are_absent() {
        let mut fixture = Fixture::new("defaults");
        for directory in [
            r".cargo\bin",
            ".rustup",
            "go/bin",
            r"AppData\Roaming\npm",
            r"AppData\Local\pnpm",
            ".bun/bin",
            ".deno/bin",
            r"scoop\shims",
            r"scoop\apps",
        ] {
            fixture.dir(directory);
        }
        // `.cargo` itself may hold `credentials.toml`, so only its `bin` is a root.
        fixture.dir(".cargo");
        fixture.dir("go");
        let roots = fixture.discover();
        for directory in [
            r".cargo\bin",
            ".rustup",
            "go/bin",
            r"AppData\Roaming\npm",
            r"AppData\Local\pnpm",
            ".bun/bin",
            ".deno/bin",
            r"scoop\shims",
            r"scoop\apps",
        ] {
            assert!(fixture.has(&roots, directory), "{directory}: {roots:?}");
        }
        assert!(!fixture.has(&roots, ".cargo"));
        assert!(!fixture.has(&roots, "go"));
    }

    #[test]
    fn the_environment_moves_every_root_it_names() {
        let mut fixture = Fixture::new("env");
        for directory in [r"tools\bin", r"tools\cargo\bin", r"tools\rustup", r"tools\nvm", r"tools\pnpm", r"tools\scoop\shims", r"tools\scoop\apps"] {
            fixture.dir(directory);
        }
        // Windows stores these names in whatever case the writer used: `Path` is the usual spelling of `PATH`, and
        // the environment itself is case-insensitive.
        fixture.env.insert("Path".into(), fixture.profile.join(r"tools\bin").to_string_lossy().into_owned());
        fixture.env.insert("CARGO_HOME".into(), fixture.profile.join(r"tools\cargo").to_string_lossy().into_owned());
        fixture.env.insert("RUSTUP_HOME".into(), fixture.profile.join(r"tools\rustup").to_string_lossy().into_owned());
        fixture.env.insert("NVM_HOME".into(), fixture.profile.join(r"tools\nvm").to_string_lossy().into_owned());
        fixture.env.insert("PNPM_HOME".into(), fixture.profile.join(r"tools\pnpm").to_string_lossy().into_owned());
        fixture.env.insert("SCOOP".into(), fixture.profile.join(r"tools\scoop").to_string_lossy().into_owned());
        // A symlink outside the profile is not ours to grant; neither is an empty NVM_SYMLINK.
        fixture.env.insert("NVM_SYMLINK".into(), fixture.outside("nodejs").to_string_lossy().into_owned());
        fixture.env.insert("GOPATH".into(), String::new());
        let roots = fixture.discover();
        for directory in [r"tools\bin", r"tools\cargo\bin", r"tools\rustup", r"tools\nvm", r"tools\pnpm", r"tools\scoop\shims", r"tools\scoop\apps"] {
            assert!(fixture.has(&roots, directory), "{directory}: {roots:?}");
        }
        assert_eq!(roots.len(), 7, "{roots:?}");
    }

    #[test]
    fn a_child_root_is_replaced_by_its_parent() {
        let mut fixture = Fixture::new("nested");
        let parent = fixture.dir(r"Tools");
        fixture.dir(r"Tools\bin");
        fixture.dir(r"Tools\bin\extra");
        fixture.env.insert(
            "PATH".into(),
            std::env::join_paths([
                fixture.profile.join(r"Tools\bin"),
                fixture.profile.join(r"Tools\bin\extra"),
                fixture.profile.join("Tools"),
            ])
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        );
        assert_eq!(fixture.discover(), vec![parent]);
    }

    #[test]
    fn profile_program_installations_are_taken_only_when_path_names_them() {
        let mut fixture = Fixture::new("programs");
        let named = fixture.dir(r"AppData\Local\Programs\Editor");
        fixture.dir(r"AppData\Local\Programs\Editor\bin");
        fixture.dir(r"AppData\Local\Programs\Unrelated");
        fixture.env.insert(
            "PATH".into(),
            fixture
                .profile
                .join(r"AppData\Local\Programs\Editor\bin")
                .to_string_lossy()
                .into_owned(),
        );
        let roots = fixture.discover();
        // The install directory covers the `bin` PATH names, without granting the whole `Programs` tree.
        assert_eq!(roots, vec![named]);
    }

    #[test]
    fn missing_outside_and_refused_candidates_are_dropped() {
        let mut fixture = Fixture::new("refused");
        let secret = fixture.dir(r".ssh");
        let cargo_bin = fixture.dir(r".cargo\bin");
        fixture.env.insert(
            "PATH".into(),
            std::env::join_paths([
                fixture.profile.clone(),
                secret,
                cargo_bin.clone(),
                fixture.profile.join("missing"),
            ])
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        );
        assert_eq!(fixture.discover(), vec![cargo_bin]);
    }
}
