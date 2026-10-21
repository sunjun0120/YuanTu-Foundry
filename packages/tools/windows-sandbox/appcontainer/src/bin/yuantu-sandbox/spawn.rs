//! Starts one command inside its own kill-on-close Job, with only its three stdio handles inherited.
use crate::{
    protocol::Request,
    win::{Handle, Result, process_token, wide, win},
};
use std::{
    collections::BTreeMap,
    ffi::c_void,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    Storage::FileSystem::*,
    System::{JobObjects::*, Threading::*},
};

/// Quotes one argument the way `CommandLineToArgvW` and the MSVC runtime split it back.
fn quote(argument: &str) -> String {
    let mut output = String::from("\"");
    let mut slash = 0;
    for character in argument.chars() {
        if character == '\\' {
            slash += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            '\\',
            if character == '"' {
                slash * 2 + 1
            } else {
                slash
            },
        ));
        output.push(character);
        slash = 0;
    }
    output.extend(std::iter::repeat_n('\\', slash * 2));
    output.push('"');
    output
}

pub fn command_line(argv: &[String], verbatim: bool) -> String {
    if verbatim {
        return std::iter::once(quote(&argv[0]))
            .chain(argv[1..].iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");
    }
    argv.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ")
}

/// A Unicode environment block, sorted case-insensitively as `CreateProcess` expects.
pub fn environment_block(env: &BTreeMap<String, String>) -> Result<Vec<u16>> {
    let mut entries: Vec<_> = env.iter().collect();
    entries.sort_by_key(|(key, _)| key.to_uppercase());
    let mut block = Vec::new();
    for (key, value) in entries {
        if key.is_empty() || key.contains('=') {
            return Err("Invalid environment key".into());
        }
        block.extend(wide(&format!("{key}={value}"))?);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// Variables that name the user's own profile. The command runs as the sandbox account, so these must be the
/// account's own — otherwise npm, pip and git would write caches into the desktop user's profile and fail.
pub const PROFILE_VARIABLES: [&str; 5] = [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// The command's environment: the host's variables, with the profile variables taken from the runner (the
/// sandbox account) and TEMP/TMP pointed at this command's scratch. Keys are matched case-insensitively.
pub fn sandbox_environment(
    env: &BTreeMap<String, String>,
    own: &dyn Fn(&str) -> Option<String>,
    scratch: &str,
) -> BTreeMap<String, String> {
    let replaced = |key: &str| {
        PROFILE_VARIABLES
            .iter()
            .chain(["TEMP", "TMP"].iter())
            .any(|name| name.eq_ignore_ascii_case(key))
    };
    let mut out: BTreeMap<String, String> = env
        .iter()
        .filter(|(key, _)| !replaced(key))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for name in PROFILE_VARIABLES {
        if let Some(value) = own(name) {
            out.insert(name.to_string(), value);
        }
    }
    out.insert("TEMP".into(), scratch.into());
    out.insert("TMP".into(), scratch.into());
    out
}

struct Attributes(Vec<usize>);
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.0.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST);
        }
    }
}

/// An inheritable copy of `source`; a missing handle becomes the NUL device.
fn inheritable(source: HANDLE) -> Result<Handle> {
    if source.is_null() || source == INVALID_HANDLE_VALUE {
        let name = wide("NUL")?;
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &security,
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err("Open NUL for stdio".into());
        }
        return Ok(Handle(handle));
    }
    let mut target = null_mut();
    win(
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                source,
                GetCurrentProcess(),
                &mut target,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        },
        "Duplicate stdio",
    )?;
    Ok(Handle(target))
}

pub struct Running {
    pub pid: u32,
    process: Handle,
    job: Handle,
}

/// Creates the command suspended, already inside its Job, verifies the kernel gave it a restricted token,
/// and only then resumes it.
pub fn start(token: &Handle, request: &Request, stdio: [HANDLE; 3]) -> Result<Running> {
    let handles = [
        inheritable(stdio[0])?,
        inheritable(stdio[1])?,
        inheritable(stdio[2])?,
    ];
    let job = Handle(unsafe { CreateJobObjectW(null(), null()) });
    if job.0.is_null() {
        return Err("Create command Job failed".into());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    // Breakaway is never permitted: no JOB_OBJECT_LIMIT_BREAKAWAY_OK.
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    win(
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        },
        "Set command Job limits",
    )?;
    let inherited: Vec<HANDLE> = handles.iter().map(|h| h.0).collect();
    let job_list = [job.0];
    let mut length = 0;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut length);
    }
    let mut attributes = Attributes(vec![0usize; length.div_ceil(size_of::<usize>())]);
    let list = attributes.0.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    win(
        unsafe { InitializeProcThreadAttributeList(list, 2, 0, &mut length) },
        "Initialize process attributes",
    )?;
    win(
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited.as_ptr() as *const c_void,
                inherited.len() * size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        },
        "Set inherited stdio list",
    )?;
    win(
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                job_list.as_ptr() as *const c_void,
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        },
        "Set Job membership",
    )?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0].0;
    startup.StartupInfo.hStdOutput = handles[1].0;
    startup.StartupInfo.hStdError = handles[2].0;
    startup.lpAttributeList = list;
    let image = wide(&request.argv[0])?;
    let mut command = wide(&command_line(&request.argv, request.verbatim))?;
    let cwd = wide(&request.cwd)?;
    let environment = environment_block(&request.env)?;
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    win(
        unsafe {
            CreateProcessAsUserW(
                token.0,
                image.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_NO_WINDOW,
                environment.as_ptr() as *const c_void,
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        },
        "Create sandboxed process",
    )?;
    let process = Handle(info.hProcess);
    let thread = Handle(info.hThread);
    let running = Running {
        pid: info.dwProcessId,
        process,
        job,
    };
    // Do not infer confinement from CreateProcess success: check the token the kernel actually assigned.
    let restricted = process_token(running.process.0)
        .map(|token| unsafe { IsTokenRestricted(token.0) } != 0)
        .unwrap_or(false);
    if !restricted {
        running.cancel();
        return Err("Kernel did not assign the restricted token".into());
    }
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        running.cancel();
        return Err("Resume sandboxed process failed".into());
    }
    Ok(running)
}

impl Running {
    /// Terminates the whole tree. Safe to call from another thread while `wait` runs.
    pub fn cancel(&self) {
        unsafe {
            TerminateJobObject(self.job.0, 1);
        }
    }

    /// Waits for the leader, then terminates and drains every remaining descendant before reporting.
    pub fn wait(&self) -> Result<u32> {
        unsafe {
            if WaitForSingleObject(self.process.0, INFINITE) != WAIT_OBJECT_0 {
                return Err("Wait for sandboxed process failed".into());
            }
            let mut code = 0;
            win(
                GetExitCodeProcess(self.process.0, &mut code),
                "Read exit code",
            )?;
            TerminateJobObject(self.job.0, code);
            for _ in 0..500 {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                win(
                    QueryInformationJobObject(
                        self.job.0,
                        JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as *mut c_void,
                        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                        null_mut(),
                    ),
                    "Query command Job",
                )?;
                if accounting.ActiveProcesses == 0 {
                    return Ok(code);
                }
                Sleep(10);
            }
        }
        Err("Command descendants did not terminate".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{protocol::VERSION, token::restricted_token};
    use windows_sys::Win32::System::Pipes::CreatePipe;

    #[test]
    fn quoting_preserves_trailing_slashes_and_quotes() {
        assert_eq!(
            command_line(&[r"C:\a b\".into(), "x\"y".into()], false),
            r#""C:\a b\\" "x\"y""#
        );
        assert_eq!(
            command_line(&[r"C:\cmd.exe".into(), r#"/d /s /c "exit 7""#.into()], true),
            r#""C:\cmd.exe" /d /s /c "exit 7""#
        );
    }

    #[test]
    fn profile_and_temp_come_from_the_sandbox_account() {
        let host = BTreeMap::from([
            ("Path".to_string(), r"C:\bin".to_string()),
            ("userprofile".to_string(), r"C:\Users\me".to_string()),
            ("Temp".to_string(), r"C:\Users\me\Temp".to_string()),
        ]);
        let own = |name: &str| (name == "USERPROFILE").then(|| r"C:\Users\Sandbox".to_string());
        let env = sandbox_environment(&host, &own, "S");
        assert_eq!(env.get("Path").map(String::as_str), Some(r"C:\bin"));
        assert_eq!(
            env.get("USERPROFILE").map(String::as_str),
            Some(r"C:\Users\Sandbox")
        );
        assert!(!env.contains_key("userprofile") && !env.contains_key("Temp"));
        assert_eq!(env.get("TEMP").map(String::as_str), Some("S"));
        assert_eq!(env.get("TMP").map(String::as_str), Some("S"));
    }

    #[test]
    fn environment_is_sorted_and_terminated() {
        let env = BTreeMap::from([("b".into(), "2".into()), ("A".into(), "1".into())]);
        let block = environment_block(&env).unwrap();
        assert_eq!(String::from_utf16_lossy(&block), "A=1\0b=2\0\0");
        assert_eq!(environment_block(&BTreeMap::new()).unwrap(), vec![0, 0]);
    }

    fn system_env() -> BTreeMap<String, String> {
        std::env::vars()
            .filter(|(key, _)| {
                ["SYSTEMROOT", "PATH", "COMSPEC"].contains(&key.to_uppercase().as_str())
            })
            .collect()
    }

    fn cmd(args: &[&str]) -> Request {
        let root = std::env::var("SystemRoot").unwrap();
        let mut argv = vec![format!(r"{root}\System32\cmd.exe")];
        argv.extend(args.iter().map(|a| a.to_string()));
        Request {
            version: VERSION,
            argv,
            cwd: root,
            env: system_env(),
            capabilities: vec!["S-1-5-21-11-22-33-44".into()],
            verbatim: true,
        }
    }

    fn pipe() -> (Handle, Handle) {
        let (mut read, mut write) = (null_mut(), null_mut());
        assert_ne!(unsafe { CreatePipe(&mut read, &mut write, null(), 0) }, 0);
        (Handle(read), Handle(write))
    }

    #[test]
    fn reports_the_exit_code() {
        let token = restricted_token(&["S-1-5-21-11-22-33-44".into()]).unwrap();
        let (_, out) = pipe();
        let running = start(
            &token,
            &cmd(&["/c", "exit", "7"]),
            [null_mut(), out.0, out.0],
        )
        .unwrap();
        assert_eq!(running.wait().unwrap(), 7);
    }

    #[test]
    fn cancel_terminates_the_tree() {
        let token = restricted_token(&["S-1-5-21-11-22-33-44".into()]).unwrap();
        let (_, out) = pipe();
        let request = cmd(&["/c", "ping", "-n", "30", "127.0.0.1"]);
        let running = start(&token, &request, [null_mut(), out.0, out.0]).unwrap();
        let started = std::time::Instant::now();
        running.cancel();
        running.wait().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
