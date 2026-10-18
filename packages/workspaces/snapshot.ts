import { createHash, randomUUID } from 'node:crypto';
import { existsSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceFailure, type WorkspaceSnapshot } from '../protocol/workspaces.ts';
import { gitPath, isUnsafeGitPath, samePath } from '../platform/workspace-paths.ts';
import {
  repositoryIdentity,
  repositoryReadiness,
  runWorkspaceGit,
  withRepositoryLock,
  workspaceGit,
  WORKSPACE_GIT_IDENTITY,
  type RepositoryIdentity,
} from './git.ts';

/**
 * Freezing the delegator's directory into a baseline every child of one call can share.
 *
 * The baseline is the **working directory's current bytes**, not HEAD: the user is usually in the middle of
 * something when they delegate, and a child that started from HEAD would silently discard the edits the delegation
 * was about. That is also why the user's own index is read as evidence and never written — a freeze that staged the
 * working tree to build its tree would be a change to the user's repository, made without asking, as a side effect
 * of delegating work.
 *
 * Four promises, in the order they can fail:
 *
 * 1. **Reproducible.** The same bytes produce the same snapshot id, so two children of one call share one baseline
 *    even when they start minutes apart — including the ones that were queued behind the concurrency cap.
 * 2. **Stable.** The path set and every file's bytes are read twice, and a directory that changed underneath the
 *    walk is refused (`WORKSPACE_SOURCE_CHANGED`) rather than frozen half-way.
 * 3. **Reproducible by this build.** Symbolic links, junctions, unusual file types, submodules, sparse checkouts
 *    and unmerged indexes are refused by name, because each is a case where copying "the tree" would produce
 *    something other than what the user has.
 * 4. **Non-destructive.** No stash, no commit in the user's history, no `add`, no write to their index, HEAD or
 *    working tree. The baseline's own objects hang off a private ref so a later `gc` cannot collect them.
 */

const SNAPSHOT_FORMAT = 3;
/**
 * How much of a blob's digest names its file beside a format-3 manifest.
 *
 * The full digest is in the manifest and is re-checked when the bytes are read, so the file name only has to be
 * unique in practice. Truncating it keeps a snapshot's metadata path below Windows' classic 260-character limit,
 * which a full 64-character digest plus a deep temp workspace can exceed (`git hash-object` then fails on a path
 * the process can otherwise create).
 */
const BLOB_NAME_CHARS = 32;
/** One file larger than this is not a source file this feature was built for. Refused by name, not truncated. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 200_000;
/**
 * How many bytes of working tree one snapshot may carry.
 *
 * The manifest holds each file's bytes base64-encoded, so a freeze costs roughly twice the tree in memory before it
 * is published. That is fine for source trees and not fine for a directory someone pointed at by mistake — and the
 * failure used to arrive as an out-of-memory death partway through, with a half-built snapshot behind it. This is
 * the number that turns that into a refusal that names the tree, its size and the budget. It is generous on
 * purpose: a large monorepo is still a working tree this feature should handle.
 */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/**
 * Files whose *tracked* presence blocks a freeze, and whose untracked presence is simply not copied.
 *
 * The asymmetry is the whole design, and it is about *credentials* specifically — runtime directories are skipped
 * silently elsewhere. An untracked `.env` is a local secret that isolation should keep out of a child's directory,
 * so leaving it behind is the protection working. A *tracked* `.env` is a file the repository says is part of the
 * project, and a baseline that quietly omitted it would hand the child a tree whose reproduction of the project is
 * silently incomplete — the failure this list exists to prevent. It blocks, and the refusal names the paths so a
 * person can decide.
 */
const PROTECTED_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.git-credentials',
  '.htpasswd',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'secrets.json',
  'service-account.json',
]);
const PROTECTED_SUFFIXES = ['.pem', '.key', '.pfx', '.p12', '.keystore'];
/**
 * Directory names never copied, wherever they appear.
 *
 * These are *runtime* directories rather than secrets, and they are skipped silently in both cases: `.git` and
 * `.yuantu` hold version-control and service state that the destination worktree has its own copy of, so
 * reproducing them would be wrong rather than merely unnecessary. A repository that has one of them tracked has
 * already made a mistake this service need not repeat.
 */
const RUNTIME_DIRECTORIES = new Set(['.git', '.yuantu']);
/** Dependency trees are not copied for a different reason: they are reproducible, and very large. */
const IGNORED_DIRECTORIES = new Set(['node_modules']);

/**
 * Whether a path is one this feature never carries between directories.
 *
 * Exported so the worktree fill and the result export answer "is this ours to move" exactly as the walk that
 * produced the entries did: three copies of this rule is how one of them ends up copying `node_modules` or the
 * runtime's own state into a child's directory.
 */
function isRuntimePath(relativePath: string): boolean {
  return relativePath
    .split('/')
    .some((segment) => RUNTIME_DIRECTORIES.has(segment) || IGNORED_DIRECTORIES.has(segment));
}
export { isRuntimePath };

/** Whether a file looks like a stored credential, by name. */
function looksLikeCredential(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const name = segments[segments.length - 1] ?? '';
  if (PROTECTED_FILES.has(name)) return true;
  const lower = name.toLowerCase();
  return PROTECTED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** What a walk learned about one file, without the bytes: enough to compare two walks and to build a manifest. */
export interface SnapshotFileDigest {
  path: string;
  mode: '100644' | '100755';
  size: number;
  sha256: string;
}

export interface SnapshotManifestEntry extends SnapshotFileDigest {
  /**
   * The bytes, base64 — **format 2** manifests only.
   *
   * Format 3 stores each file's bytes content-addressed beside the manifest (`<metadata>/files/<sha256 prefix>`). A
   * manifest that embedded the tree made `readManifest` load the whole tree just to fill a worktree, and made the
   * published file about 2.3 times the size of the tree it describes. Entries written by this version carry no
   * `blob`; the field is still read so manifests written before the migration keep working.
   */
  blob?: string;
}

/** A tree as the bytes-returning walk produces it: every entry carries its content. */
export interface CollectedTreeEntry extends SnapshotManifestEntry {
  blob: string;
}

export interface SnapshotManifest {
  format: number;
  projectRoot: string;
  sourceRoot: string;
  sourceHead: string;
  baseCommit: string;
  baseTree: string;
  createdAt: string;
  files: SnapshotManifestEntry[];
}

export interface FreezeSnapshotInput {
  /** The logical project directory a delegation is running in. */
  projectRoot: string;
  /** The directory whose bytes are frozen. Defaults to `projectRoot`; the manager passes a binding's root. */
  sourceRoot?: string;
  signal?: AbortSignal;
}

/** Where this service keeps a snapshot's private metadata, inside the repository it belongs to. */
export function snapshotMetadataRoot(repositoryRoot: string, snapshotId: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(snapshotId))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid snapshot identifier');
  return path.join(repositoryRoot, '.yuantu', 'workspace-snapshots', snapshotId);
}

/** The ref that keeps a baseline's objects alive: an unreferenced object is garbage to a later `gc`. */
export function snapshotRef(snapshotId: string): string {
  return `refs/yuantu/snapshots/${snapshotId}`;
}

/** The content-addressed name a format-3 manifest's bytes are stored under. */
function blobName(sha256: string): string {
  return sha256.slice(0, BLOB_NAME_CHARS);
}

/**
 * Freezes one directory into a reusable baseline.
 *
 * Re-running the freeze for unchanged content returns the snapshot that already exists, which is what makes "one
 * snapshot per delegation call" hold even when the call is resumed after a crash.
 */
export async function freezeSnapshot(input: FreezeSnapshotInput): Promise<WorkspaceSnapshot> {
  const { projectRoot, signal } = input;
  const sourceRoot = input.sourceRoot ?? projectRoot;
  const identity = await repositoryIdentity(sourceRoot, signal);
  if (!identity)
    throw new WorkspaceFailure(
      'WORKSPACE_NOT_A_REPOSITORY',
      `${sourceRoot} is not inside a Git working tree, so it cannot be isolated`,
    );
  /**
   * The directory asked about has to *be* a working tree root, not a subdirectory of one.
   *
   * A project selected as a subdirectory is the case the plan refuses: the manifest is repository-relative while
   * the delegated work is project-relative, so every path in a result would name a file outside the project the
   * user chose.
   */
  // `worktreeRoot` is `realpath` output and `sourceRoot` is whatever the caller was given, so on Windows a
  // case-only difference (a hand-typed drive letter, a differently-cased folder pick) would refuse the real
  // repository root. `samePath` is the comparator this repository uses for exactly this question.
  if (!samePath(identity.worktreeRoot, sourceRoot))
    throw new WorkspaceFailure(
      'WORKSPACE_NOT_A_REPOSITORY',
      `Select the repository root (${identity.worktreeRoot}) rather than a subdirectory of it`,
      { worktreeRoot: identity.worktreeRoot },
    );
  const readiness = await repositoryReadiness(identity, signal);
  if (readiness.unmerged.length)
    throw new WorkspaceFailure(
      'WORKSPACE_UNMERGED_INDEX',
      'The repository has unresolved merge entries in its index; resolve them before delegating',
      { paths: readiness.unmerged.slice(0, 20) },
    );
  if (readiness.hasSubmodules)
    throw new WorkspaceFailure(
      'WORKSPACE_SUBMODULE_UNSUPPORTED',
      'Submodules are not supported by workspace isolation yet',
    );
  if (readiness.sparse)
    throw new WorkspaceFailure(
      'WORKSPACE_SPARSE_UNSUPPORTED',
      'A sparse checkout is not supported by workspace isolation yet: part of the working tree is absent by design',
    );

  /**
   * The bytes are staged, not held.
   *
   * A freeze used to collect the whole tree base64-encoded into the manifest, which put ~2.3 copies of the tree in
   * memory and made the published manifest a second copy on disk. The staging directory is content-addressed and
   * renamed beside the manifest once the id is known, so the freeze's peak is one file and a published snapshot is
   * a small manifest plus the bytes it names.
   */
  const staging = path.join(
    identity.repositoryRoot,
    '.yuantu',
    'workspace-snapshots',
    `.staging-${process.pid}-${randomUUID()}`,
  );
  /**
   * Two walks, and they must agree — but the first one only hashes.
   *
   * A single walk proves only that each file was a plausible size when it was read: a file rewritten to the same
   * length between two reads is invisible, and two files edited at different moments can be collected as a
   * combination that never existed. That combination is a baseline a child would analyse as if it were one version
   * of the project, so the bytes are always read twice and an equal-length rewrite or a changed path set is refused.
   * It is deliberately not called atomic: a change after the second read can still race the publish, but the
   * deterministic mixed-version window is closed.
   *
   * Hashing first is what makes a repeat freeze cheap. Delegating again from an unchanged tree used to stage every
   * file's bytes and only then find the snapshot already published and throw the copy away; now the identity is
   * known before anything is written, and a published one costs the second read and nothing else.
   */
  const first = await collectFileDigests(sourceRoot, signal);
  const manifest = await buildManifest(identity, first, { projectRoot, sourceRoot });
  const snapshotId = manifestDigest(manifest);
  // The identity of a snapshot *is* its manifest, so a later freeze of unchanged content may find the metadata
  // already published. That is idempotence, not a collision: the bytes are the same bytes.
  const published = await readManifest(identity.repositoryRoot, snapshotId);
  if (published) {
    await verifySnapshotStable(identity, first, signal);
    return snapshotOf(published, snapshotId);
  }
  try {
    assertSameTree(first, await collectStagedTree(sourceRoot, staging, signal));
    const metadata = snapshotMetadataRoot(identity.repositoryRoot, snapshotId);
    await mkdir(metadata, { recursive: true });
    const files = path.join(metadata, 'files');
    /**
     * A concurrent freeze of the same content may have published these bytes already. They are addressed by their
     * digest, so whichever copy lands first is the same content; the loser's staging directory is simply dropped.
     */
    if (!existsSync(files)) await rename(staging, files);

    const tree = await buildTree(identity, manifest, snapshotId, signal);
    /**
     * The commit is *not* part of the snapshot's identity, which is why it is made outside the lock and may be
     * discarded: two freezes of one unchanged directory produce the same id and two different `commit-tree`
     * timestamps, and only one of those commits can be the baseline the store records for that id.
     */
    const baseCommit = await commitBaseline(identity, tree, snapshotId, signal);
    await checkIndexUntouched(identity, readiness.indexHash);
    const stored: SnapshotManifest = {
      ...manifest,
      baseCommit,
      baseTree: tree,
      createdAt: new Date().toISOString(),
    };
    return publishSnapshot(identity, snapshotId, stored, signal);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Publishes metadata only if nobody published it first, and hands back whichever copy is durable.
 *
 * The check above is what normally makes a repeat freeze cheap, but it is not enough on its own: two freezes that
 * started together both read "nothing published" and both arrive here, and the loser's `rename` would replace the
 * winner's `baseCommit` with its own. The record the store keeps would then disagree with the file the service reads
 * back, and the store refuses that disagreement as `WORKSPACE_INTEGRITY` — a delegation reporting a failed child
 * whose work was, in fact, never started.
 *
 * So the read and the write happen together under the repository lock, and the losing freeze adopts the published
 * record. `refs/yuantu/snapshots/<id>` keeps one commit per id for the same reason: it is a pointer to *the*
 * baseline, and the second writer must not move it to a commit the metadata does not name. The losing commit is left
 * unreferenced on purpose — it holds the same tree, and a later `gc` is free to collect it.
 */
async function publishSnapshot(
  identity: RepositoryIdentity,
  snapshotId: string,
  manifest: SnapshotManifest,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
  return withRepositoryLock(identity.repositoryRoot, async () => {
    const winner = await readManifest(identity.repositoryRoot, snapshotId);
    if (winner) return snapshotOf(winner, snapshotId);
    await publishManifest(identity.repositoryRoot, snapshotId, manifest);
    await runWorkspaceGit(['update-ref', snapshotRef(snapshotId), manifest.baseCommit], {
      cwd: identity.worktreeRoot,
      ...(signal ? { signal } : {}),
    });
    return snapshotOf(manifest, snapshotId);
  });
}

function snapshotOf(manifest: SnapshotManifest, snapshotId: string): WorkspaceSnapshot {
  return {
    id: snapshotId,
    projectRoot: manifest.projectRoot,
    sourceRoot: manifest.sourceRoot,
    sourceHead: manifest.sourceHead,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    manifestHash: snapshotId,
    createdAt: manifest.createdAt,
  };
}

/**
 * Reads one directory's plain files, refusing anything this version cannot reproduce.
 *
 * Exported because the *result* export asks a worktree exactly the question the freeze asks of the delegator's
 * directory — "which plain files does this directory hold, and what are their bytes" — and two implementations of
 * that walk would be two answers to one question. Freed from being the freeze's private step, it takes the
 * directory rather than an identity, so it can be pointed at either side of the comparison.
 *
 * `ls-files --cached --others --exclude-standard` is the listing because it is the one Git answers that covers
 * tracked files *and* untracked-but-not-ignored files in one call, with NUL separators so a path containing a
 * newline, a space or a quote survives intact. Ignored files are deliberately absent: build output, caches and
 * `node_modules` are reproducible from the project, and copying them would make every allocation cost a full
 * install.
 */

function modeOf(info: { mode: number }): '100644' | '100755' {
  // Only the two modes Git distinguishes for regular files are reproduced; anything else was refused by the walk.
  return (info.mode & 0o111) === 0 ? '100644' : '100755';
}

/**
 * One walk over the working tree, with the caller deciding what to keep.
 *
 * The refusals and the stability checks live here once. `collectWorkingTree` keeps every file's bytes because the
 * result export compares trees byte for byte; `collectFileDigests` keeps only what identifies those bytes; and
 * `collectStagedTree` writes the bytes to a staging directory so the freeze never holds the tree in memory. Two
 * copies of this walk would be two sets of refusals to keep in step.
 */
async function walkWorkingTree(
  directory: string,
  signal: AbortSignal | undefined,
  limits: { maxTotalBytes?: number },
  onFile: (file: { relative: string; info: Stats; bytes: Buffer }) => void | Promise<void>,
): Promise<void> {
  const budget = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const cwd = directory;
  const options = signal ? { signal } : {};
  const listed = await workspaceGit(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd,
      ...options,
      maxBytes: 256 * 1024 * 1024,
    },
  );
  const paths = [
    ...new Set(
      listed
        .split('\0')
        .map((entry) => gitPath(entry))
        .filter(Boolean),
    ),
  ].sort();
  if (paths.length > MAX_FILES)
    throw new WorkspaceFailure(
      'WORKSPACE_UNSUPPORTED_FILE_TYPE',
      `The working tree holds ${paths.length} files, more than the ${MAX_FILES} this version freezes`,
    );
  const tracked = new Set(
    (await workspaceGit(['ls-files', '--cached', '-z'], { cwd, ...options }))
      .split('\0')
      .map((entry) => gitPath(entry))
      .filter(Boolean),
  );
  const refused: string[] = [];
  let totalBytes = 0;
  for (const relative of paths) {
    if (isRuntimePath(relative)) continue;
    if (looksLikeCredential(relative)) {
      /**
       * A credential file the repository tracks blocks the freeze; an untracked one is simply left behind.
       *
       * The refusal has to be about the *tracked* case, because that is the one where "we did not copy it" makes the
       * baseline an inaccurate reproduction of the project. An untracked secret is not part of the project, and
       * copying it would be the mistake.
       */
      if (tracked.has(relative)) refused.push(relative);
      continue;
    }
    if (isUnsafeGitPath(relative)) continue;
    const absolute = path.join(cwd, relative);
    /**
     * `lstat`, never `stat`: the question is what the path itself *is*, and following a link first is exactly how a
     * symbolic link would be copied as the file it points at — including one pointing outside the project.
     */
    const info = await lstat(absolute).catch(() => null);
    // A path deleted between the listing and this read is simply not in the baseline; the second pass decides
    // whether that was a concurrent change or a stale listing.
    if (!info) continue;
    if (info.isSymbolicLink())
      throw new WorkspaceFailure(
        'WORKSPACE_UNSUPPORTED_FILE_TYPE',
        `Symbolic links are not supported by workspace isolation yet: ${relative}`,
        { path: relative },
      );
    if (!info.isFile())
      throw new WorkspaceFailure(
        'WORKSPACE_UNSUPPORTED_FILE_TYPE',
        `Only plain files can be frozen: ${relative}`,
        { path: relative },
      );
    if (info.size > MAX_FILE_BYTES)
      throw new WorkspaceFailure(
        'WORKSPACE_UNSUPPORTED_FILE_TYPE',
        `File is larger than the ${MAX_FILE_BYTES} byte limit: ${relative}`,
        { path: relative },
      );
    // Checked before the read, so the file that crosses the line is not loaded first: the point of a budget is to
    // stop before the allocation that would have failed anyway, and to say which tree it was.
    if (totalBytes + info.size > budget)
      throw new WorkspaceFailure(
        'WORKSPACE_TOO_LARGE',
        `The working tree is larger than the ${budget} byte budget this version freezes (${totalBytes + info.size}+ bytes at ${relative}); delegate with a smaller project or raise the budget`,
        { bytes: totalBytes + info.size, budget, path: relative },
      );
    totalBytes += info.size;
    const bytes = await readFile(absolute);
    if (bytes.length !== info.size)
      throw new WorkspaceFailure(
        'WORKSPACE_SOURCE_CHANGED',
        `${relative} changed while it was being read; nothing was frozen`,
        { path: relative },
      );
    await onFile({ relative, info, bytes });
  }
  if (refused.length)
    throw new WorkspaceFailure(
      'WORKSPACE_PROTECTED_CREDENTIAL',
      `The repository tracks credential files that this service will not copy into an isolated workspace: ${refused
        .slice(0, 10)
        .join(', ')}`,
      { paths: refused.slice(0, 20) },
    );
}

export async function collectWorkingTree(
  directory: string,
  signal?: AbortSignal,
  limits: { maxTotalBytes?: number } = {},
): Promise<CollectedTreeEntry[]> {
  const entries: CollectedTreeEntry[] = [];
  await walkWorkingTree(directory, signal, limits, ({ relative, info, bytes }) => {
    entries.push({
      path: relative,
      mode: modeOf(info),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      blob: bytes.toString('base64'),
    });
  });
  return entries;
}

/**
 * The freeze's own walk: each file's bytes go to `staging/<sha256 prefix>`, and the entry keeps only what
 * identifies them.
 *
 * This is what makes a freeze's memory independent of the tree's size. The staging directory is content-addressed,
 * so two files with the same content share one copy, and it is renamed beside the manifest once the snapshot id is
 * known; the caller removes it on every path that does not publish.
 */
export async function collectStagedTree(
  directory: string,
  staging: string,
  signal?: AbortSignal,
  limits: { maxTotalBytes?: number } = {},
): Promise<SnapshotManifestEntry[]> {
  const entries: SnapshotManifestEntry[] = [];
  await mkdir(staging, { recursive: true });
  await walkWorkingTree(directory, signal, limits, async ({ relative, info, bytes }) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(staging, blobName(sha256)), bytes);
    entries.push({ path: relative, mode: modeOf(info), size: bytes.length, sha256 });
  });
  return entries;
}

/**
 * The same walk, keeping only what identifies the bytes.
 *
 * `collectWorkingTree` returns every file's content base64-encoded, which publishing a snapshot needs and a
 * *comparison* does not: a caller that only asks "is this still the same tree" used to hold a second full copy of
 * it. This walk hashes each file and lets the buffer go, so its peak is one file whatever the tree's size.
 */
export async function collectFileDigests(
  directory: string,
  signal?: AbortSignal,
  limits: { maxTotalBytes?: number } = {},
): Promise<SnapshotFileDigest[]> {
  const digests: SnapshotFileDigest[] = [];
  await walkWorkingTree(directory, signal, limits, ({ relative, info, bytes }) => {
    digests.push({
      path: relative,
      mode: modeOf(info),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
  return digests;
}

async function buildManifest(
  identity: RepositoryIdentity,
  entries: readonly SnapshotManifestEntry[],
  input: { projectRoot: string; sourceRoot: string },
): Promise<Omit<SnapshotManifest, 'baseCommit' | 'baseTree' | 'createdAt'>> {
  const head = (await workspaceGit(['rev-parse', 'HEAD'], { cwd: identity.worktreeRoot })).trim();
  return {
    format: SNAPSHOT_FORMAT,
    projectRoot: input.projectRoot,
    sourceRoot: input.sourceRoot,
    sourceHead: head,
    files: [...entries].sort((left, right) => (left.path < right.path ? -1 : 1)),
  };
}

/**
 * The snapshot's identity includes its project and source directory as well as its bytes.
 *
 * Deliberately over the file list rather than over the commit, and deliberately **not** including the source HEAD.
 * A `git commit` the user runs while a delegation is queued changes HEAD without changing the working bytes this
 * baseline is made of; folding HEAD in would then hand two children of one call two different baselines, which is
 * exactly what the shared-input promise forbids. The file list is what the baseline *is*.
 *
 * The content is committed to by `sha256`, not by embedding the bytes: an identity that hashed the encoded tree
 * was itself a reason to hold the tree in memory.
 */
function manifestDigest(
  manifest: Omit<SnapshotManifest, 'baseCommit' | 'baseTree' | 'createdAt'>,
): string {
  const hash = createHash('sha256');
  hash.update(`v${manifest.format}\u0000`);
  // Snapshots share a process-wide store, and linked worktrees share metadata on disk. Equal bytes in
  // different directories must not reuse a record carrying another project's/source's identity.
  hash.update(
    `${path.resolve(manifest.projectRoot)}\u0000${path.resolve(manifest.sourceRoot)}\u0000`,
  );
  for (const entry of manifest.files)
    hash.update(`${entry.path}\u0000${entry.mode}\u0000${entry.size}\u0000${entry.sha256}\u0000`);
  return hash.digest('hex').slice(0, 32);
}

/**
 * Builds the baseline tree from a private index.
 *
 * The private `GIT_INDEX_FILE` is the mechanism that keeps the user's index out of this: `update-index` and
 * `write-tree` are given somewhere else to write, so the repository's own index is untouched and the before/after
 * hash check proves it. `--no-filters` and `hash-object --stdin` avoid every path that could consult
 * `.gitattributes` and run a clean filter, and `commit-tree` runs no hook at all.
 */
async function buildTree(
  identity: RepositoryIdentity,
  manifest: Omit<SnapshotManifest, 'baseCommit' | 'baseTree' | 'createdAt'>,
  snapshotId: string,
  signal?: AbortSignal,
): Promise<string> {
  const metadata = snapshotMetadataRoot(identity.repositoryRoot, snapshotId);
  await mkdir(metadata, { recursive: true });
  const indexFile = path.join(metadata, 'index');
  await rm(indexFile, { force: true });
  const env = { GIT_INDEX_FILE: indexFile };
  const options = { cwd: identity.worktreeRoot, env, ...(signal ? { signal } : {}) };
  /**
   * Two Git processes for the whole manifest, not two per file.
   *
   * Each entry used to spawn its own `hash-object` and `update-index`; on Windows a Git spawn costs tens of
   * milliseconds, so a baseline of 800 files took over a minute before the child could start. The bytes are the
   * content-addressed files the freeze staged beside this manifest (names this code chose, so `--stdin-paths` never
   * sees a path with a newline), hashed by one `hash-object --stdin-paths` that answers one id per line in order,
   * and entered by one `update-index -z --index-info`, whose NUL-terminated records carry any path Git can store.
   * `--no-filters` keeps the bytes exactly as recorded.
   */
  if (manifest.files.length) {
    const filesDirectory = path.join(metadata, 'files');
    const staged = manifest.files.map((entry) => {
      // A format 2 manifest embeds its bytes; only a manifest this version wrote has the files beside it.
      if (entry.blob === undefined) return path.join(filesDirectory, blobName(entry.sha256));
      throw new WorkspaceFailure(
        'WORKSPACE_INTEGRITY',
        `A snapshot manifest without stored files cannot be rebuilt: ${entry.path}`,
      );
    });
    try {
      const blobs = (
        await runWorkspaceGit(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
          ...options,
          input: Buffer.from(staged.join('\n') + '\n', 'utf8'),
        })
      ).stdout
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (
        blobs.length !== manifest.files.length ||
        !blobs.every((id) => /^[0-9a-f]{40,64}$/.test(id))
      )
        throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Git did not hash every baseline file');
      const records = manifest.files.map(
        (entry, index) => `${entry.mode} ${blobs[index]}\t${entry.path}\0`,
      );
      await runWorkspaceGit(['update-index', '--add', '-z', '--index-info'], {
        ...options,
        input: Buffer.from(records.join(''), 'utf8'),
      });
    } catch (error) {
      // The files beside the manifest are the snapshot's bytes and stay; a failure here is a failed build, not a
      // reason to delete what a concurrent writer may already be using.
      throw error;
    }
  }
  const tree = (await runWorkspaceGit(['write-tree'], options)).stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Git did not produce a baseline tree');
  return tree;
}

/** The synthetic commit, created with the service's own identity and never on a branch. */
async function commitBaseline(
  identity: RepositoryIdentity,
  tree: string,
  snapshotId: string,
  signal?: AbortSignal,
): Promise<string> {
  const output = await runWorkspaceGit(
    ['commit-tree', tree, '-m', `YuanTu workspace baseline ${snapshotId}`],
    {
      cwd: identity.worktreeRoot,
      ...(signal ? { signal } : {}),
      env: {
        GIT_AUTHOR_NAME: WORKSPACE_GIT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: WORKSPACE_GIT_IDENTITY.email,
        GIT_COMMITTER_NAME: WORKSPACE_GIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: WORKSPACE_GIT_IDENTITY.email,
      },
    },
  );
  const commit = output.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Git did not produce a baseline commit');
  return commit;
}

/**
 * Proves the freeze did not write the user's index.
 *
 * Not an assertion about intent: `hash-object -w` writes objects and `update-index` writes an index, and the only
 * reason the user's index is safe is that `GIT_INDEX_FILE` pointed somewhere else. Comparing a hash taken before
 * the freeze with one taken after turns that from a claim about the code into an observation about the repository.
 */
async function checkIndexUntouched(identity: RepositoryIdentity, before: string): Promise<void> {
  const after = await readFile(path.join(identity.metadataDirectory, 'index'))
    .then((bytes) => createHash('sha256').update(bytes).digest('hex'))
    .catch(() => 'absent');
  if (after !== before)
    throw new WorkspaceFailure(
      'WORKSPACE_INTEGRITY',
      'The repository index changed while the baseline was being built; nothing was published',
    );
}

/** Metadata is published by an atomic rename, so a reader never sees a half-written manifest. */
async function publishManifest(
  repositoryRoot: string,
  snapshotId: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const directory = snapshotMetadataRoot(repositoryRoot, snapshotId);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, 'manifest.json');
  const staging = `${target}.${process.pid}.tmp`;
  /**
   * Produced in pieces rather than as one string.
   *
   * `JSON.stringify(manifest)` built a second copy of the manifest just to hand it to `writeFile`. The bytes are the
   * same JSON either way; writing the header and then the entries keeps peak memory at one chunk. Chunks are bounded
   * rather than one write per entry, so a tree of a hundred thousand small files is not a hundred thousand syscalls.
   */
  const header = JSON.stringify({
    format: manifest.format,
    projectRoot: manifest.projectRoot,
    sourceRoot: manifest.sourceRoot,
    sourceHead: manifest.sourceHead,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    createdAt: manifest.createdAt,
  });
  const handle = await open(staging, 'w');
  try {
    await handle.write(`${header.slice(0, -1)},"files":[`);
    let chunk = '';
    for (const [index, entry] of manifest.files.entries()) {
      chunk += `${index ? ',' : ''}${JSON.stringify(entry)}`;
      if (chunk.length >= 64 * 1024) {
        await handle.write(chunk);
        chunk = '';
      }
    }
    if (chunk) await handle.write(chunk);
    await handle.write(']}\n');
  } finally {
    await handle.close();
  }
  await rename(staging, target);
}

export async function readManifest(
  repositoryRoot: string,
  snapshotId: string,
): Promise<SnapshotManifest | null> {
  const key = snapshotMetadataRoot(repositoryRoot, snapshotId);
  const bytes = await readFile(path.join(key, 'manifest.json')).catch(() => null);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as SnapshotManifest;
    if (
      // Formats 1 and 2 embedded the bytes; format 3 names them by digest. All three stay readable.
      ![1, 2, SNAPSHOT_FORMAT].includes(parsed?.format ?? 0) ||
      !Array.isArray(parsed.files) ||
      typeof parsed.baseCommit !== 'string' ||
      typeof parsed.baseTree !== 'string'
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Reads back the *other* half of the second read, for a caller that wants to check stability itself.
 *
 * Exported because the manager allocates a directory from a snapshot that was frozen moments earlier, while a
 * child's session is still being created — and the input it must not silently diverge from is the one the other
 * children of the same call are already using.
 */
export async function verifySnapshotStable(
  identity: RepositoryIdentity,
  expected: readonly SnapshotFileDigest[],
  signal?: AbortSignal,
): Promise<void> {
  assertSameTree(expected, await collectFileDigests(identity.worktreeRoot, signal));
}

/** Two walks of one tree, refused as `WORKSPACE_SOURCE_CHANGED` unless every path, mode and digest agrees. */
function assertSameTree(
  expected: readonly SnapshotFileDigest[],
  actual: readonly SnapshotFileDigest[],
): void {
  if (actual.length !== expected.length)
    throw new WorkspaceFailure(
      'WORKSPACE_SOURCE_CHANGED',
      'The working tree changed after the workspace snapshot was frozen',
    );
  for (let index = 0; index < expected.length; index++) {
    const before = expected[index]!;
    const after = actual[index]!;
    if (before.path !== after.path || before.sha256 !== after.sha256 || before.mode !== after.mode)
      throw new WorkspaceFailure(
        'WORKSPACE_SOURCE_CHANGED',
        `${before.path} changed after the workspace snapshot was frozen`,
        { path: before.path },
      );
  }
}

/**
 * One entry's bytes: embedded in the manifest when it is a format 2 one, read from the content-addressed files
 * beside it otherwise.
 *
 * The digest is checked on the way out. A stored file is what a worktree will be filled with, so a file that no
 * longer hashes to the entry's `sha256` is a snapshot that would silently hand a child different content — the
 * `WORKSPACE_INTEGRITY` case, not a reason to carry on.
 */
export async function snapshotFileBytes(
  repositoryRoot: string,
  snapshotId: string,
  entry: SnapshotManifestEntry,
): Promise<Buffer> {
  if (entry.blob !== undefined) return Buffer.from(entry.blob, 'base64');
  const files = path.join(snapshotMetadataRoot(repositoryRoot, snapshotId), 'files');
  /**
   * The short name is what this build writes. The full digest is still read so snapshots published by the
   * preceding format-3 build remain usable; both are verified against `entry.sha256` below.
   */
  const bytes = await readFile(path.join(files, blobName(entry.sha256)))
    .catch(() => readFile(path.join(files, entry.sha256)))
    .catch(() => null);
  if (!bytes)
    throw new WorkspaceFailure(
      'WORKSPACE_MISSING',
      `The stored bytes for ${entry.path} are missing from snapshot ${snapshotId}`,
      { path: entry.path },
    );
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw new WorkspaceFailure(
      'WORKSPACE_INTEGRITY',
      `The stored bytes for ${entry.path} do not match the digest recorded for it`,
      { path: entry.path },
    );
  return bytes;
}
