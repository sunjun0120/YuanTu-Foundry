import { verifyFileDelivery, type FileDeliverySpec } from '../../tools/file-delivery.ts';
import {
  prepareSandbox,
  stopSandbox,
  cleanupSandbox,
  markSandboxStarted,
  resolveSandboxConfig,
  withSandboxPreparation,
} from '../../sandbox/sandbox.ts';
import { executionPolicy } from '../../sandbox/execution-policy.ts';
import type { SandboxPlan } from '../../sandbox/sandbox-provider.ts';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { COMPLETION_LIMITS } from '../../protocol/completion.ts';
import type { CheckFailureReason } from '../../protocol/index.ts';
import type { Approver } from '../../protocol/index.ts';
import { DeferredApprovalError } from '../../protocol/failure.ts';
import { environmentBlockedCode } from '../../protocol/environment-blocked.ts';
import {
  sandboxLaunchFailure,
  sandboxChildSpawnBlocked,
} from '../../sandbox/sandbox-launch-failure.ts';
import {
  VerificationAssertionError,
  VerificationDefinitionError,
} from '../../tools/verification-errors.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 24_000;
const MAX_OUTPUT_BYTES = 64_000;
const MAX_TIMEOUT_MS = 300_000;
/**
 * How many executable checks one task may carry; shared with the task validator so a stored task
 * can always be verified.
 */
export const MAX_CHECKS = COMPLETION_LIMITS.acceptanceChecks;
const DEFAULT_FILE_BYTES = 1_000_000;
const MAX_FILE_BYTES = 4_000_000;
const MAX_SNAPSHOT_ENTRIES = 2_000;
const MAX_SNAPSHOT_BYTES = 4_000_000;

export interface CommandAcceptanceSpec {
  id: string;
  kind: 'command';
  command: string;
  args?: readonly string[];
  cwd?: string;
  expectedExitCode?: number;
  timeoutMs?: number;
}

export interface FileExactAcceptanceSpec {
  id: string;
  kind: 'file-exact';
  path: string;
  expected: string;
  maxBytes?: number;
}

export interface FileContainsAcceptanceSpec {
  id: string;
  kind: 'file-contains';
  path: string;
  expected: string;
  maxBytes?: number;
}

export interface FileDeliveryAcceptanceSpec extends FileDeliverySpec {
  id: string;
  kind: 'file-delivery';
}

export interface ForbiddenPathAbsentAcceptanceSpec {
  id: string;
  kind: 'forbidden-path';
  path: string;
  expectation: 'absent';
}

export interface ForbiddenPathUnchangedAcceptanceSpec {
  id: string;
  kind: 'forbidden-path';
  path: string;
  expectation: 'unchanged';
  baseline: PathSnapshot;
}

export type AcceptanceSpec =
  | CommandAcceptanceSpec
  | FileExactAcceptanceSpec
  | FileContainsAcceptanceSpec
  | FileDeliveryAcceptanceSpec
  | ForbiddenPathAbsentAcceptanceSpec
  | ForbiddenPathUnchangedAcceptanceSpec;

export interface PathSnapshot {
  /**
   * How the image orders directory entries: `1` English collation, `2` code unit (immune to ICU
   * changes). Stored `1` images are compared against images taken the same way.
   */
  version: 1 | 2;
  state: 'absent' | 'present';
  digest?: string;
  entries: number;
  bytes: number;
  /** The workspace path the image was taken of, recorded so a stored image is reused only for that path. */
  path?: string;
}

interface CommandExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  /** The backend that actually ran it; the child-fork failure is specific to the Windows backend. */
  backend?: SandboxPlan['backend'];
}

export interface AcceptanceCheckResult {
  id: string;
  kind: AcceptanceSpec['kind'];
  passed: boolean;
  detail: string;
  durationMs: number;
  /** Why the check failed, when known. Omitted on success. */
  failureReason?: CheckFailureReason;
  command?: CommandExecutionResult;
}

/** The assertion class: the definition ran, the assertion is false, the code must change. */
function assertion(message: string): VerificationAssertionError {
  return new VerificationAssertionError(message);
}

/** A definition that cannot be executed as written; executing more of it will not help. */
function definition(message: string): VerificationDefinitionError {
  return new VerificationDefinitionError(message);
}

export interface AcceptanceResult {
  passed: boolean;
  checks: AcceptanceCheckResult[];
  durationMs: number;
}

export interface VerifyAcceptanceOptions {
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Command checks are executed only after this authorizer returns true. */
  approve?: Approver;
}

interface SnapshotState {
  hash: ReturnType<typeof createHash>;
  entries: number;
  bytes: number;
}

function integerInRange(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw definition(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function validateId(id: string): void {
  if (!id || id.length > 128)
    throw definition('Acceptance check id must contain 1 to 128 characters');
}

async function workspaceRoot(root: string): Promise<string> {
  return realpath(path.resolve(root));
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}

async function resolveWorkspacePath(
  root: string,
  input: string,
): Promise<{ target: string; exists: boolean }> {
  if (!input || input.includes('\0'))
    throw definition('Acceptance path must be non-empty and valid');
  const target = path.resolve(root, input);
  if (!contained(root, target)) throw definition(`Acceptance path is outside workspace: ${input}`);
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw definition(`Symbolic links are not allowed in acceptance paths: ${input}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { target, exists: false };
      throw error;
    }
  }
  const canonical = await realpath(target);
  if (!contained(root, canonical))
    throw definition(`Acceptance path resolves outside workspace: ${input}`);
  return { target: canonical, exists: true };
}

async function readBoundedFile(root: string, input: string, maxBytes: number): Promise<string> {
  const resolved = await resolveWorkspacePath(root, input);
  if (!resolved.exists) throw assertion(`File does not exist: ${input}`);
  const handle = await open(resolved.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw assertion(`Expected a regular file: ${input}`);
    if (stat.size > maxBytes)
      throw assertion(`File exceeds ${maxBytes} byte acceptance limit: ${input}`);
    const buffer = await handle.readFile();
    if (buffer.includes(0)) throw assertion(`Expected a UTF-8 text file: ${input}`);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * A protected path that cannot be imaged is an unexecutable definition, not an environment fault.
 */
function snapshotEntry(state: SnapshotState, label: string, type: string, content?: Buffer): void {
  state.entries++;
  if (state.entries > MAX_SNAPSHOT_ENTRIES)
    throw definition(`Path snapshot exceeds ${MAX_SNAPSHOT_ENTRIES} entries; fence a smaller path`);
  state.hash.update(type).update('\0').update(label).update('\0');
  if (content) {
    state.bytes += content.length;
    if (state.bytes > MAX_SNAPSHOT_BYTES)
      throw definition(`Path snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes; fence a smaller path`);
    state.hash.update(content);
  }
  state.hash.update('\0');
}

/** Directory entry order for each image version (see `PathSnapshot.version`). */
const ENTRY_ORDER: Record<PathSnapshot['version'], (left: string, right: string) => number> = {
  1: (left, right) => left.localeCompare(right, 'en'),
  2: (left, right) => (left < right ? -1 : left > right ? 1 : 0),
};

async function hashPath(
  root: string,
  target: string,
  label: string,
  state: SnapshotState,
  version: PathSnapshot['version'],
): Promise<void> {
  const stat = await lstat(target);
  // Image links as what they say, never followed.
  if (stat.isSymbolicLink()) {
    snapshotEntry(state, label, 'link', Buffer.from(await readlink(target), 'utf8'));
    return;
  }
  if (stat.isFile()) {
    if (stat.size > MAX_SNAPSHOT_BYTES - state.bytes)
      throw definition(`Path snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes; fence a smaller path`);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const content = await handle.readFile();
      snapshotEntry(state, label, 'file', content);
    } finally {
      await handle.close();
    }
    return;
  }
  if (!stat.isDirectory()) throw definition(`Unsupported path type in snapshot: ${label}`);
  snapshotEntry(state, label, 'directory');
  const entries = await readdir(target, { withFileTypes: true });
  const order = ENTRY_ORDER[version];
  entries.sort((left, right) => order(left.name, right.name));
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    const childLabel = label ? `${label}/${entry.name}` : entry.name;
    await hashPath(root, child, childLabel, state, version);
  }
}

/**
 * Capture a bounded content snapshot before work that must not alter a path. `version` matches a
 * stored image's ordering.
 */
export async function capturePathSnapshot(
  root: string,
  input: string,
  version: PathSnapshot['version'] = 2,
): Promise<PathSnapshot> {
  const canonicalRoot = await workspaceRoot(root);
  const resolved = await resolveWorkspacePath(canonicalRoot, input);
  if (!resolved.exists) return { version, state: 'absent', entries: 0, bytes: 0 };
  const state: SnapshotState = { hash: createHash('sha256'), entries: 0, bytes: 0 };
  await hashPath(canonicalRoot, resolved.target, '', state, version);
  return {
    version,
    state: 'present',
    digest: state.hash.digest('hex'),
    entries: state.entries,
    bytes: state.bytes,
  };
}

function sameSnapshot(left: PathSnapshot, right: PathSnapshot): boolean {
  return (
    left.version === right.version &&
    left.state === right.state &&
    left.digest === right.digest &&
    left.entries === right.entries &&
    left.bytes === right.bytes
  );
}

function captureChunk(
  chunks: Buffer[],
  chunk: Buffer,
  state: { captured: number; truncated: boolean },
  limit: number,
): void {
  if (state.captured >= limit) {
    state.truncated = true;
    return;
  }
  const kept = chunk.subarray(0, limit - state.captured);
  chunks.push(kept);
  state.captured += kept.length;
  if (kept.length < chunk.length) state.truncated = true;
}

/**
 * The sandbox a check runs in, or the abort that arrived while preparing it. The wait is abandoned
 * on Stop, the preparation carries the same signal, and a plan that finishes anyway is cleaned up
 * by its provider.
 */
async function preparedUnlessAborted(
  preparing: Promise<SandboxPlan>,
  signal: AbortSignal | undefined,
): Promise<SandboxPlan> {
  if (!signal) return preparing;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Acceptance verification cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([preparing, aborted]);
  } catch (error) {
    if (signal.aborted)
      void preparing.then(
        (plan) => cleanupSandbox(plan).catch(() => undefined),
        () => undefined,
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    aborted.catch(() => undefined);
  }
}

async function runCommand(
  root: string,
  spec: CommandAcceptanceSpec,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
): Promise<CommandExecutionResult> {
  if (!spec.command || spec.command.includes('\0'))
    throw definition('Command must be non-empty and valid');
  const args = [...(spec.args ?? [])];
  if (
    args.length > 256 ||
    args.some((argument) => argument.length > 16_000 || argument.includes('\0'))
  )
    throw definition('Command arguments exceed acceptance limits');
  const cwd = await resolveWorkspacePath(root, spec.cwd ?? '.');
  if (!cwd.exists || !(await lstat(cwd.target)).isDirectory())
    throw definition(`Command working directory does not exist: ${spec.cwd ?? '.'}`);
  const timeoutMs = integerInRange(
    spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'Command timeoutMs',
    10,
    MAX_TIMEOUT_MS,
  );
  signal?.throwIfAborted();
  const plan = await preparedUnlessAborted(
    /**
     * The signal travels with the preparation, so Stop cancels a first workspace authorization
     * (`ensureGrant` has no deadline).
     */
    withSandboxPreparation({ signal }, () => prepareSandbox(root, cwd.target, spec.command, args)),
    signal,
  );
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      markSandboxStarted(plan);
      child = spawn(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      void cleanupSandbox(plan).then(() => reject(error), reject);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const output = { captured: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let killing: Promise<void> | undefined;
    let cleanupError: unknown;
    let spawnError: Error | undefined;
    const collect = (chunks: Buffer[]) => (chunk: Buffer) =>
      captureChunk(chunks, chunk, output, maxOutputBytes);
    child.stdout!.on('data', collect(stdout));
    child.stderr!.on('data', collect(stderr));
    const stop = () => {
      if (child.pid && !killing)
        killing = stopSandbox(child, plan).catch((error) => {
          cleanupError = error;
          child.kill();
          child.stdout!.destroy();
          child.stderr!.destroy();
        });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const abort = () => stop();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      // Node emits `close` after a spawn error; keep ownership until then and await cleanup.
      spawnError = error;
    });
    child.once('close', (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        if (killing) await killing;
        else await stopSandbox(child, plan);
        if (cleanupError) throw cleanupError;
        if (spawnError) throw spawnError;
        if (signal?.aborted)
          return reject(signal.reason ?? new Error('Acceptance verification cancelled'));
        resolve({
          exitCode,
          signal: closeSignal,
          timedOut,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          outputTruncated: output.truncated,
          ...(plan.backend ? { backend: plan.backend } : {}),
        });
      })().catch(reject);
    });
  });
}

function failed(
  id: string,
  kind: AcceptanceSpec['kind'],
  started: number,
  error: unknown,
): AcceptanceCheckResult {
  return {
    id,
    kind,
    passed: false,
    detail: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - started,
    failureReason: classifyFailure(error),
  };
}

/**
 * Turn a thrown verification failure into a repair reason. Unclassified errors become
 * `environment-error`, which is not repaired.
 */
function classifyFailure(error: unknown): CheckFailureReason {
  if (error instanceof VerificationDefinitionError) return 'invalid-definition';
  if (error instanceof VerificationAssertionError) return 'assertion-failed';
  return 'environment-error';
}

async function verifyOne(
  root: string,
  spec: AcceptanceSpec,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
  approve?: Approver,
): Promise<AcceptanceCheckResult> {
  const started = Date.now();
  validateId(spec.id);
  signal?.throwIfAborted();
  try {
    if (spec.kind === 'command') {
      // Match `run_command`'s declared argument shape (`{command, cwd?, timeout_ms?}`) exactly,
      // since permission rules compare the whole object.
      const commandLine = [spec.command, ...(spec.args ?? [])]
        .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
        .join(' ');
      /**
       * Display form, quoted so arguments are unambiguous. `commandLine` keeps its spelling because
       * exact-match permission rules are written against it.
       */
      const displayLine = [spec.command, ...(spec.args ?? [])]
        .map((part) =>
          part === '' || /[^\w@%+=:,./\\-]/u.test(part) ? JSON.stringify(part) : part,
        )
        .join(' ');
      if (approve) {
        // The boundary `runCommand` will run under, so a policy rule on the network can read it.
        const config = resolveSandboxConfig();
        const policy = executionPolicy(config.mode, config);
        const allowed = await approve(
          {
            kind: 'command',
            description: `Verification command (run without a shell): ${displayLine}`,
            boundary: { processFiles: policy.processFiles, network: policy.network },
            toolCall: {
              id: `acceptance:${spec.id}`,
              name: 'run_command',
              arguments: {
                command: commandLine,
                ...(spec.cwd ? { cwd: spec.cwd } : {}),
                ...(spec.timeoutMs ? { timeout_ms: spec.timeoutMs } : {}),
              },
            },
          },
          signal ?? new AbortController().signal,
        );
        if (!allowed)
          return {
            id: spec.id,
            kind: spec.kind,
            passed: false,
            detail: 'Command acceptance was not authorized',
            durationMs: Date.now() - started,
            failureReason: 'permission-denied',
          };
      }
      const command = (await runCommand(root, spec, signal, maxOutputBytes))!;
      /** The launcher could not start the image: `environment-error`, not a failing check. */
      const launchFailure = sandboxLaunchFailure(command.stderr, command.exitCode);
      if (launchFailure)
        return {
          id: spec.id,
          kind: spec.kind,
          passed: false,
          detail: `The sandbox could not start the command: ${launchFailure}`,
          durationMs: Date.now() - started,
          failureReason: 'environment-error',
          command,
        };
      /**
       * A command that could not fork (`spawn EPERM` under the Windows restricted-token backends)
       * is an environment failure. Narrow on purpose.
       */
      const childSpawnBlocked =
        command.backend === 'windows' &&
        command.exitCode !== 0 &&
        sandboxChildSpawnBlocked(`${command.stdout}\n${command.stderr}`);
      if (childSpawnBlocked)
        return {
          id: spec.id,
          kind: spec.kind,
          passed: false,
          detail:
            'The command started but could not create a child process (sandbox spawn EPERM). ' +
            'This is an execution-environment limitation, not a failing test.',
          durationMs: Date.now() - started,
          failureReason: 'environment-error',
          command,
        };
      const expected = spec.expectedExitCode ?? 0;
      const passed = !command.timedOut && command.exitCode === expected;
      // A timeout or signal means the check never reached a verdict; both stop the repair loop.
      const failureReason: CheckFailureReason | undefined = passed
        ? undefined
        : command.timedOut || (command.exitCode === null && command.signal !== null)
          ? 'timeout'
          : 'assertion-failed';
      return {
        id: spec.id,
        kind: spec.kind,
        passed,
        detail: command.timedOut
          ? `Command timed out after ${spec.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : passed
            ? `Command exited with expected code ${expected}`
            : `Expected exit code ${expected}, received ${command.exitCode ?? command.signal ?? 'unknown'}`,
        durationMs: Date.now() - started,
        ...(failureReason ? { failureReason } : {}),
        command,
      };
    }
    if (spec.kind === 'file-delivery') {
      const evidence = await verifyFileDelivery(root, spec);
      return {
        id: spec.id,
        kind: spec.kind,
        passed: true,
        detail:
          'Delivered ' +
          evidence.path +
          ': ' +
          evidence.bytes +
          ' bytes, sha256 ' +
          evidence.sha256 +
          '; ' +
          evidence.validation,
        durationMs: Date.now() - started,
      };
    }
    if (spec.kind === 'file-exact' || spec.kind === 'file-contains') {
      const maxBytes = integerInRange(
        spec.maxBytes ?? DEFAULT_FILE_BYTES,
        'File maxBytes',
        1,
        MAX_FILE_BYTES,
      );
      const actual = await readBoundedFile(root, spec.path, maxBytes);
      const passed =
        spec.kind === 'file-exact' ? actual === spec.expected : actual.includes(spec.expected);
      return {
        id: spec.id,
        kind: spec.kind,
        passed,
        detail: passed
          ? spec.kind === 'file-exact'
            ? 'File content matched exactly'
            : 'File contained expected content'
          : spec.kind === 'file-exact'
            ? 'File content did not match exactly'
            : 'File did not contain expected content',
        durationMs: Date.now() - started,
        ...(passed ? {} : { failureReason: 'assertion-failed' as const }),
      };
    }
    const snapshot = await capturePathSnapshot(
      root,
      spec.path,
      spec.expectation === 'unchanged' ? spec.baseline.version : undefined,
    );
    const passed =
      spec.expectation === 'absent'
        ? snapshot.state === 'absent'
        : sameSnapshot(snapshot, spec.baseline);
    /**
     * A changed forbidden path needs a person, not a repair. `absent` stays an assertion because
     * the model can undo its own output.
     */
    const failureReason: CheckFailureReason | undefined = passed
      ? undefined
      : spec.expectation === 'absent'
        ? 'assertion-failed'
        : 'protected-path-changed';
    return {
      id: spec.id,
      kind: spec.kind,
      passed,
      detail: passed
        ? spec.expectation === 'absent'
          ? 'Forbidden path is absent'
          : 'Forbidden path is unchanged'
        : spec.expectation === 'absent'
          ? 'Forbidden path exists'
          : 'Forbidden path changed',
      durationMs: Date.now() - started,
      ...(failureReason ? { failureReason } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof DeferredApprovalError) throw error;
    return failed(spec.id, spec.kind, started, error);
  }
}

/** Run bounded, deterministic acceptance checks sequentially without model calls. */
export async function verifyAcceptance(
  root: string,
  specs: readonly AcceptanceSpec[],
  options: VerifyAcceptanceOptions = {},
): Promise<AcceptanceResult> {
  if (specs.length > MAX_CHECKS) throw new Error(`Acceptance checks exceed limit of ${MAX_CHECKS}`);
  const maxOutputBytes = integerInRange(
    options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    'maxOutputBytes',
    1,
    MAX_OUTPUT_BYTES,
  );
  const canonicalRoot = await workspaceRoot(root);
  const started = Date.now();
  const checks: AcceptanceCheckResult[] = [];
  const ids = new Set<string>();
  let commandBlocker: AcceptanceCheckResult | undefined;
  for (const spec of specs) {
    options.signal?.throwIfAborted();
    if (ids.has(spec.id)) throw new Error(`Duplicate acceptance check id: ${spec.id}`);
    ids.add(spec.id);
    if (spec.kind === 'command' && commandBlocker) {
      checks.push({
        id: spec.id,
        kind: spec.kind,
        passed: false,
        durationMs: 0,
        failureReason: 'environment-error',
        detail: `Not executed: sandbox startup was blocked in check ${commandBlocker.id}. ${commandBlocker.detail}`,
      });
      continue;
    }
    const check = await verifyOne(
      canonicalRoot,
      spec,
      options.signal,
      maxOutputBytes,
      options.approve,
    );
    checks.push(check);
    if (
      spec.kind === 'command' &&
      environmentBlockedCode(check.detail)?.startsWith('windows-sandbox-')
    )
      commandBlocker = check;
  }
  return {
    passed: checks.every((check) => check.passed),
    checks,
    durationMs: Date.now() - started,
  };
}
