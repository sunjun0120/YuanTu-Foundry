import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore, WorkspaceFailure } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import {
  readManifest,
  snapshotFileBytes,
  snapshotMetadataRoot,
} from '../packages/workspaces/snapshot.ts';
import {
  isManagedWorktreePath,
  registeredWorktrees,
  repositoryIdentity,
} from '../packages/workspaces/git.ts';
import { samePath } from '../packages/platform/workspace-paths.ts';

/**
 * Allocating real worktrees.
 *
 * These cases run against actual Git repositories rather than mocked commands, because every property worth having
 * here is a property of the filesystem: that two allocations hold the same bytes in different directories, that the
 * delegator's own directory did not change, that Git itself reports the new directory as a registered worktree, and
 * that a directory which merely *looks* like one is refused.
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

interface Fixture {
  root: string;
  store: SessionStore;
  manager: WorkspaceManager;
  parentSessionId: string;
  bindingId: string;
  snapshotId: string;
  head: string;
  index: string;
}

/**
 * A temporary repository plus a store, with no allocation yet.
 *
 * `metadataWrites: false` is what the policy case needs, so the allocation is deliberately *not* part of this
 * setup: a manager that refuses to manage Git metadata must be observable before anything is frozen.
 */
async function base(t: test.TestContext, options: { metadataWrites?: () => boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-manager-'));
  const store = new SessionStore(path.join(`${root}-state`, 'sessions.sqlite'));
  const manager = new WorkspaceManager({
    store,
    ...(options.metadataWrites ? { metadataWritesAllowed: options.metadataWrites } : {}),
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    await rm(`${root}-state`, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'same.txt'), 'base\n');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'only-in-baseline.ts'), 'export const a = 1;\n');
  /**
   * `.yuantu` is excluded through `.git/info/exclude` rather than `.gitignore`.
   *
   * That is the repository-local place for a rule a project does not want to commit, and it keeps this fixture from
   * claiming that the product's own `.gitignore` policy is what makes the service's state directory invisible.
   */
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
  /**
   * A dirty file, because the whole point of the baseline is that the child starts from what the user has. It is
   * written *before* the index is recorded so the index evidence is the state a freeze must not disturb.
   */
  await writeFile(path.join(root, 'same.txt'), 'dirty base\n');
  return { root, store, manager };
}

/** The full fixture: a repository, an allocation, and a frozen baseline behind it. */
async function fixture(
  t: test.TestContext,
  options: { metadataWrites?: () => boolean } = {},
): Promise<Fixture> {
  const { root, store, manager } = await base(t, options);
  const head = git(root, ['rev-parse', 'HEAD']);
  const index = git(root, ['write-tree']);
  const session = store.create(root);
  const signal = new AbortController().signal;
  const source = manager.resolve(session.id);
  const snapshot = await manager.freeze({
    parentSessionId: session.id,
    sourceBinding: source,
    signal,
  });
  const binding = await manager.allocate({
    parentSessionId: session.id,
    taskId: 'task-1',
    snapshot,
    signal,
  });
  return {
    root,
    store,
    manager,
    parentSessionId: session.id,
    bindingId: binding.id,
    snapshotId: snapshot.id,
    head,
    index,
  };
}

/** The child session an allocation belongs to, attached the way the delegation path does it. */
function attachChild(fixture: Fixture): { sessionId: string; executionRoot: string } {
  const child = fixture.store.create(fixture.root, fixture.parentSessionId);
  const binding = fixture.manager.attach({
    bindingId: fixture.bindingId,
    childSessionId: child.id,
  });
  return { sessionId: child.id, executionRoot: binding.executionRoot };
}

test('two allocations hold the same baseline in different directories', async (t) => {
  const harness = await fixture(t);
  const signal = new AbortController().signal;
  const snapshot = harness.store.workspaceSnapshot(harness.snapshotId)!;
  const second = await harness.manager.allocate({
    parentSessionId: harness.parentSessionId,
    taskId: 'task-2',
    snapshot,
    signal,
  });
  const first = harness.store.workspaceById(harness.bindingId)!;
  assert.notEqual(first.executionRoot, second.executionRoot);
  // The uncommitted edit is in both: a baseline taken from HEAD would have lost the work the delegation was about.
  assert.equal(await readFile(path.join(first.executionRoot, 'same.txt'), 'utf8'), 'dirty base\n');
  assert.equal(await readFile(path.join(second.executionRoot, 'same.txt'), 'utf8'), 'dirty base\n');
  assert.equal(
    await readFile(path.join(first.executionRoot, 'src', 'only-in-baseline.ts'), 'utf8'),
    'export const a = 1;\n',
  );

  // Writing in one child's directory is invisible in the other's and invisible in the parent's.
  await writeFile(path.join(first.executionRoot, 'same.txt'), 'child A\n');
  assert.equal(await readFile(path.join(second.executionRoot, 'same.txt'), 'utf8'), 'dirty base\n');
  assert.equal(await readFile(path.join(harness.root, 'same.txt'), 'utf8'), 'dirty base\n');
  // The parent's repository is exactly as it was: same HEAD, same index.
  assert.equal(git(harness.root, ['rev-parse', 'HEAD']), harness.head);
  assert.equal(git(harness.root, ['write-tree']), harness.index);
  // The delegator's own directory is untouched: exactly one modified file, and nothing new — no worktree
  // registration, no snapshot metadata, no baseline commit leaking into what the user sees as their status.
  assert.deepEqual(
    git(harness.root, ['status', '--porcelain'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    ['M same.txt'],
  );
});

test('a stored file changed after one allocation used it is refused by the next', async (t) => {
  // Later allocations of a snapshot skip re-hashing stored bytes an earlier one already checked; that shortcut must
  // end the moment the stored file changes, or a second child would receive bytes nobody froze.
  const harness = await fixture(t);
  const identity = (await repositoryIdentity(harness.root))!;
  const manifest = (await readManifest(identity.repositoryRoot, harness.snapshotId))!;
  const entry = manifest.files.find((candidate) => candidate.path === 'same.txt')!;
  const stored = path.join(
    snapshotMetadataRoot(identity.repositoryRoot, harness.snapshotId),
    'files',
    entry.sha256.slice(0, 32),
  );
  // Same length as 'dirty base\n', so only the content and the file's times differ.
  await writeFile(stored, 'tampered!!\n');
  await assert.rejects(
    harness.manager.allocate({
      parentSessionId: harness.parentSessionId,
      taskId: 'task-2',
      snapshot: harness.store.workspaceSnapshot(harness.snapshotId)!,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_INTEGRITY',
  );
});

test('files that share bytes are each filled, and editing one leaves the stored copy intact', async (t) => {
  const { root, store, manager } = await base(t);
  await mkdir(path.join(root, 'a', 'deep'), { recursive: true });
  await writeFile(path.join(root, 'a', 'deep', 'twin.txt'), 'same bytes\n');
  await writeFile(path.join(root, 'twin.txt'), 'same bytes\n');
  const session = store.create(root);
  const signal = new AbortController().signal;
  const snapshot = await manager.freeze({
    parentSessionId: session.id,
    sourceBinding: manager.resolve(session.id),
    signal,
  });
  const first = await manager.allocate({
    parentSessionId: session.id,
    taskId: 't1',
    snapshot,
    signal,
  });
  assert.equal(await readFile(path.join(first.executionRoot, 'twin.txt'), 'utf8'), 'same bytes\n');
  assert.equal(
    await readFile(path.join(first.executionRoot, 'a', 'deep', 'twin.txt'), 'utf8'),
    'same bytes\n',
  );
  // A child editing in place must not reach the stored copy the next child is filled from.
  await writeFile(path.join(first.executionRoot, 'twin.txt'), 'edited by child\n', { flag: 'r+' });
  const second = await manager.allocate({
    parentSessionId: session.id,
    taskId: 't2',
    snapshot,
    signal,
  });
  assert.equal(await readFile(path.join(second.executionRoot, 'twin.txt'), 'utf8'), 'same bytes\n');
});

test('the allocated directory is a detached worktree Git itself reports', async (t) => {
  const harness = await fixture(t);
  const binding = harness.store.workspaceById(harness.bindingId)!;
  const identity = await repositoryIdentity(harness.root);
  assert.ok(identity);
  assert.equal(binding.repositoryRoot, identity.repositoryRoot);
  assert.equal(binding.state, 'ready');
  assert.equal(binding.kind, 'worktree');
  assert.equal(isManagedWorktreePath(identity.repositoryRoot, binding.executionRoot), true);

  const registered = await registeredWorktrees(identity);
  // Compared by what the paths name, not by how Git spells them: `worktree list` reports forward slashes on
  // Windows and this binding uses the platform separator, and the two are the same directory.
  const entry = registered.find((candidate) => samePath(candidate.path, binding.executionRoot));
  assert.ok(entry, 'git worktree list reports the allocation');
  assert.equal(entry.detached, true, 'no branch was taken from the user');
  assert.equal(entry.branch, null);
  // The worktree is at the synthetic baseline, which is what makes a later result a diff against a known tree.
  const snapshot = harness.store.workspaceSnapshot(harness.snapshotId)!;
  assert.equal(entry.head, snapshot.baseCommit);
  assert.equal(git(binding.executionRoot, ['rev-parse', 'HEAD']), snapshot.baseCommit);
  // And a validation pass accepts it, which is what a child's first turn does before it writes anything.
  await harness.manager.validate(binding, new AbortController().signal);
});

test('an allocation can be made from a linked worktree, and stays in the same repository', async (t) => {
  const harness = await fixture(t);
  const signal = new AbortController().signal;
  // The delegator is itself an isolated child: nested collaboration must allocate a sibling worktree of the *main*
  // repository rather than a worktree of a worktree, which is what the common-dir resolution is for.
  const nested = harness.store.create(harness.root, harness.parentSessionId);
  const outer = harness.store.workspaceById(harness.bindingId)!;
  const inner = harness.store.createWorkspaceBinding({
    parentSessionId: harness.parentSessionId,
    projectRoot: harness.root,
    executionRoot: outer.executionRoot,
    repositoryRoot: outer.repositoryRoot,
    kind: 'shared',
    snapshotId: null,
    baseCommit: null,
  });
  harness.store.attachWorkspaceBinding({ bindingId: inner.id, childSessionId: nested.id });
  const source = harness.manager.resolve(nested.id);
  assert.equal(source.executionRoot, outer.executionRoot);

  const snapshot = await harness.manager.freeze({
    parentSessionId: harness.parentSessionId,
    sourceBinding: harness.store.workspaceById(harness.bindingId)!,
    signal,
  });
  const allocation = await harness.manager.allocate({
    parentSessionId: harness.parentSessionId,
    taskId: 'nested',
    snapshot,
    signal,
  });
  assert.equal(
    allocation.repositoryRoot,
    harness.store.workspaceById(harness.bindingId)!.repositoryRoot,
  );
  await harness.manager.validate(allocation, signal);
  // The snapshot taken from the *worktree* carries the worktree's bytes — here, not the parent's dirty file but the
  // worktree's own copy, which was populated from the parent's baseline.
  assert.equal(
    await readFile(path.join(allocation.executionRoot, 'same.txt'), 'utf8'),
    'dirty base\n',
  );
});

test('a forged .git link is refused rather than adopted', async (t) => {
  const harness = await fixture(t);
  const binding = harness.store.workspaceById(harness.bindingId)!;
  const identity = await repositoryIdentity(harness.root);
  const signal = new AbortController().signal;

  /**
   * A crafted `.git` link naming a metadata directory whose reverse link points somewhere else.
   *
   * This is the forgery worth refusing, and it is checked against a *real* metadata directory: the link is
   * well-formed, the metadata exists, and the only thing wrong is that Git's own record of that metadata names a
   * different directory. Without the reverse check the directory would pass as a managed worktree of this
   * repository, and a result computed in it would be attributed to a workspace this session does not own.
   */
  const forge = path.join(harness.root, '.yuantu', 'worktrees', 'forged');
  await mkdir(forge, { recursive: true });
  const metadata = path.join(
    identity!.commonDirectory,
    'worktrees',
    path.basename(binding.executionRoot),
  );
  await writeFile(path.join(forge, '.git'), `gitdir: ${metadata}\n`);
  await assert.rejects(
    harness.manager.validate({ ...binding, executionRoot: forge }, signal),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      // The refusal may arrive as "not a working tree" or as "the link does not point back"; what must never
      // happen is acceptance.
      assert.ok(
        ['WORKSPACE_IDENTITY_MISMATCH', 'WORKSPACE_MISSING'].includes(error.code),
        `unexpected code ${error.code}`,
      );
      return true;
    },
  );

  // A missing directory is its own answer: the binding must not fall back to the parent's directory.
  const third = await harness.manager.allocate({
    parentSessionId: harness.parentSessionId,
    taskId: 'task-3',
    snapshot: harness.store.workspaceSnapshot(harness.snapshotId)!,
    signal,
  });
  await rm(third.executionRoot, { recursive: true, force: true });
  await assert.rejects(harness.manager.validate(third, signal), (error: unknown) => {
    assert.ok(error instanceof WorkspaceFailure);
    assert.equal(error.code, 'WORKSPACE_MISSING');
    return true;
  });
});

test('a cancelled or failed allocation leaves a record, never a runnable session', async (t) => {
  const harness = await fixture(t);
  const snapshot = harness.store.workspaceSnapshot(harness.snapshotId)!;
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    harness.manager.allocate({
      parentSessionId: harness.parentSessionId,
      taskId: 'task-cancelled',
      snapshot,
      signal: controller.signal,
    }),
  );
  // Cancellation happens before the row is written, so there is nothing to recover and nothing to clean up.
  assert.equal(harness.store.workspaceBindingsByState(['preparing']).length, 0);

  // A failure *after* the row exists is the interesting case: the directory may or may not have appeared, and the
  // row must be `blocked` rather than `ready`, so nothing can attach a session to it.
  const missing = harness.manager as unknown as {
    createWorktree: (...args: unknown[]) => Promise<void>;
  };
  const original = missing.createWorktree.bind(harness.manager);
  missing.createWorktree = async () => {
    throw new Error('simulated failure');
  };
  await assert.rejects(
    harness.manager.allocate({
      parentSessionId: harness.parentSessionId,
      taskId: 'task-failed',
      snapshot,
      signal: new AbortController().signal,
    }),
    /simulated failure/,
  );
  missing.createWorktree = original;
  const blocked = harness.store.workspaceBindingsByState(['blocked']);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.sessionId, null, 'no session may exist for a blocked allocation');
});

test('a policy that cannot manage Git metadata fails loudly instead of degrading', async (t) => {
  const harness = await base(t, { metadataWrites: () => false });
  const session = harness.store.create(harness.root);
  // The freeze is the first step, so the refusal arrives before anything is created.
  await assert.rejects(
    harness.manager.freeze({
      parentSessionId: session.id,
      sourceBinding: harness.manager.resolve(session.id),
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      assert.equal(error.code, 'WORKSPACE_POLICY_UNSUPPORTED');
      return true;
    },
  );
  // Nothing was created: no snapshot, no binding, no directory.
  assert.deepEqual(harness.store.workspaceSnapshots(), []);
  assert.deepEqual(harness.store.workspaceBindingsByState(['preparing', 'ready', 'blocked']), []);
  // A shared binding is not isolation and needs no metadata write, so it still resolves and validates.
  const binding = harness.manager.resolve(session.id);
  assert.equal(binding.kind, 'shared');
  await harness.manager.validate(binding, new AbortController().signal);
});

test('archiving preserves the work, and restoring rebuilds the same workspace', async (t) => {
  const harness = await fixture(t);
  const { sessionId, executionRoot } = attachChild(harness);
  const signal = new AbortController().signal;
  await writeFile(path.join(executionRoot, 'same.txt'), 'child work\n');
  await writeFile(path.join(executionRoot, 'src', 'new.ts'), 'export const b = 2;\n');

  await harness.manager.archive(harness.bindingId, signal);
  const archived = harness.store.workspaceById(harness.bindingId)!;
  assert.equal(archived.state, 'archived');
  // What the child produced is still reachable as Git objects, referenced by the binding's own ref — an archived
  // workspace whose work was not saved would be work destroyed to save disk.
  const head = git(executionRoot, ['rev-parse', 'HEAD']);
  assert.equal(
    git(harness.root, ['rev-parse', `refs/yuantu/workspaces/${harness.bindingId}`]),
    head,
  );

  await rm(executionRoot, { recursive: true, force: true });
  const restored = await harness.manager.restore(harness.bindingId, signal);
  assert.equal(restored.state, 'ready');
  assert.equal(restored.id, archived.id, 'a restore is the same workspace, not a new one');
  assert.equal(restored.sessionId, sessionId);
  assert.equal(restored.executionRoot, executionRoot);
  // The directory is rebuilt from the frozen input, not from the archived one: the workspace comes back as it was
  // handed to the child, which is what makes a restore reproducible.
  assert.equal(await readFile(path.join(executionRoot, 'same.txt'), 'utf8'), 'dirty base\n');
  await harness.manager.validate(restored, signal);
});

test('reconciliation classifies leftovers without replaying anything', async (t) => {
  const harness = await fixture(t);
  const signal = new AbortController().signal;
  // A `preparing` row whose directory never appeared: an allocation that died before it created anything.
  const orphan = harness.store.createWorkspaceBinding({
    parentSessionId: harness.parentSessionId,
    projectRoot: harness.root,
    executionRoot: path.join(harness.root, '.yuantu', 'worktrees', 'never-created'),
    repositoryRoot: harness.root,
    kind: 'worktree',
    snapshotId: harness.snapshotId,
    baseCommit: harness.store.workspaceSnapshot(harness.snapshotId)!.baseCommit,
  });
  // A `ready` binding whose directory was removed behind its back: blocked, and never silently re-pointed.
  const gone = await harness.manager.allocate({
    parentSessionId: harness.parentSessionId,
    taskId: 'gone',
    snapshot: harness.store.workspaceSnapshot(harness.snapshotId)!,
    signal,
  });
  // Match this fixture's teardown policy for transient Windows file handles. The
  // missing directory is a prerequisite of the recovery case, not its outcome.
  await rm(gone.executionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await assert.rejects(stat(gone.executionRoot), { code: 'ENOENT' });

  await harness.manager.reconcile(signal);
  assert.equal(harness.store.workspaceById(orphan.id)!.state, 'removed');
  assert.equal(harness.store.workspaceById(gone.id)!.state, 'blocked');
  // Reconciliation is idempotent: a second pass finds consistent state and changes nothing.
  await harness.manager.reconcile(signal);
  assert.equal(harness.store.workspaceById(orphan.id)!.state, 'removed');
  assert.equal(harness.store.workspaceById(gone.id)!.state, 'blocked');
});

test('the manifest the allocation was built from is on disk and matches the filled tree', async (t) => {
  const harness = await fixture(t);
  const binding = harness.store.workspaceById(harness.bindingId)!;
  const identity = await repositoryIdentity(harness.root);
  const manifest = await readManifest(identity!.repositoryRoot, harness.snapshotId);
  assert.ok(manifest);
  assert.ok(manifest.files.length >= 2);
  for (const entry of manifest.files) {
    const actual = await readFile(
      path.join(binding.executionRoot, ...entry.path.split('/')),
      'utf8',
    );
    assert.equal(
      actual,
      (await snapshotFileBytes(identity!.repositoryRoot, harness.snapshotId, entry)).toString(
        'utf8',
      ),
      entry.path,
    );
  }
  // Every path Git lists in the worktree is one the baseline names, so a result computed there cannot include a
  // file the snapshot never froze.
  const listed = git(binding.executionRoot, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
    .split('\n')
    .filter(Boolean)
    .filter((name) => !name.startsWith('.yuantu/'))
    .sort();
  assert.deepEqual(listed, manifest.files.map((entry) => entry.path).sort());
});
