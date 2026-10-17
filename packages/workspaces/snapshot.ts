import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceFailure, type WorkspaceSnapshot } from '../protocol/workspaces.ts';
import { gitPath, isUnsafeGitPath, samePath } from '../core/workspace-paths.ts';
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

const SNAPSHOT_FORMAT = 2;
/** One file larger than this is not a source file this feature was built for. Refused by name, not truncated. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 200_000;

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

export interface SnapshotManifestEntry {
  path: string;
  mode: '100644' | '100755';
  size: number;
  sha256: string;
  /** The bytes, base64: a snapshot's manifest is its own copy of the input, so a lost directory is recoverable. */
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

  const entries = await collectWorkingTree(sourceRoot, signal);
  const manifest = await buildManifest(identity, entries, { projectRoot, sourceRoot });
  const snapshotId = manifestDigest(manifest);
  // The identity of a snapshot *is* its manifest, so a later freeze of unchanged content may find the metadata
  // already published. That is idempotence, not a collision: the bytes are the same bytes.
  const published = await readManifest(identity.repositoryRoot, snapshotId);
  if (published) return snapshotOf(published, snapshotId);

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
export async function collectWorkingTree(
  directory: string,
  signal?: AbortSignal,
): Promise<SnapshotManifestEntry[]> {
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
  const entries: SnapshotManifestEntry[] = [];
  const refused: string[] = [];
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
    const bytes = await readFile(absolute);
    if (bytes.length !== info.size)
      throw new WorkspaceFailure(
        'WORKSPACE_SOURCE_CHANGED',
        `${relative} changed while it was being read; nothing was frozen`,
        { path: relative },
      );
    entries.push({
      path: relative,
      // Only the two modes Git distinguishes for regular files are reproduced; anything else was refused above.
      mode: (info.mode & 0o111) === 0 ? '100644' : '100755',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      blob: bytes.toString('base64'),
    });
  }
  if (refused.length)
    throw new WorkspaceFailure(
      'WORKSPACE_PROTECTED_CREDENTIAL',
      `The repository tracks credential files that this service will not copy into an isolated workspace: ${refused
        .slice(0, 10)
        .join(', ')}`,
      { paths: refused.slice(0, 20) },
    );
  return entries;
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
    hash.update(
      `${entry.path}\u0000${entry.mode}\u0000${entry.size}\u0000${entry.sha256}\u0000${entry.blob}\u0000`,
    );
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
   * milliseconds, so a baseline of 800 files took over a minute before the child could start. The bytes are
   * staged as numbered files under this snapshot's own metadata directory (names this code chose, so
   * `--stdin-paths` never sees a path with a newline), hashed by one `hash-object --stdin-paths` that answers
   * one id per line in order, and entered by one `update-index -z --index-info`, whose NUL-terminated records
   * carry any path Git can store. `--no-filters` keeps the bytes exactly as recorded, as before.
   */
  if (manifest.files.length) {
    const staging = path.join(metadata, 'blobs');
    await mkdir(staging, { recursive: true });
    try {
      const staged: string[] = [];
      for (const [index, entry] of manifest.files.entries()) {
        const file = path.join(staging, String(index));
        await writeFile(file, Buffer.from(entry.blob, 'base64'));
        staged.push(file);
      }
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
    } finally {
      await rm(staging, { recursive: true, force: true });
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
  await writeFile(staging, `${JSON.stringify(manifest, null, 2)}\n`);
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
      (parsed?.format !== 1 && parsed?.format !== SNAPSHOT_FORMAT) ||
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
  expected: readonly SnapshotManifestEntry[],
  signal?: AbortSignal,
): Promise<void> {
  const actual = await collectWorkingTree(identity.worktreeRoot, signal);
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

/** One entry's bytes, read back out of the manifest, for the worktree fill. */
export function entryBytes(entry: SnapshotManifestEntry): Buffer {
  return Buffer.from(entry.blob, 'base64');
}
