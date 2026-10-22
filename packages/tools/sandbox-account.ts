/**
 * The Windows sandbox account backend (`windows-account`): commands run as a dedicated local account, under a
 * write-restricted token whose only workspace grant is the workspace's own capability SID.
 *
 * The native side (`yuantu-sandbox.exe`) does the work: initialization, the per-workspace grant, the broker that
 * logs the runner on as the sandbox account, and the runner that creates each command inside its own Job. This
 * module decides what to ask for: which account (the network policy), which capability (the workspace, unless
 * the files are read-only), and what command line. See docs/superpowers/specs/2026-10-21-windows-account-sandbox-design.md.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { toolEnvironment } from './environment.ts';
import { windowsAccountCapabilities } from './execution-capabilities.ts';
import {
  brokerPipe,
  stopBrokers,
  type BrokerLauncher,
  type SandboxAccount,
} from './sandbox-account-broker.ts';
import { setWindowsAccountReady } from './sandbox-mode.ts';
import {
  insideWorkspace,
  type SandboxPlan,
  type SandboxProvider,
  type SandboxRequest,
} from './sandbox-provider.ts';
import { quoteWindowsArgument, windowsProgramNeedsShell } from './sandbox-windows.ts';

const assetRoot =
  typeof __dirname === 'string'
    ? path.resolve(__dirname, '../packages/tools/windows-sandbox')
    : fileURLToPath(new URL('./windows-sandbox/', import.meta.url));

/** Runs the helper with fixed arguments and answers its stdout; replaced in tests. */
export type HelperRunner = (helper: string, args: string[]) => Promise<string>;

const runHelper: HelperRunner = async (helper, args) => {
  const { stdout } = await promisify(execFile)(helper, args, {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1 << 20,
    timeout: 60_000,
    env: toolEnvironment(),
  });
  return stdout;
};

interface Configuration {
  helper: string;
  run: HelperRunner;
  launch?: BrokerLauncher;
  state: string;
}
let configuration: Configuration = {
  helper: path.join(assetRoot, 'yuantu-sandbox.exe'),
  run: runHelper,
  state: path.join(os.userInfo().homedir, '.yuantu', 'sandbox-state', 'windows-account'),
};

/**
 * Replaces the helper, how it is run, and where state lives. For tests and the native acceptance suite only:
 * a Host always uses the helper shipped beside this module.
 */
export function configureAccountBackend(change: Partial<Configuration>): void {
  configuration = { ...configuration, ...change };
  grants.clear();
  capabilities = undefined;
  status = undefined;
}

export interface AccountStatus {
  version: 1;
  ready: boolean;
  problems: string[];
  details: string[];
  accounts: { account: SandboxAccount; sid: string | null }[];
  group: string | null;
}

const SID = /^S-1-5-21(?:-\d{1,10}){4}$/;

/** Parses `account-status` output, refusing anything that is not exactly the shape the helper writes. */
export function parseAccountStatus(text: string): AccountStatus {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The sandbox account helper returned an unreadable status');
  }
  const status = value as Record<string, unknown>;
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((x) => typeof x === 'string');
  const accounts = status?.accounts;
  if (
    !status ||
    typeof status !== 'object' ||
    status.version !== 1 ||
    typeof status.ready !== 'boolean' ||
    !strings(status.problems) ||
    !strings(status.details) ||
    !(status.group === null || (typeof status.group === 'string' && SID.test(status.group))) ||
    !Array.isArray(accounts) ||
    accounts.length !== 2 ||
    !accounts.every(
      (entry: { account?: unknown; sid?: unknown }) =>
        (entry.account === 'offline' || entry.account === 'online') &&
        (entry.sid === null || (typeof entry.sid === 'string' && SID.test(entry.sid))),
    ) ||
    Object.keys(status).length !== 6
  )
    throw new Error('The sandbox account helper returned an invalid status');
  // A status that calls itself ready while naming problems is not believed.
  if (status.ready && (status.problems as string[]).length)
    throw new Error('The sandbox account helper returned an inconsistent status');
  return status as unknown as AccountStatus;
}

let status: Promise<AccountStatus> | undefined;

/** Maintenance may replace account passwords and revoke grants: discard every process-local lease. */
export async function refreshAccountBackend(): Promise<void> {
  await stopBrokers();
  grants.clear();
  await refreshAccountReadiness();
}

/** Asks the helper for the backend's state and records whether `native` may use it. Never throws. */
export async function refreshAccountReadiness(): Promise<AccountStatus | undefined> {
  if (process.platform !== 'win32') return undefined;
  status = configuration.run(configuration.helper, ['account-status']).then(parseAccountStatus);
  try {
    const current = await status;
    setWindowsAccountReady(current.ready);
    return current;
  } catch {
    setWindowsAccountReady(false);
    return undefined;
  }
}

async function readiness(): Promise<string | null> {
  if (process.platform !== 'win32')
    return 'The Windows sandbox account backend only runs on Windows';
  const current = status ? await status.catch(() => undefined) : await refreshAccountReadiness();
  if (!current) return 'The Windows sandbox account helper is unavailable';
  if (current.ready) return null;
  return `The Windows sandbox accounts are not ready (${current.problems.join(', ')}); initialize them in Settings`;
}

interface CapabilityFile {
  version: 1;
  workspaces: Record<string, string>;
}
let capabilities: Promise<CapabilityFile> | undefined;
let capabilityWrites: Promise<void> = Promise.resolve();

function capabilityFile(): string {
  return path.join(configuration.state, 'cap-sids.json');
}

async function loadCapabilities(): Promise<CapabilityFile> {
  try {
    const value = JSON.parse(await readFile(capabilityFile(), 'utf8')) as CapabilityFile;
    if (
      value?.version === 1 &&
      value.workspaces &&
      typeof value.workspaces === 'object' &&
      Object.values(value.workspaces).every((sid) => typeof sid === 'string' && SID.test(sid))
    )
      return value;
  } catch {
    /* Missing or unreadable: start over; grants are refreshed with the new SID. */
  }
  return { version: 1, workspaces: {} };
}

function freshCapability(): string {
  const bytes = randomBytes(16);
  const parts = [0, 4, 8, 12].map((offset) => bytes.readUInt32LE(offset));
  return `S-1-5-21-${parts.join('-')}`;
}

/** The workspace's capability SID, created once per canonical workspace path and kept. */
export async function capabilityFor(root: string): Promise<string> {
  const key = path.resolve(root).toLowerCase();
  capabilities ??= loadCapabilities();
  const file = await capabilities;
  const existing = file.workspaces[key];
  if (existing) return existing;
  const sid = freshCapability();
  file.workspaces[key] = sid;
  const write = capabilityWrites.then(async () => {
    await mkdir(configuration.state, { recursive: true });
    const temporary = `${capabilityFile()}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(file));
    await rename(temporary, capabilityFile());
  });
  capabilityWrites = write.catch(() => undefined);
  await write;
  return sid;
}

const grants = new Map<string, Promise<void>>();

/** Grants the workspace once per process; the grant itself is persistent (see the helper's `grant`). */
async function ensureGrant(root: string, capability: string): Promise<void> {
  const key = `${root.toLowerCase()}|${capability}`;
  let pending = grants.get(key);
  if (!pending) {
    pending = configuration
      .run(configuration.helper, ['grant', '--root', root, '--capability', capability])
      .then(() => undefined);
    grants.set(key, pending);
    pending.catch(() => grants.delete(key));
  }
  await pending;
}

function comspec(): string {
  return (
    process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  );
}

/**
 * The runner's `argv` for a request, in the shape the host backend runs it.
 *
 * Shell text and anything the shell has to resolve (a `.cmd` shim, a bare name) go through `cmd.exe /d /s /c`
 * verbatim; only an absolute program image is started directly. The runner never searches PATH itself.
 */
export function accountCommand(
  request: Pick<SandboxRequest, 'command' | 'argv'>,
  env: NodeJS.ProcessEnv = process.env,
): { argv: string[]; verbatim: boolean } {
  if (request.argv) {
    if (path.win32.isAbsolute(request.command) && !windowsProgramNeedsShell(request.command, env))
      return { argv: [request.command, ...request.argv], verbatim: false };
    const line = [request.command, ...request.argv].map(quoteWindowsArgument).join(' ');
    return { argv: [comspec(), `/d /s /c "${line}"`], verbatim: true };
  }
  return { argv: [comspec(), `/d /s /c "${request.command}"`], verbatim: true };
}

const planFiles = new WeakMap<SandboxPlan, string>();

async function accountPrepare(request: SandboxRequest): Promise<SandboxPlan> {
  insideWorkspace(request.root, request.cwd);
  const unavailable = await readiness();
  if (unavailable) throw new Error(unavailable);
  const root = await realpath(request.root);
  const cwd = await realpath(request.cwd);
  insideWorkspace(root, cwd);
  const capability = await capabilityFor(root);
  // Even a read-only command needs the grant: the group's ACE is what lets the account read the workspace.
  await ensureGrant(root, capability);
  const account: SandboxAccount = request.config.network === 'denied' ? 'offline' : 'online';
  const pipe = await brokerPipe(configuration.helper, account, configuration.launch);
  const env = Object.fromEntries(
    Object.entries({ ...toolEnvironment(), ...(request.env ?? {}) }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const command = accountCommand(request, env);
  const requests = path.join(configuration.state, 'requests');
  await mkdir(requests, { recursive: true });
  const file = path.join(requests, `${randomBytes(16).toString('hex')}.json`);
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      argv: command.argv,
      cwd,
      env,
      capabilities: request.config.files === 'read-only' ? [] : [capability],
      verbatim: command.verbatim,
    }),
    { flag: 'wx' },
  );
  const plan: SandboxPlan = {
    executable: configuration.helper,
    args: ['exec', '--broker', pipe, '--request', file],
    cwd,
    env: toolEnvironment(),
    windowsVerbatimArguments: false,
    backend: 'windows-account',
    processTree: 'contained',
  };
  planFiles.set(plan, file);
  return plan;
}

/** exec deletes its request on start; this removes one that was never started. Idempotent. */
async function accountCleanup(plan: SandboxPlan): Promise<void> {
  const file = planFiles.get(plan);
  if (!file) return;
  planFiles.delete(plan);
  await rm(file, { force: true });
}

export const windowsAccountSandboxProvider: SandboxProvider = {
  mode: 'windows-account',
  description:
    'Windows sandbox accounts: commands run as a dedicated low-privilege local account under a write-restricted token; writes only to the workspace (and its own scratch), no read of your profile, network blocked by WFP when denied. Needs a one-time administrator initialization.',
  capabilities: windowsAccountCapabilities,
  available: () => readiness(),
  prepare: accountPrepare,
  cleanup: accountCleanup,
};
