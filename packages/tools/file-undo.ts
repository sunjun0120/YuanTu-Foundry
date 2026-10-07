import { open, unlink, realpath } from 'node:fs/promises';
import type { FileSnapshot } from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { Workspace } from './files.ts';
import { writeAll, atomicWriteFile } from './write-all.ts';

async function current(workspace: Workspace, snapshot: FileSnapshot): Promise<Buffer | null> {
  let file: string;
  try {
    file = await workspace.resolve(snapshot.path, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Expected a regular file');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function matches(value: Buffer | null, expected: Uint8Array | null): boolean {
  return value === null ? expected === null : expected !== null && value.equals(expected);
}

export async function reconcilePendingFileChanges(
  store: SessionStore,
  sessionId: string,
  root: string,
): Promise<void> {
  const session = store.get(sessionId);
  if ((await realpath(session.workspace)) !== (await realpath(root)))
    throw new Error('Session belongs to another workspace');
  const workspace = new Workspace(root);
  for (const item of store.fileChanges(sessionId).filter((change) => change.status === 'pending')) {
    const snapshots = store.fileChangeSnapshots(sessionId, item.id);
    const values = await Promise.all(snapshots.map((snapshot) => current(workspace, snapshot)));
    const before = snapshots.every((snapshot, index) => matches(values[index]!, snapshot.before));
    const after = snapshots.every((snapshot, index) => matches(values[index]!, snapshot.after));
    store.markFileChange(item.id, after ? 'applied' : before ? 'abandoned' : 'conflict');
  }
}

async function restore(workspace: Workspace, snapshot: FileSnapshot): Promise<void> {
  const value = await current(workspace, snapshot);
  if (matches(value, snapshot.before)) return;
  if (!matches(value, snapshot.after))
    throw new Error(
      `File changed after this operation: ${snapshot.path}; undo conflict. Restore later edits first.`,
    );
  const file = await workspace.resolve(
    snapshot.path,
    snapshot.before === null || snapshot.after === null,
  );
  if (snapshot.before === null) {
    await unlink(file);
    return;
  }
  const before = Buffer.from(snapshot.before);
  if (snapshot.after === null) {
    // Restore a previously deleted file by creating it exclusively.
    const handle = await open(file, 'wx');
    try {
      await writeAll(handle, before);
      await handle.truncate(before.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  // Restore an overwritten file atomically so an interrupted undo remains resumable.
  await atomicWriteFile(file, before);
}

// Restores grouped effects in reverse order. An interrupted undo remains resumable because
// each path may be either in its exact before or exact after state, never an arbitrary state.
export async function undoFileChange(
  store: SessionStore,
  sessionId: string,
  id: string,
  root: string,
): Promise<void> {
  const session = store.get(sessionId);
  if ((await realpath(session.workspace)) !== (await realpath(root)))
    throw new Error('Session belongs to another workspace');
  const item = store.fileChanges(sessionId).find((candidate) => candidate.id === id);
  if (!item) throw new Error('File change not found in session');
  if (item.status === 'undone') throw new Error('File change was already undone');
  if (item.status === 'pending') {
    await reconcilePendingFileChanges(store, sessionId, root);
    const reconciled = store.fileChanges(sessionId).find((candidate) => candidate.id === id);
    if (reconciled?.status === 'applied') return undoFileChange(store, sessionId, id, root);
    throw new Error(
      reconciled?.status === 'abandoned'
        ? 'Cannot undo an abandoned change because no file effect was applied'
        : 'Cannot undo change; its recovered file state conflicts with the journal',
    );
  }
  if (item.status === 'abandoned') throw new Error('Cannot undo an abandoned change');
  if (item.status === 'conflict') throw new Error('Cannot undo a conflicting recovered change');
  const snapshots = store.fileChangeSnapshots(sessionId, id);
  const workspace = new Workspace(root);
  const values = await Promise.all(snapshots.map((snapshot) => current(workspace, snapshot)));
  if (item.status === 'applied') {
    for (let index = 0; index < snapshots.length; index++)
      if (!matches(values[index]!, snapshots[index]!.after))
        throw new Error(
          `File changed after this operation: ${snapshots[index]!.path}; undo conflict. Restore later edits first.`,
        );
  } else {
    for (let index = 0; index < snapshots.length; index++)
      if (
        !matches(values[index]!, snapshots[index]!.before) &&
        !matches(values[index]!, snapshots[index]!.after)
      )
        throw new Error(`Interrupted undo conflicts with current file: ${snapshots[index]!.path}`);
  }
  const runId = store.beginRun(sessionId);
  let done = false;
  try {
    const latest = store.fileChanges(sessionId).find((candidate) => candidate.id === id)?.status;
    if (latest !== 'applied' && latest !== 'undoing')
      throw new Error('File change was already undone');
    store.markFileChange(id, 'undoing');
    for (const snapshot of [...snapshots].reverse()) await restore(workspace, snapshot);
    store.completeFileUndo(
      sessionId,
      id,
      `[Files restored by user] ${item.change.path}: restored ${snapshots.length} path${snapshots.length === 1 ? '' : 's'} to the exact bytes from before this operation. Read current files before further edits.`,
    );
    done = true;
  } finally {
    store.finishRun({
      sessionId,
      runId,
      status: done ? 'completed' : 'failed',
      text: done ? 'Files restored' : 'File restoration did not complete',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }
}
