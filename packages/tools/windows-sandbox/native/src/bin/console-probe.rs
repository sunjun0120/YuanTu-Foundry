//! Test-only probe: prints `console <columns>` when its standard output is a console (a ConPTY counts), and
//! `redirected` when it is a pipe or file. The sandbox tests run it as a sandboxed command to prove TTY requests
//! reach a real terminal and that resizes arrive. Packaging ships only `yuantu-sandbox.exe`.
#[cfg(windows)]
fn main() {
    use windows_sys::Win32::System::Console::{
        CONSOLE_SCREEN_BUFFER_INFO, GetConsoleMode, GetConsoleScreenBufferInfo, GetStdHandle,
        STD_OUTPUT_HANDLE,
    };
    let output = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    let mut mode = 0;
    if unsafe { GetConsoleMode(output, &mut mode) } == 0 {
        println!("redirected");
        return;
    }
    let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
    let columns = if unsafe { GetConsoleScreenBufferInfo(output, &mut info) } != 0 {
        (info.srWindow.Right - info.srWindow.Left + 1).to_string()
    } else {
        "unknown".to_string()
    };
    println!("console {columns}");
}

#[cfg(not(windows))]
fn main() {}
