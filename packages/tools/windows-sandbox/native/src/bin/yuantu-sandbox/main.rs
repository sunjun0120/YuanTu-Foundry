//! Sandbox account executor: `exec` (per command, desktop user), `broker` (per host, desktop user),
//! and `runner` (per broker, sandbox account). See docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md.
mod broker;
mod exec;
mod frame;
mod pipe;
mod protocol;
mod provision;
mod runner;
mod spawn;
mod token;
mod win;

use win::Result;

fn usage() -> Result<u32> {
    Err("Expected: exec --broker PIPE --request FILE | broker --dev|--account offline|online | account-status [--verify] | grant --root R --capability S | ungrant --root R | read-grant --root R | read-ungrant --root R | read-refresh --env FILE | account-setup | account-uninstall | runner --control ID --owner SID".into())
}

fn main_result() -> Result<u32> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
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
        ["runner", "--control", control, "--owner", owner]
            if control.len() == 32
                && control.bytes().all(|b| b.is_ascii_hexdigit())
                && owner.starts_with("S-1-5-")
                && owner[6..].bytes().all(|b| b.is_ascii_digit() || b == b'-') =>
        {
            runner::run(control, owner)
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
