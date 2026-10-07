import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  chmod,
  open,
  readdir,
  stat,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { reconcilePendingFileChanges, undoFileChange } from '../packages/tools/file-undo.ts';
import { writeAll, atomicWriteFile } from '../packages/tools/write-all.ts';
import { Workspace } from '../packages/tools/files.ts';
import type { FileChange, FileSnapshot, ToolContext } from '../packages/protocol/index.ts';

// ---- merged from file-review.test.ts ----

test('file approvals show actual unified diff and successful results retain it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.ts'), 'const n = 1;\n');
  const tools = createTools(root);
  // The gate wants the file read in this run before it can be edited; this test is about the diff a person is
  // shown, which only exists after that.
  await tools.execute(
    { id: 'read', name: 'read_file', arguments: { path: 'a.ts' } },
    { signal: new AbortController().signal, approve: async () => true },
  );
  const result = await tools.execute(
    { id: 'edit', name: 'edit_file', arguments: { path: 'a.ts', old_text: '1', new_text: '2' } },
    {
      signal: new AbortController().signal,
      approve: async (approval) => {
        assert.match(approval.change!.patch, /-const n = 1;/);
        assert.match(approval.change!.patch, /\+const n = 2;/);
        assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'const n = 1;\n');
        return true;
      },
    },
  );
  assert.equal(result.isError, false);
  assert.equal(result.change!.path, 'a.ts');
  const store = new SessionStore(path.join(root, 'test.sqlite'));
  const session = store.create(root);
  store.append(session.id, { role: 'tool', toolCallId: 'edit', ...result });
  assert.deepEqual(store.messages(session.id)[0], { role: 'tool', toolCallId: 'edit', ...result });
  store.close();
});

test('file modified while approval is pending is not overwritten', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'old');
  const tools = createTools(root);
  await tools.execute(
    { id: 'read', name: 'read_file', arguments: { path: 'a.txt' } },
    { signal: new AbortController().signal, approve: async () => true },
  );
  const result = await tools.execute(
    {
      id: 'edit',
      name: 'edit_file',
      arguments: { path: 'a.txt', old_text: 'old', new_text: 'new' },
    },
    {
      signal: new AbortController().signal,
      approve: async () => {
        await writeFile(path.join(root, 'a.txt'), 'old + user changes');
        return true;
      },
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /changed.*approval/i);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'old + user changes');
  assert.equal(result.change, undefined);
});

test('denied new-file preview has no side effects', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let previewSeen = false;
  const result = await createTools(root).execute(
    { id: 'create', name: 'write_file', arguments: { path: 'new.txt', content: 'hello\n' } },
    {
      signal: new AbortController().signal,
      approve: async (approval) => {
        assert.equal(approval.change!.kind, 'create');
        assert.match(approval.change!.patch, /\+hello/);
        previewSeen = true;
        return false;
      },
    },
  );
  assert.equal(result.isError, true);
  assert.equal(previewSeen, true);
  assert.equal(result.change, undefined);
  await assert.rejects(readFile(path.join(root, 'new.txt')), { code: 'ENOENT' });
});

test('diff counts content beginning with plus signs and marks oversized previews', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await createTools(root).execute(
    {
      id: 'new',
      name: 'write_file',
      arguments: { path: 'big.txt', content: '++content\n' + 'x'.repeat(40000) + '\n' },
    },
    { signal: new AbortController().signal, approve: async () => true },
  );
  assert.equal(result.isError, false);
  assert.equal(result.change!.added, 2);
  assert.equal(result.change!.truncated, true);
  assert.ok(result.change!.patch.length <= 32000);
});

// ---- merged from file-undo.test.ts ----

async function setup(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-undo-'));
  let store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  const session = store.create(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    session,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    },
    async edit(name: string, args: Record<string, unknown>, allow = true) {
      const tools = createTools(root);
      const context = {
        signal: new AbortController().signal,
        approve: async () => allow,
        fileJournal: {
          prepare: (change: FileChange, before: Buffer, after: Buffer) =>
            store.prepareFileChange(session.id, change, before, after),
          prepareGroup: (change: FileChange, files: FileSnapshot[]) =>
            store.prepareFileChangeGroup(session.id, change, files),
          applied: (id: string) => store.markFileChange(id, 'applied'),
        },
      };
      // Read first, exactly as a model must: the read-before-write gate refuses a change computed from a file this
      // run never read. These tests are about what happens *after* a change is prepared — snapshots, undo,
      // conflict detection — so the read is the one step of the real flow they were missing.
      const targets =
        name === 'batch_edit'
          ? (args.edits as { path: string }[]).map((edit) => edit.path)
          : ['edit_file', 'apply_patch'].includes(name)
            ? [String(args.path)]
            : [];
      for (const target of targets) {
        const read = await tools.execute(
          { id: 'read', name: 'read_file', arguments: { path: target } },
          context,
        );
        assert.equal(read.isError, false, `reading ${target}: ${read.content}`);
      }
      return tools.execute({ id: 'call', name, arguments: args }, context);
    },
  };
}
test('file snapshots survive restart and undo edits only once with visible history', async (t) => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.root, 'a.txt'), 'original');
  const result = await ctx.edit('edit_file', {
    path: 'a.txt',
    old_text: 'original',
    new_text: 'updated',
  });
  assert.equal(result.isError, false);
  assert.ok(result.change?.id);
  ctx.reopen();
  assert.equal(ctx.store.fileChanges(ctx.session.id)[0]?.status, 'applied');
  await undoFileChange(ctx.store, ctx.session.id, result.change!.id!, ctx.root);
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'original');
  assert.equal(ctx.store.fileChanges(ctx.session.id)[0]?.status, 'undone');
  assert.match(JSON.stringify(ctx.store.messages(ctx.session.id)), /restored/i);
  await assert.rejects(
    undoFileChange(ctx.store, ctx.session.id, result.change!.id!, ctx.root),
    /already|undone/i,
  );
});
test('undo refuses manual modifications and allows reverse-order recovery', async (t) => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.root, 'a.txt'), 'one');
  const first = await ctx.edit('edit_file', { path: 'a.txt', old_text: 'one', new_text: 'two' });
  const second = await ctx.edit('edit_file', { path: 'a.txt', old_text: 'two', new_text: 'three' });
  await assert.rejects(
    undoFileChange(ctx.store, ctx.session.id, first.change!.id!, ctx.root),
    /changed|conflict/i,
  );
  await writeFile(path.join(ctx.root, 'a.txt'), 'manual');
  await assert.rejects(
    undoFileChange(ctx.store, ctx.session.id, second.change!.id!, ctx.root),
    /changed|conflict/i,
  );
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'manual');
  await writeFile(path.join(ctx.root, 'a.txt'), 'three');
  await undoFileChange(ctx.store, ctx.session.id, second.change!.id!, ctx.root);
  await undoFileChange(ctx.store, ctx.session.id, first.change!.id!, ctx.root);
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'one');
});
test('undo deletes an unchanged created file and denies active runs or foreign sessions', async (t) => {
  const ctx = await setup(t);
  const denied = await ctx.edit('write_file', { path: 'denied.txt', content: 'no' }, false);
  assert.equal(denied.isError, true);
  assert.equal(ctx.store.fileChanges(ctx.session.id).length, 0);
  const created = await ctx.edit('write_file', { path: 'new.txt', content: 'hello' });
  const other = ctx.store.create(ctx.root);
  await assert.rejects(
    undoFileChange(ctx.store, other.id, created.change!.id!, ctx.root),
    /not found|session/i,
  );
  const runId = ctx.store.beginRun(ctx.session.id);
  await assert.rejects(
    undoFileChange(ctx.store, ctx.session.id, created.change!.id!, ctx.root),
    /running/i,
  );
  ctx.store.finishRun({
    runId,
    sessionId: ctx.session.id,
    status: 'completed',
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  await undoFileChange(ctx.store, ctx.session.id, created.change!.id!, ctx.root);
  await assert.rejects(readFile(path.join(ctx.root, 'new.txt')), { code: 'ENOENT' });
});
test('pending snapshots reconcile without replaying file effects', async (t) => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.root, 'a.txt'), 'before');
  const id = ctx.store.prepareFileChange(
    ctx.session.id,
    { path: 'a.txt', kind: 'edit', patch: '', added: 1, removed: 1, truncated: false },
    Buffer.from('before'),
    Buffer.from('after'),
  );
  ctx.reopen();
  await reconcilePendingFileChanges(ctx.store, ctx.session.id, ctx.root);
  assert.equal(ctx.store.fileChanges(ctx.session.id)[0]?.status, 'abandoned');
  await assert.rejects(undoFileChange(ctx.store, ctx.session.id, id, ctx.root), /abandoned/i);
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'before');
});

test('pending snapshots reconcile applied and conflicting crash outcomes', async (t) => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.root, 'a.txt'), 'after');
  const applied = ctx.store.prepareFileChange(
    ctx.session.id,
    { path: 'a.txt', kind: 'edit', patch: '', added: 1, removed: 1, truncated: false },
    Buffer.from('before'),
    Buffer.from('after'),
  );
  await writeFile(path.join(ctx.root, 'b.txt'), 'manual');
  const conflict = ctx.store.prepareFileChange(
    ctx.session.id,
    { path: 'b.txt', kind: 'edit', patch: '', added: 1, removed: 1, truncated: false },
    Buffer.from('before'),
    Buffer.from('after'),
  );
  await reconcilePendingFileChanges(ctx.store, ctx.session.id, ctx.root);
  const changes = new Map(
    ctx.store.fileChanges(ctx.session.id).map((change) => [change.id, change]),
  );
  assert.equal(changes.get(applied)?.status, 'applied');
  assert.equal(changes.get(conflict)?.status, 'conflict');
  await assert.rejects(undoFileChange(ctx.store, ctx.session.id, conflict, ctx.root), /conflict/i);
});

test('grouped move and batch snapshots survive restart and undo in reverse', async (t) => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.root, 'a.txt'), 'one');
  await writeFile(path.join(ctx.root, 'b.txt'), 'red');
  const batch = await ctx.edit('batch_edit', {
    edits: [
      { path: 'a.txt', old_text: 'one', new_text: 'two' },
      { path: 'b.txt', old_text: 'red', new_text: 'blue' },
    ],
  });
  assert.equal(batch.change?.changes?.length, 2);
  ctx.reopen();
  assert.equal(ctx.store.fileChangeSnapshots(ctx.session.id, batch.change!.id!).length, 2);
  await undoFileChange(ctx.store, ctx.session.id, batch.change!.id!, ctx.root);
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'one');
  assert.equal(await readFile(path.join(ctx.root, 'b.txt'), 'utf8'), 'red');

  const moved = await ctx.edit('move_file', { from: 'a.txt', to: 'moved.txt' });
  ctx.reopen();
  await undoFileChange(ctx.store, ctx.session.id, moved.change!.id!, ctx.root);
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'one');
  await assert.rejects(readFile(path.join(ctx.root, 'moved.txt')), { code: 'ENOENT' });
});

test('an interrupted grouped undo resumes after restart from exact before/after states', async (t) => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.root, 'a.txt'), 'one');
  await writeFile(path.join(ctx.root, 'b.txt'), 'red');
  const batch = await ctx.edit('batch_edit', {
    edits: [
      { path: 'a.txt', old_text: 'one', new_text: 'two' },
      { path: 'b.txt', old_text: 'red', new_text: 'blue' },
    ],
  });
  ctx.store.markFileChange(batch.change!.id!, 'undoing');
  await writeFile(path.join(ctx.root, 'b.txt'), 'red');
  ctx.reopen();
  await undoFileChange(ctx.store, ctx.session.id, batch.change!.id!, ctx.root);
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'one');
  assert.equal(await readFile(path.join(ctx.root, 'b.txt'), 'utf8'), 'red');
  assert.equal(ctx.store.fileChanges(ctx.session.id)[0]?.status, 'undone');
});
test('grouped undo preflights every path and makes no changes on conflict', async (t) => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.root, 'a.txt'), 'one');
  await writeFile(path.join(ctx.root, 'b.txt'), 'red');
  const batch = await ctx.edit('batch_edit', {
    edits: [
      { path: 'a.txt', old_text: 'one', new_text: 'two' },
      { path: 'b.txt', old_text: 'red', new_text: 'blue' },
    ],
  });
  await writeFile(path.join(ctx.root, 'a.txt'), 'manual');
  await assert.rejects(
    undoFileChange(ctx.store, ctx.session.id, batch.change!.id!, ctx.root),
    /conflict|changed/i,
  );
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'manual');
  assert.equal(await readFile(path.join(ctx.root, 'b.txt'), 'utf8'), 'blue');
  assert.equal(ctx.store.fileChanges(ctx.session.id)[0]?.status, 'applied');
});

test('parallel undo requests cannot restore the same change twice', async (t) => {
  const ctx = await setup(t);
  await writeFile(path.join(ctx.root, 'a.txt'), 'before');
  const edited = await ctx.edit('edit_file', {
    path: 'a.txt',
    old_text: 'before',
    new_text: 'after',
  });
  const attempts = await Promise.allSettled([
    undoFileChange(ctx.store, ctx.session.id, edited.change!.id!, ctx.root),
    undoFileChange(ctx.store, ctx.session.id, edited.change!.id!, ctx.root),
  ]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await readFile(path.join(ctx.root, 'a.txt'), 'utf8'), 'before');
  assert.equal(ctx.store.messages(ctx.session.id).length, 1);
});

// ---- merged from write-all.test.ts ----

test('short filesystem writes still persist every byte at the correct position', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-short-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'file.txt'),
    handle = await open(file, 'w+');
  try {
    // Simulate the OS returning fewer bytes while performing actual file writes.
    const partialWriter = {
      write: (buffer: Buffer, offset: number, length: number, position: number) =>
        handle.write(buffer, offset, Math.min(length, 3), position),
    };
    await writeAll(partialWriter, Buffer.from('Hello 世界!'));
  } finally {
    await handle.close();
  }
  assert.equal(await readFile(file, 'utf8'), 'Hello 世界!');
});
test('zero-progress write fails instead of looping or reporting success', async () => {
  await assert.rejects(
    writeAll({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from('x')),
    /progress|write/i,
  );
});
test('atomicWriteFile replaces existing content and preserves permission bits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'target.txt');
  await writeFile(file, 'before');
  await chmod(file, 0o600);
  await atomicWriteFile(file, Buffer.from('after-content'));
  assert.equal(await readFile(file, 'utf8'), 'after-content');
  // Windows only models the read-only bit, so permission-bit preservation is POSIX-only.
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});
test('atomicWriteFile creates a missing target without leaving temporary files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-atomic-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'fresh.txt');
  await atomicWriteFile(file, Buffer.from('new'));
  assert.equal(await readFile(file, 'utf8'), 'new');
  const entries = await readdir(root);
  assert.deepEqual(entries, ['fresh.txt']);
});

// ---- merged from workspace-scale.test.ts ----

test('workspace walk stays bounded and skips credentials across a synthetic 600-file tree', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-workspace-scale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let directory = 0; directory < 12; directory++) {
    const folder = path.join(root, 'module-' + String(directory).padStart(2, '0'));
    await mkdir(folder);
    for (let file = 0; file < 50; file++) {
      await writeFile(
        path.join(folder, 'file-' + String(file).padStart(2, '0') + '.ts'),
        'export const value = 1;\n',
      );
    }
  }
  await writeFile(path.join(root, '.env'), 'API_KEY=do-not-index\n');
  const workspace = new Workspace(root);
  const context = { signal: new AbortController().signal } as ToolContext;
  const files = await workspace.walk('.', context);
  assert.equal(files.length, 600);
  assert.equal(files[0], 'module-00/file-00.ts');
  assert.ok(files.includes('module-11/file-49.ts'));
  assert.ok(files.every((file) => !file.includes('.env')));
});
