//! Non-elevated AppContainer launcher. No network capabilities, no breakaway, explicit stdio handles.
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    ffi::c_void,
    fs,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Isolation::*, *},
    System::{Console::*, JobObjects::*, Threading::*},
};
use yuantu_appcontainer::{
    Handle, Result, Sid, maintenance, network, profile_name, sid_text, wide, win,
};

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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Run {
    version: u32,
    profile: String,
    executable: String,
    args: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    capabilities: Vec<String>,
    network: bool,
}
struct Capability(PSID);
impl Drop for Capability {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0 as _);
        }
    }
}
fn capability(name: &str) -> Result<Capability> {
    if !(name.starts_with("Yuantu.Workspace.Read.") || name.starts_with("Yuantu.Workspace.Write."))
        || name.len() > 100
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err("Only application-private workspace capabilities are accepted".into());
    }
    let name = wide(name)?;
    let mut groups = null_mut();
    let mut group_count = 0;
    let mut sids = null_mut();
    let mut count = 0;
    unsafe {
        win(
            DeriveCapabilitySidsFromName(
                name.as_ptr(),
                &mut groups,
                &mut group_count,
                &mut sids,
                &mut count,
            ),
            "Derive workspace capability",
        )?;
    }
    unsafe {
        for index in 0..group_count {
            LocalFree(*groups.add(index as usize) as _);
        }
        LocalFree(groups as _);
        if count != 1 {
            for index in 0..count {
                LocalFree(*sids.add(index as usize) as _);
            }
            LocalFree(sids as _);
            return Err("Unexpected capability SID count".into());
        }
        let sid = *sids;
        LocalFree(sids as _);
        Ok(Capability(sid))
    }
}
struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.0);
        }
    }
}
unsafe fn run(request: Run, control: &std::path::Path) -> Result<u32> {
    if request.version != 1 {
        return Err("Unsupported AppContainer launcher protocol".into());
    }
    if !std::path::Path::new(&request.executable).is_absolute()
        || !std::path::Path::new(&request.cwd).is_absolute()
    {
        return Err("Launcher paths must be absolute".into());
    }
    let name = profile_name(&request.profile)?;
    let mut sid = null_mut();
    let hr = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
    if hr < 0 {
        return Err(format!("Derive AppContainer identity: {hr:#x}"));
    }
    let sid = Sid(sid);
    if request.capabilities.len() > 1 {
        return Err("A process must carry exactly one workspace policy capability".into());
    }
    let private_capabilities: Vec<_> = request
        .capabilities
        .iter()
        .map(|name| capability(name))
        .collect::<Result<_>>()?;
    let mut capability_sids: Vec<_> = private_capabilities
        .iter()
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid.0,
            Attributes: 0x4, /* SE_GROUP_ENABLED */
        })
        .collect();
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: sid.0,
        Capabilities: capability_sids.as_mut_ptr(),
        CapabilityCount: capability_sids.len() as u32,
        Reserved: 0,
    };
    let mut handles = Vec::new();
    for source in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let mut target = null_mut();
        unsafe {
            win(
                DuplicateHandle(
                    GetCurrentProcess(),
                    GetStdHandle(source),
                    GetCurrentProcess(),
                    &mut target,
                    0,
                    1,
                    DUPLICATE_SAME_ACCESS,
                ),
                "Duplicate stdio",
            )?;
        }
        handles.push(Handle(target));
    }
    let job = Handle(unsafe { CreateJobObjectW(null(), null()) });
    if job.0.is_null() {
        return Err("Create Job Object failed".into());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        win(
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ),
            "Set Job containment",
        )?;
    }
    let inherited: Vec<_> = handles.iter().map(|h| h.0).collect();
    // The guest is created inside the job rather than assigned to it afterwards: create-then-assign leaves a
    // moment where a killed launcher strands a suspended guest that belongs to no job and that nobody resumes or
    // kills, holding the stdio pipes it inherited.
    let job_list = [job.0];
    let mut length = 0;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 3, 0, &mut length);
    }
    // Vec<usize> supplies pointer alignment required by the native opaque list.
    let mut allocation = vec![0usize; length.div_ceil(size_of::<usize>())];
    let attributes = allocation.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    unsafe {
        win(
            InitializeProcThreadAttributeList(attributes, 3, 0, &mut length),
            "Initialize process attributes",
        )?;
    }
    let attributes = Attributes(attributes);
    unsafe {
        win(
            UpdateProcThreadAttribute(
                attributes.0,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &capabilities as *const _ as *const c_void,
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            ),
            "Set AppContainer identity",
        )?;
        win(
            UpdateProcThreadAttribute(
                attributes.0,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited.as_ptr() as *const c_void,
                inherited.len() * size_of::<HANDLE>(),
                null_mut(),
                null(),
            ),
            "Set inherited stdio list",
        )?;
        win(
            UpdateProcThreadAttribute(
                attributes.0,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                job_list.as_ptr() as *const c_void,
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            ),
            "Set Job membership",
        )?;
    }
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0].0;
    startup.StartupInfo.hStdOutput = handles[1].0;
    startup.StartupInfo.hStdError = handles[2].0;
    startup.lpAttributeList = attributes.0;
    let executable = wide(&request.executable)?;
    let cwd = wide(&request.cwd)?;
    let command = std::iter::once(request.executable.as_str())
        .chain(request.args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = wide(&command)?;
    let mut environment = Vec::<u16>::new();
    for (key, value) in request.env {
        if key.is_empty() || key.contains('=') {
            return Err("Invalid environment key".into());
        }
        environment.extend(wide(&format!("{key}={value}"))?);
    }
    environment.push(0);
    if environment.len() == 1 {
        environment.push(0);
    }
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        win(
            CreateProcessW(
                executable.as_ptr(),
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
            ),
            "Create AppContainer process",
        )?;
    }
    let process = Handle(info.hProcess);
    let thread = Handle(info.hThread);
    // Do not infer isolation from CreateProcess success. Verify the kernel token
    // while the guest is still suspended and already owned by the killing job.
    let mut token = null_mut();
    unsafe {
        win(
            OpenProcessToken(process.0, TOKEN_QUERY, &mut token),
            "Open sandbox token",
        )?;
    }
    let token = Handle(token);
    let mut is_container = 0u32;
    let mut returned = 0;
    unsafe {
        win(
            GetTokenInformation(
                token.0,
                TokenIsAppContainer,
                &mut is_container as *mut _ as *mut c_void,
                size_of::<u32>() as u32,
                &mut returned,
            ),
            "Verify AppContainer token",
        )?;
    }
    if is_container != 1 {
        return Err("Kernel did not create an AppContainer token".into());
    }
    let mut length = 0;
    unsafe {
        GetTokenInformation(token.0, TokenAppContainerSid, null_mut(), 0, &mut length);
    }
    let mut information = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    unsafe {
        win(
            GetTokenInformation(
                token.0,
                TokenAppContainerSid,
                information.as_mut_ptr() as *mut c_void,
                length,
                &mut returned,
            ),
            "Verify AppContainer identity",
        )?;
    }
    let actual = unsafe { &*(information.as_ptr() as *const TOKEN_APPCONTAINER_INFORMATION) };
    if unsafe { EqualSid(actual.TokenAppContainer, sid.0) } == 0 {
        return Err("Kernel sandbox identity differs from the owned profile".into());
    }
    if request.network {
        network::require_profile(&request.profile)?;
    }
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        unsafe {
            TerminateJobObject(job.0, 1);
        }
        return Err("Resume AppContainer process failed".into());
    }
    unsafe {
        loop {
            let status = WaitForSingleObject(process.0, 10);
            if status == WAIT_OBJECT_0 {
                break;
            }
            if status != WAIT_TIMEOUT {
                return Err("Wait for AppContainer failed".into());
            }
            if control.join("cancel").exists() {
                win(
                    TerminateJobObject(job.0, 1),
                    "Cancel contained process tree",
                )?;
                if WaitForSingleObject(process.0, 5000) != WAIT_OBJECT_0 {
                    return Err("Cancelled contained leader did not terminate".into());
                }
                break;
            }
        }
        let mut exit = 0;
        win(
            GetExitCodeProcess(process.0, &mut exit),
            "Read process exit",
        )?;
        win(
            TerminateJobObject(job.0, 0),
            "Terminate AppContainer descendants",
        )?;
        for _ in 0..500 {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            win(
                QueryInformationJobObject(
                    job.0,
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut c_void,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                ),
                "Wait for contained descendants",
            )?;
            if accounting.ActiveProcesses == 0 {
                // The guest cannot write the Medium host-control directory.
                // This acknowledgement alone authorizes release of file grants.
                let mut complete = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(control.join("complete.json"))
                    .map_err(|_| "Create termination acknowledgement failed")?;
                std::io::Write::write_all(&mut complete, b"{\"version\":1,\"terminated\":true}")
                    .map_err(|_| "Write termination acknowledgement failed")?;
                complete
                    .sync_all()
                    .map_err(|_| "Flush termination acknowledgement failed")?;
                return Ok(exit);
            }
            Sleep(10);
        }
    }
    Err("Contained descendants did not terminate; ACL cleanup refused".into())
}
fn main_result() -> Result<u32> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    match arguments.as_slice() {
        [operation] if operation == "network-preflight" => {
            let _installation = maintenance::preflight()?;
            println!("{}", serde_json::json!({"version":1,"ready":true}));
            Ok(0)
        }
        [operation] if operation == "network-setup" => maintenance::setup(),
        [operation] if operation == "network-initialize" => {
            network::initialize()?;
            println!("{}", serde_json::json!({"version":1,"installed":true}));
            Ok(0)
        }
        [operation] if operation == "network-status" => {
            println!(
                "{}",
                serde_json::to_string(&network::status()?)
                    .map_err(|_| "Network status serialization failed")?
            );
            Ok(0)
        }
        [operation, name] if operation == "create" => {
            let name = profile_name(name)?;
            let mut sid = null_mut();
            let hr = unsafe {
                CreateAppContainerProfile(
                    name.as_ptr(),
                    name.as_ptr(),
                    name.as_ptr(),
                    null(),
                    0,
                    &mut sid,
                )
            };
            if hr < 0 {
                return Err(format!("Create fresh AppContainer profile: {hr:#x}"));
            }
            let sid = Sid(sid);
            let text_value = sid_text(sid.0)?;
            println!("{}", serde_json::json!({"version":1,"sid":text_value}));
            Ok(0)
        }
        [operation, name] if operation == "capability" => {
            let sid = capability(name)?;
            println!(
                "{}",
                serde_json::json!({"version":1,"sid":sid_text(sid.0)?})
            );
            Ok(0)
        }
        [operation, name] if operation == "delete" => {
            let name = profile_name(name)?;
            let hr = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
            if hr < 0 {
                return Err(format!("Delete owned AppContainer profile: {hr:#x}"));
            }
            Ok(0)
        }
        [operation, filename] if operation == "run" => {
            let bytes = fs::read(filename).map_err(|_| "Read private launcher request failed")?;
            if bytes.len() > 1024 * 1024 {
                return Err("Launcher request exceeds 1 MiB".into());
            }
            let request: Run =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid launcher request")?;
            let control = std::path::Path::new(filename)
                .parent()
                .ok_or("Invalid host control path")?;
            unsafe { run(request, control) }
        }
        _ => Err("Expected create/delete PROFILE or run PRIVATE_REQUEST_FILE".into()),
    }
}
fn main() {
    match main_result() {
        Ok(code) => std::process::exit(code as i32),
        Err(error) => {
            eprintln!("AppContainer sandbox: {error}");
            std::process::exit(125);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoting_preserves_trailing_slashes_and_quotes() {
        assert_eq!(quote("a\\\"b\\"), "\"a\\\\\\\"b\\\\\"");
    }
    #[test]
    fn refuses_foreign_profile_and_nul() {
        assert!(profile_name("Other.Profile").is_err());
        assert!(wide("bad\0path").is_err());
    }
    #[test]
    fn protocol_refuses_unknown_fields() {
        assert!(serde_json::from_str::<Run>(r#"{"version":1,"profile":"x","executable":"x","args":[],"cwd":"x","env":{},"capabilities":[],"network":true,"bypass":true}"#).is_err());
    }
    #[test]
    fn network_capability_is_never_accepted() {
        assert!(capability("internetClient").is_err());
    }
}
