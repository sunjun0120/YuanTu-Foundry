/**
 * The fingerprint a completion contract's evidence is bound to.
 *
 * The verifier answers "did the checks pass". It cannot answer "is the code that passed still the code on disk",
 * and the file journal does not close that gap either — it records what the *file tools* wrote, not what a
 * command, a build or another process did. These tests pin the properties that make the fingerprint usable:
 * it moves when the monitored content moves, it does not move when the runtime writes its own state, and it
 * refuses rather than guesses when the range it was asked about is too large to describe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CompletionInputLimitError,
  COMPLETION_INPUT_EXCLUDED_SEGMENTS,
  snapshotCompletionInputs,
} from '../packages/core/completion-inputs.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';

const signal = new AbortController().signal;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-completion-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the digest follows the content, and absence is part of it', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'one');
  await writeFile(path.join(root, 'b.txt'), 'two');
  const first = await snapshotCompletionInputs(root, ['.'], signal);
  assert.equal(first.version, 1);
  assert.equal(first.files, 2);

  // The same tree read again is the same digest: nothing about the *reading* is in it, so two rounds that found
  // the same code agree.
  const again = await snapshotCompletionInputs(root, ['.'], signal);
  assert.equal(again.digest, first.digest);

  await writeFile(path.join(root, 'a.txt'), 'ONE');
  const changed = await snapshotCompletionInputs(root, ['.'], signal);
  assert.notEqual(changed.digest, first.digest);

  // A file that disappears changes the digest too. The alternative — skipping what is not there — would let the
  // checks' subject vanish without the evidence noticing.
  await rm(path.join(root, 'b.txt'));
  const removed = await snapshotCompletionInputs(root, ['.'], signal);
  assert.notEqual(removed.digest, changed.digest);
  assert.equal(removed.files, 1);

  await writeFile(path.join(root, 'c.txt'), 'new');
  const added = await snapshotCompletionInputs(root, ['.'], signal);
  assert.notEqual(added.digest, removed.digest);
});

test('the order inputs are listed in does not change the digest, and duplicates collapse', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.ts'), 'a');
  await writeFile(path.join(root, 'src/b.ts'), 'b');
  const forward = await snapshotCompletionInputs(root, ['src/a.ts', 'src/b.ts'], signal);
  const backward = await snapshotCompletionInputs(root, ['src/b.ts', 'src/a.ts'], signal);
  assert.equal(forward.digest, backward.digest);
  const duplicated = await snapshotCompletionInputs(
    root,
    ['src/b.ts', 'src/a.ts', 'src/a.ts'],
    signal,
  );
  assert.equal(duplicated.digest, forward.digest);
  assert.equal(duplicated.files, 2);
});

test('two workspaces with identical content are still two workspaces', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  for (const root of [first, second]) {
    await writeFile(path.join(root, 'same.txt'), 'identical');
  }
  const a = await snapshotCompletionInputs(first, ['.'], signal);
  const b = await snapshotCompletionInputs(second, ['.'], signal);
  assert.notEqual(a.rootId, b.rootId, 'the resolved root is part of the identity');
  assert.notEqual(
    a.digest,
    b.digest,
    'evidence taken in one root may not be presented as the other’s',
  );
});

test('derived directories are excluded by name, and the file count says what was covered', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'src.ts'), 'source');
  for (const segment of COMPLETION_INPUT_EXCLUDED_SEGMENTS) {
    await mkdir(path.join(root, segment), { recursive: true });
    await writeFile(path.join(root, segment, 'generated.txt'), segment);
  }
  const snapshot = await snapshotCompletionInputs(root, ['.'], signal);
  assert.equal(snapshot.files, 1, 'only the source file was hashed');
  // The exclusion is a stated coverage boundary, not a silent one: the count is reported with the digest.
  assert.equal(snapshot.bytes, 'source'.length);
});

test('the runtime’s own database does not invalidate the evidence it is recording', async (t) => {
  const root = await fixture(t);
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const session = store.create(root);
  await writeFile(path.join(root, 'src.ts'), 'source');
  const before = await snapshotCompletionInputs(root, ['.'], signal, {
    runtimeStatePaths: store.databaseFiles(),
  });
  // A round's own writes — the log, the attempt row, the effect ledger — all land in this store.
  store.recordEvent(session.id, 'message.user', { content: 'progress' });
  store.recordEvent(session.id, 'message.user', { content: 'more progress' });
  const after = await snapshotCompletionInputs(root, ['.'], signal, {
    runtimeStatePaths: store.databaseFiles(),
  });
  assert.equal(after.digest, before.digest, 'the runtime state is not monitored input');
  assert.equal(after.files, 1);
  // Without the exclusion the same tree differs, which is what makes this a test of the exclusion rather than of
  // a store that happens not to write.
  const unexcluded = await snapshotCompletionInputs(root, ['.'], signal);
  assert.notEqual(unexcluded.digest, before.digest);
  store.close();
});

test('a user file that merely looks like a database is still monitored', async (t) => {
  const root = await fixture(t);
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const session = store.create(root);
  // A SQLite database that belongs to the *project* rather than to the runtime: the exclusion is by resolved
  // path, never by suffix, or a change to a user's own data file would go unnoticed.
  await writeFile(path.join(root, 'fixture.sqlite'), 'first');
  const before = await snapshotCompletionInputs(root, ['.'], signal, {
    runtimeStatePaths: store.databaseFiles(),
  });
  await writeFile(path.join(root, 'fixture.sqlite'), 'second');
  const after = await snapshotCompletionInputs(root, ['.'], signal, {
    runtimeStatePaths: store.databaseFiles(),
  });
  assert.notEqual(after.digest, before.digest);
  store.recordEvent(session.id, 'message.user', { content: 'noise' });
  // Closed here rather than in an after hook: the hook that removes the temporary directory is registered first
  // and would otherwise run while the store still holds a WAL open on Windows.
  store.close();
});

test('a protected path is refused rather than quietly skipped', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.ssh'));
  await writeFile(path.join(root, '.ssh', 'id_rsa'), 'private');
  await assert.rejects(snapshotCompletionInputs(root, ['.ssh/id_rsa'], signal), /protected path/);
  await assert.rejects(snapshotCompletionInputs(root, ['.env'], signal), /protected path/);
  // A scan of the whole root passes over it: the refusal is about *naming* it, not about a directory listing.
  const whole = await snapshotCompletionInputs(root, ['.'], signal);
  assert.equal(whole.files, 0);
});

test('an input that escapes the root is refused', async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    snapshotCompletionInputs(root, ['../outside.txt'], signal),
    /escapes|relative/,
  );
  await assert.rejects(snapshotCompletionInputs(root, ['/etc/passwd'], signal), /relative/);
});

test(
  'a link is never followed out of the execution root',
  { skip: process.platform === 'win32' ? 'symlink creation needs privileges on Windows' : false },
  async (t) => {
    const root = await fixture(t);
    const outside = await fixture(t);
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await assert.rejects(
      snapshotCompletionInputs(root, ['link.txt'], signal),
      /Symbolic links are not followed/,
    );
    await assert.rejects(
      snapshotCompletionInputs(root, ['.'], signal),
      /Symbolic links are not followed/,
    );
  },
);

test('a cancelled snapshot stops rather than reporting a partial tree', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'a');
  const controller = new AbortController();
  controller.abort(new Error('cancelled by the fixture'));
  await assert.rejects(snapshotCompletionInputs(root, ['.'], controller.signal), /cancelled/);
});

test('a range that is too large is refused, not truncated', async (t) => {
  const root = await fixture(t);
  // 20 001 empty files is slow to create; the single-file bound is the same rule and cheap to exercise, so both
  // the class of error and the refusal itself are asserted without building a quarter of a million files.
  await writeFile(path.join(root, 'huge.bin'), Buffer.alloc(16 * 1024 * 1024 + 1, 0));
  await assert.rejects(
    snapshotCompletionInputs(root, ['huge.bin'], signal),
    (error: unknown) =>
      error instanceof CompletionInputLimitError && /per-file limit/.test(error.message),
  );
});
