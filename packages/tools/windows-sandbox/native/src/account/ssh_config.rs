//! The files `~/.ssh/config` points at — keys, certificates, known-hosts lists and control sockets kept outside
//! `.ssh` — so a directory holding one never becomes a sandbox read root. `.ssh` itself is already refused by name;
//! this covers `IdentityFile ~/keys/id_ed25519` and the like. Ported from Codex `ssh_config_dependencies.rs`
//! (openai/codex@86e17e9), without its `glob` dependency: `Include` wildcards are honoured in the last component.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

/// Directives whose arguments are paths, lower-cased as `ssh` matches them.
const PATH_DIRECTIVES: &[&str] = &[
    "certificatefile",
    "controlpath",
    "globalknownhostsfile",
    "identityagent",
    "identityfile",
    "revokedhostkeys",
    "userknownhostsfile",
];
const MAX_INCLUDE_DEPTH: usize = 32;

/// `~/.ssh/config` and every file it, or a file it includes, names. An unreadable or missing config names nothing.
pub fn dependencies(profile: &Path) -> Vec<PathBuf> {
    let ssh = profile.join(".ssh");
    let config = ssh.join("config");
    let mut found = vec![config.clone()];
    visit(&config, profile, &ssh, &mut HashSet::new(), &mut found, 0);
    found
}

fn visit(
    file: &Path,
    profile: &Path,
    ssh: &Path,
    visited: &mut HashSet<PathBuf>,
    found: &mut Vec<PathBuf>,
    depth: usize,
) {
    if depth == MAX_INCLUDE_DEPTH {
        return;
    }
    if !visited.insert(std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf())) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    for (key, arguments) in text.lines().filter_map(directive) {
        let key = key.to_ascii_lowercase();
        if key == "include" {
            for argument in arguments {
                for included in includes(&argument, profile, ssh) {
                    found.push(included.clone());
                    visit(&included, profile, ssh, visited, found, depth + 1);
                }
            }
        } else if PATH_DIRECTIVES.contains(&key.as_str()) {
            found.extend(
                arguments
                    .iter()
                    .filter_map(|argument| expand(argument, profile, None)),
            );
        }
    }
}

/// The existing files an `Include` argument names. Relative patterns start at `~/.ssh`, as `ssh` reads them.
fn includes(argument: &str, profile: &Path, ssh: &Path) -> Vec<PathBuf> {
    let Some(pattern) = expand(argument, profile, Some(ssh)) else {
        return Vec::new();
    };
    let (Some(parent), Some(name)) = (pattern.parent(), pattern.file_name()) else {
        return Vec::new();
    };
    let name = name.to_string_lossy();
    if !name.contains(['*', '?']) {
        return if pattern.is_file() {
            vec![pattern]
        } else {
            Vec::new()
        };
    }
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut matched: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| wildcard(&name, &entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    matched.sort();
    matched
}

/// `*` and `?` against one file name, case-insensitively as Windows file names compare.
fn wildcard(pattern: &str, name: &str) -> bool {
    let (pattern, name): (Vec<char>, Vec<char>) = (
        pattern.to_lowercase().chars().collect(),
        name.to_lowercase().chars().collect(),
    );
    let (mut p, mut n, mut star, mut mark) = (0, 0, None, 0);
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = n;
            p += 1;
        } else if let Some(position) = star {
            p = position + 1;
            mark += 1;
            n = mark;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

/// One config line as its keyword and arguments, accepting both `Key value` and `Key=value`.
fn directive(line: &str) -> Option<(String, Vec<String>)> {
    let mut words = words(line);
    let first = words.first()?.clone();
    if let Some((key, value)) = first.split_once('=')
        && !key.is_empty()
    {
        let mut arguments = Vec::new();
        if !value.is_empty() {
            arguments.push(value.to_string());
        }
        arguments.extend(words.drain(1..));
        return Some((key.to_string(), arguments));
    }
    let key = words.remove(0);
    if let Some(argument) = words.first_mut()
        && let Some(value) = argument.strip_prefix('=')
    {
        *argument = value.to_string();
    }
    words.retain(|argument| !argument.is_empty());
    Some((key, words))
}

/// Splits on unquoted whitespace, honouring quotes, backslash escapes and `#` comments.
fn words(line: &str) -> Vec<String> {
    let (mut out, mut word, mut quote) = (Vec::new(), String::new(), None);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '#' if quote.is_none() => break,
            '\'' | '"' if quote == Some(c) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(c),
            '\\' => match chars.peek() {
                Some(&next)
                    if matches!(next, '\'' | '"' | '\\') || (quote.is_none() && next == ' ') =>
                {
                    word.push(next);
                    chars.next();
                }
                _ => word.push(c),
            },
            c if c.is_whitespace() && quote.is_none() => {
                if !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
            }
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// `~`, `%d` and `${HOME}` are the profile; other relative paths resolve against `relative` when given.
fn expand(argument: &str, profile: &Path, relative: Option<&Path>) -> Option<PathBuf> {
    if argument.eq_ignore_ascii_case("none") {
        return None;
    }
    if matches!(argument, "~" | "%d" | "${HOME}") {
        return Some(profile.to_path_buf());
    }
    for prefix in ["~/", r"~\", "%d/", r"%d\", "${HOME}/", r"${HOME}\"] {
        if let Some(rest) = argument.strip_prefix(prefix) {
            return Some(profile.join(rest));
        }
    }
    let path = PathBuf::from(argument);
    if path.is_absolute() {
        Some(path)
    } else {
        relative.map(|base| base.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Profile(PathBuf);
    impl Profile {
        fn new(name: &str) -> Profile {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("unit-tmp")
                .join(format!("ssh-config-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join(".ssh")).unwrap();
            Profile(root)
        }
        fn write(&self, relative: &str, text: &str) {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }
    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn without_a_config_only_the_config_path_is_named() {
        let profile = Profile::new("none");
        assert_eq!(
            dependencies(&profile.0),
            vec![profile.0.join(r".ssh\config")]
        );
    }

    #[test]
    fn path_directives_expand_the_home_forms_and_skip_none() {
        let profile = Profile::new("paths");
        profile.write(
            r".ssh\config",
            "Host *\n  IdentityFile ~/keys/id_ed25519\n  CertificateFile=%d/certs/id-cert.pub\n  \
             UserKnownHostsFile \"${HOME}/known hosts\"\n  IdentityFile none\n  User git # IdentityFile ~/ignored\n",
        );
        let found = dependencies(&profile.0);
        for expected in [
            profile.0.join(r"keys/id_ed25519"),
            profile.0.join(r"certs/id-cert.pub"),
            profile.0.join(r"known hosts"),
        ] {
            assert!(
                found.contains(&expected),
                "{expected:?} missing from {found:?}"
            );
        }
        assert!(
            !found
                .iter()
                .any(|path| path.ends_with("none") || path.ends_with("ignored"))
        );
    }

    #[test]
    fn includes_are_followed_with_last_component_wildcards() {
        let profile = Profile::new("include");
        profile.write(r".ssh\config", "Include config.d/*.conf\n");
        profile.write(r".ssh\config.d\work.conf", "IdentityFile ~/work/key\n");
        profile.write(r".ssh\config.d\notes.txt", "IdentityFile ~/never\n");
        let found = dependencies(&profile.0);
        assert!(
            found.contains(&profile.0.join(r".ssh\config.d\work.conf")),
            "{found:?}"
        );
        assert!(found.contains(&profile.0.join("work/key")), "{found:?}");
        assert!(!found.contains(&profile.0.join("never")), "{found:?}");
    }

    #[test]
    fn an_include_cycle_ends() {
        let profile = Profile::new("cycle");
        profile.write(r".ssh\config", "Include ~/.ssh/config\nIdentityFile ~/k\n");
        let found = dependencies(&profile.0);
        assert!(found.contains(&profile.0.join("k")));
    }
}
