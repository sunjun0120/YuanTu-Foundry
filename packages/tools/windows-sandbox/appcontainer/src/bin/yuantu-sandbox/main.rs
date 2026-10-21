//! Sandbox account executor: `exec` (per command, desktop user), `broker` (per host, desktop user),
//! and `runner` (per broker, sandbox account). See docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md.
// Release builds have no broker launch mode until the account launch lands (plan 2b); only `--dev` exists.
#[cfg_attr(
    not(debug_assertions),
    allow(dead_code, unreachable_code, unused_variables)
)]
mod broker;
mod exec;
mod frame;
mod pipe;
mod protocol;
mod runner;
mod spawn;
mod token;
mod win;

use win::Result;

fn usage() -> Result<u32> {
    Err("Expected: exec --broker PIPE --request FILE | broker --dev | runner --control ID --owner SID".into())
}

fn main_result() -> Result<u32> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
    match arguments.as_slice() {
        ["exec", "--broker", broker, "--request", request] => Ok(exec::run(broker, request)),
        #[cfg(debug_assertions)]
        ["broker", "--dev"] => broker::run(broker::Launch::Dev),
        ["broker", ..] => Err("This build has no broker launch mode for these arguments".into()),
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
