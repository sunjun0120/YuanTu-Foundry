/**
 * Windows write-restricted token with a stable workspace-specific restricting SID. Grants for another
 * workspace, including legacy RESTRICTED grants, cannot satisfy this workspace's write check.
 *
 * The restricting list also carries Everyone and the native logon SID: Node DLL initialization requires
 * these system-object identities. Ambient write ACLs naming them remain effective, so this backend declares
 * a partial filesystem boundary. Strict workspace-only, read-only process or denied-network requirements
 * must select a backend that can enforce them. Reads and network are unrestricted.
 *
 * The default DACL adds the workspace identity for newly created process objects and pipes; outside directory
 * ACLs are untouched. File-tool paths remain bounded by Workspace independently of this process policy.
 *
 * The command is handed to the launcher as a base64 JSON payload and never interpolated into the PowerShell
 * text that starts it: the script below contains the payload, not the command, so no command can escape into
 * PowerShell source no matter what it contains. That is what makes an arbitrary model-authored command safe to
 * carry through a shell in the first place.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toolEnvironment } from './environment.ts';
import {
  insideWorkspace,
  type SandboxPlan,
  type SandboxProvider,
  type SandboxRequest,
} from './sandbox-provider.ts';
/** Legacy shared identity, retained as a public constant; new workspace grants never use it. */
export const WINDOWS_SANDBOX_SID = 'S-1-5-12';
/** Restrict writes to this workspace's grant, rather than every directory ever granted RESTRICTED. */
export function workspaceSandboxSid(root: string): string {
  const digest = createHash('sha256').update(path.resolve(root).toLowerCase()).digest();
  return `S-1-5-21-${digest.readUInt32LE(0)}-${digest.readUInt32LE(4)}-${digest.readUInt32LE(8)}-${digest.readUInt32LE(12)}`;
}
/**
 * `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`.
 *
 * The first two make the token harmless (no privileges, no administrative groups); the third is the confinement
 * itself. Dropping it would leave a token that is merely "unelevated" — the same thing the CLI already runs at
 * when it is not started as an administrator, which is to say no isolation at all.
 */
const LAUNCHER_FLAGS = 0x1 | 0x4 | 0x8;
/**
 * The C# launcher, compiled once per code revision into the user's temp directory and loaded by each command.
 *
 * It exists because Node has no way to start a process with a token: `CreateProcessAsUser` is the only entry
 * point that takes one. The alternative — a native addon or an FFI dependency — would add a compiled artifact to
 * a project that has none, and this is forty lines of P/Invoke.
 */
const launcherSource = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;

public static class YuantuSandbox
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES { public IntPtr sid; public uint attributes; }

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete, uint restrictCount, SID_AND_ATTRIBUTES[] restrict, out IntPtr outToken);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int which, IntPtr buffer, uint length, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(IntPtr token, int which, IntPtr buffer, uint length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSidToSidW(string sid, out IntPtr result);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUserW(IntPtr token, string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    const uint TOKEN_DUPLICATE = 0x0002;
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const int STARTF_USESTDHANDLES = 0x100;

    public static int Run(string commandLine, string directory, string[] environment, string restrictingSid, uint flags)
    {
        IntPtr current;
        if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out current))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken");
        IntPtr sid;
        if (!ConvertStringSidToSidW(restrictingSid, out sid))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSidToSid");
        IntPtr world;
        if (!ConvertStringSidToSidW("S-1-1-0", out world))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSidToSid world");
        string logonSid = FindLogonSid(current);
        IntPtr logon;
        if (!ConvertStringSidToSidW(logonSid, out logon))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSidToSid logon");
        IntPtr restricted;
        // A restricted version of our own token needs no SeAssignPrimaryTokenPrivilege; anything else would mean
        // this backend required elevation to drop privileges, which is the wrong way round.
        if (!CreateRestrictedToken(current, flags, 0, IntPtr.Zero, 0, IntPtr.Zero, 3, new SID_AND_ATTRIBUTES[] { new SID_AND_ATTRIBUTES { sid = sid }, new SID_AND_ATTRIBUTES { sid = world }, new SID_AND_ATTRIBUTES { sid = logon } }, out restricted))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateRestrictedToken");
        GrantDefaultDacl(restricted, restrictingSid);
        IntPtr block = EnvironmentBlock(environment);
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        // The child writes straight into the pipes this process was given, so output streams while it runs
        // instead of arriving in one piece at the end.
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(-10);
        startup.hStdOutput = GetStdHandle(-11);
        startup.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION info;
        if (!CreateProcessAsUserW(restricted, null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_UNICODE_ENVIRONMENT, block, directory, ref startup, out info))
            // The number and the system's own sentence, because this is the one failure a caller cannot diagnose
            // from anything else: "CreateProcessAsUser" alone says neither what went wrong nor which of the two
            // ways in (shell text vs program+argv) was taken.
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
        WaitForSingleObject(info.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(info.hProcess, out code);
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
        return (int)code;
    }

    // New pipes, events and process objects must remain usable by this token's own restricting identity.
    // This changes defaults for newly created objects, never the ACL of an outside directory.
    static void GrantDefaultDacl(IntPtr token, string sid)
    {
        uint needed;
        GetTokenInformation(token, 6, IntPtr.Zero, 0, out needed);
        if (needed == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenDefaultDacl size");
        IntPtr info = Marshal.AllocHGlobal((int)needed);
        IntPtr merged = IntPtr.Zero;
        try {
            if (!GetTokenInformation(token, 6, info, needed, out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation");
            IntPtr old = Marshal.ReadIntPtr(info);
            if (old == IntPtr.Zero) throw new InvalidOperationException("Missing token default DACL");
            int length = (ushort)Marshal.ReadInt16(old, 2);
            var bytes = new byte[length]; Marshal.Copy(old, bytes, 0, length);
            var acl = new RawAcl(bytes, 0);
            acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x10000000, new SecurityIdentifier(sid), false, null));
            bytes = new byte[acl.BinaryLength]; acl.GetBinaryForm(bytes, 0);
            merged = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, merged, bytes.Length);
            Marshal.WriteIntPtr(info, merged);
            if (!SetTokenInformation(token, 6, info, (uint)IntPtr.Size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetTokenInformation default DACL");
        } finally { if (merged != IntPtr.Zero) Marshal.FreeHGlobal(merged); Marshal.FreeHGlobal(info); }
    }

    static string FindLogonSid(IntPtr token)
    {
        uint needed; GetTokenInformation(token, 2, IntPtr.Zero, 0, out needed);
        if (needed == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenGroups size");
        IntPtr groups = Marshal.AllocHGlobal((int)needed);
        try {
            if (!GetTokenInformation(token, 2, groups, needed, out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation groups");
            int count = Marshal.ReadInt32(groups);
            int stride = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            for (int i = 0; i < count; i++) {
                IntPtr entry = IntPtr.Add(groups, IntPtr.Size + i * stride);
                uint attributes = (uint)Marshal.ReadInt32(entry, IntPtr.Size);
                if ((attributes & 0xC0000000) == 0xC0000000)
                    return new SecurityIdentifier(Marshal.ReadIntPtr(entry)).Value;
            }
            throw new InvalidOperationException("Missing logon SID");
        } finally { Marshal.FreeHGlobal(groups); }
    }

    static IntPtr EnvironmentBlock(string[] entries)
    {
        var sorted = new List<string>(entries);
        sorted.Sort(StringComparer.OrdinalIgnoreCase);
        var text = new StringBuilder();
        foreach (var entry in sorted) { text.Append(entry); text.Append('\0'); }
        text.Append('\0');
        var bytes = Encoding.Unicode.GetBytes(text.ToString());
        IntPtr block = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, block, bytes.Length);
        return block;
    }
}
`;
/**
 * Where the compiled launcher lives.
 *
 * The user's own temp directory, and the choice matters twice: the sandboxed command cannot write there (it is
 * outside both grants), so a confined command cannot replace the launcher the *next* command loads — that would
 * be a sandbox escape with extra steps — and the path is already private to this user. The file name carries a
 * digest of the source so that editing the launcher above cannot load a stale assembly.
 */
function launcherPath(): string {
  const digest = createHash('sha256').update(launcherSource).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'yuantu-sandbox', `launcher-${digest}.dll`);
}
/** The launcher's C# source, beside the assembly that was compiled from it. */
function launcherSourcePath(dll: string): string {
  return dll.replace(/\.dll$/, '.cs');
}
/**
 * Writes the launcher source where the bootstrap can read it.
 *
 * The source used to be carried inside the encoded command, and that is a hard ceiling rather than a style
 * preference: base64 of the C# is about six kilobytes, the bootstrap encodes its own text again for
 * `-EncodedCommand`, and the result travelled as UTF-16 — which put every command within a few hundred
 * characters of Windows' 32 767-character limit and made `spawn` fail with `ENAMETOOLONG` before anything ran.
 * A file has no such limit, and it is written once per revision.
 */
async function writeLauncherSource(dll: string): Promise<string> {
  const file = launcherSourcePath(dll);
  const existing = await stat(file).then(
    (info) => info.size === Buffer.byteLength(launcherSource, 'utf8'),
    () => false,
  );
  if (!existing) {
    const temporary = `${file}.${process.pid}.tmp`;
    const { writeFile, rename } = await import('node:fs/promises');
    await writeFile(temporary, launcherSource, 'utf8');
    await rename(temporary, file);
  }
  return file;
}
function powershellPath(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
/** The environment the sandboxed command gets: the project's sanitised set, with temp pointed at its scratch. */
function commandEnvironment(scratch: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...toolEnvironment(), ...(extra ?? {}) };
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) env[name] = scratch;
  return env;
}
function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
/** The name the per-command payload travels in. A name of ours, so the child's own environment stays clean. */
const SPEC_VARIABLE = 'YUANTU_SANDBOX_SPEC';
/**
 * The PowerShell program that loads the launcher and starts one command under the restricted token.
 *
 * **Nothing per-command appears in this text, and that is a performance requirement rather than tidiness.** A
 * first version embedded the command, the working directory and the environment in the script, and measured
 * 2.1 seconds per command against 0.44 seconds for the identical script run twice: something on this platform
 * (Windows Defender's script scanning is the only content-keyed component in the path) caches a decision per
 * distinct script *text*, so a script that differs for every command is scanned from scratch every time. The
 * check that proved it: appending one comment character to an otherwise identical script restored the 1.7-second
 * penalty, and running that same variant a second time was fast again. Hence the split — a constant script, and
 * the command, directory and environment in one base64 payload that arrives as an environment variable, which
 * nothing scans as code. The two paths below are constant for a given launcher revision because they are derived
 * from a digest of its source.
 *
 * `-NoProfile`/`-NonInteractive` are not politeness: a profile is arbitrary code that would run *before* the
 * token exists, inside the sandbox's own starter, and `-EncodedCommand` keeps the whole program out of the
 * command line where a shell would see it.
 */
function bootstrap(dll: string, source: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    // Without this a non-interactive PowerShell writes progress records to stderr as CLIXML, which buries the
    // real error and makes every failure message start with a serialised object graph.
    '$ProgressPreference = "SilentlyContinue"',
    `$dll = '${dll}'`,
    'if (-not (Test-Path -LiteralPath $dll)) {',
    `  $temporary = $dll + '.' + $PID + '.dll'`,
    `  Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source}')) -OutputAssembly $temporary`,
    // Two commands can arrive at once on a cold cache. The loser's move fails because the winner's file is
    // already loaded, which is a success: the launcher that is there is the same launcher.
    '  try { Move-Item -LiteralPath $temporary -Destination $dll -Force -ErrorAction Stop }',
    '  catch { if (-not (Test-Path -LiteralPath $dll)) { throw } }',
    '  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue',
    '}',
    '[void][Reflection.Assembly]::LoadFrom($dll)',
    `$spec = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${SPEC_VARIABLE})))`,
    `exit [YuantuSandbox]::Run([string]$spec.command, [string]$spec.cwd, [string[]]$spec.env, [string]$spec.sid, ${LAUNCHER_FLAGS})`,
  ].join('\n');
}
/** What one command needs: where to run, what to run, and the environment the child is started with. */
interface Spec {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sid?: string;
}
/** The environment for the *starter*: this process's sanitised set plus the payload it reads back. */
function starterEnvironment(spec: Spec, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    [SPEC_VARIABLE]: encode(
      JSON.stringify({
        command: spec.command,
        cwd: spec.cwd,
        sid: spec.sid ?? workspaceSandboxSid(spec.cwd),
        env: Object.entries(spec.env).map(([name, value]) => `${name}=${value ?? ''}`),
      }),
    ),
  };
}
/** The `-EncodedCommand` argument: UTF-16LE base64 of the bootstrap, so no shell ever parses it. */
function launcherArgs(program: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(program, 'utf16le').toString('base64'),
  ];
}
/**
 * Quotes one argument for the `CreateProcess` command line the child is started with.
 *
 * Windows has no argv: the child parses one string back into arguments, with rules (`\"` escapes, backslashes
 * doubled only when they precede a quote) that are easy to get subtly wrong and impossible to test through a
 * shell. This is the same algorithm Node applies for `spawn` on Windows, and the test in
 * `tests/sandbox-windows.test.ts` round-trips real arguments through a real process rather than trusting it.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes++;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
}
/** The command line for a request: the same shell shape the host backend uses, quoted for `CreateProcess`. */
export function windowsCommandLine(request: Pick<SandboxRequest, 'command' | 'argv'>): string {
  // With an argv the request is program-plus-arguments (`acceptance` checks and the hook bridge pass it that
  // way), so the program has to lead the command line: `CreateProcess` resolves the *first* token as the image
  // and the first version of this line left it out, which turned `node -e …` into a command line starting with
  // `-e` and failed as `ERROR_FILE_NOT_FOUND` — the argv path never ran at all.
  if (request.argv) return [request.command, ...request.argv].map(quoteWindowsArgument).join(' ');
  // `/d` skips AutoRun commands and `/s` makes the quoting below the documented "everything inside the outer
  // quotes" form, which is what the host backend does too. The command is deliberately *not* run through
  // `quoteWindowsArgument`: cmd's parser is not the C runtime's, and escaping the outer quotes as `\"` hands it
  // a literal program name (`'"exit 0"' is not recognized as an internal or external command`) instead of a
  // command. The command is shell text because a shell is what runs it — same contract as the host backend.
  const shell = process.env.ComSpec ?? 'cmd.exe';
  return `${quoteWindowsArgument(shell)} /d /s /c "${request.command}"`;
}
/** Runs one program and resolves with its exit code, for the checks that only need a yes or a no. */
function run(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? toolEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // The head, not the tail: the launcher's failure is the first thing it writes, and everything after it is
      // the loader's noise — a message that ends in half a serialised object is a message nobody can act on.
      error = (error + chunk.toString()).slice(0, 512);
    });
    child.once('error', (cause) => resolve({ code: null, error: String(cause) }));
    child.once('close', (code) => resolve({ code, error }));
  });
}
/**
 * Grants one directory to the sandbox's SID, once per directory per process.
 *
 * Set-Acl propagates the inheritable entry into the existing tree, including files that predate the grant.
 * Doing it per command instead would re-walk the whole workspace on every command; doing it never would mean
 * every command failed with `Access is denied` on the first write. The memo is per process because a second run
 * of the same workspace does not need the walk either — re-granting an identical ACE is a no-op the system
 * already paid for.
 */
const granted = new Map<string, Promise<void>>();
const grantScript = [
  "$ErrorActionPreference = 'Stop'",
  `$spec = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${SPEC_VARIABLE})))`,
  '$sid = [Security.Principal.SecurityIdentifier]::new([string]$spec.sid)',
  '$acl = Get-Acl -LiteralPath ([string]$spec.root)',
  '$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit", [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)',
  '$acl.AddAccessRule($rule)',
  'Set-Acl -LiteralPath ([string]$spec.root) -AclObject $acl',
].join('\n');
function grant(root: string, sid: string): Promise<void> {
  const pending = granted.get(root);
  if (pending) return pending;
  const work = (async () => {
    const result = await run(powershellPath(), launcherArgs(grantScript), {
      env: { ...toolEnvironment(), [SPEC_VARIABLE]: encode(JSON.stringify({ root, sid })) },
    });
    if (result.code !== 0)
      throw new Error(
        `Could not grant the sandbox identity access to the workspace: ${result.error.trim() || `ACL helper exited with ${String(result.code)}`}`,
      );
  })();
  // A failed grant is not remembered as done: the next command should try again rather than inherit a promise
  // that already rejected, which would turn one transient icacls failure into a permanently broken workspace.
  work.catch(() => granted.delete(root));
  granted.set(root, work);
  return work;
}
/**
 * Whether this backend can run here — answered by *running it*, not by looking for a file.
 *
 * The first check is that a command starts at all (PowerShell present, the launcher compiles, the token is
 * created). The second is the one that matters: a write outside every grant must be refused by the system, and
 * the probe requires both the failure *and* the absence of the file it tried to create. A launcher that starts
 * processes but does not confine them would otherwise report itself available — and the caller's next step
 * ("run the command as if it were sandboxed") would be a lie.
 */
let availability: Promise<string | null> | undefined;
export function windowsSandboxAvailable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (process.platform !== 'win32')
    return Promise.resolve(
      'The Windows restricted-token backend only runs on Windows; use docker, sbx, or host',
    );
  availability ??= (async (): Promise<string | null> => {
    const powershell = powershellPath();
    try {
      await stat(powershell);
    } catch {
      return `PowerShell is not installed at ${powershell}; use docker, sbx, or host`;
    }
    const dll = launcherPath();
    const directory = path.dirname(dll);
    await mkdir(directory, { recursive: true });
    const source = await writeLauncherSource(dll);
    const args = launcherArgs(bootstrap(dll, source));
    const start = await run(powershell, args, {
      cwd: directory,
      env: starterEnvironment(
        {
          command: windowsCommandLine({ command: 'exit 0' }),
          cwd: directory,
          env: commandEnvironment(directory),
        },
        toolEnvironment(env),
      ),
    });
    if (start.code !== 0)
      return `The Windows sandbox launcher could not start a process: ${start.error.trim() || `exit code ${String(start.code)}`}; use docker, sbx, or host`;
    const probe = path.join(directory, `probe-${process.pid}.txt`);
    const confined = await run(powershell, args, {
      cwd: directory,
      env: starterEnvironment(
        {
          command: windowsCommandLine({ command: `echo probe> "${probe}"` }),
          cwd: directory,
          env: commandEnvironment(directory),
        },
        toolEnvironment(env),
      ),
    });
    const wrote = await stat(probe).then(
      () => true,
      () => false,
    );
    if (wrote) await rm(probe, { force: true });
    if (confined.code === 0 || wrote)
      return 'The restricted token did not confine a write outside the workspace; use docker, sbx, or host';
    return null;
  })().catch((error: unknown) => {
    availability = undefined;
    return `The Windows sandbox could not be prepared: ${String(error)}; use docker, sbx, or host`;
  });
  return availability;
}
/** Starts one command under the restricted token, granting the workspace and a private scratch directory. */
async function windowsPrepare(request: SandboxRequest): Promise<SandboxPlan> {
  const unavailable = await windowsSandboxAvailable();
  if (unavailable) throw new Error(unavailable);
  const canonical = await realpath(request.root);
  const working = await realpath(request.cwd);
  insideWorkspace(canonical, working);
  const sid = workspaceSandboxSid(canonical);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'yuantu-sandbox-'));
  try {
    await grant(canonical, sid);
    // The scratch directory is granted for the same reason the workspace is: almost every real command writes
    // *somewhere* for temporary files, and a sandbox whose commands cannot use a temp directory fails in ways
    // that look like the tool being broken rather than the sandbox doing its job. It is deliberately outside the
    // workspace — a command's scratch files are not the repository's business — and removed with the plan.
    await grant(scratch, sid);
    granted.delete(scratch);
    const dll = launcherPath();
    await mkdir(path.dirname(dll), { recursive: true });
    const source = await writeLauncherSource(dll);
    const env = commandEnvironment(scratch, request.env);
    return {
      executable: powershellPath(),
      // The script is constant, so the per-command data rides in the starter's environment (see `bootstrap`).
      args: launcherArgs(bootstrap(dll, source)),
      cwd: working,
      env: starterEnvironment(
        { command: windowsCommandLine(request), cwd: working, env, sid },
        toolEnvironment(),
      ),
      windowsVerbatimArguments: false,
      backend: 'windows',
      cleanupPath: scratch,
    };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
/**
 * Teardown: nothing was created but the scratch directory, which the seam removes for any backend that set
 * `cleanupPath`. The workspace grant stays, because it is not this command's — removing it would break every
 * command that runs next. It names only this workspace's identity; another workspace's token cannot use it.
 */
async function windowsCleanup(plan: SandboxPlan): Promise<void> {
  if (plan.cleanupPath) await rm(plan.cleanupPath, { recursive: true, force: true });
}
/** The backend as the seam sees it, registered by `sandbox.ts` next to the other built-ins. */
export const windowsSandboxProvider: SandboxProvider = {
  mode: 'windows',
  description:
    'Windows write-restricted token: workspace-specific write grants and private scratch; ambient Everyone write ACLs remain effective. Reads and network are not confined; strict workspace-only requirements are unsupported.',
  available: (env) => windowsSandboxAvailable(env),
  prepare: windowsPrepare,
  cleanup: windowsCleanup,
};
