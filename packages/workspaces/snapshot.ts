import { createHash, randomUUID } from 'node:crypto';
import { type Stats } from 'node:fs';
import { lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  WORKSPACE_SCALE_LIMITS,
  WorkspaceFailure,
  type WorkspaceSnapshot,
} from '../protocol/workspaces.ts';
import { isCredentialFileName } from '../platform/credential-paths.ts';
import { ensureRuntimeDirectory } from '../platform/runtime-directory.ts';
import { gitPath, isUnsafeGitPath, samePath } from '../platform/workspace-paths.ts';
import { sameStatKey, statKey, type StatKey } from '../platform/stat-cache.ts';
import {
  repositoryIdentity,
  repositoryReadiness,
  runWorkspaceGit,
  withRepositoryLock,
  workspaceGit,
  workspaceGitList,
  openBlobBatch,
  readBlob,
  type BlobReader,
  WORKSPACE_GIT_IDENTITY,
  type RepositoryIdentity,
  type TreeEntry,
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

/**
 * Format 4 keeps a snapshot's bytes only as Git blobs the manifest names (`SnapshotManifestEntry.oid`), kept alive by
 * one owner ref per session database (`snapshotOwnerRef`). Formats 1–3 stay readable; format 3 kept a second copy of
 * the bytes in a `files` directory beside the manifest and a single `refs/yuantu/snapshots/<id>` ref.
 */
const SNAPSHOT_FORMAT = 4;
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
const MAX_FILE_BYTES = WORKSPACE_SCALE_LIMITS.fileBytes;
const MAX_FILES = WORKSPACE_SCALE_LIMITS.files;
/**
 * How many bytes of working tree one snapshot may carry.
 *
 * The manifest holds each file's bytes base64-encoded, so a freeze costs roughly twice the tree in memory before it
 * is published. That is fine for source trees and not fine for a directory someone pointed at by mistake — and the
 * failure used to arrive as an out-of-memory death partway through, with a half-built snapshot behind it. This is
 * the number that turns that into a refusal that names the tree, its size and the budget. It is generous on
 * purpose: a large monorepo is still a working tree this feature should handle.
 */
const MAX_TOTAL_BYTES = WORKSPACE_SCALE_LIMITS.totalBytes;

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
  const lower = name.toLowerCase();
  // The shared rule covers the `.env.*` and `credentials.*` families the file tools refuse; this list adds the
  // names only a whole-tree copy needs to worry about. Both compare without case, as Windows and macOS do.
  if (isCredentialFileName(name) || PROTECTED_FILES.has(lower)) return true;
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
  /**
   * The Git blob holding the bytes — **format 4**, where Git's object store is the only copy.
   *
   * Format 3 entries carry neither field: their bytes are the files beside the manifest.
   */
  oid?: string;
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
  /**
   * Who keeps this snapshot alive: the session database that will record it (`SessionStore.snapshotOwner`).
   *
   * Defaults to `STANDALONE_OWNER`, whose share is never released — a caller outside a store keeps what it froze.
   */
  owner?: string;
  signal?: AbortSignal;
}

/** Where this service keeps a snapshot's private metadata, inside the repository it belongs to. */
export function snapshotMetadataRoot(repositoryRoot: string, snapshotId: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(snapshotId))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid snapshot identifier');
  return path.join(repositoryRoot, '.yuantu', 'workspace-snapshots', snapshotId);
}

/** How old a staging directory whose owner still looks alive must be before it counts as abandoned anyway. */
const STAGING_ABANDONED_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the staging directories of freezes that will never finish.
 *
 * A freeze stages its bytes in `.staging-<pid>-<uuid>` and removes the directory in a `finally`, so only a process
 * that was killed outright leaves one — up to a whole tree's worth of bytes, kept forever. A directory is
 * abandoned when its owner pid is gone, or when it is older than any freeze takes (the pid may since belong to
 * another process). This process's own are never touched: a freeze of its own may be in flight. Returns how many
 * were removed.
 */
export async function sweepAbandonedStaging(
  repositoryRoot: string,
  now = Date.now(),
): Promise<number> {
  const directory = path.join(repositoryRoot, '.yuantu', 'workspace-snapshots');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = /^\.staging-(\d+)-/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const target = path.join(directory, name);
    let ownerGone = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      ownerGone = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (!ownerGone) {
      const info = await lstat(target).catch(() => null);
      if (!info || now - info.mtimeMs < STAGING_ABANDONED_MS) continue;
    }
    await rm(target, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * The single ref that kept a baseline's objects alive before owners were recorded (formats 3 and earlier).
 *
 * Still read: a snapshot that has one is never deleted automatically, because nothing says which databases use it.
 */
export function snapshotRef(snapshotId: string): string {
  return `refs/yuantu/snapshots/${snapshotId}`;
}

/**
 * Where the owner refs live: one ref per snapshot per owner, `<prefix>/<snapshot id>/<owner>`.
 *
 * A namespace of its own rather than below `refs/yuantu/snapshots/<id>`, because Git cannot hold a ref and a
 * directory of refs under the same name, and that name is taken by the pre-owner ref of older snapshots.
 */
export const SNAPSHOT_OWNER_REFS = 'refs/yuantu/snapshot-owners';

/** The owner a caller that names none is recorded as; nothing ever releases it, so its snapshots are kept. */
export const STANDALONE_OWNER = 'standalone';

/**
 * The ref through which `owner` keeps a snapshot alive.
 *
 * Each session database of a repository is one owner (`SessionStore.snapshotOwner`), so the set of refs under a
 * snapshot is the set of databases that use it — visible to all of them, because refs live in the repository rather
 * than in any one database.
 */
export function snapshotOwnerRef(snapshotId: string, owner: string): string {
  if (!/^[0-9a-z-]{1,64}$/.test(owner))
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Invalid snapshot owner');
  return `${SNAPSHOT_OWNER_REFS}/${snapshotId}/${owner}`;
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

  const owner = input.owner ?? STANDALONE_OWNER;
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
    // Another owner published it; this one still has to say it uses it, or the other's release would drop it.
    return publishSnapshot(identity, snapshotId, published, owner, signal);
  }
  /**
   * The bytes go straight into Git's object store, and that is the only copy.
   *
   * Format 3 staged every file into a content-addressed directory beside the manifest and then imported the same
   * bytes into Git to build the baseline tree — two copies of the tree per snapshot, and the directory copy shared
   * nothing between snapshots of slightly different trees. The second walk now writes each file as a blob through one
   * `fast-import` stream as it reads it, the manifest names each file's blob, and Git's own content addressing
   * shares every unchanged file between every snapshot of the repository.
   */
  const collected = await collectObjectTree(identity.repositoryRoot, sourceRoot, signal);
  assertSameTree(first, collected);
  const tree = await buildTree(identity, collected, snapshotId, signal);
  /**
   * The commit is *not* part of the snapshot's identity, which is why it is made outside the lock and may be
   * discarded: two freezes of one unchanged directory produce the same id and two different `commit-tree`
   * timestamps, and only one of those commits can be the baseline the store records for that id.
   */
  const baseCommit = await commitBaseline(identity, tree, snapshotId, signal);
  await checkIndexUntouched(identity, readiness.indexHash);
  const stored: SnapshotManifest = {
    ...manifest,
    files: collected,
    baseCommit,
    baseTree: tree,
    createdAt: new Date().toISOString(),
  };
  return publishSnapshot(identity, snapshotId, stored, owner, signal);
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
 * record. The owner ref points at the *published* baseline commit for the same reason: it must keep alive the commit
 * the metadata names, never the loser's. The losing commit is left unreferenced on purpose — it holds the same tree,
 * and a later `gc` is free to collect it.
 *
 * Every publish, including one that finds the snapshot already there, records its owner (`snapshotOwnerRef`). The
 * owner refs are the snapshot's reference count across every session database of the repository: a snapshot is
 * deleted only when the last of them is released (`releaseSnapshotOwner`).
 */
async function publishSnapshot(
  identity: RepositoryIdentity,
  snapshotId: string,
  manifest: SnapshotManifest,
  owner: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
  return withRepositoryLock(identity.repositoryRoot, async () => {
    const winner = await readManifest(identity.repositoryRoot, snapshotId);
    if (!winner) await publishManifest(identity.repositoryRoot, snapshotId, manifest);
    const durable = winner ?? manifest;
    await runWorkspaceGit(['update-ref', snapshotOwnerRef(snapshotId, owner), durable.baseCommit], {
      cwd: identity.repositoryRoot,
      ...(signal ? { signal } : {}),
    });
    return snapshotOf(durable, snapshotId);
  });
}

/**
 * Records that `owner` uses a snapshot that is already published, by pointing its owner ref at the baseline.
 *
 * For callers that adopt an existing snapshot without freezing it (recovery, a restore) and for snapshots published
 * before owners were recorded: from now on this owner's release decides for its share, as it would for a new one.
 */
export async function claimSnapshotOwner(
  repositoryRoot: string,
  snapshotId: string,
  baseCommit: string,
  owner: string,
  signal?: AbortSignal,
): Promise<void> {
  await withRepositoryLock(repositoryRoot, async () => {
    await runWorkspaceGit(['update-ref', snapshotOwnerRef(snapshotId, owner), baseCommit], {
      cwd: repositoryRoot,
      ...(signal ? { signal } : {}),
    });
  });
}

/**
 * Releases `owner`'s share of a snapshot, and deletes the snapshot when that was the last share.
 *
 * Under the repository lock, so a concurrent freeze adopting the same snapshot either records its owner first (and
 * the snapshot stays) or finds it gone and publishes it afresh. A snapshot is never deleted while any owner ref or a
 * pre-owner `refs/yuantu/snapshots/<id>` ref still names it: a database this one cannot see may be using it. Only the
 * metadata is removed here; the objects become unreachable and Git's own maintenance collects them. Answers whether
 * the snapshot was deleted.
 */
export async function releaseSnapshotOwner(
  repositoryRoot: string,
  snapshotId: string,
  owner: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const metadata = snapshotMetadataRoot(repositoryRoot, snapshotId);
  return withRepositoryLock(repositoryRoot, async () => {
    const options = { cwd: repositoryRoot, ...(signal ? { signal } : {}) };
    await runWorkspaceGit(['update-ref', '-d', snapshotOwnerRef(snapshotId, owner)], {
      ...options,
      allowFailure: true,
    });
    const remaining = await workspaceGit(
      [
        'for-each-ref',
        '--format=%(refname)',
        `${SNAPSHOT_OWNER_REFS}/${snapshotId}/`,
        snapshotRef(snapshotId),
      ],
      options,
    );
    if (remaining) return false;
    await rm(metadata, { recursive: true, force: true });
    return true;
  });
}

/** One snapshot directory of a repository, as `workspace-gc` reports it. */
export interface SnapshotInventoryEntry {
  id: string;
  /** The manifest's format, or `null` when the directory holds no readable manifest. */
  format: number | null;
  /** Bytes on disk under the snapshot's metadata directory (format 3 kept a copy of every file there). */
  bytes: number;
  owners: string[];
  /** A pre-owner `refs/yuantu/snapshots/<id>` ref: kept until a person decides. */
  legacyRef: boolean;
}

/**
 * Every snapshot directory and staging directory one repository holds, with who keeps each.
 *
 * A report, never a decision: it is what `workspace-gc --dry-run` prints so a person can see which snapshots predate
 * owners (`legacyRef`, or `owners` empty with a format below 4), how large each is, and what an abandoned freeze left.
 */
export async function inventorySnapshots(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<{ snapshots: SnapshotInventoryEntry[]; staging: { name: string; bytes: number }[] }> {
  const directory = path.join(repositoryRoot, '.yuantu', 'workspace-snapshots');
  const names = await readdir(directory).catch(() => [] as string[]);
  const legacy = new Set(
    (
      await workspaceGit(['for-each-ref', '--format=%(refname)', 'refs/yuantu/snapshots/'], {
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      })
    )
      .split('\n')
      .filter(Boolean)
      .map((ref) => ref.slice('refs/yuantu/snapshots/'.length)),
  );
  const snapshots: SnapshotInventoryEntry[] = [];
  const staging: { name: string; bytes: number }[] = [];
  for (const name of names.sort()) {
    signal?.throwIfAborted();
    const bytes = await directoryBytes(path.join(directory, name));
    if (name.startsWith('.staging-')) {
      staging.push({ name, bytes });
      continue;
    }
    if (!/^[0-9a-f]{16,64}$/.test(name)) continue;
    const manifest = await readManifest(repositoryRoot, name);
    snapshots.push({
      id: name,
      format: manifest?.format ?? null,
      bytes,
      owners: await snapshotOwners(repositoryRoot, name, signal),
      legacyRef: legacy.has(name),
    });
  }
  return { snapshots, staging };
}

async function directoryBytes(target: string): Promise<number> {
  const info = await lstat(target).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(target).catch(() => [] as string[]))
    total += await directoryBytes(path.join(target, name));
  return total;
}

/** Every owner that has a share of a snapshot, as its owner refs name them. */
export async function snapshotOwners(
  repositoryRoot: string,
  snapshotId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const prefix = `${SNAPSHOT_OWNER_REFS}/${snapshotId}/`;
  const refs = await workspaceGit(['for-each-ref', '--format=%(refname)', prefix], {
    cwd: repositoryRoot,
    ...(signal ? { signal } : {}),
  });
  return refs
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.slice(prefix.length));
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

/** How far a tree walk has got: files handled, and how many the Git listing admitted. */
export interface TreeWalkProgress {
  processed: number;
  total: number;
}

/**
 * One walk over the working tree, with the caller deciding what to keep.
 *
 * The refusals and the stability checks live here once. `collectWorkingTree` keeps every file's bytes for callers
 * that need them in memory; `collectTreeBlobs` writes each file to the object store for the result export; `collectFileDigests` keeps only what identifies those bytes; and
 * `collectStagedTree` writes the bytes to a staging directory so the freeze never holds the tree in memory. Two
 * copies of this walk would be two sets of refusals to keep in step.
 */
async function walkWorkingTree(
  directory: string,
  signal: AbortSignal | undefined,
  limits: { maxTotalBytes?: number },
  onFile: (file: { relative: string; info: Stats; bytes: Buffer }) => void | Promise<void>,
  /**
   * A file this answers `true` for is not read: `onKnown` is told about it instead. Every check before the read —
   * the listing, the credential and link refusals, the size and budget limits — still applies to it.
   */
  known?: {
    has(relative: string, info: Stats): boolean;
    onKnown(file: { relative: string; info: Stats }): void;
  },
  /**
   * Told after every listed path, including the ones a refusal skipped, so a caller can say "N of M" while a large
   * first export is still running. The total is known before the first read; the walk is where the time goes.
   */
  onProgress?: (progress: TreeWalkProgress) => void,
): Promise<void> {
  const budget = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const cwd = directory;
  const options = signal ? { signal } : {};
  const listed = await workspaceGitList(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd,
      ...options,
      maxBytes: 256 * 1024 * 1024,
    },
  );
  const paths = [...new Set(listed.map((entry) => gitPath(entry)).filter(Boolean))].sort();
  if (paths.length > MAX_FILES)
    throw new WorkspaceFailure(
      'WORKSPACE_UNSUPPORTED_FILE_TYPE',
      `The working tree holds ${paths.length} files, more than the ${MAX_FILES} this version freezes`,
    );
  const tracked = new Set(
    (await workspaceGitList(['ls-files', '--cached', '-z'], { cwd, ...options }))
      .map((entry) => gitPath(entry))
      .filter(Boolean),
  );
  /**
   * Every directory above a file, checked once per walk.
   *
   * `lstat` on the file alone does not see a link further up: a tracked directory replaced by a symbolic link or
   * a Windows junction leaves the file itself looking plain while the read follows the link out of the tree.
   */
  const ancestors = new Map<string, Promise<boolean>>();
  const plainAncestor = (relative: string): Promise<boolean> => {
    let known = ancestors.get(relative);
    if (!known) {
      known = lstat(path.join(cwd, ...relative.split('/')))
        .catch(() => null)
        .then((info) => {
          if (info?.isSymbolicLink())
            throw new WorkspaceFailure(
              'WORKSPACE_UNSUPPORTED_FILE_TYPE',
              `Symbolic links are not supported by workspace isolation yet: ${relative}`,
              { path: relative },
            );
          return Boolean(info?.isDirectory());
        });
      ancestors.set(relative, known);
    }
    return known;
  };
  const plainAncestors = async (relative: string): Promise<boolean> => {
    const segments = relative.split('/').slice(0, -1);
    for (let depth = 1; depth <= segments.length; depth++)
      if (!(await plainAncestor(segments.slice(0, depth).join('/')))) return false;
    return true;
  };
  const refused: string[] = [];
  let totalBytes = 0;
  let processed = 0;
  for (const relative of paths) {
    try {
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
      // A missing ancestor means the path was deleted after the listing, which the second pass judges like a file.
      if (!(await plainAncestors(relative))) continue;
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
      if (known?.has(relative, info)) {
        known.onKnown({ relative, info });
        continue;
      }
      const bytes = await readFile(absolute);
      if (bytes.length !== info.size)
        throw new WorkspaceFailure(
          'WORKSPACE_SOURCE_CHANGED',
          `${relative} changed while it was being read; nothing was frozen`,
          { path: relative },
        );
      await onFile({ relative, info, bytes });
    } finally {
      processed += 1;
      onProgress?.({ processed, total: paths.length });
    }
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
 * The freeze's second walk: each file written as a Git blob as it is read, the entry keeping its digest and blob.
 *
 * This is what makes a freeze's memory independent of the tree's size and its disk cost one copy: the bytes reach
 * the object store through one `fast-import` stream and nowhere else, and a file another snapshot already holds is
 * the same object. A walk that fails part-way leaves only unreachable objects, which Git collects.
 */
async function collectObjectTree(
  repositoryRoot: string,
  directory: string,
  signal?: AbortSignal,
  limits: { maxTotalBytes?: number } = {},
): Promise<SnapshotManifestEntry[]> {
  const entries: SnapshotManifestEntry[] = [];
  const batch = openBlobBatch(repositoryRoot, signal);
  try {
    await walkWorkingTree(directory, signal, limits, async ({ relative, info, bytes }) => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      entries.push({ path: relative, mode: modeOf(info), size: bytes.length, sha256 });
      await batch.add(bytes);
    });
  } catch (error) {
    batch.abort();
    throw error;
  }
  const blobs = await batch.finish();
  return entries.map((entry, index) => ({ ...entry, oid: blobs[index]! }));
}

/**
 * The walk a result export needs: each file written as a Git blob as it is read, keeping only the blob id.
 *
 * The export compares trees by object id, so the bytes only have to reach the object store once. Writing each
 * file's blob as the walk reads it keeps the peak at one file, where collecting the tree first held every file
 * base64-encoded (about 1.3 times the tree) and then decoded a second copy to hand to `writeTree`. The blobs share
 * one `fast-import` stream rather than one `hash-object` process each, which took 72 s for 2000 files on Windows.
 */
export async function collectTreeBlobs(
  repositoryRoot: string,
  directory: string,
  signal?: AbortSignal,
  limits: { maxTotalBytes?: number } = {},
  cache?: TreeBlobCache,
  onProgress?: (progress: TreeWalkProgress) => void,
): Promise<TreeEntry[]> {
  const files: { path: string; mode: '100644' | '100755'; blob?: string; key: StatKey }[] = [];
  const batch = openBlobBatch(repositoryRoot, signal);
  const startedAt = Date.now();
  try {
    await walkWorkingTree(
      directory,
      signal,
      limits,
      async ({ relative, info, bytes }) => {
        files.push({ path: relative, mode: modeOf(info), key: statKey(info) });
        await batch.add(bytes);
      },
      cache && {
        has: (relative, info) => cache.blobFor(relative, info) !== undefined,
        onKnown: ({ relative, info }) =>
          files.push({
            path: relative,
            mode: modeOf(info),
            blob: cache.blobFor(relative, info)!,
            key: statKey(info),
          }),
      },
      onProgress,
    );
  } catch (error) {
    batch.abort();
    throw error;
  }
  const blobs = await batch.finish();
  let written = 0;
  const entries = files.map((file) => ({ ...file, blob: file.blob ?? blobs[written++]! }));
  cache?.replace(entries, startedAt);
  return entries.map((entry): TreeEntry => ({
    path: entry.path,
    mode: entry.mode,
    blob: entry.blob,
  }));
}

/**
 * The blob id of each file a working tree held the last time it was exported, keyed by what a write changes.
 *
 * A worktree child's turn usually touches a handful of files, and the export at its end read, hashed and imported
 * every file in the tree — the whole repository, every turn. A file whose size, times, inode and mode are what
 * they were last time is the same bytes, so its blob id is reused without reading it; this is the same bet Git's
 * own index makes. The one case it cannot see is a write inside the clock's granularity of the walk that recorded
 * it, so a file modified that close to the walk is read again (Git calls these racily clean).
 */
export class TreeBlobCache {
  private entries = new Map<string, { key: StatKey; mode: string; blob: string }>();
  private recordedAt = 0;
  blobFor(relative: string, info: Stats): string | undefined {
    const entry = this.entries.get(relative);
    if (!entry || entry.mode !== modeOf(info) || !sameStatKey(entry.key, statKey(info))) return;
    // The modification time, as Git judges it; the change time is still part of the key compared above.
    if (info.mtimeMs >= this.recordedAt - RACY_WINDOW_MS) return;
    return entry.blob;
  }
  /** What one walk found, recorded as of when that walk started. */
  replace(
    entries: readonly { path: string; mode: string; blob: string; key: StatKey }[],
    walkStartedAt: number,
  ): void {
    this.entries = new Map(entries.map((entry) => [entry.path, entry]));
    this.recordedAt = walkStartedAt;
  }
  clear(): void {
    this.entries.clear();
    this.recordedAt = 0;
  }
}
/** Wider than the coarsest timestamp a supported filesystem keeps (FAT's two seconds). */
const RACY_WINDOW_MS = 3_000;

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
  entries: readonly SnapshotManifestEntry[],
  snapshotId: string,
  signal?: AbortSignal,
): Promise<string> {
  /**
   * A private index of its own, so nothing here can write the user's — and outside the snapshot's metadata, which a
   * concurrent release may delete: the index only lives for the length of this call.
   */
  const indexFile = path.join(
    identity.commonDirectory,
    `yuantu-snapshot-${snapshotId}-${process.pid}-${randomUUID()}.index`,
  );
  const env = { GIT_INDEX_FILE: indexFile };
  const options = { cwd: identity.worktreeRoot, env, ...(signal ? { signal } : {}) };
  try {
    /**
     * One Git process for the whole manifest, not one per file.
     *
     * Each entry used to spawn its own `hash-object` and `update-index`; on Windows a Git spawn costs tens of
     * milliseconds, so a baseline of 800 files took over a minute before the child could start. The blobs are already
     * in the object store (`collectObjectTree`), so the tree is one `update-index -z --index-info`, whose
     * NUL-terminated records carry any path Git can store, and one `write-tree`.
     */
    if (entries.length) {
      const records = entries.map((entry) => {
        if (!entry.oid || !/^[0-9a-f]{40,64}$/.test(entry.oid))
          throw new WorkspaceFailure('WORKSPACE_INTEGRITY', `No blob for ${entry.path}`);
        return `${entry.mode} ${entry.oid}\t${entry.path}\0`;
      });
      await runWorkspaceGit(['update-index', '--add', '-z', '--index-info'], {
        ...options,
        input: Buffer.from(records.join(''), 'utf8'),
      });
    }
    const tree = (await runWorkspaceGit(['write-tree'], options)).stdout.toString('utf8').trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree))
      throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Git did not produce a baseline tree');
    return tree;
  } finally {
    await rm(indexFile, { force: true });
  }
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
  const directory = ensureRuntimeDirectory(snapshotMetadataRoot(repositoryRoot, snapshotId));
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

/**
 * Whether every entry of a manifest read from disk is one this version could have written.
 *
 * The manifest decides where a worktree fill writes, so a path is trusted only when it is relative, stays inside
 * the tree, avoids runtime directories and credential names, and appears once; embedded bytes are accepted only
 * from the formats that embedded them.
 */
function validManifestEntries(manifest: SnapshotManifest): boolean {
  const seen = new Set<string>();
  for (const entry of manifest.files as unknown[]) {
    if (!entry || typeof entry !== 'object') return false;
    const { path: relative, mode, size, sha256, blob, oid } = entry as Record<string, unknown>;
    if (
      typeof relative !== 'string' ||
      relative !== gitPath(relative) ||
      isUnsafeGitPath(relative) ||
      relative.split('/').some((segment) => segment === '.') ||
      isRuntimePath(relative) ||
      looksLikeCredential(relative) ||
      seen.has(relative) ||
      (mode !== '100644' && mode !== '100755') ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      (blob !== undefined && (manifest.format >= 3 || typeof blob !== 'string')) ||
      // A format-4 entry names its blob, and only a format-4 entry may.
      (manifest.format >= 4
        ? typeof oid !== 'string' || !/^[0-9a-f]{40,64}$/.test(oid)
        : oid !== undefined)
    )
      return false;
    seen.add(relative);
  }
  return true;
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
      // Formats 1 and 2 embedded the bytes, format 3 stored them beside the manifest, format 4 names Git blobs.
      ![1, 2, 3, SNAPSHOT_FORMAT].includes(parsed?.format ?? 0) ||
      !Array.isArray(parsed.files) ||
      typeof parsed.baseCommit !== 'string' ||
      typeof parsed.baseTree !== 'string' ||
      !validManifestEntries(parsed)
    )
      return null;
    /**
     * A format-3 snapshot is named by its manifest's digest, so a manifest edited on disk no longer answers to the
     * id it is stored under and is treated as absent. Older formats used other naming schemes and rely on the entry
     * checks alone.
     */
    if (parsed.format >= 3 && manifestDigest(parsed) !== snapshotId) return null;
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
 * Stored files whose digest has been checked, with the stat that was true at the time.
 *
 * Every child of a delegation is filled from the same snapshot, so without this each one re-reads and re-hashes
 * every stored file. A file is trusted again only while its size, times and inode are what they were when it was
 * hashed; a rewrite or replacement changes at least one of them and sends it back through the full check.
 */
const verifiedFiles = new Map<string, { key: StatKey; sha256: string }>();
const VERIFIED_FILE_LIMIT = 200_000;

/**
 * The stored file behind a format-3 entry, checked against the entry's digest; `null` for a format-2 entry.
 *
 * Returning a path rather than bytes lets the caller copy it with the filesystem's own copy (a clone where the
 * volume supports it) instead of holding the file in memory between a read and a write.
 */
export async function verifiedSnapshotFile(
  repositoryRoot: string,
  snapshotId: string,
  entry: SnapshotManifestEntry,
): Promise<string | null> {
  // Embedded (format 2) or a Git blob (format 4): there is no stored file to copy.
  if (entry.blob !== undefined || entry.oid !== undefined) return null;
  const files = path.join(snapshotMetadataRoot(repositoryRoot, snapshotId), 'files');
  for (const file of [path.join(files, blobName(entry.sha256)), path.join(files, entry.sha256)]) {
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const key = statKey(info);
    const known = verifiedFiles.get(file);
    if (known && known.sha256 === entry.sha256 && sameStatKey(known.key, key)) return file;
    await snapshotFileBytes(repositoryRoot, snapshotId, entry);
    if (verifiedFiles.size >= VERIFIED_FILE_LIMIT) verifiedFiles.clear();
    verifiedFiles.set(file, { key, sha256: entry.sha256 });
    return file;
  }
  // Neither name exists: the full read reports it the same way it always has.
  await snapshotFileBytes(repositoryRoot, snapshotId, entry);
  return null;
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
  /** One reader for a whole fill, so a format-4 snapshot is not one `cat-file` process per file. */
  reader?: BlobReader,
): Promise<Buffer> {
  if (entry.blob !== undefined) return Buffer.from(entry.blob, 'base64');
  if (entry.oid !== undefined) {
    const bytes = reader ? await reader.read(entry.oid) : await readBlob(repositoryRoot, entry.oid);
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
