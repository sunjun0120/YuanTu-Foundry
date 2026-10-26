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
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { toolEnvironment } from './environment.ts';
import { withoutToolDeadline } from './call-runtime.ts';
import { windowsAccountCapabilities } from './execution-capabilities.ts';
import { windowsShell, windowsShellArgs } from './windows-shell.ts';
import {
  brokerPipe,
  stopBrokers,
  type BrokerLauncher,
  type SandboxAccount,
} from './sandbox-account-broker.ts';
import {
  insideWorkspace,
  currentSandboxPreparation,
  type SandboxPreparationContext,
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
export type HelperRunner = (
  helper: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => Promise<string>;

const runHelper: HelperRunner = async (helper, args, options) => {
  const { stdout } = await promisify(execFile)(helper, args, {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1 << 20,
    timeout: options?.timeout ?? 60_000,
    signal: options?.signal,
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
  readRefreshes.clear();
  capabilities.clear();
  status = undefined;
  statusFailure = undefined;
}

export interface AccountStatus {
  version: 1;
  ready: boolean;
  problems: string[];
  details: string[];
  accounts: { account: SandboxAccount; sid: string | null }[];
  group: string | null;
  /** Directories a sandboxed command may read, and whether refresh or the user put them there. */
  readRoots: { path: string; source: 'auto' | 'user' }[];
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
  const readRoots = status?.readRoots;
  const readRoot = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const root = entry as Record<string, unknown>;
    return (
      typeof root.path === 'string' &&
      root.path.length > 0 &&
      (root.source === 'auto' || root.source === 'user') &&
      Object.keys(root).length === 2
    );
  };
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
    !Array.isArray(readRoots) ||
    !readRoots.every(readRoot) ||
    Object.keys(status).length !== 7
  )
    throw new Error('The sandbox account helper returned an invalid status');
  // A status that calls itself ready while naming problems is not believed.
  if (status.ready && (status.problems as string[]).length)
    throw new Error('The sandbox account helper returned an inconsistent status');
  return status as unknown as AccountStatus;
}

let status: Promise<AccountStatus> | undefined;
/** Why the last status read failed; kept so a refusal can name the helper's own failure instead of guessing. */
let statusFailure: unknown;

/** Maintenance may replace account passwords and revoke grants: discard every process-local lease. */
export async function refreshAccountBackend(): Promise<void> {
  await stopBrokers();
  grants.clear();
  readRefreshes.clear();
  await refreshAccountReadiness();
}

/** Asks the helper for the backend's state. Never throws. */
export async function refreshAccountReadiness(): Promise<AccountStatus | undefined> {
  if (process.platform !== 'win32') return undefined;
  statusFailure = undefined;
  status = configuration
    .run(configuration.helper, ['account-status'])
    .then(parseAccountStatus)
    .catch((failure: unknown) => {
      statusFailure = failure;
      throw failure;
    });
  try {
    return await status;
  } catch {
    return undefined;
  }
}

/** The helper's own error text, bounded, for a refusal that has to stay readable in a tool result. */
function failureDetail(failure: unknown, limit = 500): string {
  const error = failure as { stderr?: string; message?: string };
  const text = (
    error?.stderr?.trim() || (failure instanceof Error ? failure.message : String(failure))
  ).trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function readiness(): Promise<string | null> {
  if (process.platform !== 'win32')
    return 'The Windows sandbox account backend only runs on Windows';
  const current = status ? await status.catch(() => undefined) : await refreshAccountReadiness();
  const helper = configuration.helper;
  if (!current)
    return existsSync(helper)
      ? `Sandboxed commands are blocked at Windows sandbox account initialization: the helper (${helper}) ` +
          `did not answer its status check${
            statusFailure === undefined ? '' : ` (${failureDetail(statusFailure)})`
          }. Reinstall YuanTu to run sandboxed commands.`
      : `Sandboxed commands are blocked at Windows sandbox account initialization: the helper is missing from ` +
          `this installation (${helper}); reinstall YuanTu to run sandboxed commands.`;
  if (current.ready) return null;
  const state = current.problems.includes('setup-marker-missing')
    ? 'The Windows sandbox accounts have not been initialized'
    : current.problems.includes('setup-marker-version')
      ? 'The Windows sandbox setup marker is from an older version and needs to be repaired'
      : `The Windows sandbox accounts are not ready (${current.problems.join(', ')})`;
  const details = current.details
    .map((detail) => detail.trim())
    .filter(Boolean)
    .join('; ');
  return (
    `Sandboxed commands are blocked at Windows sandbox account initialization: ${state}.` +
    (details ? ` (${details})` : '') +
    ' Set them up from the Windows sandbox prompt above the message box. ' +
    'Sandboxed commands remain blocked until initialization or repair succeeds.'
  );
}

interface CapabilityFile {
  version: 1;
  workspaces: Record<string, string>;
}
const capabilities = new Map<string, Promise<string>>();

function capabilityFile(): string {
  return path.join(configuration.state, 'cap-sids.json');
}

async function loadCapabilities(): Promise<CapabilityFile> {
  let raw: string;
  try {
    raw = await readFile(capabilityFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: {} };
    throw error;
  }
  const value = JSON.parse(raw) as CapabilityFile;
  if (
    value?.version !== 1 ||
    !value.workspaces ||
    typeof value.workspaces !== 'object' ||
    Array.isArray(value.workspaces) ||
    !Object.values(value.workspaces).every((sid) => typeof sid === 'string' && SID.test(sid))
  )
    throw new Error(`Invalid legacy sandbox capability registry: ${capabilityFile()}`);
  return value;
}

function freshCapability(): string {
  const bytes = randomBytes(16);
  const parts = [0, 4, 8, 12].map((offset) => bytes.readUInt32LE(offset));
  return `S-1-5-21-${parts.join('-')}`;
}

/** The workspace's capability SID, created once per canonical workspace path and kept. */
export async function capabilityFor(root: string): Promise<string> {
  const key = path.resolve(root).toLowerCase();
  let pending = capabilities.get(key);
  if (!pending) {
    pending = persistCapability(key).catch((cause: unknown) => {
      capabilities.delete(key);
      throw new Error(
        `Windows sandbox capability state could not be accessed for ${root}; the command has not started. ` +
          `Check permissions on the sandbox state directory (${configuration.state}). ${failureDetail(cause)}`,
        { cause },
      );
    });
    capabilities.set(key, pending);
  }
  return pending;
}

/**
 * Immutable per-workspace records avoid replacing a shared JSON map while another Host reads or writes it.
 * Publishing a hard link is atomic and never overwrites the winner. Every contender then reads that winner,
 * so two Hosts cannot authorize the same workspace under different SIDs. Old mappings retain their identity.
 */
async function persistCapability(key: string): Promise<string> {
  const directory = path.join(configuration.state, 'capabilities');
  const file = path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  const read = async () => {
    const record = JSON.parse(await readFile(file, 'utf8')) as {
      version?: number;
      root?: string;
      sid?: unknown;
    };
    if (
      record.version !== 1 ||
      record.root !== key ||
      typeof record.sid !== 'string' ||
      !SID.test(record.sid)
    )
      throw new Error(`Invalid sandbox capability record: ${file}`);
    return record.sid;
  };
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const legacy = await loadCapabilities();
  const sid = legacy.workspaces[key] ?? freshCapability();
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${randomBytes(16).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, root: key, sid }), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return await read();
  } finally {
    await rm(temporary, { force: true });
  }
}

interface GrantFlight {
  done: Promise<void>;
  abort: AbortController;
  waiters: number;
  settled: boolean;
}
const grants = new Map<string, GrantFlight>();

function authorizationFailure(root: string, failure: unknown): Error {
  const error = failure as { stderr?: string; code?: unknown; signal?: unknown };
  let detail =
    error?.stderr?.trim() || (failure instanceof Error ? failure.message : String(failure));
  try {
    const report = JSON.parse(detail) as {
      version?: number;
      stage?: string;
      path?: string;
      message?: string;
    };
    if (
      report.version === 1 &&
      typeof report.stage === 'string' &&
      typeof report.message === 'string'
    )
      detail = `${report.stage}${typeof report.path === 'string' ? ` (${report.path})` : ''}: ${report.message}`;
  } catch {
    /* Older helpers report plain stderr. */
  }
  return new Error(
    `Windows sandbox workspace authorization is incomplete for ${root}; the command has not started. ${detail}${error?.code !== undefined ? ` (exit/code: ${String(error.code)})` : ''}${error?.signal ? ` (signal: ${String(error.signal)})` : ''}`,
    { cause: failure },
  );
}

/** Grants the workspace once per process; the grant itself is persistent (see the helper's `grant`). */
async function ensureGrant(
  root: string,
  capability: string,
  context: SandboxPreparationContext,
): Promise<void> {
  await withoutToolDeadline(() => waitForGrant(root, capability, context));
}

async function waitForGrant(
  root: string,
  capability: string,
  context: SandboxPreparationContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  const key = `${root.toLowerCase()}|${capability}`;
  let flight = grants.get(key);
  // A cancelled helper must close before another grant starts for this root.
  if (flight?.abort.signal.aborted) {
    await flight.done.catch(() => undefined);
    return waitForGrant(root, capability, context);
  }
  if (!flight) {
    const abort = new AbortController();
    const created: GrantFlight = { abort, waiters: 0, settled: false, done: Promise.resolve() };
    created.done = Promise.resolve()
      .then(() =>
        configuration.run(
          configuration.helper,
          ['grant', '--root', root, '--capability', capability],
          { timeout: 0, signal: abort.signal },
        ),
      )
      .then(() => undefined)
      .catch((failure: unknown) => {
        if (grants.get(key) === created) grants.delete(key);
        throw authorizationFailure(root, failure);
      })
      .finally(() => {
        created.settled = true;
      });
    grants.set(key, created);
    flight = created;
  }
  if (flight.settled) return flight.done;
  const pending = flight;
  pending.waiters++;
  const report = (active: boolean) => {
    try {
      context.onPreparation?.({ stage: 'workspace-authorization', root, active });
    } catch {
      /* An observer cannot change authorization. */
    }
  };
  report(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(context.signal!.reason);
      context.signal?.addEventListener('abort', cancel, { once: true });
      pending.done
        .then(resolve, reject)
        .finally(() => context.signal?.removeEventListener('abort', cancel));
      if (context.signal?.aborted) cancel();
    });
  } finally {
    if (--pending.waiters === 0 && !pending.settled) pending.abort.abort();
    report(false);
  }
}

/**
 * The environment values the helper's read-root discovery reads. Everything else is left out of the request, so a
 * tool never sees the whole environment of the Host in a file.
 */
const REFRESH_ENVIRONMENT = [
  'PATH',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'NVM_HOME',
  'NVM_SYMLINK',
  'PNPM_HOME',
  'GOPATH',
  'SCOOP',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
] as const;

/** What the helper's `read-refresh` reports; only `error` is read here. */
export interface ReadRefreshResult {
  /** Why the read roots could not be refreshed. The command still runs, without them. */
  error?: string;
}

const readRefreshes = new Map<string, Promise<ReadRefreshResult>>();

/**
 * Before each command: protects the reserved names of the workspace `root` (a `.git` made since the last command,
 * a worktree's `.git` file), then authorizes the toolchain roots. Only identical refreshes that are still running
 * are shared.
 *
 * Refresh can revoke another environment's automatic roots, so a completed refresh cannot answer a later request:
 * switching A to B and back to A must ask the helper again. Both success and failure discard their own entry.
 * A rejection means the reserved names could not be protected; a failed refresh of the read roots is `error`.
 */
export async function ensureReadRefresh(
  env: NodeJS.ProcessEnv,
  root?: string,
): Promise<ReadRefreshResult> {
  const values = [...REFRESH_ENVIRONMENT.map((name) => env[name] ?? ''), root ?? ''];
  const key = createHash('sha256').update(JSON.stringify(values)).digest('hex');
  let pending = readRefreshes.get(key);
  if (!pending) {
    const created = runReadRefresh(env, root).finally(() => {
      // Maintenance may have cleared the map and started a newer refresh for the same environment.
      if (readRefreshes.get(key) === created) readRefreshes.delete(key);
    });
    readRefreshes.set(key, created);
    pending = created;
  }
  return pending;
}

async function runReadRefresh(env: NodeJS.ProcessEnv, root?: string): Promise<ReadRefreshResult> {
  const requested: Record<string, string> = {};
  for (const name of REFRESH_ENVIRONMENT) {
    const value = env[name];
    if (typeof value === 'string') requested[name] = value;
  }
  const requests = path.join(configuration.state, 'requests');
  await mkdir(requests, { recursive: true });
  const file = path.join(requests, `${randomBytes(16).toString('hex')}.json`);
  await writeFile(file, JSON.stringify({ version: 1, env: requested, ...(root ? { root } : {}) }), {
    flag: 'wx',
  });
  try {
    const output = await configuration.run(configuration.helper, ['read-refresh', '--env', file]);
    let error: unknown;
    try {
      error = (JSON.parse(output) as ReadRefreshResult | null)?.error;
    } catch {
      /* An unreadable report says nothing about the read roots; the reserved names were protected. */
    }
    return typeof error === 'string' ? { error } : {};
  } finally {
    // The helper deletes the request once it has read it; a helper that never started must not leave it behind.
    await rm(file, { force: true });
  }
}

function comspec(): string {
  return (
    process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  );
}

/**
 * The runner's `argv` for a request, in the shape the host backend runs it.
 *
 * Shell text runs in the Windows shell (`./windows-shell.ts`), the same one the host backend uses; a program
 * the shell has to resolve (a `.cmd` shim, a bare name) goes through `cmd.exe /d /s /c` verbatim; only an
 * absolute program image is started directly. The runner never searches PATH itself.
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
  const shell = windowsShell();
  if (shell.kind === 'cmd')
    return { argv: [shell.path, `/d /s /c "${request.command}"`], verbatim: true };
  return { argv: [shell.path, ...windowsShellArgs(shell, request.command)], verbatim: false };
}

const planFiles = new WeakMap<SandboxPlan, string>();

async function accountPrepare(request: SandboxRequest): Promise<SandboxPlan> {
  const context = { ...currentSandboxPreparation(), ...request };
  context.signal?.throwIfAborted();
  insideWorkspace(request.root, request.cwd);
  const unavailable = await readiness();
  if (unavailable) throw new Error(unavailable);
  const root = await realpath(request.root);
  const cwd = await realpath(request.cwd);
  insideWorkspace(root, cwd);
  const capability = await capabilityFor(root);
  const env = Object.fromEntries(
    Object.entries({ ...toolEnvironment(), ...(request.env ?? {}) }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  // Even a read-only command needs the grant: the group's ACE is what lets the account read the workspace.
  await ensureGrant(root, capability, context);
  context.signal?.throwIfAborted();
  // Before each command the workspace's reserved names are protected and the toolchains this environment names are
  // refreshed; identical concurrent requests share it. Protection failing stops the command: a reserved directory a
  // sandboxed command could still write must not sit beside the next one. A failed read-root refresh does not: the
  // workspace grant above is all a command needs, and a missing read root shows up as the tool not being found.
  let refreshed: ReadRefreshResult;
  try {
    refreshed = await ensureReadRefresh(env, root);
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`The workspace's protected directories could not be secured (${message}).`);
  }
  if (refreshed.error)
    console.error(
      'sandbox account: the automatic read roots could not be refreshed',
      refreshed.error,
    );
  const account: SandboxAccount = request.config.network === 'denied' ? 'offline' : 'online';
  let pipe: string;
  try {
    pipe = await brokerPipe(configuration.helper, account, configuration.launch);
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new Error(
      `The Windows sandbox account runner could not start (${message}). If restarting YuanTu does not help, ` +
        'uninstall the accounts in Settings > General > Windows sandbox accounts and set them up again.',
    );
  }
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
      // The runner's console of this size; exec relays it to the host's pseudo terminal and passes on resizes.
      ...(request.terminal
        ? { tty: { columns: request.terminal.columns, rows: request.terminal.rows } }
        : {}),
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
