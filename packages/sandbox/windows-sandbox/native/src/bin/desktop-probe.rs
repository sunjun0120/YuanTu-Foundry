//! Test-only probe: prints the name of the desktop this process runs on. The sandbox tests run it as a sandboxed
//! command to prove commands land on the private desktop. Packaging ships only `yuantu-sandbox.exe`.
#[cfg(windows)]
fn main() {
    use windows_sys::Win32::System::{
        StationsAndDesktops::{GetThreadDesktop, GetUserObjectInformationW, UOI_NAME},
        Threading::GetCurrentThreadId,
    };
    let desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
    let mut name = [0u16; 256];
    let mut needed = 0;
    let read = unsafe {
        GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            size_of_val(&name) as u32,
            &mut needed,
        )
    };
    if read == 0 {
        eprintln!("GetUserObjectInformationW failed");
        std::process::exit(1);
    }
    let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
    println!("{}", String::from_utf16_lossy(&name[..length]));
}

#[cfg(not(windows))]
fn main() {}
