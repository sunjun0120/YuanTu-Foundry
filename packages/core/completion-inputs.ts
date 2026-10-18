import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_SCALE_LIMITS } from '../protocol/workspaces.ts';
import { normalizeCompletionPath } from './completion-contract.ts';

/**
 * A content fingerprint of the files a completion contract's evidence is about.
 *
 * The verifier's checks answer "did this pass". They cannot answer "is the thing that passed still the thing on
 * disk": a check runs, passes, and then a shell command, a delegated child or a cleanup step rewrites a file —
 * and every reader of the log would still be shown a pass. The file journal does not close that gap either: it
 * records what the *file tools* wrote, and says nothing about a command that wrote through spawn, a build that
 * emitted into a directory, or an editor outside this process.
 *
 * So the contract is fingerprinted instead. `S0` is taken before the checks, `S1` after them, and a completion is
 * only published when the two agree. A check that mutates the code it is judging is therefore not a pass at all —
 * it is a verification that invalidated its own evidence.
 *
 * Three properties matter for honesty:
 *
 * - **What is covered is stated, not implied.** `inputs` is a list of paths, and the digest covers exactly those.
 *   A caller that monitored nothing gets a digest of nothing, which is why an explicit `CompletionSpec` must name
 *   at least one input and a task may fall back to the workspace root.
 * - **Exceeding a bound is a refusal, not a truncation.** A digest computed over the first N files of a larger
 *   tree is a digest of a different tree; reporting it as a pass would be the exact false assurance this is for.
 * - **Identity is the resolved root, not the logical session.** Two workspaces with identical content are still
 *   two workspaces, and evidence collected in one may never be presented as the other's.
 */
export interface CompletionInputSnapshot {
  version: 1;
  /** The identity of the resolved execution root this snapshot was taken in. */
  rootId: string;
  digest: string;
  files: number;
  bytes: number;
}

export interface CompletionInputOptions {
  /**
   * Paths the runtime itself is writing, excluded by their resolved location rather than by a suffix rule.
   *
   * The session database is the motivating case: a workspace-scoped store puts its SQLite file inside the tree
   * being fingerprinted, and its WAL is rewritten continuously, so a snapshot that included it would differ from
   * itself between two reads a millisecond apart. Excluding *every* `.sqlite` file would be the wrong fix — a
   * user's own SQLite resource is source, and silently dropping it is how a monitored change goes unnoticed.
   */
  runtimeStatePaths?: readonly string[];
}

export class CompletionInputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompletionInputLimitError';
  }
}

export class CompletionInputUnstableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompletionInputUnstableError';
  }
}

/**
 * The same budget a child's frozen snapshot uses, so a tree that can be delegated can also be verified: a fingerprint
 * that refused a file the snapshot accepted sent an unrelated large asset to review at the end of a task.
 */
const MAX_FILES = WORKSPACE_SCALE_LIMITS.files;
const MAX_TOTAL_BYTES = WORKSPACE_SCALE_LIMITS.totalBytes;
const MAX_FILE_BYTES = WORKSPACE_SCALE_LIMITS.fileBytes;

/**
 * Directory names the default source range never descends into.
 *
 * Excluded because they are *derived*: a checkout's `.git`, a dependency tree, the runtime's own state directory,
 * scratch space and build output all change for reasons that have nothing to do with whether the work is correct,
 * and including them would make the fingerprint flap on every build. The list is documented rather than
 * discovered, and the coverage boundary it creates is reported with the digest (`files` counts exactly what was
 * hashed) rather than left implicit.
 */
export const COMPLETION_INPUT_EXCLUDED_SEGMENTS: readonly string[] = [
  '.git',
  'node_modules',
  '.yuantu',
  '.scratch',
  'dist',
  'target',
];

/**
 * Path segments that are never readable as inputs, mirroring the file tools' own refusals.
 *
 * A contract that names one of these is rejected rather than silently skipped: "verify this" pointed at a
 * credential file is either a mistake or an attempt to read it, and neither is served by pretending the input
 * was excluded.
 */
const FORBIDDEN_SEGMENTS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.env'];

function excluded(relative: string, runtimePaths: ReadonlySet<string>): boolean {
  // A walk that started at the root names its children `./child`, so the leading segment is stripped before
  // anything is compared: without this, the runtime's own database — matched by its exact relative path — would
  // only be excluded when it happened to be named some other way, and the snapshot would flag every round.
  const normalized = relative.replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (segments.some((segment) => COMPLETION_INPUT_EXCLUDED_SEGMENTS.includes(segment))) return true;
  // Credential paths are skipped by a walk exactly as they are refused by name: a range of `.` that descended
  // into `.ssh` would read a private key in order to prove the source did not change.
  if (segments.some(isProtectedSegment)) return true;
  return runtimePaths.has(normalized);
}

function isProtectedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return FORBIDDEN_SEGMENTS.includes(lower) || lower.startsWith('.env');
}

export function assertCompletionInputReadable(relative: string): void {
  for (const segment of relative.split('/')) {
    if (isProtectedSegment(segment))
      throw new CompletionInputLimitError(
        `Completion input names a protected path and will not be read: ${relative}`,
      );
  }
}

interface Accumulator {
  hash: ReturnType<typeof createHash>;
  files: number;
  bytes: number;
}

async function hashFile(
  absolute: string,
  relative: string,
  state: Accumulator,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const before = await lstat(absolute);
  if (before.isSymbolicLink())
    throw new CompletionInputLimitError(
      `Symbolic links are not followed in completion inputs: ${relative}`,
    );
  if (before.size > MAX_FILE_BYTES)
    throw new CompletionInputLimitError(
      `Completion input exceeds the ${String(MAX_FILE_BYTES)} byte per-file limit: ${relative}`,
    );
  if (state.bytes + before.size > MAX_TOTAL_BYTES)
    throw new CompletionInputLimitError(
      `Completion inputs exceed the ${String(MAX_TOTAL_BYTES)} byte limit`,
    );
  // Streamed rather than read whole: the limits above are chosen so a large input list is *refused*, and a
  // reader that loaded each file into memory to decide would reach the limit the hard way.
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    // Hashed as it is read, so memory stays one buffer whatever the file's size. A file that moves while it is read
    // throws, and a throw discards the whole snapshot, so a half-hashed file can never reach a digest.
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    state.hash.update('file\0').update(relative).update('\0');
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      state.hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || offset !== before.size)
      throw new CompletionInputUnstableError(
        `Completion input changed while it was being read: ${relative}`,
      );
    state.files += 1;
    state.bytes += offset;
    state.hash.update('\0');
  } finally {
    await handle.close();
  }
}

async function walk(
  absolute: string,
  relative: string,
  state: Accumulator,
  runtimePaths: ReadonlySet<string>,
  signal: AbortSignal,
  includeCurrent: boolean,
): Promise<void> {
  signal.throwIfAborted();
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink())
    throw new CompletionInputLimitError(
      `Symbolic links are not followed in completion inputs: ${relative}`,
    );
  if (stat.isFile()) {
    await hashFile(absolute, relative, state, signal);
    return;
  }
  if (!stat.isDirectory())
    throw new CompletionInputLimitError(`Unsupported path type in completion inputs: ${relative}`);
  if (!includeCurrent) {
    state.hash.update('directory\0').update(relative).update('\0');
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded(childRelative, runtimePaths)) continue;
    if (state.files > MAX_FILES)
      throw new CompletionInputLimitError(
        `Completion inputs exceed the ${String(MAX_FILES)} file limit`,
      );
    await walk(path.join(absolute, entry.name), childRelative, state, runtimePaths, signal, false);
  }
}

/** Whether a path is inside the given root, compared after normalization on the same separators. */
function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}

export async function snapshotCompletionInputs(
  root: string,
  inputs: readonly string[],
  signal: AbortSignal,
  options: CompletionInputOptions = {},
): Promise<CompletionInputSnapshot> {
  signal.throwIfAborted();
  const resolvedRoot = await realpath(path.resolve(root));
  const canonicalRoot = await realpath(resolvedRoot);
  const runtimePaths = new Set<string>();
  for (const entry of options.runtimeStatePaths ?? []) {
    const resolved = path.resolve(entry);
    if (contained(canonicalRoot, resolved)) {
      runtimePaths.add(path.relative(canonicalRoot, resolved).split(path.sep).join('/'));
    }
  }
  const normalized = [
    ...new Set(
      inputs.map((input) => {
        assertCompletionInputReadable(input);
        return normalizeCompletionPath(input, 'input');
      }),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const state: Accumulator = { hash: createHash('sha256'), files: 0, bytes: 0 };
  // The identity of the root is hashed first, so two workspaces with identical content produce different
  // digests: evidence is evidence about *this* directory, not about a directory that happens to look like it.
  state.hash.update('root\0').update(canonicalRoot).update('\0');
  for (const relative of normalized) {
    signal.throwIfAborted();
    if (excluded(relative, runtimePaths)) continue;
    const absolute = path.resolve(canonicalRoot, relative);
    if (!contained(canonicalRoot, absolute))
      throw new CompletionInputLimitError(
        `Completion input escapes the execution root: ${relative}`,
      );
    let exists = true;
    try {
      await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) {
      // Absence is recorded rather than skipped: a file the checks read disappearing between two snapshots has
      // to change the digest, and "it was not there" is a fact about the range that was monitored.
      state.hash.update('absent\0').update(relative).update('\0');
      continue;
    }
    await walk(absolute, relative, state, runtimePaths, signal, true);
  }
  const afterRoot = await realpath(canonicalRoot);
  if (afterRoot !== canonicalRoot)
    throw new CompletionInputUnstableError('Execution root identity changed while snapshotting');
  return {
    version: 1,
    rootId: createHash('sha256').update(canonicalRoot).digest('hex'),
    digest: state.hash.digest('hex'),
    files: state.files,
    bytes: state.bytes,
  };
}
