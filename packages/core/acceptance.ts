import { verifyFileDelivery, type FileDeliverySpec } from '../tools/file-delivery.ts';
import {
  prepareSandbox,
  stopSandbox,
  cleanupSandbox,
  markSandboxStarted,
} from '../tools/sandbox.ts';
import type { SandboxPlan } from '../tools/sandbox-provider.ts';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { COMPLETION_LIMITS } from '../protocol/completion.ts';
import type { CheckFailureReason } from '../protocol/index.ts';
import type { Approver } from '../protocol/index.ts';
import { DeferredApprovalError } from '../protocol/failure.ts';
import { environmentBlockedCode } from '../tools/environment-blocked.ts';
import { sandboxLaunchFailure, sandboxChildSpawnBlocked } from '../tools/sandbox-launch-failure.ts';
import {
  VerificationAssertionError,
  VerificationDefinitionError,
} from '../tools/verification-errors.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 24_000;
const MAX_OUTPUT_BYTES = 64_000;
const MAX_TIMEOUT_MS = 300_000;
/**
 * How many executable checks one task may carry.
 *
 * Exported because it is the same number on both sides of the task's life: the verifier refuses more than this,
 * so the validator that *stores* a task has to refuse them too. It used to be 64 here and 100 there, which let a
 * task be persisted that every single run then failed with "Acceptance checks exceed limit of 64" — a failure
 * that blames the work when the definition is what is wrong.
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
  version: 1;
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
  /**
   * Why the check failed, when this layer knew. Omitted on success, so a reader that sees the field at all is
   * looking at a failure it may be able to classify without reading `detail`.
   */
  failureReason?: CheckFailureReason;
  command?: CommandExecutionResult;
}

/**
 * A successful command that exits with the wrong code, a missing deliverable, content that does not match.
 *
 * One name for the whole class because the repair policy treats them identically: the definition was executable,
 * the assertion is false, and the code is what has to change.
 */
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

function snapshotEntry(state: SnapshotState, label: string, type: string, content?: Buffer): void {
  state.entries++;
  if (state.entries > MAX_SNAPSHOT_ENTRIES)
    throw new Error(`Path snapshot exceeds ${MAX_SNAPSHOT_ENTRIES} entries`);
  state.hash.update(type).update('\0').update(label).update('\0');
  if (content) {
    state.bytes += content.length;
    if (state.bytes > MAX_SNAPSHOT_BYTES)
      throw new Error(`Path snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
    state.hash.update(content);
  }
  state.hash.update('\0');
}

async function hashPath(
  root: string,
  target: string,
  label: string,
  state: SnapshotState,
): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink())
    throw new Error(`Symbolic links are not allowed in path snapshots: ${label}`);
  if (stat.isFile()) {
    if (stat.size > MAX_SNAPSHOT_BYTES - state.bytes)
      throw new Error(`Path snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const content = await handle.readFile();
      snapshotEntry(state, label, 'file', content);
    } finally {
      await handle.close();
    }
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported path type in snapshot: ${label}`);
  snapshotEntry(state, label, 'directory');
  const entries = await readdir(target, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    const childLabel = label ? `${label}/${entry.name}` : entry.name;
    await hashPath(root, child, childLabel, state);
  }
}

/** Capture a bounded content snapshot before work that must not alter a path. */
export async function capturePathSnapshot(root: string, input: string): Promise<PathSnapshot> {
  const canonicalRoot = await workspaceRoot(root);
  const resolved = await resolveWorkspacePath(canonicalRoot, input);
  if (!resolved.exists) return { version: 1, state: 'absent', entries: 0, bytes: 0 };
  const state: SnapshotState = { hash: createHash('sha256'), entries: 0, bytes: 0 };
  await hashPath(canonicalRoot, resolved.target, '', state);
  return {
    version: 1,
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
 * The sandbox a check runs in, or the abort that arrived while it was being prepared.
 *
 * Preparing the native Windows sandbox journals and grants workspace access, which takes seconds (more for the
 * first command of a process), and none of it can be interrupted half way. Stop used to wait for all of it, then
 * for the cleanup that undid it: a check stopped before its command even started still took over ten seconds to
 * end. The wait is what is abandoned, not the work — a plan that finishes preparing after the abort is cleaned up
 * as soon as it exists, by the provider that owns it, so no grant is left behind by a cancelled check.
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
    prepareSandbox(root, cwd.target, spec.command, args),
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
      // Node emits close after a spawn error. Keep ownership until that boundary
      // and await cleanup instead of leaving a prepared native resource behind.
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
 * Turn a thrown verification failure into the reason a repair decision reads.
 *
 * The residual class is `environment-error` on purpose. An error nobody classified is an error nobody
 * understands, and "we do not know why this failed" must not be spent as a repair round: the plan's rule is that
 * only failures whose semantics the checker understood are handed back to the model.
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
      // The approval must carry the argument shape run_command actually declares
      // ({command, cwd?, timeout_ms?}). It previously added an `args` key the tool does not have,
      // and PermissionPolicy matches the whole arguments object with isDeepStrictEqual, so an
      // exact-argument rule written against run_command could never match — including one meant to
      // DENY the very command this check runs.
      const commandLine = [spec.command, ...(spec.args ?? [])]
        .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
        .join(' ');
      if (approve) {
        const allowed = await approve(
          {
            kind: 'command',
            description: `Verification command: ${commandLine}`,
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
      /**
       * The launcher's inability to start the image is not a statement about the work.
       *
       * It used to arrive as an ordinary exit code 1 — the same shape as a failing test suite — so the repair loop
       * spent its rounds asking the model to fix code that had never executed, and only the exit code text hinted
       * otherwise. The launcher now marks it, and this is where the mark becomes the classification the decision
       * maker already understands: `environment-error` stops the loop instead of repairing.
       */
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
       * A command that started but could not fork is an environment failure, not a failing suite.
       *
       * `npm test`, `vitest` and `jest` all spawn a child per file; the Windows restricted-token backend
       * refuses that with `spawn EPERM`. Treating it as an assertion failure sends the repair loop after code
       * that never executed. The signature is deliberately narrow and only applies to the Windows backends
       * that carry the restricted token; a host command that merely reports EPERM keeps its own meaning.
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
      // A command that ran out of time, or that a signal ended, is not a statement about the work: the check
      // never reached its own verdict. Both stop the repair loop, which is why they are one reason.
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
    const snapshot = await capturePathSnapshot(root, spec.path);
    const passed =
      spec.expectation === 'absent'
        ? snapshot.state === 'absent'
        : sameSnapshot(snapshot, spec.baseline);
    /**
     * A forbidden path that changed is not repairable work.
     *
     * The check exists to fence off something the run promised not to touch. Once it has been touched, "the model
     * should try harder" is the wrong response and a retry would run the same commands against an already-dirty
     * tree; a person has to look. `absent` is the model's own output appearing where it must not, which the model
     * *can* undo, so that one stays an assertion.
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
