import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBlobBatch, readBlob, writeBlobs, writeTree } from '../packages/workspaces/git.ts';

/**
 * The one-process blob writer behind freezes and result exports.
 *
 * Its answer is only useful if it is exactly what `git hash-object` would have said for the same bytes, in the order
 * the bytes were given, and if the objects are really in the store afterwards — so each case checks against Git.
 */

async function repository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-blob-batch-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const hashObject = (root: string, bytes: Buffer) =>
  execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: root, input: bytes })
    .toString('utf8')
    .trim();

test('ids match hash-object, in order, and the objects are stored', async (t) => {
  const root = await repository(t);
  const inputs = [
    Buffer.from('first\n'),
    Buffer.alloc(0),
    Buffer.from('first\n'),
    Buffer.from([0, 255, 10, 13, 0]),
    Buffer.from('line\r\nwith CRLF and é\n', 'utf8'),
  ];
  const ids = await writeBlobs(root, inputs);
  assert.deepEqual(
    ids,
    inputs.map((bytes) => hashObject(root, bytes)),
  );
  for (const [index, id] of ids.entries())
    assert.deepEqual(await readBlob(root, id), inputs[index]);
});

test('a batch large enough to be packed stores every blob', async (t) => {
  const root = await repository(t);
  // Above `fastimport.unpackLimit` (100), so Git keeps a pack instead of exploding it into loose objects.
  const inputs = Array.from({ length: 150 }, (_, index) => Buffer.from(`blob ${index}\n`));
  const ids = await writeBlobs(
    root,
    (async function* () {
      yield* inputs;
    })(),
  );
  assert.equal(new Set(ids).size, inputs.length);
  assert.deepEqual(await readBlob(root, ids[149]!), inputs[149]);
});

test('an empty batch answers no ids', async (t) => {
  assert.deepEqual(await writeBlobs(await repository(t), []), []);
});

test('a cancelled batch rejects instead of answering', async (t) => {
  const root = await repository(t);
  const controller = new AbortController();
  const batch = openBlobBatch(root, controller.signal);
  await batch.add(Buffer.from('kept?\n'));
  controller.abort(new Error('stop'));
  await assert.rejects(batch.finish(), /stop/);
});

test('a source that throws abandons the batch and rethrows', async (t) => {
  const root = await repository(t);
  await assert.rejects(
    writeBlobs(
      root,
      (async function* () {
        yield Buffer.from('one\n');
        throw new Error('walk failed');
      })(),
    ),
    /walk failed/,
  );
});

test('a tree takes any name Git allows, including newlines and a leading quote', async (t) => {
  const root = await repository(t);
  const [blob] = await writeBlobs(root, [Buffer.from('content\n')]);
  const names = [
    'normal.txt',
    'new\nline.txt',
    '"leading-quote.txt',
    'tab\there.txt',
    '中文 名称.txt',
  ];
  const tree = await writeTree(root, [
    ...names.map((name) => ({ path: name, mode: '100644' as const, blob: blob! })),
    { path: 'dir/"quoted"\nchild.txt', mode: '100644', blob: blob! },
  ]);
  const listed = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', tree], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  assert.deepEqual(listed, [...names, 'dir/"quoted"\nchild.txt'].sort());
});
