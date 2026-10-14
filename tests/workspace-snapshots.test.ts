import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore, WorkspaceFailure } from '../packages/storage/sqlite.ts';
import { freezeSnapshot, readManifest, snapshotRef } from '../packages/workspaces/snapshot.ts';
import { repositoryIdentity } from '../packages/workspaces/git.ts';

/**
 * Freezing a working directory into a baseline.
 *
 * The property under test is not "a baseline exists" — it is that the baseline is the *working directory's current
 * bytes*, that the user's own repository was not touched while producing it, and that an input this version cannot
 * reproduce is refused by name instead of being frozen approximately.
 */

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/**
 * A repository with one commit, plus the store a manager would use.
 *
 * The two halves are cleaned up by one hook in the order that works on Windows: every connection closes before the
 * directory is unlinked, or the removal fails with EBUSY on SQLite's sidecars.
 */
class Harness {
  readonly root: string;
  readonly store: SessionStore;
  constructor(root: string, store: SessionStore) {
    this.root = root;
    this.store = store;
  }
  get project(): string {
    return this.root;
  }
  async close(): Promise<void> {
    this.store.close();
    await rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

async function repository(t: test.TestContext): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-snapshots-'));
  const store = new SessionStore(
    path.join(root, '..', `${path.basename(root)}-state`, 'sessions.sqlite'),
  );
  const harness = new Harness(root, store);
  t.after(() => harness.close());
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'tracked.txt'), 'original\n');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.ts'), 'export const value = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
  return harness;
}

/** The user's own index and HEAD, as bytes, so "nothing was touched" is an observation rather than a claim. */
async function repositoryEvidence(
  root: string,
): Promise<{ head: string; index: string; files: Map<string, string> }> {
  const index = await readFile(path.join(root, '.git', 'index')).catch(() => Buffer.alloc(0));
  const files = new Map<string, string>();
  for (const name of ['tracked.txt', 'src/app.ts', 'added.txt', 'staged-then-edited.txt'])
    files.set(
      name,
      (await readFile(path.join(root, name)).catch(() => Buffer.alloc(0))).toString('base64'),
    );
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    index: createHash('sha256').update(index).digest('hex'),
    files,
  };
}

test('the baseline is the working directory, including staged edits, deletions and new files', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  // Every case the plan names, in one tree: a file staged and then modified again (the classic way a naive
  // `git stash` or `git checkout` freeze loses work), a deletion, and a file Git has never seen.
  await writeFile(path.join(root, 'staged-then-edited.txt'), 'staged version\n');
  git(root, ['add', 'staged-then-edited.txt']);
  await writeFile(path.join(root, 'staged-then-edited.txt'), 'edited after staging\n');
  await rm(path.join(root, 'src', 'app.ts'));
  await writeFile(path.join(root, 'added.txt'), 'brand new\n');
  await writeFile(path.join(root, 'crlf.txt'), 'first\r\nsecond\r\n');
  await mkdir(path.join(root, '文档'), { recursive: true });
  await writeFile(path.join(root, '文档', "it's a file.md"), '中文内容\n');

  const before = await repositoryEvidence(root);
  const snapshot = await freezeSnapshot({
    projectRoot: root,
    signal: new AbortController().signal,
  });
  const after = await repositoryEvidence(root);

  // The user's HEAD, index and files are byte-identical: a freeze is a read.
  assert.equal(after.head, before.head);
  assert.equal(after.index, before.index);
  assert.deepEqual(after.files, before.files);

  const identity = await repositoryIdentity(root);
  const manifest = await readManifest(identity!.repositoryRoot, snapshot.id);
  const byPath = new Map(manifest!.files.map((entry) => [entry.path, entry]));
  const decode = (name: string): string =>
    Buffer.from(byPath.get(name)!.blob, 'base64').toString('utf8');
  assert.equal(decode('staged-then-edited.txt'), 'edited after staging\n');
  assert.equal(decode('added.txt'), 'brand new\n');
  // CRLF survives exactly: the baseline is bytes, and a checkout filter that "helpfully" normalised line endings
  // would hand the child a file the user does not have.
  assert.equal(decode('crlf.txt'), 'first\r\nsecond\r\n');
  assert.equal(decode("文档/it's a file.md"), '中文内容\n');
  // A deletion is part of the baseline, which is why the manifest is a list of what *is* there rather than a diff.
  assert.equal(byPath.has('src/app.ts'), false);
  // The baseline is a real tree in the repository, reachable from the snapshot's own ref.
  assert.equal(git(root, ['rev-parse', `${snapshotRef(snapshot.id)}^{tree}`]), snapshot.baseTree);
  assert.equal(git(root, ['cat-file', '-t', snapshot.baseCommit]), 'commit');
  // The identity a child will run under: a synthetic commit that is not in the user's history. `HEAD`'s own
  // history is what must not grow — the baseline hangs off a private ref instead, which is why it is counted
  // this way rather than with `--all`.
  assert.notEqual(snapshot.baseCommit, before.head);
  assert.equal(
    git(root, ['rev-list', '--count', 'HEAD']),
    '1',
    'the user history gained no commit',
  );
});

test('the same content freezes to the same snapshot, and a change makes a new one', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  const signal = new AbortController().signal;
  const first = await freezeSnapshot({ projectRoot: root, signal });
  // Two children of one delegation call must share one baseline even when they start minutes apart, which is what
  // makes the queued-behind-the-cap case correct rather than merely likely.
  const second = await freezeSnapshot({ projectRoot: root, signal });
  assert.equal(second.id, first.id);
  assert.equal(second.baseCommit, first.baseCommit);

  await writeFile(path.join(root, 'tracked.txt'), 'changed\n');
  const third = await freezeSnapshot({ projectRoot: root, signal });
  assert.notEqual(third.id, first.id);
  assert.notEqual(third.baseCommit, first.baseCommit);

  /**
   * A commit the user makes while a delegation is queued does not change what the baseline *is*. The snapshot id
   * is the file list, not HEAD, so the second child of a call still shares the input the first one got.
   */
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'user work']);
  const fourth = await freezeSnapshot({ projectRoot: root, signal });
  assert.equal(fourth.id, third.id);
});

test('an input that changes while it is being frozen is refused, not frozen half-way', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  // A watcher that rewrites a *later* path in sort order on the first read: the walk then sees one version of the
  // file list and another of the file, which is exactly the race the second pass exists to catch.
  let fired = false;
  const watcher = setInterval(() => {
    if (fired) return;
    fired = true;
    void writeFile(path.join(root, 'tracked.txt'), `rewritten ${Date.now()}\n`);
  }, 1);
  t.after(() => clearInterval(watcher));
  const outcome = await freezeSnapshot({ projectRoot: root, signal: new AbortController().signal })
    .then(() => null)
    .catch((error: unknown) => error);
  clearInterval(watcher);
  if (outcome) {
    assert.ok(outcome instanceof WorkspaceFailure);
    assert.equal(outcome.code, 'WORKSPACE_SOURCE_CHANGED');
  }
  // Either the change landed between the two reads (refused) or after both (a consistent baseline of one version).
  // Both are correct; a snapshot that mixed the two versions is not, and the manifest is what proves which it is.
  const identity = await repositoryIdentity(root);
  const snapshot = await freezeSnapshot({
    projectRoot: root,
    signal: new AbortController().signal,
  });
  const manifest = await readManifest(identity!.repositoryRoot, snapshot.id);
  const entry = manifest!.files.find((candidate) => candidate.path === 'tracked.txt')!;
  assert.equal(
    createHash('sha256').update(Buffer.from(entry.blob, 'base64')).digest('hex'),
    entry.sha256,
  );
});

test('credentials, symbolic links, submodules and unmerged indexes are refused by name', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  const signal = new AbortController().signal;

  // An *untracked* secret is simply not copied: it is not part of the project, and copying it would be the leak.
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  const clean = await freezeSnapshot({ projectRoot: root, signal });
  const identity = await repositoryIdentity(root);
  const manifest = await readManifest(identity!.repositoryRoot, clean.id);
  assert.equal(
    manifest!.files.some((entry) => entry.path === '.env'),
    false,
  );

  // A *tracked* one blocks: a baseline that silently omitted a file the repository considers part of the project
  // would reproduce the project inaccurately, which is the failure this refusal prevents.
  git(root, ['add', '-f', '.env']);
  git(root, ['commit', '-qm', 'track credentials']);
  await assert.rejects(freezeSnapshot({ projectRoot: root, signal }), (error: unknown) => {
    assert.ok(error instanceof WorkspaceFailure);
    assert.equal(error.code, 'WORKSPACE_PROTECTED_CREDENTIAL');
    assert.match(error.message, /\.env/);
    return true;
  });
  git(root, ['rm', '-q', '--cached', '.env']);
  git(root, ['commit', '-qm', 'untrack credentials']);

  // A symbolic link is refused rather than followed: following it would copy a file from outside the project.
  await symlink(path.join(root, 'tracked.txt'), path.join(root, 'link.txt'));
  await assert.rejects(freezeSnapshot({ projectRoot: root, signal }), (error: unknown) => {
    assert.ok(error instanceof WorkspaceFailure);
    assert.equal(error.code, 'WORKSPACE_UNSUPPORTED_FILE_TYPE');
    return true;
  });
  await rm(path.join(root, 'link.txt'));

  // A submodule is a pointer to another repository, which a baseline cannot reproduce.
  await writeFile(path.join(root, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
  await assert.rejects(freezeSnapshot({ projectRoot: root, signal }), (error: unknown) => {
    assert.ok(error instanceof WorkspaceFailure);
    assert.equal(error.code, 'WORKSPACE_SUBMODULE_UNSUPPORTED');
    return true;
  });
  await rm(path.join(root, '.gitmodules'));

  // An unmerged index means the working file may hold conflict markers, so there is no version of it to freeze.
  const blob = git(root, ['rev-parse', 'HEAD:tracked.txt']);
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: root,
    env: GIT_ENV,
    input: `100644 ${blob} 1\ttracked.txt\n100644 ${blob} 2\ttracked.txt\n100644 ${blob} 3\ttracked.txt\n`,
  });
  const unmerged = git(root, ['ls-files', '--unmerged']);
  assert.notEqual(unmerged, '', 'the fixture really has an unmerged index');
  await assert.rejects(freezeSnapshot({ projectRoot: root, signal }), (error: unknown) => {
    assert.ok(error instanceof WorkspaceFailure);
    assert.equal(error.code, 'WORKSPACE_UNMERGED_INDEX');
    return true;
  });
});

test('freezing runs no repository hook and no clean filter', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  const sentinel = path.join(root, 'sentinel.txt');
  const hook = path.join(root, '.git', 'hooks', 'post-checkout');
  await writeFile(hook, `#!/bin/sh\necho ran >> "${sentinel.replaceAll('\\', '/')}"\n`);
  // A clean filter that would rewrite every file it is asked to hash. Plumbing that consults `.gitattributes`
  // would run it, so its silence is evidence that `--no-filters` and the private index are doing their job.
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=noisy\n');
  git(root, ['config', 'filter.noisy.clean', 'sh -c "echo filtered >> sentinel.txt; cat"']);
  await writeFile(path.join(root, 'tracked.txt'), 'with filter\n');

  const snapshot = await freezeSnapshot({
    projectRoot: root,
    signal: new AbortController().signal,
  });
  assert.equal(await readFile(sentinel, 'utf8').catch(() => ''), '');
  const identity = await repositoryIdentity(root);
  const manifest = await readManifest(identity!.repositoryRoot, snapshot.id);
  const entry = manifest!.files.find((candidate) => candidate.path === 'tracked.txt')!;
  // The bytes are the file's, un-filtered: a filter that ran would have stored something else.
  assert.equal(Buffer.from(entry.blob, 'base64').toString('utf8'), 'with filter\n');
});

test('a directory that is not a repository root is refused, and a shared binding needs no snapshot', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  await assert.rejects(
    freezeSnapshot({ projectRoot: path.join(root, 'src'), signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_NOT_A_REPOSITORY');
      return true;
    },
  );
  const outside = await mkdtemp(path.join(tmpdir(), 'yuantu-not-a-repo-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(
    freezeSnapshot({ projectRoot: outside, signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_NOT_A_REPOSITORY');
      return true;
    },
  );
});

test('a repository with no commit yet is refused with the reason a person can act on', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-empty-repo-'));
  const store = new SessionStore(
    path.join(root, '..', `${path.basename(root)}-state`, 'sessions.sqlite'),
  );
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  await assert.rejects(
    freezeSnapshot({ projectRoot: root, signal: new AbortController().signal }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_NO_HEAD');
      return true;
    },
  );
});
