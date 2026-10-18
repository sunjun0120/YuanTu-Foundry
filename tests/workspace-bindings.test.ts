import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore, WorkspaceFailure } from '../packages/storage/sqlite.ts';
import {
  canTransition,
  gitObjectId,
  relativeWorkspacePath,
  workspaceBindingFrom,
  workspacePath,
} from '../packages/protocol/workspaces.ts';
import { isWithin, samePath } from '../packages/platform/workspace-paths.ts';

/**
 * The durable half of workspace isolation.
 *
 * What these cases hold the store to is that a *logical project* and an *execution directory* are two different
 * facts which cannot be confused: a child may work somewhere else entirely, but it still belongs to the project
 * its parent belongs to, and a binding that says otherwise is refused where it is read rather than travelling
 * into a child's tool registry.
 */

/**
 * A temporary project plus every store opened over it.
 *
 * The two halves are cleaned up by one hook rather than two, in the order that actually works on Windows: every
 * connection has to be closed *before* the directory is unlinked, or the removal fails with EBUSY on the `-wal`
 * and `-shm` sidecars. Relying on two `after` hooks to run in the right order is the sort of thing that works
 * until it does not, so the ordering is written down here instead of assumed.
 */
class Harness {
  readonly root: string;
  private readonly stores: SessionStore[] = [];
  constructor(root: string) {
    this.root = root;
  }
  use(name = 'sessions.sqlite'): SessionStore {
    const store = new SessionStore(path.join(this.root, '.yuantu', name));
    this.stores.push(store);
    return store;
  }
  /** Closes a store this test is finished with, and stops the cleanup from closing it twice. */
  release(store: SessionStore): void {
    store.close();
    const index = this.stores.indexOf(store);
    if (index >= 0) this.stores.splice(index, 1);
  }
  async close(): Promise<void> {
    for (const store of this.stores.splice(0)) store.close();
    // Retries because Windows releases a closed file's lock asynchronously: the connection is gone and the
    // handle is still briefly open in the kernel.
    await rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

async function scratch(t: test.TestContext): Promise<Harness> {
  const harness = new Harness(await mkdtemp(path.join(tmpdir(), 'yuantu-workspaces-')));
  t.after(() => harness.close());
  return harness;
}

test('a session written before isolation reads as a shared binding on its own project', async (t) => {
  const harness = await scratch(t);
  const root = harness.root;
  const store = harness.use();
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const session = store.create(project);

  const binding = store.workspaceBinding(session.id);
  assert.equal(binding.kind, 'shared');
  assert.equal(binding.state, 'ready');
  assert.equal(binding.sessionId, session.id);
  assert.equal(binding.projectRoot, project);
  // The two roots being the same directory *is* the pre-isolation behaviour, and saying so is what lets every
  // existing session keep its journal and undo semantics without a migration.
  assert.equal(binding.executionRoot, project);
  assert.equal(binding.snapshotId, null);
  assert.equal(binding.baseCommit, null);
  // Synthesised rather than written: no row may be invented for a session this service never bound.
  assert.equal(store.workspaceBindingsByState(['preparing', 'ready']).length, 0);
});

test('a child session must belong to the parent project, but may execute elsewhere', async (t) => {
  const harness = await scratch(t);
  const root = harness.root;
  const store = harness.use();
  const project = path.join(root, 'project');
  const elsewhere = path.join(root, 'elsewhere');
  await mkdir(project, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  const parent = store.create(project);
  const child = store.create(project, parent.id);

  const binding = store.createWorkspaceBinding({
    parentSessionId: parent.id,
    projectRoot: project,
    executionRoot: elsewhere,
    repositoryRoot: project,
    kind: 'worktree',
    snapshotId: 'snap-1',
    baseCommit: 'a'.repeat(40),
  });
  assert.equal(binding.state, 'preparing');
  assert.equal(binding.sessionId, null, 'a directory exists before the session that will use it');

  const attached = store.attachWorkspaceBinding({
    bindingId: binding.id,
    childSessionId: child.id,
  });
  assert.equal(attached.state, 'ready');
  assert.equal(attached.sessionId, child.id);
  assert.equal(attached.projectRoot, project);
  assert.equal(attached.executionRoot, elsewhere);
  assert.equal(store.workspaceBinding(child.id).id, binding.id);
  // The child still belongs where it always did: nothing about a binding may move a session's project.
  assert.equal(store.get(child.id).workspace, project);
});

test('a binding for another project, another parent or another session is refused', async (t) => {
  const harness = await scratch(t);
  const root = harness.root;
  const store = harness.use();
  const projectA = path.join(root, 'a');
  const projectB = path.join(root, 'b');
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  const parentA = store.create(projectA);
  const parentB = store.create(projectB);
  const childA = store.create(projectA, parentA.id);
  const childB = store.create(projectB, parentB.id);

  // A binding claiming a project its parent does not belong to.
  assert.throws(
    () =>
      store.createWorkspaceBinding({
        parentSessionId: parentA.id,
        projectRoot: projectB,
        executionRoot: projectB,
        repositoryRoot: projectB,
        kind: 'shared',
      }),
    (error: unknown) =>
      error instanceof WorkspaceFailure && error.code === 'WORKSPACE_IDENTITY_MISMATCH',
  );
  // A child of another project cannot attach to this parent's binding.
  const binding = store.createWorkspaceBinding({
    parentSessionId: parentA.id,
    projectRoot: projectA,
    executionRoot: path.join(root, 'wt-a'),
    repositoryRoot: projectA,
    kind: 'worktree',
    snapshotId: 'snap-1',
    baseCommit: 'b'.repeat(40),
  });
  assert.throws(
    () => store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: childB.id }),
    (error: unknown) =>
      error instanceof WorkspaceFailure && error.code === 'WORKSPACE_IDENTITY_MISMATCH',
  );
  // A sibling of the same parent is not this binding's session either: the relationship is checked, not assumed.
  const sibling = store.create(projectA, parentA.id);
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: childA.id });
  assert.throws(
    () => store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: sibling.id }),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_INTEGRITY',
  );
});

test('a binding whose row no longer matches its session project is refused on read', async (t) => {
  const harness = await scratch(t);
  const root = harness.root;
  const store = harness.use();
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  await mkdir(project, { recursive: true });
  await mkdir(other, { recursive: true });
  const parent = store.create(project);
  const child = store.create(project, parent.id);
  const binding = store.createWorkspaceBinding({
    parentSessionId: parent.id,
    projectRoot: project,
    executionRoot: path.join(root, 'wt'),
    repositoryRoot: project,
    kind: 'worktree',
    snapshotId: 'snap-1',
    baseCommit: 'c'.repeat(40),
  });
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  harness.release(store);

  // Editing the session's project behind the binding's back is exactly the state a reader must refuse: the
  // binding would otherwise point the child's tools at a directory belonging to a project it does not own. The
  // edit is made on a raw connection rather than through the store, because nothing in this build offers a way to
  // do it — which is the point of the check.
  const raw = new DatabaseSync(path.join(root, '.yuantu', 'sessions.sqlite'));
  raw.prepare('UPDATE sessions SET workspace=? WHERE id=?').run(other, child.id);
  raw.close();
  const editing = harness.use();
  assert.throws(
    () => editing.workspaceBinding(child.id),
    (error: unknown) =>
      error instanceof WorkspaceFailure && error.code === 'WORKSPACE_IDENTITY_MISMATCH',
  );
});

test('states move only along the transitions the protocol declares', async (t) => {
  const harness = await scratch(t);
  const root = harness.root;
  const store = harness.use();
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const parent = store.create(project);
  const binding = store.createWorkspaceBinding({
    parentSessionId: parent.id,
    projectRoot: project,
    executionRoot: path.join(root, 'wt'),
    repositoryRoot: project,
    kind: 'worktree',
    snapshotId: 'snap-1',
    baseCommit: 'd'.repeat(40),
  });

  // A state the caller did not believe is refused rather than applied.
  assert.throws(
    () => store.setWorkspaceState({ bindingId: binding.id, expect: 'ready', to: 'archiving' }),
    (error: unknown) => error instanceof WorkspaceFailure,
  );
  // A transition the table does not contain is refused even when the belief is right.
  assert.throws(
    () => store.setWorkspaceState({ bindingId: binding.id, expect: 'preparing', to: 'archived' }),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_INTEGRITY',
  );
  assert.equal(
    store.setWorkspaceState({ bindingId: binding.id, expect: 'preparing', to: 'blocked' }).state,
    'blocked',
  );
  // `blocked` can come back, which is what makes a transient failure recoverable without a new directory.
  assert.equal(
    store.setWorkspaceState({ bindingId: binding.id, expect: 'blocked', to: 'preparing' }).state,
    'preparing',
  );
  assert.equal(
    store.setWorkspaceState({ bindingId: binding.id, expect: ['preparing', 'ready'], to: 'ready' })
      .state,
    'ready',
  );
  // Every state the table lists is a state this build can name, and the terminal ones lead back only through an
  // explicit restore.
  for (const from of [
    'preparing',
    'ready',
    'blocked',
    'archiving',
    'archived',
    'removing',
    'removed',
  ] as const)
    assert.equal(canTransition(from, from), true);
  assert.equal(canTransition('removed', 'ready'), false);
  assert.equal(canTransition('removed', 'preparing'), true);
});

test('a snapshot is its own identity: the same id with different contents is refused', async (t) => {
  const harness = await scratch(t);
  const root = harness.root;
  const store = harness.use();
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const snapshot = {
    id: 'snapshot-1',
    projectRoot: project,
    sourceRoot: project,
    sourceHead: 'e'.repeat(40),
    baseCommit: 'f'.repeat(40),
    baseTree: '1'.repeat(40),
    manifestHash: 'a'.repeat(64),
  };
  assert.equal(store.recordWorkspaceSnapshot(snapshot).manifestHash, snapshot.manifestHash);
  // Re-recording the same snapshot is idempotent: two children of one delegation call must be able to publish
  // the same frozen input without racing.
  assert.equal(store.recordWorkspaceSnapshot(snapshot).id, 'snapshot-1');
  // A second claim on the same id with different bytes is two inputs wearing one name, and the durable result of
  // accepting it would be a child working from a baseline nobody froze.
  assert.throws(
    () => store.recordWorkspaceSnapshot({ ...snapshot, baseTree: '2'.repeat(40) }),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_INTEGRITY',
  );
  assert.equal(store.workspaceSnapshot('snapshot-1')?.baseTree, '1'.repeat(40));
  assert.equal(store.workspaceSnapshots().length, 1);
});

test('results and import receipts are durable, and a receipt is keyed by target', async (t) => {
  const harness = await scratch(t);
  const root = harness.root;
  const store = harness.use();
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const parent = store.create(project);
  const child = store.create(project, parent.id);
  const binding = store.createWorkspaceBinding({
    parentSessionId: parent.id,
    projectRoot: project,
    executionRoot: path.join(root, 'wt'),
    repositoryRoot: project,
    kind: 'worktree',
    snapshotId: 'snap-1',
    baseCommit: 'a'.repeat(40),
  });
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  const result = store.recordWorkspaceResult({
    id: 'result-1',
    bindingId: binding.id,
    childSessionId: child.id,
    parentSessionId: parent.id,
    snapshotId: 'snap-1',
    comparisonTree: 'b'.repeat(40),
    resultTree: 'c'.repeat(40),
    digest: 'd'.repeat(64),
    paths: ['src/a.ts', 'docs/b.md'],
    status: 'ready',
  });
  assert.deepEqual(result.paths, ['src/a.ts', 'docs/b.md']);
  assert.deepEqual(
    store.workspaceResults(parent.id).map((entry) => entry.id),
    ['result-1'],
  );
  assert.deepEqual(
    store.childWorkspaceResults(child.id).map((entry) => entry.id),
    ['result-1'],
  );
  // A result is frozen: the same id with a different digest is two results wearing one name.
  assert.throws(
    () => store.recordWorkspaceResult({ ...result, digest: 'e'.repeat(64) }),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_INTEGRITY',
  );

  const receipt = store.recordWorkspaceApplyReceipt({
    resultId: result.id,
    digest: result.digest,
    targetBindingId: 'target-1',
    changeId: 'change-1',
  });
  // Repeating the request returns the receipt that already exists instead of recording a second import.
  assert.deepEqual(
    store.recordWorkspaceApplyReceipt({
      resultId: result.id,
      digest: result.digest,
      targetBindingId: 'target-1',
      changeId: 'change-2',
    }).id,
    receipt.id,
  );
  assert.equal(
    store.recordWorkspaceApplyReceipt({
      resultId: result.id,
      digest: result.digest,
      targetBindingId: 'target-2',
      changeId: 'change-3',
    }).changeId,
    'change-3',
  );

  // A follow-up turn makes the importable result stale, and the answer to "what did the parent accept" stays.
  assert.deepEqual(
    store.supersedeWorkspaceResults(child.id).map((entry) => entry.id),
    ['result-1'],
  );
  assert.equal(store.workspaceResult('result-1')?.status, 'superseded');
  store.setWorkspaceResultStatus({ resultId: 'result-1', expect: 'superseded', to: 'applied' });
  assert.deepEqual(store.supersedeWorkspaceResults(child.id), []);
});

test('deleting a session takes its results and receipts, except an import interrupted mid-way', async (t) => {
  const harness = await scratch(t);
  const root = harness.root;
  const store = harness.use();
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const parent = store.create(project);
  const child = store.create(project, parent.id);
  const other = store.create(project);
  const otherChild = store.create(project, other.id);
  const record = (
    id: string,
    childSessionId: string,
    parentSessionId: string,
    status: 'ready' | 'applying',
  ) =>
    store.recordWorkspaceResult({
      id,
      bindingId: `binding-${id}`,
      childSessionId,
      parentSessionId,
      snapshotId: 'snap-1',
      comparisonTree: 'b'.repeat(40),
      resultTree: 'c'.repeat(40),
      digest: 'd'.repeat(64),
      paths: ['src/a.ts'],
      status,
    });
  record('done', child.id, parent.id, 'ready');
  record('interrupted', child.id, parent.id, 'applying');
  record('unrelated', otherChild.id, other.id, 'ready');
  for (const resultId of ['done', 'interrupted', 'unrelated'])
    store.recordWorkspaceApplyReceipt({
      resultId,
      digest: 'd'.repeat(64),
      targetBindingId: 'target',
      changeId: `change-${resultId}`,
    });
  const receipt = (resultId: string) =>
    store.workspaceApplyReceipt({ resultId, digest: 'd'.repeat(64), targetBindingId: 'target' });

  // The child dies with its parent, and the results between them go too: they named sessions that no longer exist.
  store.delete(parent.id);
  assert.equal(store.workspaceResult('done'), null);
  assert.equal(receipt('done'), null, 'its import receipt with it');
  // Startup recovery decides an interrupted import from this row; deleting it would leave half-written files unrecorded.
  assert.equal(store.workspaceResult('interrupted')?.status, 'applying');
  assert.equal(receipt('interrupted')?.changeId, 'change-interrupted');
  assert.equal(
    store.workspaceResult('unrelated')?.status,
    'ready',
    'another conversation is untouched',
  );
  assert.equal(receipt('unrelated')?.changeId, 'change-unrelated');
});

test('the protocol refuses a row this build cannot interpret', () => {
  const absolute = path.resolve('somewhere');
  // A relative path is either a bug or a hand-edited row, and guessing a base for it would point a child at the
  // wrong tree; `..` segments are what a path-traversal bug looks like after normalisation stopped helping.
  assert.throws(() => workspacePath('relative/dir'), /must be absolute/);
  assert.throws(() => relativeWorkspacePath('../escape.ts'), /Invalid workspace path/);
  assert.throws(() => relativeWorkspacePath('C:/escape.ts'), /Invalid workspace path/);
  assert.throws(() => relativeWorkspacePath('a\\b.ts'), /Invalid workspace path/);
  assert.equal(relativeWorkspacePath('src/a.ts'), 'src/a.ts');
  // Object ids are accepted at the widths Git actually uses, and refused at the widths it does not.
  assert.equal(gitObjectId('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(gitObjectId('b'.repeat(64)), 'b'.repeat(64));
  assert.throws(() => gitObjectId('c'.repeat(39)), /Invalid git/);
  assert.throws(() => gitObjectId('Z'.repeat(40)), /Invalid git/);
  // An isolated binding without a snapshot is not an isolated binding: there is nothing for it to have been
  // built from, so it is refused where it is read.
  assert.throws(
    () =>
      workspaceBindingFrom({
        id: 'b1',
        sessionId: 's1',
        parentSessionId: 'p1',
        projectRoot: absolute,
        executionRoot: absolute,
        repositoryRoot: absolute,
        kind: 'worktree',
        snapshotId: null,
        baseCommit: null,
        state: 'ready',
      }),
    /must name its snapshot and baseline/,
  );
  const shared = workspaceBindingFrom({
    id: 'b2',
    sessionId: 's1',
    parentSessionId: 'p1',
    projectRoot: absolute,
    executionRoot: absolute,
    repositoryRoot: absolute,
    kind: 'shared',
    snapshotId: null,
    baseCommit: null,
    state: 'ready',
  });
  assert.equal(shared.kind, 'shared');
});

test('paths are compared by what they name, not by how they are spelled', () => {
  const base = path.resolve('repo');
  assert.equal(samePath(base, base.toUpperCase()), process.platform === 'win32');
  assert.equal(samePath(base, path.join(base, '.')), true);
  assert.equal(isWithin(base, path.join(base, 'sub')), true);
  assert.equal(isWithin(base, base), true);
  // A sibling whose name merely starts with the same letters is a different directory, which a string-prefix
  // test would get wrong.
  assert.equal(isWithin(base, `${base}-other`), false);
  assert.equal(isWithin(base, path.resolve(base, '..', 'sibling')), false);
});
