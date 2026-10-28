/** Recovery-only support for ACL journals left by the retired Windows token backend. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { toolEnvironment } from './environment.ts';
import { testResource, testWindowsSandboxStateDirectory } from '../platform/test-lifecycle.ts';
import { EnvironmentBlockedError } from '../protocol/environment-blocked.ts';

function powershellPath(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
/**
 * The environment for our own PowerShell helpers, with TEMP and TMP where `Add-Type` can compile.
 *
 * `Add-Type` compiles through csc, which fails with "The filename, directory name, or volume label syntax is
 * incorrect" when the temp path has characters outside the ANSI code page: a CJK temp directory on an
 * English-locale Windows. Setting TEMP inside the PowerShell process is too late, and an 8.3 short name does not
 * help because the path is expanded back to its long form. So a helper whose temp path is not ASCII compiles in the
 * nearest ancestor of that path whose name is ASCII: still the temp directory's owner's own tree, which already holds
 * the launcher assembly. Only the helper's environment changes; a command keeps its own TEMP.
 */
function helperEnvironment(base: NodeJS.ProcessEnv = toolEnvironment()): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of ['TEMP', 'TMP']) {
    let directory = env[name];
    while (directory && /[^\x20-\x7e]/.test(directory) && path.dirname(directory) !== directory)
      directory = path.dirname(directory);
    env[name] = directory;
  }
  return env;
}

const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const SPEC_VARIABLE = 'YUANTU_SANDBOX_SPEC';
const IN_BOX_MODULES = [
  "$PSModuleAutoLoadingPreference = 'None'",
  "foreach ($module in 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security') { Import-Module -Name ($PSHOME + '\\Modules\\' + $module + '\\' + $module + '.psd1') }",
];
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
  ...IN_BOX_MODULES,
  "$ProgressPreference = 'SilentlyContinue'",
  `$spec = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${SPEC_VARIABLE})))`,
  `$bytes = [Convert]::FromBase64String($env:${ACL_VARIABLE})`,
  '$memory = [IO.MemoryStream]::new([byte[]]$bytes, $false)',
  '$gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Decompress)',
  '$reader = [IO.StreamReader]::new($gzip)',
  '$script = [ScriptBlock]::Create($reader.ReadToEnd())',
  '$reader.Dispose()',
  '& $script -Operation ([string]$spec.operation) -Root ([string]$spec.root) -Journal ([string]$spec.journal) -Sid ([string]$spec.sid) -ControlRoots ([string[]]$spec.controlRoots)',
].join('\n');

export function windowsSandboxStateDirectory(): string {
  return (
    testWindowsSandboxStateDirectory() ??
    path.join(os.userInfo().homedir, '.yuantu', 'sandbox-state', 'windows')
  );
}
const OWNER_LOCK = 'workspace-owner.lock';
/**
 * Whether the process a lock names is still running.
 *
 * A live process is never treated as a dead owner, including this recovery process.
 */
function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
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
  /** Every historical lock, including a live owner. */
  locks: { file: string; pid?: number; alive: boolean }[];
  /** Historical recovery journals. */
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
    locks.push({ file, pid, alive: live });
  }
  const journals = names
    .filter((entry) => entry.endsWith('.json'))
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
  operation: 'restore',
  root: string,
  journal: string,
  sid: string,
): Promise<void> {
  const result = await run(powershellPath(), launcherArgs(aclBootstrap), {
    env: {
      ...helperEnvironment(),
      [ACL_VARIABLE]: aclSource(),
      [SPEC_VARIABLE]: encode(JSON.stringify({ operation, root, journal, sid })),
    },
  });
  if (result.code !== 0)
    throw new Error(
      `Windows sandbox ACL restore failed; recovery journal ${journal}: ${result.error}`,
    );
}

export function workspaceSandboxSid(root: string): string {
  const digest = createHash('sha256').update(path.resolve(root).toLowerCase()).digest();
  return `S-1-5-21-${digest.readUInt32LE(0)}-${digest.readUInt32LE(4)}-${digest.readUInt32LE(8)}-${digest.readUInt32LE(12)}`;
}
