import { verifyFileDelivery, type FileDeliverySpec } from './delivery.ts';
import { prepareSandbox, stopSandbox, cleanupSandbox } from '../tools/sandbox.ts';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Approver } from '../protocol/index.ts';
import { DeferredApprovalError } from './approval-deferred.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 24_000;
const MAX_OUTPUT_BYTES = 64_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CHECKS = 64;
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
}

interface CommandExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface AcceptanceCheckResult {
  id: string;
  kind: AcceptanceSpec['kind'];
  passed: boolean;
  detail: string;
  durationMs: number;
  command?: CommandExecutionResult;
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
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function validateId(id: string): void {
  if (!id || id.length > 128)
    throw new Error('Acceptance check id must contain 1 to 128 characters');
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
    throw new Error('Acceptance path must be non-empty and valid');
  const target = path.resolve(root, input);
  if (!contained(root, target)) throw new Error(`Acceptance path is outside workspace: ${input}`);
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symbolic links are not allowed in acceptance paths: ${input}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { target, exists: false };
      throw error;
    }
  }
  const canonical = await realpath(target);
  if (!contained(root, canonical))
    throw new Error(`Acceptance path resolves outside workspace: ${input}`);
  return { target: canonical, exists: true };
}

async function readBoundedFile(root: string, input: string, maxBytes: number): Promise<string> {
  const resolved = await resolveWorkspacePath(root, input);
  if (!resolved.exists) throw new Error(`File does not exist: ${input}`);
  const handle = await open(resolved.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${input}`);
    if (stat.size > maxBytes)
      throw new Error(`File exceeds ${maxBytes} byte acceptance limit: ${input}`);
    const buffer = await handle.readFile();
    if (buffer.includes(0)) throw new Error(`Expected a UTF-8 text file: ${input}`);
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

async function runCommand(
  root: string,
  spec: CommandAcceptanceSpec,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
): Promise<CommandExecutionResult> {
  if (!spec.command || spec.command.includes('\0'))
    throw new Error('Command must be non-empty and valid');
  const args = [...(spec.args ?? [])];
  if (
    args.length > 256 ||
    args.some((argument) => argument.length > 16_000 || argument.includes('\0'))
  )
    throw new Error('Command arguments exceed acceptance limits');
  const cwd = await resolveWorkspacePath(root, spec.cwd ?? '.');
  if (!cwd.exists || !(await lstat(cwd.target)).isDirectory())
    throw new Error(`Command working directory does not exist: ${spec.cwd ?? '.'}`);
  const timeoutMs = integerInRange(
    spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'Command timeoutMs',
    10,
    MAX_TIMEOUT_MS,
  );
  signal?.throwIfAborted();
  const plan = await prepareSandbox(root, cwd.target, spec.command, args);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      cwd: cwd.target,
      env: plan.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const output = { captured: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let killing: Promise<void> | undefined;
    let cleanupError: unknown;
    const collect = (chunks: Buffer[]) => (chunk: Buffer) =>
      captureChunk(chunks, chunk, output, maxOutputBytes);
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const stop = () => {
      if (child.pid && !killing)
        killing = stopSandbox(child, plan).catch((error) => {
          cleanupError = error;
          child.kill();
          child.stdout.destroy();
          child.stderr.destroy();
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
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        if (killing) await killing;
        else await cleanupSandbox(plan);
        if (cleanupError) throw cleanupError;
        if (signal?.aborted)
          return reject(signal.reason ?? new Error('Acceptance verification cancelled'));
        resolve({
          exitCode,
          signal: closeSignal,
          timedOut,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          outputTruncated: output.truncated,
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
  };
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
          };
      }
      const command = (await runCommand(root, spec, signal, maxOutputBytes))!;
      const expected = spec.expectedExitCode ?? 0;
      const passed = !command.timedOut && command.exitCode === expected;
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
      };
    }
    const snapshot = await capturePathSnapshot(root, spec.path);
    const passed =
      spec.expectation === 'absent'
        ? snapshot.state === 'absent'
        : sameSnapshot(snapshot, spec.baseline);
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
  for (const spec of specs) {
    if (ids.has(spec.id)) throw new Error(`Duplicate acceptance check id: ${spec.id}`);
    ids.add(spec.id);
    checks.push(
      await verifyOne(canonicalRoot, spec, options.signal, maxOutputBytes, options.approve),
    );
  }
  return {
    passed: checks.every((check) => check.passed),
    checks,
    durationMs: Date.now() - started,
  };
}
