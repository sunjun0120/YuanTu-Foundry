import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore, WorkspaceFailure } from '../packages/storage/sqlite.ts';
import {
  collectFileDigests,
  collectWorkingTree,
  freezeSnapshot,
  readManifest,
  snapshotFileBytes,
  releaseSnapshotOwner,
  snapshotOwnerRef,
  snapshotOwners,
  snapshotRef,
  STANDALONE_OWNER,
  snapshotMetadataRoot,
  verifySnapshotStable,
} from '../packages/workspaces/snapshot.ts';
import { repositoryIdentity } from '../packages/workspaces/git.ts';
import { tempRoot } from './temp-fixture.ts';

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
    await rm(`${this.root}-state`, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 20,
    });
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
  const decode = async (name: string): Promise<string> =>
    (await snapshotFileBytes(identity!.repositoryRoot, snapshot.id, byPath.get(name)!)).toString(
      'utf8',
    );
  assert.equal(await decode('staged-then-edited.txt'), 'edited after staging\n');
  assert.equal(await decode('added.txt'), 'brand new\n');
  // CRLF survives exactly: the baseline is bytes, and a checkout filter that "helpfully" normalised line endings
  // would hand the child a file the user does not have.
  assert.equal(await decode('crlf.txt'), 'first\r\nsecond\r\n');
  assert.equal(await decode("文档/it's a file.md"), '中文内容\n');
  // A deletion is part of the baseline, which is why the manifest is a list of what *is* there rather than a diff.
  assert.equal(byPath.has('src/app.ts'), false);
  // The baseline is a real tree in the repository, reachable from its owner's ref.
  assert.equal(
    git(root, ['rev-parse', `${snapshotOwnerRef(snapshot.id, STANDALONE_OWNER)}^{tree}`]),
    snapshot.baseTree,
  );
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

test('identical content in independent projects has distinct snapshots in one store', async (t) => {
  const first = await repository(t);
  const other = await repository(t);
  git(other.root, ['commit', '--allow-empty', '-qm', 'independent history']);
  const left = await freezeSnapshot({ projectRoot: first.root });
  const right = await freezeSnapshot({ projectRoot: other.root });
  first.store.recordWorkspaceSnapshot(left);
  first.store.recordWorkspaceSnapshot(right);
  assert.notEqual(left.id, right.id);
  assert.equal(first.store.workspaceSnapshot(left.id)?.projectRoot, first.root);
  assert.equal(first.store.workspaceSnapshot(right.id)?.projectRoot, other.root);
});

test('identical content in sibling source worktrees keeps each source identity', async (t) => {
  const harness = await repository(t);
  const child = path.join(harness.root, '..', `${path.basename(harness.root)}-child`);
  t.after(async () => {
    await rm(child, { recursive: true, force: true });
  });
  git(harness.root, ['worktree', 'add', '--detach', child, 'HEAD']);
  const first = await freezeSnapshot({ projectRoot: harness.root });
  const second = await freezeSnapshot({ projectRoot: harness.root, sourceRoot: child });
  assert.notEqual(first.id, second.id);
  assert.equal(second.sourceRoot, child);
  harness.store.recordWorkspaceSnapshot(first);
  harness.store.recordWorkspaceSnapshot(second);
});

test('legacy content-only snapshot manifests remain readable after upgrading the identity format', async (t) => {
  const harness = await repository(t);
  const snapshot = await freezeSnapshot({ projectRoot: harness.root });
  const identity = await repositoryIdentity(harness.root);
  const manifest = (await readManifest(identity!.repositoryRoot, snapshot.id))!;
  // A format 1 manifest embedded the bytes; build one from the current entries so the reader is exercised against
  // the shape it has to keep supporting. Format 1 named no blob.
  const files = [];
  for (const { oid: _oid, ...entry } of manifest.files)
    files.push({
      ...entry,
      blob: (
        await snapshotFileBytes(identity!.repositoryRoot, snapshot.id, { ...entry, oid: _oid })
      ).toString('base64'),
    });
  const legacy = { ...manifest, format: 1, files };
  const hash = createHash('sha256').update('v1\u0000');
  for (const entry of legacy.files)
    hash.update(
      `${entry.path}\u0000${entry.mode}\u0000${entry.size}\u0000${entry.sha256}\u0000${entry.blob}\u0000`,
    );
  const legacyId = hash.digest('hex').slice(0, 32);
  const directory = snapshotMetadataRoot(identity!.repositoryRoot, legacyId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(legacy));
  assert.deepEqual(await readManifest(identity!.repositoryRoot, legacyId), legacy);
  harness.store.recordWorkspaceSnapshot({ ...snapshot, id: legacyId, manifestHash: legacyId });
  assert.equal(harness.store.workspaceSnapshot(legacyId)?.sourceRoot, harness.root);
});

test('the stability check refuses equal-length rewrites of more than one file', async (t) => {
  const harness = await repository(t);
  const identity = await repositoryIdentity(harness.root);
  assert.ok(identity);
  const expected = await collectFileDigests(harness.root);
  // Both files keep their byte length; only their contents change. A size check cannot see this, and a
  // snapshot that mixed the old and new bytes would describe a tree that never existed.
  await writeFile(path.join(harness.root, 'tracked.txt'), 'changed!\n');
  await writeFile(path.join(harness.root, 'src', 'app.ts'), 'export const value = 2;\n');
  await assert.rejects(
    verifySnapshotStable(identity!, expected, new AbortController().signal),
    (error: unknown) =>
      error instanceof WorkspaceFailure && error.code === 'WORKSPACE_SOURCE_CHANGED',
  );
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
    createHash('sha256')
      .update(await snapshotFileBytes(identity!.repositoryRoot, snapshot.id, entry))
      .digest('hex'),
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
  assert.equal(
    (await snapshotFileBytes(identity!.repositoryRoot, snapshot.id, entry)).toString('utf8'),
    'with filter\n',
  );
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
  const outside = await tempRoot(t, 'yuantu-not-a-repo-');
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

test('a working tree over the byte budget is refused by name before it is copied', async (t) => {
  const harness = await repository(t);
  await writeFile(path.join(harness.root, 'src', 'payload.bin'), 'x'.repeat(4_096));
  // The budget is an argument here so the refusal is exercised without a real half-gigabyte tree.
  await assert.rejects(
    collectWorkingTree(harness.root, undefined, { maxTotalBytes: 1_024 }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_TOO_LARGE');
      assert.match(error.message, /1024 byte budget/);
      assert.match(
        error.message,
        /payload\.bin/,
        'the refusal names the file that crossed the line',
      );
      return true;
    },
  );
  // Under the budget the same tree freezes normally, so the bound is the budget and not the walk.
  const entries = await collectWorkingTree(harness.root, undefined, { maxTotalBytes: 1_000_000 });
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['src/app.ts', 'src/payload.bin', 'tracked.txt'],
  );
});

test('the digest-only walk identifies the same tree without keeping its bytes', async (t) => {
  const harness = await repository(t);
  const entries = await collectWorkingTree(harness.root);
  const digests = await collectFileDigests(harness.root);
  // Same walk, same refusals, same answer about what the tree is — one of them just does not carry the content.
  assert.deepEqual(
    digests,
    entries.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 })),
  );
  assert.ok(digests.every((digest) => !('blob' in digest)));
});

test('a published manifest names its bytes as Git blobs, and keeps no second copy', async (t) => {
  const harness = await repository(t);
  const snapshot = await freezeSnapshot({ projectRoot: harness.root });
  const identity = (await repositoryIdentity(harness.root))!;
  const manifest = (await readManifest(identity.repositoryRoot, snapshot.id))!;
  assert.equal(manifest.format, 4);
  assert.ok(manifest.files.length >= 2);
  for (const entry of manifest.files) {
    // No content in the manifest itself: reading it is a metadata read whatever the tree's size.
    assert.equal(entry.blob, undefined, entry.path);
    const bytes = execFileSync('git', ['cat-file', 'blob', entry.oid!], {
      cwd: harness.root,
      env: GIT_ENV,
    });
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.path);
    assert.equal(
      bytes.toString('utf8'),
      await readFile(path.join(harness.root, ...entry.path.split('/')), 'utf8'),
      entry.path,
    );
  }
  // Format 3 also copied every file into `files/` beside the manifest; Git's object store is now the only copy.
  await assert.rejects(
    readdir(path.join(snapshotMetadataRoot(identity.repositoryRoot, snapshot.id), 'files')),
  );
});

test('a blob that is not the bytes an entry recorded is refused, not handed to a child', async (t) => {
  const harness = await repository(t);
  const snapshot = await freezeSnapshot({ projectRoot: harness.root });
  const identity = (await repositoryIdentity(harness.root))!;
  const manifest = (await readManifest(identity.repositoryRoot, snapshot.id))!;
  const entry = manifest.files.find((candidate) => candidate.path === 'tracked.txt')!;
  const other = manifest.files.find((candidate) => candidate.oid !== entry.oid)!;
  await assert.rejects(
    snapshotFileBytes(identity.repositoryRoot, snapshot.id, { ...entry, oid: other.oid }),
    (error) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_INTEGRITY');
      return true;
    },
  );
  // A blob the repository does not have is reported as missing bytes, not as a crash.
  await assert.rejects(
    snapshotFileBytes(identity.repositoryRoot, snapshot.id, { ...entry, oid: 'f'.repeat(40) }),
    (error) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_MISSING',
  );
});

test('credential names are matched by family and without case, tracked or not', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  for (const name of [
    '.ENV',
    '.env.staging',
    'credentials.dev.json',
    'Secrets.JSON',
    'ordinary.txt',
  ])
    await writeFile(path.join(root, name), 'SYNTHETIC\n');
  // Untracked: left behind, and the ordinary file next to them still travels.
  const copied = (await collectWorkingTree(root)).map((entry) => entry.path);
  for (const name of ['.ENV', '.env.staging', 'credentials.dev.json', 'Secrets.JSON'])
    assert.equal(copied.includes(name), false, name);
  assert.ok(copied.includes('ordinary.txt'));
  // A placeholder file is not a credential.
  await writeFile(path.join(root, '.env.example'), 'KEY=\n');
  assert.ok((await collectWorkingTree(root)).some((entry) => entry.path === '.env.example'));

  // Tracked: refused by name, as an exactly named `.env` is.
  git(root, ['add', '-f', '.env.staging']);
  await assert.rejects(collectWorkingTree(root), (error: unknown) => {
    assert.ok(error instanceof WorkspaceFailure);
    assert.equal(error.code, 'WORKSPACE_PROTECTED_CREDENTIAL');
    assert.match(error.message, /\.env\.staging/);
    return true;
  });
});

test('a tracked directory replaced by a link is refused, not read through', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  const outside = `${root}-outside`;
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(outside);
  await writeFile(path.join(outside, 'app.ts'), 'OUTSIDE_FIXTURE\n');
  // `src/app.ts` is tracked; its directory now leads out of the tree, while the file itself still looks plain.
  await rm(path.join(root, 'src'), { recursive: true });
  await symlink(outside, path.join(root, 'src'), 'junction');
  await assert.rejects(collectWorkingTree(root), (error: unknown) => {
    assert.ok(error instanceof WorkspaceFailure);
    assert.equal(error.code, 'WORKSPACE_UNSUPPORTED_FILE_TYPE');
    assert.match(error.message, /src/);
    return true;
  });
  await assert.rejects(freezeSnapshot({ projectRoot: root }), WorkspaceFailure);
});

test('a file name with leading whitespace is listed as it is, even when it sorts first', async (t) => {
  const harness = await repository(t);
  const root = harness.root;
  await writeFile(path.join(root, ' leading.txt'), 'kept\n');
  git(root, ['add', '-A']);
  const entries = await collectWorkingTree(root);
  const kept = entries.find((entry) => entry.path === ' leading.txt');
  assert.ok(kept, 'the first listed path keeps its leading space');
  assert.equal(Buffer.from(kept.blob, 'base64').toString('utf8'), 'kept\n');
  const snapshot = await freezeSnapshot({ projectRoot: root });
  const identity = await repositoryIdentity(root);
  const manifest = await readManifest(identity!.repositoryRoot, snapshot.id);
  assert.ok(manifest!.files.some((entry) => entry.path === ' leading.txt'));
});

test('a manifest edited on disk is not trusted', async (t) => {
  const harness = await repository(t);
  const snapshot = await freezeSnapshot({ projectRoot: harness.root });
  const identity = (await repositoryIdentity(harness.root))!;
  const manifestFile = path.join(
    snapshotMetadataRoot(identity.repositoryRoot, snapshot.id),
    'manifest.json',
  );
  const original = JSON.parse(await readFile(manifestFile, 'utf8'));
  const bytes = Buffer.from('SYNTHETIC_MANIFEST_ESCAPE_PROOF\n');
  const forged = (overrides: Record<string, unknown>) => ({
    path: 'forged.txt',
    mode: '100644',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...overrides,
  });
  const write = (manifest: unknown) => writeFile(manifestFile, JSON.stringify(manifest));

  // Formats 3 and 4 are named by their digest: any change to the entries no longer answers to the id.
  await write({ ...original, files: [...original.files, forged({})] });
  assert.equal(await readManifest(identity.repositoryRoot, snapshot.id), null);

  // Older formats are not digest-named, so their entries are checked one by one.
  // Format 2 named no blobs, so the current entries lose theirs to become format 2 ones.
  const legacy = {
    ...original,
    format: 2,
    files: original.files.map(({ oid: _oid, ...entry }: Record<string, unknown>) => entry),
  };
  await write(legacy);
  assert.ok(
    await readManifest(identity.repositoryRoot, snapshot.id),
    'the unedited entries are fine',
  );
  const blob = bytes.toString('base64');
  for (const entry of [
    forged({ path: '../../../escaped-proof.txt', blob }),
    forged({ path: 'nested/../../escaped-proof.txt', blob }),
    forged({ path: '/escaped-proof.txt', blob }),
    forged({ path: 'C:/escaped-proof.txt', blob }),
    forged({ path: 'nested\\..\\..\\escaped-proof.txt', blob }),
    forged({ path: './forged.txt', blob }),
    forged({ path: '.git/hooks/post-checkout', blob }),
    forged({ path: '.yuantu/worktrees/x', blob }),
    forged({ path: '.env', blob }),
    forged({ path: 'tracked.txt', blob }),
    forged({ mode: '120000', blob }),
    forged({ size: -1, blob }),
    forged({ sha256: 'not-a-digest', blob }),
    forged({ blob: 42 }),
  ]) {
    await write({ ...legacy, files: [...legacy.files, entry] });
    assert.equal(
      await readManifest(identity.repositoryRoot, snapshot.id),
      null,
      JSON.stringify(entry.path),
    );
  }
  // Embedded bytes belong to the formats that embedded them.
  await write({ ...original, files: original.files.map((entry: object) => ({ ...entry, blob })) });
  assert.equal(await readManifest(identity.repositoryRoot, snapshot.id), null);
});

test('a snapshot two owners hold survives the first release and goes with the last', async (t) => {
  const harness = await repository(t);
  const identity = (await repositoryIdentity(harness.root))!;
  const left = await freezeSnapshot({ projectRoot: harness.root, owner: 'owner-a' });
  // The same content from another database: the same snapshot, and a second share of it.
  const right = await freezeSnapshot({ projectRoot: harness.root, owner: 'owner-b' });
  assert.equal(right.id, left.id);
  assert.deepEqual((await snapshotOwners(identity.repositoryRoot, left.id)).sort(), [
    'owner-a',
    'owner-b',
  ]);
  assert.equal(await releaseSnapshotOwner(identity.repositoryRoot, left.id, 'owner-a'), false);
  assert.ok(await readManifest(identity.repositoryRoot, left.id), 'one owner left, so it stays');
  assert.equal(await releaseSnapshotOwner(identity.repositoryRoot, left.id, 'owner-b'), true);
  assert.equal(await readManifest(identity.repositoryRoot, left.id), null);
  assert.equal(git(harness.root, ['for-each-ref', `refs/yuantu/snapshot-owners/${left.id}/`]), '');
});

test('a snapshot with a ref from before owners existed is never deleted by a release', async (t) => {
  const harness = await repository(t);
  const identity = (await repositoryIdentity(harness.root))!;
  const snapshot = await freezeSnapshot({ projectRoot: harness.root, owner: 'owner-a' });
  // What an older build left: one ref, no owner. Nothing says which databases still use it.
  git(harness.root, ['update-ref', snapshotRef(snapshot.id), snapshot.baseCommit]);
  assert.equal(await releaseSnapshotOwner(identity.repositoryRoot, snapshot.id, 'owner-a'), false);
  assert.ok(await readManifest(identity.repositoryRoot, snapshot.id));
});
