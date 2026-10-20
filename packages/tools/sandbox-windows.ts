/**
 * Windows write-restricted token with a stable workspace-specific restricting SID. Grants for another
 * workspace, including legacy RESTRICTED grants, cannot satisfy this workspace's write check.
 *
 * The token runs at Low integrity. The restricting list also carries Everyone and the native logon SID:
 * Node DLL initialization requires these system-object identities. Ambient Low-integrity write ACLs naming them remain effective, so this backend declares
 * a partial filesystem boundary. Strict workspace-only, read-only process or denied-network requirements
 * must select a backend that can enforce them. Reads and network are unrestricted.
 *
 * Workspace ACLs and labels are journaled before modification, leased across concurrent plans, and restored
 * after the final cleanup. An exclusive disk lock refuses cross-process overlap; crash journals require
 * explicit reconciliation. Everyone FILE_DELETE_CHILD is denied on lowered writable directories.
 * File-tool paths remain bounded by Workspace independently of this process policy.
 *
 * The command is handed to the launcher as a base64 JSON payload and never interpolated into the PowerShell
 * text that starts it: the script below contains the payload, not the command, so no command can escape into
 * PowerShell source no matter what it contains. That is what makes an arbitrary model-authored command safe to
 * carry through a shell in the first place.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { toolEnvironment } from './environment.ts';
import { testResource } from '../platform/test-lifecycle.ts';
import { createOwnedFileLease } from './owned-file-lease.ts';
import { EnvironmentBlockedError } from './environment-blocked.ts';
import { WINDOWS_CAPABILITIES } from './execution-capabilities.ts';
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
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

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
    static extern bool CreateProcessAsUserW(IntPtr token, string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JOB_LIMITS limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out JOB_ACCOUNTING accounting, uint length, IntPtr returned);
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct JOB_LIMITS {
        public BASIC_LIMITS Basic;
        public IO_COUNTERS Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct JOB_ACCOUNTING {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    const uint TOKEN_DUPLICATE = 0x0002;
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const int STARTF_USESTDHANDLES = 0x100;

    public static int Run(string commandLine, string directory, string[] environment, string[] restrictingSids, uint flags)
    {
        IntPtr current;
        if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out current))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken");
        if (restrictingSids == null || restrictingSids.Length == 0)
            throw new InvalidOperationException("Missing sandbox identities");
        var restricting = new List<SID_AND_ATTRIBUTES>();
        foreach (string identity in restrictingSids) {
            IntPtr sid;
            if (!ConvertStringSidToSidW(identity, out sid))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSidToSid");
            restricting.Add(new SID_AND_ATTRIBUTES { sid = sid });
        }
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
        restricting.Add(new SID_AND_ATTRIBUTES { sid = world });
        restricting.Add(new SID_AND_ATTRIBUTES { sid = logon });
        if (!CreateRestrictedToken(current, flags, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restricting.Count, restricting.ToArray(), out restricted))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateRestrictedToken");
        SetLowIntegrity(restricted);
        foreach (string identity in restrictingSids) GrantDefaultDacl(restricted, identity);
        IntPtr block = EnvironmentBlock(environment);
        var startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // The child writes straight into the pipes this process was given, so output streams while it runs
        // instead of arriving in one piece at the end.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = GetStdHandle(-10);
        startup.StartupInfo.hStdOutput = GetStdHandle(-11);
        startup.StartupInfo.hStdError = GetStdHandle(-12);
        IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Create sandbox job");
        PROCESS_INFORMATION info = new PROCESS_INFORMATION();
        IntPtr attributes = IntPtr.Zero;
        IntPtr jobs = Marshal.AllocHGlobal(IntPtr.Size);
        bool attributesReady = false;
        try {
        var limits = new JOB_LIMITS();
        limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; breakaway is never permitted.
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOB_LIMITS))))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Set sandbox job limits");
        /*
         * The child is created *inside* the job (PROC_THREAD_ATTRIBUTE_JOB_LIST), not assigned to it afterwards.
         *
         * Create-then-assign leaves a moment in which the child exists but belongs to no job of ours. A launcher
         * killed in that moment (its parent quitting, for instance) left a suspended child nobody would resume or
         * kill, holding the pipes it inherited. Created in the job, the child dies with this process's job handle.
         */
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        attributes = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Initialize sandbox attributes");
        attributesReady = true;
        Marshal.WriteIntPtr(jobs, job);
        const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000D;
        if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Set sandbox job attribute");
        startup.lpAttributeList = attributes;
        const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
        // Suspended as well, so nothing runs before this process holds the handles it waits on.
        if (!CreateProcessAsUserW(restricted, null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | 0x4, block, directory, ref startup, out info))
            // The number and the system's own sentence, because this is the one failure a caller cannot diagnose
            // from anything else: "CreateProcessAsUser" alone says neither what went wrong nor which of the two
            // ways in (shell text vs program+argv) was taken.
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
        TestLaunchPause();
        if (ResumeThread(info.hThread) == 0xFFFFFFFF)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Resume sandbox process");
        WaitForSingleObject(info.hProcess, 0xFFFFFFFF);
        uint code;
        if (!GetExitCodeProcess(info.hProcess, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!TerminateJobObject(job, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Terminate sandbox descendants");
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true) {
            JOB_ACCOUNTING accounting;
            if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JOB_ACCOUNTING)), IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Confirm sandbox job termination");
            if (accounting.ActiveProcesses == 0) break;
            if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("Sandbox descendants did not terminate");
            System.Threading.Thread.Sleep(10);
        }
        return (int)code;
        } finally {
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            Marshal.FreeHGlobal(jobs);
            CloseHandle(job);
            if (info.hThread != IntPtr.Zero) CloseHandle(info.hThread);
            if (info.hProcess != IntPtr.Zero) CloseHandle(info.hProcess);
            Marshal.FreeHGlobal(block);
            CloseHandle(restricted);
            CloseHandle(current);
        }
    }

    // Tests widen the moment between creating the command and resuming it, so a launcher kill can be aimed there.
    // The variable is read from the launcher's own environment, which a sandboxed command cannot set.
    static void TestLaunchPause()
    {
        int ms;
        if (int.TryParse(Environment.GetEnvironmentVariable("YUANTU_SANDBOX_TEST_LAUNCH_PAUSE_MS"), out ms) && ms > 0)
            System.Threading.Thread.Sleep(Math.Min(ms, 60000));
    }

    static void SetLowIntegrity(IntPtr token)
    {
        IntPtr sid;
        if (!ConvertStringSidToSidW("S-1-16-4096", out sid)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Low integrity SID");
        IntPtr label = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) + 12);
        try {
            Marshal.StructureToPtr(new SID_AND_ATTRIBUTES { sid = sid, attributes = 0x20 }, label, false);
            if (!SetTokenInformation(token, 25, label, (uint)(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) + 12)))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenIntegrityLevel Low");
        } finally { Marshal.FreeHGlobal(label); LocalFree(sid); }
    }
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);

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
  const existing = await readFile(file, 'utf8').then(
    (text) => text === launcherSource,
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
 * One path as a *complete* PowerShell single-quoted literal, delimiters included.
 *
 * Single quotes are the right delimiter — nothing inside them is expanded — but the literal ends at the first
 * `'`, and a temp directory like `C:\Users\O'Brien\AppData\Local\Temp` is ordinary on Windows. Left alone, that
 * apostrophe closes the string early and the remainder of the path is handed to PowerShell as source, which
 * fails to parse before the launcher is ever loaded. Doubling the quote is the language's own escape for it;
 * inside a single-quoted literal no other character needs escaping.
 */
function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
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
    `$dll = ${powerShellLiteral(dll)}`,
    'if (-not (Test-Path -LiteralPath $dll)) {',
    `  $temporary = $dll + '.' + $PID + '.dll'`,
    `  Add-Type -TypeDefinition ([IO.File]::ReadAllText(${powerShellLiteral(source)})) -OutputAssembly $temporary`,
    // Two commands can arrive at once on a cold cache. The loser's move fails because the winner's file is
    // already loaded, which is a success: the launcher that is there is the same launcher.
    '  try { Move-Item -LiteralPath $temporary -Destination $dll -Force -ErrorAction Stop }',
    '  catch { if (-not (Test-Path -LiteralPath $dll)) { throw } }',
    '  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue',
    '}',
    '[void][Reflection.Assembly]::LoadFrom($dll)',
    `$spec = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${SPEC_VARIABLE})))`,
    `exit [YuantuSandbox]::Run([string]$spec.command, [string]$spec.cwd, [string[]]$spec.env, [string[]]$spec.sids, ${LAUNCHER_FLAGS})`,
  ].join('\n');
}
/** What one command needs: where to run, what to run, and the environment the child is started with. */
interface Spec {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sid?: string;
  sids?: string[];
}
/** The environment for the *starter*: this process's sanitised set plus the payload it reads back. */
function starterEnvironment(spec: Spec, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    [SPEC_VARIABLE]: encode(
      JSON.stringify({
        command: spec.command,
        cwd: spec.cwd,
        sids: spec.sids ?? [spec.sid ?? workspaceSandboxSid(spec.cwd)],
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
  testResource('windows-sandbox');
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
 * Grants a disposable scratch directory to its independent sandbox SID.
 *
 * Persistent workspace security changes use the journal helper below instead of this disposable grant.
 */
const scratchGrant = [
  '$sid = [Security.Principal.SecurityIdentifier]::new([string]$spec.sid)',
  '$acl = Get-Acl -LiteralPath ([string]$spec.root)',
  // Only disposable scratch uses a protected DACL. Workspace grants continue to merge user ACLs.
  'if ($spec.privateScratch) {',
  '  $acl = [Security.AccessControl.DirectorySecurity]::new()',
  '  $acl.SetAccessRuleProtection($true, $false)',
  '  foreach ($identity in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new("S-1-5-18"))) {',
  '    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit", [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))',
  '  }',
  // An owner retains READ_CONTROL but has no implicit WRITE_DAC path around the restricting SID check.
  '  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new("S-1-3-4"), [Security.AccessControl.FileSystemRights]::ReadPermissions, [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit", [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))',
  '}',
  '$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit", [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)',
  '$acl.AddAccessRule($rule)',
  '$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new("S-1-1-0"), [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles, [Security.AccessControl.InheritanceFlags]::ContainerInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny))',
  'Set-Acl -LiteralPath ([string]$spec.root) -AclObject $acl',
  '& "$env:SystemRoot\\System32\\icacls.exe" ([string]$spec.root) /setintegritylevel "(OI)(CI)L" /Q | Out-Null',
  'if ($LASTEXITCODE -ne 0) { throw "Could not label sandbox scratch Low integrity" }',
].join('\n');

interface WorkspaceLease {
  references: number;
  journal: string;
  releaseLock: () => Promise<void>;
  closing?: Promise<void>;
}
const workspaceLeases = new Map<string, Promise<WorkspaceLease>>();
const planLeases = new WeakMap<SandboxPlan, { root: string; scratch: string }>();
const planCleanup = new WeakMap<SandboxPlan, Promise<void>>();
// Electron's CommonJS bundles live in dist/desktop; ordinary ESM keeps the module-relative asset.
const aclHelper =
  typeof __dirname === 'string'
    ? path.resolve(__dirname, '../packages/tools/windows-sandbox/acl.ps1')
    : fileURLToPath(new URL('./windows-sandbox/acl.ps1', import.meta.url));
// Capture trusted application code once. Guest workspace edits must never become host cleanup code.
// Read on first use rather than at import: every Host imports this module, most never prepare a Windows sandbox,
// and a read at import time ties module loading to a file path a bundler moves. The helper ships with the
// application rather than in any workspace, and it is still captured once and reused for the process's lifetime.
let aclSourceMemo: string | undefined;
const aclSource = (): string =>
  (aclSourceMemo ??= gzipSync(readFileSync(aclHelper)).toString('base64'));
const ACL_VARIABLE = 'YUANTU_SANDBOX_ACL_SOURCE';
const aclBootstrap = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `$spec = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${SPEC_VARIABLE})))`,
  `$bytes = [Convert]::FromBase64String($env:${ACL_VARIABLE})`,
  '$memory = [IO.MemoryStream]::new([byte[]]$bytes, $false)',
  '$gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Decompress)',
  '$reader = [IO.StreamReader]::new($gzip)',
  '$script = [ScriptBlock]::Create($reader.ReadToEnd())',
  '$reader.Dispose()',
  '& $script -Operation ([string]$spec.operation) -Root ([string]$spec.root) -Journal ([string]$spec.journal) -Sid ([string]$spec.sid) -ControlRoots ([string[]]$spec.controlRoots)',
  // Check every control path before granting disposable scratch. One helper launch also compiles YuantuAcl
  // just once; no successful validation is cached across prepares or TEMP changes.
  'if ($spec.scratch) {',
  '  $spec = $spec.scratch',
  scratchGrant,
  '}',
].join('\n');
interface ProcessLease {
  references: number;
  release: () => Promise<void>;
  closing?: Promise<void>;
}
let processLease: Promise<ProcessLease> | undefined;
/** One Host owns persistent ACL changes at a time, including overlapping roots in other Hosts. */
async function acquireProcessLease(state: string): Promise<() => Promise<void>> {
  processLease ??= (async () => {
    const lockPath = path.join(state, 'workspace-owner.lock');
    const lease = await createOwnedFileLease(lockPath, { pid: process.pid }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        throw await leaseRefusal(state, lockPath);
      },
    );
    return {
      references: 0,
      release: lease.release,
    };
  })();
  const pending = processLease;
  let lease: ProcessLease;
  try {
    lease = await pending;
  } catch (error) {
    if (processLease === pending) processLease = undefined;
    throw error;
  }
  if (lease.closing) {
    await lease.closing;
    return acquireProcessLease(state);
  }
  lease.references++;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--lease.references !== 0) return;
    lease.closing = lease.release().finally(() => {
      if (processLease === pending) processLease = undefined;
    });
    await lease.closing;
  };
}
/** Account-derived, so it stays independent of TEMP/USERPROFILE and MSIX AppData virtualization. */
export function windowsSandboxStateDirectory(): string {
  return path.join(os.userInfo().homedir, '.yuantu', 'sandbox-state', 'windows');
}
const OWNER_LOCK = 'workspace-owner.lock';
/**
 * Whether the process a lock names is still running.
 *
 * Our own pid counts only while this process really holds a lease: a lock carrying it with nothing held here
 * was left by an earlier process that happened to get the same pid. `EPERM` is a process we may not signal,
 * which is still a process.
 */
function processAlive(pid: number): boolean {
  if (pid === process.pid) return processLease !== undefined || workspaceLeases.size > 0;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
/** A lock with no readable owner this young is a lease being published, not a leftover. */
const PUBLISHING_GRACE_MS = 60_000;
export type WindowsSandboxLeaseState = 'clear' | 'held' | 'stale' | 'needs-restore' | 'unreadable';
export interface WindowsSandboxLeaseReport {
  /**
   * `held`: another live process owns the sandbox. `stale`: only dead owners' locks remain. `needs-restore`:
   * a dead owner also left recovery journals, so workspace permissions still carry its grant. `unreadable`: a
   * lock names no owner, and nothing can tell whether it is in use.
   */
  state: WindowsSandboxLeaseState;
  directory: string;
  /** Every lock except this process's own live ones. */
  locks: { file: string; pid?: number; alive: boolean }[];
  /** Recovery journals whose lock is not this process's own live one. */
  journals: string[];
}
/**
 * What the Windows sandbox's lease directory says about who holds it — read only, never repaired.
 *
 * The lease is released by the process that took it, after it restores the workspace's permissions. A process
 * that dies in between leaves its locks, and possibly its journals, and every later command is refused until a
 * person reconciles them (see `recoverWindowsSandboxLeases`). This is what turns that refusal into a reason.
 */
export async function inspectWindowsSandboxLeases(
  directory = windowsSandboxStateDirectory(),
  alive: (pid: number) => boolean = processAlive,
): Promise<WindowsSandboxLeaseReport> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const locks: WindowsSandboxLeaseReport['locks'] = [];
  const ours = new Set<string>();
  let publishing = false;
  for (const name of names.filter((entry) => entry.endsWith('.lock')).sort()) {
    const file = path.join(directory, name);
    const pid = await readFile(file, 'utf8')
      .then((text) => {
        const value: unknown = (JSON.parse(text) as { pid?: unknown }).pid;
        return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
          ? value
          : undefined;
      })
      .catch(() => undefined);
    if (pid === undefined) {
      const age = await stat(file).then(
        (info) => Date.now() - info.mtimeMs,
        () => Infinity,
      );
      if (age < PUBLISHING_GRACE_MS) publishing = true;
      locks.push({ file, alive: false });
      continue;
    }
    const live = alive(pid);
    if (live && pid === process.pid) {
      ours.add(name.slice(0, -'.lock'.length));
      continue;
    }
    locks.push({ file, pid, alive: live });
  }
  const journals = names
    .filter((entry) => entry.endsWith('.json') && !ours.has(entry.slice(0, -'.json'.length)))
    .sort()
    .map((entry) => path.join(directory, entry));
  const state: WindowsSandboxLeaseState =
    publishing || locks.some((lock) => lock.alive)
      ? 'held'
      : locks.some((lock) => lock.pid === undefined)
        ? 'unreadable'
        : journals.length
          ? 'needs-restore'
          : locks.length
            ? 'stale'
            : 'clear';
  return { state, directory, locks, journals };
}
const RECOVER_COMMAND = '`yuantu-agent sandbox-recover` (add `--dry-run` to only inspect)';
/** The refusal a person and the model read for a lease state other than `clear`. */
export function leaseBlockedError(report: WindowsSandboxLeaseReport): EnvironmentBlockedError {
  const pids = [
    ...new Set(report.locks.flatMap((lock) => (lock.pid === undefined ? [] : [lock.pid]))),
  ].join(', ');
  switch (report.state) {
    case 'held':
      return new EnvironmentBlockedError(
        'windows-sandbox-in-use',
        `The Windows sandbox is in use by another YuanTu process${pids ? ` (pid ${pids})` : ''}; no command was started.`,
        'Wait for that process to finish its command, or close it, and then ask again.',
      );
    case 'stale':
      return new EnvironmentBlockedError(
        'windows-sandbox-stale-lease',
        `A YuanTu process that is no longer running (pid ${pids}) left the Windows sandbox lease behind in ${report.directory}; no command was started.`,
        `A person can release it with ${RECOVER_COMMAND}, or switch this session to another execution environment.`,
      );
    case 'needs-restore':
      return new EnvironmentBlockedError(
        'windows-sandbox-needs-restore',
        `A YuanTu process that is no longer running${pids ? ` (pid ${pids})` : ''} exited while workspace permissions were granted to the Windows sandbox; the original permissions are kept in ${report.journals.length} recovery journal(s) in ${report.directory}, and no command was started.`,
        `A person can restore them and release the lease with ${RECOVER_COMMAND}.`,
      );
    default:
      return new EnvironmentBlockedError(
        'windows-sandbox-lease-unreadable',
        `A Windows sandbox lock in ${report.directory} names no owner process; no command was started.`,
        'A person has to inspect that directory; nothing removes such a lock automatically.',
      );
  }
}
/** Why an exclusive create of `lockPath` failed, classified once the directory has been read. */
async function leaseRefusal(directory: string, lockPath: string): Promise<Error> {
  const report = await inspectWindowsSandboxLeases(directory).catch(() => undefined);
  return report && report.state !== 'clear'
    ? leaseBlockedError(report)
    : new Error(
        `Windows workspace ACL is leased by another process or needs recovery: ${lockPath}`,
      );
}
/**
 * The operator's reconciliation of a lease a dead process left: restore every journal, then remove the locks.
 *
 * Refuses while any owner is alive or unidentifiable — this never decides that a running process is gone. A
 * restore that fails (the workspace's permissions were changed since, or the folder is gone) stops here with the
 * journal and every lock kept, so nothing is released over permissions that were not put back.
 */
export async function recoverWindowsSandboxLeases(
  directory = windowsSandboxStateDirectory(),
  alive: (pid: number) => boolean = processAlive,
  restore: (root: string, journal: string, sid: string) => Promise<void> = (root, journal, sid) =>
    journalOperation('restore', root, journal, sid),
): Promise<WindowsSandboxLeaseReport & { restored: string[]; removed: string[] }> {
  const report = await inspectWindowsSandboxLeases(directory, alive);
  if (report.state === 'held' || report.state === 'unreadable') throw leaseBlockedError(report);
  const restored: string[] = [];
  for (const journal of report.journals) {
    const record = JSON.parse((await readFile(journal, 'utf8')).replace(/^﻿/, '')) as {
      root?: unknown;
      sid?: unknown;
    };
    if (typeof record.root !== 'string' || typeof record.sid !== 'string')
      throw new Error(`Recovery journal names no workspace; reconcile it manually: ${journal}`);
    await restore(record.root, journal, record.sid);
    restored.push(record.root);
  }
  // A grant that died between writing its next journal and replacing the old one leaves the `.next` file, which
  // would make the next grant's exclusive create fail. Its journal is restored above, so it records nothing left.
  for (const name of (await readdir(directory).catch(() => [] as string[])).filter((entry) =>
    entry.endsWith('.json.next'),
  ))
    await rm(path.join(directory, name), { force: true });
  // The owner lock goes last: while it exists, no other Host can start a lease over half-removed state.
  const removed = report.locks
    .map((lock) => lock.file)
    .sort(
      (a, b) => Number(path.basename(a) === OWNER_LOCK) - Number(path.basename(b) === OWNER_LOCK),
    );
  for (const file of removed) await rm(file, { force: true });
  return { ...report, restored, removed };
}
async function journalOperation(
  operation: 'grant' | 'restore' | 'validate-control',
  root: string,
  journal: string,
  sid: string,
  preparation?: {
    controlRoots: string[];
    scratch: { root: string; sid: string; privateScratch: true };
  },
): Promise<void> {
  const result = await run(powershellPath(), launcherArgs(aclBootstrap), {
    env: {
      ...toolEnvironment(),
      [ACL_VARIABLE]: aclSource(),
      [SPEC_VARIABLE]: encode(JSON.stringify({ operation, root, journal, sid, ...preparation })),
    },
  });
  if (result.code !== 0) {
    const detail = `Windows sandbox ACL ${operation} failed; recovery journal ${journal}: ${result.error}`;
    if (operation === 'grant')
      throw new EnvironmentBlockedError(
        'windows-sandbox-acl-failed',
        detail,
        'Resolve the named ACL or workspace link problem before retrying. Keep the configured isolation.',
      );
    throw new Error(detail);
  }
}
async function acquireWorkspace(root: string, sid: string, state: string): Promise<void> {
  for (const existing of workspaceLeases.keys()) {
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
      );
    };
    if (existing !== root && (contains(existing, root) || contains(root, existing)))
      throw new Error('Overlapping Windows sandbox ACL leases are unsupported');
  }
  let pending = workspaceLeases.get(root);
  if (pending) {
    const lease = await pending;
    if (lease.closing) {
      await lease.closing;
      return acquireWorkspace(root, sid, state);
    }
  }
  if (!pending) {
    pending = (async () => {
      const releaseProcess = await acquireProcessLease(state);
      const name = createHash('sha256').update(root.toLowerCase()).digest('hex');
      const lockPath = path.join(state, `${name}.lock`);
      const journal = path.join(state, `${name}.json`);
      const lock = await open(lockPath, 'wx').catch(async () => {
        await releaseProcess();
        throw await leaseRefusal(state, lockPath);
      });
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, root, journal }));
        await lock.sync();
      } catch (error) {
        // Publishing failed after the exclusive create: close the handle and remove only the file this attempt
        // made, so the next prepare retries instead of reading the leftover as "needs recovery" forever.
        await lock.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        await releaseProcess().catch(() => undefined);
        throw error;
      }
      const releaseLock = async () => {
        await lock.close();
        await rm(lockPath);
        await releaseProcess();
      };
      try {
        await journalOperation('grant', root, journal, sid);
        return { references: 0, journal, releaseLock };
      } catch (error) {
        // Retain lock + journal after partial mutation; never automatically guess that another process died.
        const journalExists = await stat(journal).then(
          () => true,
          () => false,
        );
        if (!journalExists) await releaseLock();
        else await lock.close();
        throw error;
      }
    })();
    workspaceLeases.set(root, pending);
    pending.catch(() => workspaceLeases.delete(root));
  }
  const lease = await pending;
  lease.references++;
}
async function releaseWorkspace(root: string): Promise<void> {
  const pending = workspaceLeases.get(root);
  if (!pending) return;
  const lease = await pending;
  if (--lease.references !== 0) return;
  // Block new prepares until restoration completes, then release the cross-process lease.
  lease.closing = (async () => {
    try {
      await journalOperation('restore', root, lease.journal, workspaceSandboxSid(root));
      await lease.releaseLock();
    } finally {
      workspaceLeases.delete(root);
    }
  })();
  await lease.closing;
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
      'The Windows restricted-token backend only runs on Windows; no command was started',
    );
  testResource('windows-sandbox');
  availability ??= (async (): Promise<string | null> => {
    const powershell = powershellPath();
    try {
      await stat(powershell);
    } catch {
      return `PowerShell is not installed at ${powershell}; no command was started`;
    }
    const dll = launcherPath();
    const directory = path.dirname(dll);
    await mkdir(directory, { recursive: true });
    await journalOperation('validate-control', directory, '-', '-');
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
      return `The Windows sandbox launcher could not start a process: ${start.error.trim() || `exit code ${String(start.code)}`}; execution refused`;
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
      return 'The restricted token did not confine a write outside the workspace; execution refused';
    const deleteProbe = path.join(directory, `delete-probe-${process.pid}-${randomUUID()}.txt`);
    await writeFile(deleteProbe, 'retain', { flag: 'wx' });
    let retained = false;
    try {
      await run(powershell, args, {
        cwd: directory,
        env: starterEnvironment(
          {
            command: windowsCommandLine({ command: `del /q "${deleteProbe}"` }),
            cwd: directory,
            env: commandEnvironment(directory),
          },
          toolEnvironment(env),
        ),
      });
      retained = await stat(deleteProbe).then(
        () => true,
        () => false,
      );
    } finally {
      await rm(deleteProbe, { force: true });
    }
    if (!retained)
      return 'The restricted token could delete launcher-cache files; execution refused';
    return null;
  })().catch((error: unknown) => {
    availability = undefined;
    return `The Windows sandbox could not be prepared: ${String(error)}; execution refused`;
  });
  return availability;
}
/** Starts one command under the restricted token, granting the workspace and a private scratch directory. */
async function windowsPrepare(request: SandboxRequest): Promise<SandboxPlan> {
  insideWorkspace(request.root, request.cwd);
  if (request.config.files === 'read-only')
    throw new Error(
      'Windows basic sandbox cannot enforce strict process read-only; select a backend with read-only enforcement',
    );
  if (request.config.network === 'denied')
    throw new Error('Windows basic sandbox cannot deny network access');
  const unavailable = await windowsSandboxAvailable();
  if (unavailable) throw new Error(unavailable);
  const canonical = await realpath(request.root);
  const working = await realpath(request.cwd);
  insideWorkspace(canonical, working);
  const sid = workspaceSandboxSid(canonical);
  const dll = launcherPath();
  await mkdir(path.dirname(dll), { recursive: true });
  // Account-derived profile stays independent of TEMP/USERPROFILE and MSIX AppData virtualization.
  const state = windowsSandboxStateDirectory();
  await mkdir(state, { recursive: true });
  if (path.resolve(await realpath(state)).toLowerCase() !== path.resolve(state).toLowerCase())
    throw new Error('Windows sandbox refuses redirected ACL state paths');
  const cache = await realpath(path.dirname(dll));
  const contains = (target: string) => {
    const relative = path.relative(canonical, target);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  };
  if (path.parse(canonical).root.toLowerCase() === canonical.toLowerCase())
    throw new Error('Windows sandbox refuses a volume root as workspace');
  if (contains(state) || contains(cache))
    throw new Error('Windows sandbox workspace contains trusted control paths; execution refused');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'yuantu-sandbox-'));
  let workspaceAcquired = false;
  try {
    // The scratch directory is granted for the same reason the workspace is: almost every real command writes
    // *somewhere* for temporary files, and a sandbox whose commands cannot use a temp directory fails in ways
    // that look like the tool being broken rather than the sandbox doing its job. It is deliberately outside the
    // workspace — a command's scratch files are not the repository's business — and removed with the plan.
    const scratchSid = workspaceSandboxSid(scratch);
    await journalOperation('validate-control', path.dirname(dll), '-', '-', {
      controlRoots: [state],
      scratch: { root: scratch, sid: scratchSid, privateScratch: true },
    });
    const source = await writeLauncherSource(dll);
    await acquireWorkspace(canonical, sid, state);
    workspaceAcquired = true;
    const env = commandEnvironment(scratch, request.env);
    const plan: SandboxPlan = {
      executable: powershellPath(),
      // The script is constant, so the per-command data rides in the starter's environment (see `bootstrap`).
      args: launcherArgs(bootstrap(dll, source)),
      cwd: working,
      env: starterEnvironment(
        { command: windowsCommandLine(request), cwd: working, env, sids: [sid, scratchSid] },
        toolEnvironment(),
      ),
      windowsVerbatimArguments: false,
      backend: 'windows',
      processTree: 'contained',
      cleanupPath: scratch,
    };
    planLeases.set(plan, { root: canonical, scratch });
    return plan;
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    if (workspaceAcquired) await releaseWorkspace(canonical);
    throw error;
  }
}
/**
 * Teardown restores the original workspace security after the last concurrent plan releases its lease,
 * then deletes this plan's private scratch. Repeated cleanup of a plan cannot release another plan's lease.
 */
async function windowsCleanup(plan: SandboxPlan): Promise<void> {
  const existing = planCleanup.get(plan);
  if (existing) return existing;
  const owned = planLeases.get(plan);
  // A serialized or forged plan does not own the parent process's lease or any cleanup path.
  if (!owned) return;
  planLeases.delete(plan);
  const work = (async () => {
    try {
      await releaseWorkspace(owned.root);
    } finally {
      await rm(owned.scratch, { recursive: true, force: true });
    }
  })();
  planCleanup.set(plan, work);
  return work;
}
/** The backend as the seam sees it, registered by `sandbox.ts` next to the other built-ins. */
export const windowsSandboxProvider: SandboxProvider = {
  mode: 'windows',
  capabilities: () => WINDOWS_CAPABILITIES,
  description:
    'Windows Low integrity write-restricted token: journaled workspace write grants and private scratch; ambient Low integrity Everyone grants remain effective. Reads and network are not confined; strict process read-only is unsupported.',
  available: (env) => windowsSandboxAvailable(env),
  blocked: async () => {
    if (process.platform !== 'win32') return undefined;
    const report = await inspectWindowsSandboxLeases();
    return report.state === 'clear' ? undefined : leaseBlockedError(report);
  },
  prepare: windowsPrepare,
  cleanup: windowsCleanup,
};
