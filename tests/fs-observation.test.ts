/**
 * The read-before-write gate.
 *
 * The gap this closes is not "a tool did something wrong" — `edit_file` already refuses a mismatch and the journal
 * rechecks bytes after approval. It is that a change could be *attempted at all* on a file this run never looked
 * at, and that a person could be asked to approve it. So the assertions below are about the refusal happening
 * **before the approval prompt** and about what the model is told, plus the two ways a real observation stops being
 * one: the file changed on disk, and the run ended.
 *
 * What is deliberately *not* gated is asserted too — creating a file, deleting one, renaming one, and a
 * language-server edit — because "read before write" that turned into "read before everything" would be a tax on
 * work that carries no such claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { fileTools, Workspace } from '../packages/tools/files.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import {
  FS_NOT_OBSERVED,
  FileObservations,
  fileObservationEnabled,
} from '../packages/tools/fs-observation.ts';
import type { ToolCall, ToolContext } from '../packages/protocol/index.ts';

const approve = async () => true;

async function workspaceFixture(
  t: test.TestContext,
): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-observe-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'notes.txt'), 'alpha\nbeta\n');
  return { root, context: { signal: new AbortController().signal, approve } };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

test('a blind edit is refused before anyone is asked to approve it', async (t) => {
  const { root } = await workspaceFixture(t);
  let approvals = 0;
  const tools = createTools(root);
  const result = await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' }),
    {
      signal: new AbortController().signal,
      approve: async () => {
        approvals += 1;
        return true;
      },
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, new RegExp(`^${FS_NOT_OBSERVED}:`));
  assert.match(result.content, /notes\.txt has not been read in this run/);
  // The point of the gate: the human is not shown a diff for a change the model never verified. An unread file
  // means the approval prompt never happens at all.
  assert.equal(approvals, 0);
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'alpha\nbeta\n');
});

test('reading first lets the same edit through', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  const read = await tools.execute(call('read_file', { path: 'notes.txt' }), context);
  assert.equal(read.isError, false);
  const edited = await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' }),
    context,
  );
  assert.equal(edited.isError, false);
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'alpha\ngamma\n');
});

test('a file that changed on disk since it was read is refused, and a re-read fixes it', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  await tools.execute(call('read_file', { path: 'notes.txt' }), context);
  // Someone else — a command, a checkout, another editor — changed the file after the model looked at it.
  await writeFile(path.join(root, 'notes.txt'), 'alpha\nbeta\ndelta\n');
  const stale = await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' }),
    context,
  );
  assert.equal(stale.isError, true);
  assert.match(stale.content, new RegExp(`^${FS_NOT_OBSERVED}:`));
  assert.match(stale.content, /changed on disk since it was read/);
  await tools.execute(call('read_file', { path: 'notes.txt' }), context);
  const fresh = await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'delta', new_text: 'epsilon' }),
    context,
  );
  assert.equal(fresh.isError, false);
});

test('staleness is not inferred from size alone', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  await tools.execute(call('read_file', { path: 'notes.txt' }), context);
  const target = path.join(root, 'notes.txt');
  // Same length, different content, and an explicitly different timestamp: a size-only check would call this
  // unchanged and let the edit through against bytes the model never saw.
  await writeFile(target, 'alpha\nBETA\n');
  await utimes(target, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
  const result = await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'BETA', new_text: 'gamma' }),
    context,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /changed on disk since it was read/);
});

test('this run\u2019s own change counts as having seen the result', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  await tools.execute(call('read_file', { path: 'notes.txt' }), context);
  await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' }),
    context,
  );
  // No second read: the model wrote these bytes, so it knows what is there now.
  const again = await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'gamma', new_text: 'delta' }),
    context,
  );
  assert.equal(again.isError, false);
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'alpha\ndelta\n');
});

test('a batch that touches one unread file is refused as a whole, naming it', async (t) => {
  const { root, context } = await workspaceFixture(t);
  await writeFile(path.join(root, 'other.txt'), 'one\ntwo\n');
  const tools = createTools(root);
  await tools.execute(call('read_file', { path: 'notes.txt' }), context);
  const result = await tools.execute(
    call('batch_edit', {
      edits: [
        { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' },
        { path: 'other.txt', old_text: 'two', new_text: 'three' },
      ],
    }),
    context,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /other\.txt has not been read in this run/);
  // The read file is untouched too: a batch is one change, not a list of changes to apply until one fails.
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'alpha\nbeta\n');
  assert.equal(await readFile(path.join(root, 'other.txt'), 'utf8'), 'one\ntwo\n');
});

test('creating, deleting and renaming are not behind the read gate', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  // A file that does not exist has no content to have read.
  const created = await tools.execute(
    call('write_file', { path: 'fresh.txt', content: 'new\n' }),
    context,
  );
  assert.equal(created.isError, false);
  // A delete and a rename name a path, not text; the approval prompt already shows exactly what moves or goes.
  const renamed = await tools.execute(
    call('move_file', { from: 'fresh.txt', to: 'moved.txt' }),
    context,
  );
  assert.equal(renamed.isError, false);
  const deleted = await tools.execute(call('delete_file', { path: 'moved.txt' }), context);
  assert.equal(deleted.isError, false);
});

test('a rename does not hand out an observation nobody earned', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  // Neither file was read, so the destination must not count as seen just because it now exists.
  await tools.execute(call('write_file', { path: 'fresh.txt', content: 'new\n' }), context);
  await tools.execute(call('move_file', { from: 'fresh.txt', to: 'moved.txt' }), context);
  const result = await tools.execute(
    call('edit_file', { path: 'moved.txt', old_text: 'new', new_text: 'other' }),
    context,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /moved\.txt has not been read in this run/);
});

test('a patch is gated like an edit', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  const patch = '@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n';
  const blind = await tools.execute(call('apply_patch', { path: 'notes.txt', patch }), context);
  assert.equal(blind.isError, true);
  assert.match(blind.content, new RegExp(`^${FS_NOT_OBSERVED}:`));
  await tools.execute(call('read_file', { path: 'notes.txt' }), context);
  const applied = await tools.execute(call('apply_patch', { path: 'notes.txt', patch }), context);
  assert.equal(applied.isError, false);
});

test('a new run does not inherit the last run\u2019s reads', async (t) => {
  const { root, context } = await workspaceFixture(t);
  // Two tool sets over one workspace is what two runs of one session look like: the transcript survives, the
  // record does not — a resumed run re-reads rather than trusting a memory nothing can check.
  const first = createTools(root);
  await first.execute(call('read_file', { path: 'notes.txt' }), context);
  const second = createTools(root);
  const result = await second.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' }),
    context,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, new RegExp(`^${FS_NOT_OBSERVED}:`));
});

test('a read that only covered a slice still counts', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  await tools.execute(
    call('read_file', { path: 'notes.txt', start_line: 2, end_line: 2 }),
    context,
  );
  const edited = await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' }),
    context,
  );
  assert.equal(edited.isError, false);
});

test('a search hit is a pointer, not a read', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const tools = createTools(root);
  const found = await tools.execute(call('search_files', { query: 'beta' }), context);
  assert.match(found.content, /notes\.txt:2/);
  const result = await tools.execute(
    call('edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' }),
    context,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, new RegExp(`^${FS_NOT_OBSERVED}:`));
});

test('the gate can be turned off for a tool set, and by the environment', async (t) => {
  const { root, context } = await workspaceFixture(t);
  const blind = call('edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' });
  const registry = (tools: ReturnType<typeof fileTools>) => {
    const built = new ToolRegistry();
    for (const tool of tools) built.register(tool);
    return built;
  };
  // Both registries hold the same tools over one workspace; only the option differs, so the difference in
  // outcome is the option.
  const refused = await registry(fileTools(root)).execute(blind, context);
  assert.equal(refused.isError, true);
  assert.match(refused.content, new RegExp(`^${FS_NOT_OBSERVED}:`));
  const allowed = await registry(fileTools(root, { observe: false })).execute(blind, context);
  assert.equal(allowed.isError, false);
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'alpha\ngamma\n');

  assert.equal(fileObservationEnabled({}), true);
  assert.equal(fileObservationEnabled({ YUANTU_FS_OBSERVATION: '1' }), true);
  assert.equal(fileObservationEnabled({ YUANTU_FS_OBSERVATION: '0' }), false);
  assert.throws(
    () => fileObservationEnabled({ YUANTU_FS_OBSERVATION: 'maybe' }),
    /YUANTU_FS_OBSERVATION/,
  );
});

test('recording a read never fails the read it is recording', async (t) => {
  const { root } = await workspaceFixture(t);
  const observations = new FileObservations(new Workspace(root));
  // A file that is not there — read, then deleted, or named by a hopeful model — is not the recorder's problem:
  // the read either returned its content already or never happened, and this gate is about later changes.
  await observations.record('gone.txt');
  await observations.assertRead('gone.txt');
});

test('a language-server edit is not gated, because the model did not author those bytes', async (t) => {
  const { root, context } = await workspaceFixture(t);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'const a = 1;\n');
  // The LSP tools build their change through `prepareMutation` with no gate at all: a server computed these edits
  // against the live documents it is serving, which is a stronger observation than a read.
  const { prepareMutation } = await import('../packages/tools/file-mutation.ts');
  const { filePreview } = await import('../packages/tools/file-mutation.ts');
  const workspace = new Workspace(root);
  const before = Buffer.from('const a = 1;\n');
  const after = Buffer.from('const a = 2;\n');
  const mutation = prepareMutation(
    workspace,
    filePreview('src/a.ts', before.toString('utf8'), after.toString('utf8'), 'edit'),
    [{ path: 'src/a.ts', before, after }],
  );
  const applied = await mutation.execute(context);
  assert.equal(applied.isError, false);
  assert.equal(await readFile(path.join(root, 'src', 'a.ts'), 'utf8'), 'const a = 2;\n');
});
