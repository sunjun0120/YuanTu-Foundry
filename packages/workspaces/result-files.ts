/** Result records on disk: manifests, digests, per-target leases and the file bytes a result moves. */
import path from 'node:path';
import { atomicWriteFile } from '../platform/write-all.ts';
import type { FileChange, FileSnapshot } from '../protocol/index.ts';
import { WorkspaceFailure, type WorkspaceResultFile } from '../protocol/workspaces.ts';
import { readBlob } from './git.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/**
 * One import per target directory, at a time.
 *
 * A promise chain rather than a lock file, because the writer is a single process and what is being serialised is a
 * critical section: a second import waits rather than interleaving, and two *different* targets never wait for each
 * other. The key is the target binding, so the queue is exactly as wide as the number of directories a host imports
 * into.
 */
export interface WorkspaceResultManifest {
  version: number;
  resultId: string;
  parentSessionId: string;
  childSessionId: string;
  bindingId: string;
  repositoryRoot: string;
  comparisonTree: string;
  resultTree: string;
  createdAt: string;
  files: WorkspaceResultFile[];
  /**
   * What the child's own tools actually did, as durable evidence.
   *
   * Read from the child session's `tool.execution.finished` records, never from the child's prose: a model that
   * says "tests pass" has said nothing this record can support, and the plan is explicit that a self-reported
   * verification must not be able to turn into a verified one.
   */
  evidence: { tool: string; at: string }[];
}

const targetLeases = new Map<string, Promise<unknown>>();

export async function withTargetLease<T>(bindingId: string, body: () => Promise<T>): Promise<T> {
  const previous = targetLeases.get(bindingId) ?? Promise.resolve();
  const run = previous.then(body, body);
  /**
   * The *tail* is what a later caller queues behind, and it is settled to a value rather than chained on the body's
   * outcome: a failed import must not poison the queue for the next one, and a rejected promise left in the map
   * would make every later caller reject for a reason that has nothing to do with its own request.
   */
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  targetLeases.set(bindingId, tail);
  try {
    return await run;
  } finally {
    if (targetLeases.get(bindingId) === tail) targetLeases.delete(bindingId);
  }
}

/** Added and removed line counts for one path, from the frozen bytes rather than from the directory. */
export async function countDiff(
  snapshot: FileSnapshot,
): Promise<{ added: number; removed: number }> {
  const { structuredPatch } = await import('diff');
  const before = snapshot.before ? Buffer.from(snapshot.before).toString('utf8') : '';
  const after = snapshot.after ? Buffer.from(snapshot.after).toString('utf8') : '';
  const structured = structuredPatch('/dev/null', snapshot.path, before, after, '', '', {
    context: 0,
    timeout: 150,
    maxEditLength: 10_000,
  });
  const lines = structured?.hunks.flatMap((hunk) => hunk.lines) ?? [];
  return {
    added: lines.filter((line) => line.startsWith('+')).length,
    removed: lines.filter((line) => line.startsWith('-')).length,
  };
}

/**
 * Whether bytes are text this version will move.
 *
 * A UTF-8 check rather than a byte heuristic: the plan's promise is "plain UTF-8 text", and a file that is not
 * valid UTF-8 is one whose bytes this feature cannot round-trip through the JSON record that carries the review.
 * Refusing it is the honest answer; guessing an encoding would put bytes in a parent's tree that its own editor
 * would then rewrite.
 */
export function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The ref that keeps one result's tree alive against a later `gc`. */
export function resultRef(resultId: string): string {
  return `refs/yuantu/results/${resultId}`;
}

/** Where a result's manifest is kept: beside the repository's other service state, not in the worktree. */
export function resultMetadataPath(repositoryRoot: string, resultId: string): string {
  return path.join(repositoryRoot, '.yuantu', 'workspace-results', `${resultId}.json`);
}

/**
 * The digest a parent quotes when it applies a result.
 *
 * Over the files and their blobs rather than over the manifest text, because the manifest carries a timestamp and a
 * record id: a digest that covered those would change every time the same change was described, which is precisely
 * what the caller's `expectedDigest` is meant to pin down.
 */
export function digestOf(manifest: WorkspaceResultManifest): string {
  const hash = createHash('sha256');
  hash.update(`v${manifest.version}\u0000`);
  hash.update(`${manifest.comparisonTree}\u0000${manifest.resultTree}\u0000`);
  for (const file of manifest.files)
    hash.update(
      `${file.path}\u0000${file.kind}\u0000${file.beforeBlob ?? '-'}\u0000${file.afterBlob ?? '-'}\u0000`,
    );
  return hash.digest('hex');
}

export async function writeResultManifest(
  repositoryRoot: string,
  resultId: string,
  manifest: WorkspaceResultManifest,
): Promise<void> {
  const target = resultMetadataPath(repositoryRoot, resultId);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(staging, target);
}

export async function readResultManifest(
  repositoryRoot: string,
  resultId: string,
): Promise<WorkspaceResultManifest | null> {
  if (!repositoryRoot) return null;
  const bytes = await readFile(resultMetadataPath(repositoryRoot, resultId)).catch(() => null);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as WorkspaceResultManifest;
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The grouped journal entry one import writes, built from the result rather than from the live directory.
 *
 * Its `patch` is a summary of the *result*, not a recomputed diff: the parent is shown what it approved, and a
 * patch recomputed from whatever the directory now holds would describe something nobody agreed to.
 */
export function changeForResult(input: {
  resultId: string;
  manifest: WorkspaceResultManifest;
  diffs: { path: string; added: number; removed: number }[];
}): FileChange {
  const { resultId, manifest, diffs } = input;
  return {
    path: `${manifest.files.length} path${manifest.files.length === 1 ? '' : 's'} from sub-agent workspace`,
    kind: 'batch',
    patch: diffs.map((diff) => `${diff.path}: +${diff.added} -${diff.removed}`).join('\n'),
    added: diffs.reduce((total, diff) => total + diff.added, 0),
    removed: diffs.reduce((total, diff) => total + diff.removed, 0),
    truncated: false,
    changes: manifest.files.map((file) => ({
      path: file.path,
      kind: file.kind === 'create' ? 'create' : file.kind === 'delete' ? 'delete' : 'edit',
      patch: '',
      added: diffs.find((diff) => diff.path === file.path)?.added ?? 0,
      removed: diffs.find((diff) => diff.path === file.path)?.removed ?? 0,
      truncated: false,
    })),
    subagent: {
      id: resultId,
      role: 'general',
      objective: `Apply sub-agent result ${resultId}`,
    },
  };
}

/** The snapshots an import writes into the grouped journal, from the frozen blobs rather than from disk. */
export async function snapshotsForResult(
  repositoryRoot: string,
  manifest: WorkspaceResultManifest,
  signal?: AbortSignal,
): Promise<FileSnapshot[]> {
  const files: FileSnapshot[] = [];
  for (const file of manifest.files) {
    files.push({
      path: file.path,
      before: file.beforeBlob ? await readBlob(repositoryRoot, file.beforeBlob, signal) : null,
      after: file.afterBlob ? await readBlob(repositoryRoot, file.afterBlob, signal) : null,
    });
  }
  return files;
}

/**
 * Writes the result's bytes into a target directory, one path at a time.
 *
 * Not a transaction, and the interface says so: a filesystem has no multi-file atomic write, so what this promises
 * instead is that every interruption is *recognisable*. The journal entry is written before the first byte, and
 * every path ends in either its exact before state or its exact after state — never in a third one — which is what
 * lets `reconcilePendingFileChanges` classify a half-finished import instead of guessing.
 */
export async function writeResultFiles(input: {
  manifest: WorkspaceResultManifest;
  targetRoot: string;
  signal: AbortSignal;
}): Promise<void> {
  const { manifest, targetRoot, signal } = input;
  for (const file of manifest.files) {
    signal.throwIfAborted();
    const absolute = path.join(targetRoot, ...file.path.split('/'));
    if (file.afterBlob === null) {
      // A deletion: the file is unlinked, and a file that is already gone is the state the result describes.
      const { unlink } = await import('node:fs/promises');
      await unlink(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      continue;
    }
    const bytes = await readBlob(manifest.repositoryRoot, file.afterBlob, signal);
    if (bytes === null)
      throw new WorkspaceFailure(
        'WORKSPACE_MISSING',
        `The frozen bytes for ${file.path} are gone from the repository`,
        { path: file.path },
      );
    await mkdir(path.dirname(absolute), { recursive: true });
    await atomicWriteFile(absolute, bytes);
  }
}
