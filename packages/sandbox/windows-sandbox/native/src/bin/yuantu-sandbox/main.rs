//! Sandbox account executor: `exec` (per command, desktop user), `broker` (per host, desktop user),
//! and `runner` (per broker, sandbox account). See docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md.
mod broker;
mod desktop;
mod exec;
mod frame;
mod maintenance_handoff;
mod pipe;
mod protocol;
mod provision;
mod runner;
mod spawn;
mod terminal;
mod token;
mod win;

use win::Result;

fn usage() -> Result<u32> {
    Err("Expected: exec --broker PIPE --request FILE | broker --dev|--account offline|online | account-status [--verify] | grant --root R --capability S | ungrant --root R | read-grant --root R | read-ungrant --root R | read-refresh --env FILE | account-setup | account-uninstall | runner --control ID --owner SID --desktop NAME".into())
}

/// Marker the Host looks for to repair the executable's label; keep in step with `sandbox-account.ts`.
const LOW_INTEGRITY: &str = "helper-integrity-low";

/// Refuses to run below medium integrity.
///
/// Windows starts an image labelled Low at low integrity whatever its parent's level, and a low-integrity process
/// cannot write the sandbox state under the user's profile: every journal lock then fails with "access denied",
/// which reads like another Host holding it. A workspace folder labelled Low (as some other sandboxes leave one)
/// passes that label down to a development build of this helper. The runner is exempt: it is the sandbox account,
/// not the desktop user, and writes no state.
fn integrity_check() -> Result<()> {
    let token = win::current_token(windows_sys::Win32::Security::TOKEN_QUERY)?;
    let buffer =
        win::token_information(token.0, windows_sys::Win32::Security::TokenIntegrityLevel)?;
    let label = unsafe {
        &*(buffer.as_ptr() as *const windows_sys::Win32::Security::TOKEN_MANDATORY_LABEL)
    };
    let level = win::sid_text(label.Label.Sid)?;
    let rid = level
        .rsplit('-')
        .next()
        .and_then(|rid| rid.parse::<u32>().ok());
    if rid.is_some_and(|rid| rid >= 0x2000) {
        return Ok(());
    }
    let image = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "yuantu-sandbox.exe".into());
    Err(format!(
        "{LOW_INTEGRITY}: the sandbox helper is running at integrity {level} because its executable ({image}) \
         carries a Low mandatory label, usually inherited from the folder it sits in, so it cannot write the \
         sandbox state. Set the executable's label to Medium (icacls \"{image}\" /setintegritylevel M) or move it \
         out of that folder."
    ))
}

fn main_result() -> Result<u32> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
    if arguments.first() != Some(&"runner") {
        integrity_check()?;
    }
    match arguments.as_slice() {
        ["exec", "--broker", broker, "--request", request] => Ok(exec::run(broker, request)),
        #[cfg(debug_assertions)]
        ["broker", "--dev"] => broker::run(broker::Launch::Dev),
        ["broker", "--account", account] => {
            match yuantu_sandbox::account::Account::parse(account) {
                Some(account) => broker::run(broker::Launch::Account(account)),
                None => usage(),
            }
        }
        ["account-status"] => provision::print_status(),
        ["account-status", "--verify"] => provision::print_verify(),
        ["grant", "--root", root, "--capability", capability] => provision::grant(root, capability),
        ["ungrant", "--root", root] => provision::ungrant(root),
        ["read-grant", "--root", root] => provision::read_grant(root, false),
        ["read-ungrant", "--root", root] => provision::read_grant(root, true),
        ["read-refresh", "--env", file] => provision::read_refresh(file),
        ["account-setup"] => provision::setup(),
        ["account-uninstall"] => provision::uninstall(),
        ["account-initialize", "--handoff", pipe] => provision::initialize_handoff(pipe),
        ["account-remove", "--elevated"] => provision::remove_elevated(),
        ["account-remove", "--handoff", pipe] => provision::remove_handoff(pipe),
        [
            "runner",
            "--control",
            control,
            "--owner",
            owner,
            "--desktop",
            desktop,
        ] if control.len() == 32
            && desktop::validate_name(desktop)
            && control.bytes().all(|b| b.is_ascii_hexdigit())
            && owner.starts_with("S-1-5-")
            && owner[6..].bytes().all(|b| b.is_ascii_digit() || b == b'-') =>
        {
            runner::run(control, owner, desktop)
        }
        _ => usage(),
    }
}

fn main() {
    match main_result() {
        Ok(code) => std::process::exit(code as i32),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}
