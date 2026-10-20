import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_SCALE_LIMITS } from '../protocol/workspaces.ts';
import { runWorkspaceGit } from '../workspaces/git.ts';
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
 *   at least one input and a task may fall back to the workspace root. That fallback is Git's own view of the
 *   root — tracked files plus untracked files Git would commit, ignoring what `.gitignore` excludes — rather than
 *   every file a recursive directory listing happens to find. A root outside a Git working tree keeps the
 *   filesystem walk, because then there is no index to ask.
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
  /**
   * The most files the range may hold; defaults to the workspace snapshot's own limit.
   *
   * Exposed so the boundary itself can be exercised without creating two hundred thousand files; no caller narrows
   * it in production.
   */
  maxFiles?: number;
  /**
   * Told the size of the range once it is known and before any of it is read.
   *
   * The walk decides every limit on metadata alone, so this is the moment a caller can say "about to fingerprint
   * N files" — the cost of the snapshot is the reads that follow, and a person watching a task end on a large tree
   * otherwise saw nothing until they were done.
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
 * The same budget a child's frozen snapshot uses, so a tree that can be delegated can also be verified: a fingerprint
 * that refused a file the snapshot accepted sent an unrelated large asset to review at the end of a task.
 */
const MAX_FILES = WORKSPACE_SCALE_LIMITS.files;
const MAX_TOTAL_BYTES = WORKSPACE_SCALE_LIMITS.totalBytes;
const MAX_FILE_BYTES = WORKSPACE_SCALE_LIMITS.fileBytes;

/**
 * Directory names the *implicit* source range never descends into.
 *
 * Excluded because they are *derived*: a checkout's `.git`, a dependency tree, the runtime's own state directory,
 * scratch space and build output all change for reasons that have nothing to do with whether the work is correct,
 * and including them would make the fingerprint flap on every build. The list is documented rather than
 * discovered, and the coverage boundary it creates is reported with the digest (`files` counts exactly what was
 * hashed) rather than left implicit. It applies to paths Git already reports too: a repository that commits
 * `dist/` still gets a digest of the source, not of the build that produced it.
 *
 * A path the contract names explicitly is not filtered by this list. `inputs`/a check path is the *subject* of
 * the evidence, and silently dropping it was how a declared `dist/out.txt` could pass, be changed, and still read
 * as verified: the two snapshots compared an empty range to an empty range. The exclusions describe the fallback
 * range of `.`, not a path a caller asked to be watched.
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

/**
 * Whether a walked path is outside the range being fingerprinted.
 *
 * `defaultSegments` is true only while walking the implicit whole-workspace range. An explicit input is the
 * subject of the evidence, so the derived-directory heuristic does not apply to it or its subtree; otherwise an
 * explicit `dist/out.txt` would contribute nothing to the digest and its later change would be invisible.
 *
 * Protected paths are skipped in every walk — a private key is never read to prove the source did not change —
 * and the runtime's own state files stay excluded by their exact relative path even under an explicit directory,
 * because their writes describe the runtime rather than the work.
 */
function excluded(
  relative: string,
  runtimePaths: ReadonlySet<string>,
  defaultSegments: boolean,
): boolean {
  // A walk that started at the root names its children `./child`, so the leading segment is stripped before
  // anything is compared: without this, the runtime's own database — matched by its exact relative path — would
  // only be excluded when it happened to be named some other way, and the snapshot would flag every round.
  const normalized = relative.replace(/^\.\//, '');
  const segments = normalized.split('/');
  // Credential paths are skipped by a walk exactly as they are refused by name: a range of `.` that descended
  // into `.ssh` would read a private key in order to prove the source did not change.
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
 * What a range is, in digest order: marker text (the root, a directory, an absent input) and the files between them.
 *
 * Collected before any content is read, so every limit — files, bytes per file, bytes in total — is decided on
 * metadata alone: a range too large to fingerprint is refused before the first byte of it is hashed, rather than
 * after most of it has been.
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
  // Counted where a file is admitted, so the limit is exactly the number of files accepted: a check on the way into
  // a directory let the last entry through after the count had already reached it.
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
 * One file's own digest, streamed so memory stays one buffer whatever its size.
 *
 * A file that is not what the walk admitted — another size, another mtime, or a different number of bytes than it
 * claimed — throws, and a throw discards the whole snapshot, so a file that moved while it was read can never
 * reach a digest.
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
 * Every file's digest, read `HASH_CONCURRENCY` at a time.
 *
 * The walk used to open, read and close each file in turn, so a task's end on a large tree waited for the sum of
 * every read — twice, before and after the checks. The digest's order is the walk's, not the reads', so reading
 * in parallel changes nothing about what it covers. The first failure is the answer; reads already started are
 * let finish before it is thrown, so no handle outlives the snapshot.
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
  if (stat.isSymbolicLink())
    throw new CompletionInputLimitError(
      `Symbolic links are not followed in completion inputs: ${relative}`,
    );
  if (stat.isFile()) {
    admitFile(absolute, relative, stat, collection);
    return;
  }
  if (!stat.isDirectory())
    throw new CompletionInputLimitError(`Unsupported path type in completion inputs: ${relative}`);
  if (!includeCurrent) collection.items.push(`directory\0${relative}\0`);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
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
 * The paths Git would commit from this root: what is tracked, plus what is untracked but not ignored.
 *
 * This is the default range because it is the repository's own answer to "what is the project", and it is the
 * difference between reading a source tree and reading every dependency and build product a person happened to
 * leave in the directory. Untracked files stay in: a task that creates `out.txt` and verifies it has not committed
 * anything, and dropping the file it just produced would be the false assurance the fingerprint exists to prevent.
 *
 * `undefined` means Git could not answer — not a repository, no Git, a listing over the output cap. The caller
 * falls back to the filesystem walk, which is slower but keeps the old coverage rather than refusing to verify.
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
 * The implicit `.` range, in Git's order.
 *
 * The paths are sorted before hashing, exactly as a directory walk sorts its entries: `git ls-files` is stable but
 * its `--others` half is not promised to be, and a digest must not depend on the order a listing happened to use.
 * A path Git reports that no longer exists is skipped — the working tree is the subject, and a staged deletion is
 * an absent file rather than an unreadable one.
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
    if (stat.isSymbolicLink())
      throw new CompletionInputLimitError(
        `Symbolic links are not followed in completion inputs: ${relative}`,
      );
    // A submodule is a directory Git tracks as one entry; walk it so its contents are covered exactly as a
    // recursive listing would have covered them.
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
  // The identity of the root is hashed first, so two workspaces with identical content produce different
  // digests: evidence is evidence about *this* directory, not about a directory that happens to look like it.
  collection.items.push(`root\0${canonicalRoot}\0`);
  for (const relative of normalized) {
    signal.throwIfAborted();
    /**
     * A path named by the contract is the subject of its evidence, so the derived-directory heuristic may not
     * remove it. `dist/out.txt` declared as an acceptance input is not build output to be ignored: skipping it
     * made the two snapshots compare an empty range to an empty range, and a later change to the file left the
     * verdict at `verified`.
     *
     * `.` is the one name that still means the implicit range (a task without `completionInputs`), and it keeps
     * the exclusions. In a Git working tree it also narrows to Git's view of the root: tracked files and untracked
     * files that are not ignored, so a dependency tree `.gitignore` already excludes is never read to prove the
     * source did not change. The runtime's own state files are refused rather than silently skipped: a contract
     * that names the database cannot be monitored, and dropping it would be the same false assurance in another
     * form.
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
      // Absence is recorded rather than skipped: a file the checks read disappearing between two snapshots has
      // to change the digest, and "it was not there" is a fact about the range that was monitored.
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
