import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_SCALE_LIMITS } from '../../protocol/workspaces.ts';
import { runWorkspaceGit } from '../../workspaces/git.ts';
import { normalizeCompletionPath } from './contract.ts';

/**
 * A content fingerprint of the files a completion contract's evidence covers. `S0` is taken before
 * the checks and `S1` after; a completion is published only when they agree, so a check that
 * mutates what it judges is not a pass. The file journal cannot replace this: it misses writes from
 * commands and other processes.
 *
 * - Coverage is explicit: the digest covers exactly `inputs`. The implicit `.` range uses Git's
 *   view of the root (tracked plus untracked-not-ignored), falling back to a filesystem walk
 *   outside a Git tree.
 * - Exceeding a bound is a refusal, never a truncation.
 * - Identity is the resolved root: identical content in two workspaces still yields two digests.
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
   * Paths the runtime itself writes (e.g. a workspace-scoped session database and its WAL),
   * excluded by resolved location, not by suffix, so user SQLite files are still covered.
   */
  runtimeStatePaths?: readonly string[];
  /** Most files the range may hold; defaults to the workspace snapshot limit. Exposed for tests. */
  maxFiles?: number;
  /**
   * Told the range's size before any of it is read, so a caller can announce a large fingerprint.
   */
  onCollected?: (scale: { files: number; bytes: number }) => void;
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
 * The same budget as a child's frozen snapshot, so anything that can be delegated can be verified.
 */
const MAX_FILES = WORKSPACE_SCALE_LIMITS.files;
const MAX_TOTAL_BYTES = WORKSPACE_SCALE_LIMITS.totalBytes;
const MAX_FILE_BYTES = WORKSPACE_SCALE_LIMITS.fileBytes;

/**
 * Directory names the implicit range never descends into, because they are derived (VCS metadata,
 * dependencies, runtime state, scratch, build output). Applied even to paths Git reports. Not
 * applied to a path the contract names explicitly, which is the subject of the evidence.
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
 * Path segments never readable as inputs, mirroring the file tools. A contract naming one is
 * rejected.
 */
const FORBIDDEN_SEGMENTS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.env'];

/**
 * Whether a walked path is outside the range. `defaultSegments` is true only for the implicit
 * range; explicit inputs ignore the derived-directory list. Protected paths and runtime state files
 * are always skipped.
 */
function excluded(
  relative: string,
  runtimePaths: ReadonlySet<string>,
  defaultSegments: boolean,
): boolean {
  // Strip the leading `./` so runtime state paths match exactly.
  const normalized = relative.replace(/^\.\//, '');
  const segments = normalized.split('/');
  // Never read credential paths, even under `.`.
  if (segments.some(isProtectedSegment)) return true;
  if (
    defaultSegments &&
    segments.some((segment) => COMPLETION_INPUT_EXCLUDED_SEGMENTS.includes(segment))
  )
    return true;
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

/** One file the range holds, as it stood when the walk admitted it. */
interface FileEntry {
  absolute: string;
  relative: string;
  size: number;
  mtimeMs: number;
}

/**
 * What a range is, in digest order: marker text and files. Collected before any content is read, so
 * every limit is decided on metadata alone.
 */
interface Collection {
  items: (string | FileEntry)[];
  files: number;
  bytes: number;
  maxFiles: number;
}

/** How many files are read at once. Bounded, so a large range does not open thousands of handles together. */
const HASH_CONCURRENCY = 8;

function admitFile(
  absolute: string,
  relative: string,
  stat: { size: number; mtimeMs: number },
  collection: Collection,
): void {
  if (stat.size > MAX_FILE_BYTES)
    throw new CompletionInputLimitError(
      `Completion input exceeds the ${String(MAX_FILE_BYTES)} byte per-file limit: ${relative}`,
    );
  // Counted where a file is admitted, so the limit is exact.
  if (collection.files >= collection.maxFiles)
    throw new CompletionInputLimitError(
      `Completion inputs exceed the ${String(collection.maxFiles)} file limit`,
    );
  if (collection.bytes + stat.size > MAX_TOTAL_BYTES)
    throw new CompletionInputLimitError(
      `Completion inputs exceed the ${String(MAX_TOTAL_BYTES)} byte limit`,
    );
  collection.items.push({ absolute, relative, size: stat.size, mtimeMs: stat.mtimeMs });
  collection.files += 1;
  collection.bytes += stat.size;
}

/**
 * A symbolic link is recorded as itself (path and target text), never followed and never refused.
 * Retargeting changes the digest.
 */
async function admitLink(
  absolute: string,
  relative: string,
  collection: Collection,
): Promise<void> {
  if (collection.files >= collection.maxFiles)
    throw new CompletionInputLimitError(
      `Completion inputs exceed the ${String(collection.maxFiles)} file limit`,
    );
  collection.items.push(`link\0${relative}\0${await readlink(absolute)}\0`);
  // Counted with the files so the range stays bounded however many links it holds.
  collection.files += 1;
}

/**
 * One file's digest, streamed. A file that changed since the walk (size, mtime, byte count) throws
 * and discards the whole snapshot.
 */
async function hashFile(entry: FileEntry, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(entry.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== entry.size || after.mtimeMs !== entry.mtimeMs || offset !== entry.size)
      throw new CompletionInputUnstableError(
        `Completion input changed while it was being read: ${entry.relative}`,
      );
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Every file's digest, `HASH_CONCURRENCY` at a time; digest order is the walk's. The first failure
 * is thrown after started reads finish.
 */
async function hashFiles(files: readonly FileEntry[], signal: AbortSignal): Promise<string[]> {
  const digests = new Array<string>(files.length);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < files.length) {
      const index = next++;
      try {
        digests[index] = await hashFile(files[index]!, signal);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, worker));
  if (failure !== undefined) throw failure;
  return digests;
}

async function walk(
  absolute: string,
  relative: string,
  collection: Collection,
  runtimePaths: ReadonlySet<string>,
  signal: AbortSignal,
  includeCurrent: boolean,
  defaultSegments: boolean,
): Promise<void> {
  signal.throwIfAborted();
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    await admitLink(absolute, relative, collection);
    return;
  }
  if (stat.isFile()) {
    admitFile(absolute, relative, stat, collection);
    return;
  }
  if (!stat.isDirectory())
    throw new CompletionInputLimitError(`Unsupported path type in completion inputs: ${relative}`);
  if (!includeCurrent) collection.items.push(`directory\0${relative}\0`);
  const entries = await readdir(absolute, { withFileTypes: true });
  // Code-unit order, so the digest does not depend on ICU collation.
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded(childRelative, runtimePaths, defaultSegments)) continue;
    await walk(
      path.join(absolute, entry.name),
      childRelative,
      collection,
      runtimePaths,
      signal,
      false,
      defaultSegments,
    );
  }
}

/**
 * Paths Git would commit from this root: tracked plus untracked-but-not-ignored (a freshly created
 * output stays in). `undefined` when Git cannot answer; the caller falls back to the filesystem
 * walk.
 */
async function gitVisiblePaths(root: string, signal: AbortSignal): Promise<string[] | undefined> {
  try {
    const result = await runWorkspaceGit(
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, signal, allowFailure: true, maxBytes: 256 * 1024 * 1024 },
    );
    if (result.code !== 0) return undefined;
    return [...new Set(result.stdout.toString('utf8').split('\0').filter(Boolean))];
  } catch {
    return undefined;
  }
}

/**
 * The implicit `.` range in sorted Git order. Paths Git reports that no longer exist are skipped.
 */
async function snapshotGitVisible(
  root: string,
  listed: readonly string[],
  collection: Collection,
  runtimePaths: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  const paths = [...listed].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const relative of paths) {
    signal.throwIfAborted();
    if (excluded(relative, runtimePaths, true)) continue;
    const absolute = path.resolve(root, relative);
    if (!contained(root, absolute))
      throw new CompletionInputLimitError(
        `Completion input escapes the execution root: ${relative}`,
      );
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      await admitLink(absolute, relative, collection);
      continue;
    }
    // Walk submodules so their contents are covered.
    if (stat.isDirectory()) {
      await walk(absolute, relative, collection, runtimePaths, signal, false, true);
      continue;
    }
    if (!stat.isFile())
      throw new CompletionInputLimitError(
        `Unsupported path type in completion inputs: ${relative}`,
      );
    admitFile(absolute, relative, stat, collection);
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
  const collection: Collection = {
    items: [],
    files: 0,
    bytes: 0,
    maxFiles: options.maxFiles ?? MAX_FILES,
  };
  // Hash the root's identity first, so evidence is tied to this directory.
  collection.items.push(`root\0${canonicalRoot}\0`);
  for (const relative of normalized) {
    signal.throwIfAborted();
    /**
     * Contract-named paths bypass the derived-directory exclusions. Only `.` means the implicit
     * range (narrowed to Git's view in a working tree). Runtime state files named by a contract are
     * refused.
     */
    const implicitRange = relative === '.';
    if (!implicitRange && runtimePaths.has(relative))
      throw new CompletionInputLimitError(
        `Completion input names the runtime’s own state and cannot be monitored: ${relative}`,
      );
    const absolute = path.resolve(canonicalRoot, relative);
    if (!contained(canonicalRoot, absolute))
      throw new CompletionInputLimitError(
        `Completion input escapes the execution root: ${relative}`,
      );
    if (implicitRange) {
      const listed = await gitVisiblePaths(canonicalRoot, signal);
      if (listed) {
        await snapshotGitVisible(canonicalRoot, listed, collection, runtimePaths, signal);
        continue;
      }
    }
    let exists = true;
    try {
      await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) {
      // Record absence, so a file disappearing between snapshots changes the digest.
      collection.items.push(`absent\0${relative}\0`);
      continue;
    }
    await walk(absolute, relative, collection, runtimePaths, signal, true, implicitRange);
  }
  const files = collection.items.filter((item): item is FileEntry => typeof item !== 'string');
  options.onCollected?.({ files: collection.files, bytes: collection.bytes });
  const digests = await hashFiles(files, signal);
  const hash = createHash('sha256');
  let file = 0;
  for (const item of collection.items) {
    if (typeof item === 'string') hash.update(item);
    else hash.update(`file\0${item.relative}\0${digests[file++]!}\0`);
  }
  const afterRoot = await realpath(canonicalRoot);
  if (afterRoot !== canonicalRoot)
    throw new CompletionInputUnstableError('Execution root identity changed while snapshotting');
  return {
    version: 1,
    rootId: createHash('sha256').update(canonicalRoot).digest('hex'),
    digest: hash.digest('hex'),
    files: collection.files,
    bytes: collection.bytes,
  };
}
