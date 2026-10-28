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
import { execFileSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CompletionInputLimitError,
  COMPLETION_INPUT_EXCLUDED_SEGMENTS,
  snapshotCompletionInputs,
} from '../packages/core/completion/inputs.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { workspaceGitEnvironment } from '../packages/workspaces/git.ts';
import { WORKSPACE_SCALE_LIMITS } from '../packages/protocol/workspaces.ts';
import { tempRoot } from './temp-fixture.ts';

const signal = new AbortController().signal;

async function fixture(t: test.TestContext) {
  const root = await tempRoot(t, 'yuantu-completion-inputs-');
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

function git(root: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    env: workspaceGitEnvironment(),
    stdio: 'ignore',
  });
}

test('the implicit range is Git’s view: tracked and untracked source, never ignored trees', async (t) => {
  const root = await fixture(t);
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  await mkdir(path.join(root, 'ignored'));
  await writeFile(path.join(root, 'ignored/big.bin'), 'not source');
  await writeFile(path.join(root, 'tracked.txt'), 'tracked');
  await writeFile(path.join(root, 'new.txt'), 'new');
  git(root, ['add', '.gitignore', 'tracked.txt']);
  git(root, ['commit', '-q', '-m', 'base']);

  const first = await snapshotCompletionInputs(root, ['.'], signal);
  // `.gitignore`, the tracked file, and the untracked file Git would commit. The ignored tree is not read.
  assert.equal(first.files, 3);

  await writeFile(path.join(root, 'ignored/big.bin'), 'changed');
  const ignored = await snapshotCompletionInputs(root, ['.'], signal);
  assert.equal(ignored.digest, first.digest, 'an ignored file is outside the Git-visible range');

  await writeFile(path.join(root, 'new.txt'), 'changed');
  const changed = await snapshotCompletionInputs(root, ['.'], signal);
  assert.notEqual(changed.digest, first.digest, 'an untracked source file is still monitored');
});

test('an explicit input under a derived directory is still the evidence’s subject', async (t) => {
  const root = await fixture(t);
  const explicit: string[] = [];
  for (const segment of COMPLETION_INPUT_EXCLUDED_SEGMENTS) {
    await mkdir(path.join(root, segment), { recursive: true });
    const file = `${segment}/explicit.txt`;
    await writeFile(path.join(root, file), segment);
    explicit.push(file);
  }
  // The list describes the implicit `.` range. A path the contract names is what the evidence is *about*, so
  // silently dropping it was how a declared `dist/out.txt` could change without moving the digest.
  const before = await snapshotCompletionInputs(root, explicit, signal);
  assert.equal(before.files, explicit.length, 'every declared file was hashed');

  await writeFile(path.join(root, explicit[0]!), 'changed');
  const after = await snapshotCompletionInputs(root, explicit, signal);
  assert.notEqual(after.digest, before.digest);
});

test('an explicitly named directory is covered whole', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'dist/nested'), { recursive: true });
  await writeFile(path.join(root, 'dist/out.txt'), 'one');
  await writeFile(path.join(root, 'dist/nested/two.txt'), 'two');

  const explicit = await snapshotCompletionInputs(root, ['dist'], signal);
  assert.equal(
    explicit.files,
    2,
    'the declared directory is the subject, not build output to skip',
  );
  const implicit = await snapshotCompletionInputs(root, ['.'], signal);
  assert.equal(implicit.files, 0, 'the implicit range keeps its derived-directory boundary');
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

test('an explicit runtime state path is refused rather than silently unmonitored', async (t) => {
  const root = await fixture(t);
  const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  store.create(root);
  try {
    // Naming the database cannot make it evidence about the work: it is rewritten by the run itself. Refusing is
    // the honest answer; silently dropping it would repeat the empty-range false pass this file exists to prevent.
    await assert.rejects(
      snapshotCompletionInputs(root, ['.yuantu/sessions.sqlite'], signal, {
        runtimeStatePaths: store.databaseFiles(),
      }),
      /cannot be monitored/,
    );
  } finally {
    store.close();
  }
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
  // 200 001 empty files is slow to create; the single-file bound is the same rule and cheap to exercise, so both
  // the class of error and the refusal itself are asserted without building a quarter of a million files.
  await writeFile(
    path.join(root, 'huge.bin'),
    Buffer.alloc(WORKSPACE_SCALE_LIMITS.fileBytes + 1, 0),
  );
  await assert.rejects(
    snapshotCompletionInputs(root, ['huge.bin'], signal),
    (error: unknown) =>
      error instanceof CompletionInputLimitError && /per-file limit/.test(error.message),
  );
});

test('files read in parallel still digest in walk order, each bound to its own path', async (t) => {
  const root = await fixture(t);
  // More files than are read at once, so the reads interleave.
  for (let index = 0; index < 40; index++)
    await writeFile(path.join(root, `f${String(index).padStart(2, '0')}.txt`), `content ${index}`);
  const first = await snapshotCompletionInputs(root, ['.'], signal);
  assert.equal(first.files, 40);
  assert.equal((await snapshotCompletionInputs(root, ['.'], signal)).digest, first.digest);
  // Swapping two files' contents keeps the multiset of contents but not which path holds which.
  await writeFile(path.join(root, 'f03.txt'), 'content 37');
  await writeFile(path.join(root, 'f37.txt'), 'content 3');
  assert.notEqual((await snapshotCompletionInputs(root, ['.'], signal)).digest, first.digest);
});

test('the size of a range is told before any of it is read', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), 'aaaa');
  await writeFile(path.join(root, 'b.txt'), 'bb');
  const told: { files: number; bytes: number }[] = [];
  const snapshot = await snapshotCompletionInputs(root, ['.'], signal, {
    onCollected: (scale) => told.push(scale),
  });
  assert.deepEqual(told, [{ files: 2, bytes: 6 }]);
  assert.equal(snapshot.files, 2);
  // A range refused on its size is refused before the notice: nothing is announced that will not be read.
  told.length = 0;
  await assert.rejects(
    snapshotCompletionInputs(root, ['.'], signal, {
      maxFiles: 1,
      onCollected: (scale) => told.push(scale),
    }),
    CompletionInputLimitError,
  );
  assert.deepEqual(told, []);
});

test('the file limit admits exactly that many files and refuses one more', async (t) => {
  const root = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(path.join(root, name), name);
  const exact = await snapshotCompletionInputs(root, ['.'], signal, { maxFiles: 3 });
  assert.equal(exact.files, 3);
  // The check used to run on the way into each entry with `>`, so the last file of a directory got through after
  // the count had already reached the limit: a limit of 2 accepted these three files.
  await assert.rejects(
    snapshotCompletionInputs(root, ['.'], signal, { maxFiles: 2 }),
    (error: unknown) =>
      error instanceof CompletionInputLimitError && /2 file limit/.test(error.message),
  );
});

test('the fingerprint accepts any file the workspace snapshot accepts', async (t) => {
  const root = await fixture(t);
  // 17 MiB: above the fingerprint's former 16 MiB bound, below the bound the workspace snapshot shares with it.
  await writeFile(path.join(root, 'asset.bin'), Buffer.alloc(17 * 1024 * 1024, 1));
  const first = await snapshotCompletionInputs(root, ['.'], signal);
  assert.ok(first.bytes >= 17 * 1024 * 1024);
  assert.equal((await snapshotCompletionInputs(root, ['.'], signal)).digest, first.digest);
});
