//! Sandbox account executor: `exec` (per command, desktop user), `broker` (per host, desktop user),
//! and `runner` (per broker, sandbox account). See docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md.
mod frame;
mod pipe;
mod protocol;
mod spawn;
mod token;
mod win;

use win::Result;

fn main_result() -> Result<u32> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        _ => Err("Expected exec, broker, or runner".into()),
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
