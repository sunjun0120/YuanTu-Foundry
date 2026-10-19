import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionStore, WorkspaceFailure } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../packages/workspaces/results.ts';
import { openHostServices } from '../apps/agent-host/services.ts';
import type { Options } from '../apps/shared/args.ts';

/**
 * Surviving a restart.
 *
 * The property under test is that a binding is *durable state about a directory*, not a fact this process happens
 * to remember. Everything here therefore closes a store and opens a new one over the same file — which is what a
 * restart is — and asks the reloaded process the same questions. Three answers must survive that: which directory a
 * session works in, that a directory which is no longer the one recorded is *refused* rather than silently adopted,
 * and that an archived workspace can be rebuilt without changing its identity.
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
 * A repository plus every store opened over it.
 *
 * The stores are tracked and closed by one hook, in the order that works on Windows: every connection has to be
 * closed *before* the directory is unlinked, or the removal fails with EBUSY on SQLite's `-wal` sidecar. Since this
 * suite is *about* closing and reopening, that ordering is the one thing the fixture has to get right.
 */
class Workspace {
  readonly root: string;
  readonly state: string;
  readonly db: string;
  readonly sessionId: string;
  /** What the CLI or Host would be given; only `workspace` and `db` matter to the services under test. */
  readonly options: Options;
  private readonly stores: SessionStore[] = [];
  constructor(input: { root: string; state: string; db: string; sessionId: string }) {
    this.root = input.root;
    this.state = input.state;
    this.db = input.db;
    this.sessionId = input.sessionId;
    this.options = {
      workspace: this.root,
      db: this.db,
      help: false,
      json: false,
      allowWrite: false,
      allowCommand: false,
    };
  }
  /** A store over this workspace's database, as a new process would open one. */
  open(): SessionStore {
    const store = new SessionStore(this.db);
    this.stores.push(store);
    return store;
  }
  /** Takes ownership of a store this fixture did not construct, so it is closed before the directory goes. */
  track(store: SessionStore): SessionStore {
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
    await rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    await rm(this.state, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

async function prepared(t: test.TestContext): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-recovery-'));
  const state = `${root}-state`;
  const db = path.join(state, 'sessions.sqlite');
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
  const seed = new SessionStore(db);
  const session = seed.create(root);
  seed.close();
  const workspace = new Workspace({ root, state, db, sessionId: session.id });
  t.after(() => workspace.close());
  return workspace;
}

test('a binding survives a restart, and the session still resolves to the same directory', async (t) => {
  const w = await prepared(t);
  const first = w.open();
  const manager = new WorkspaceManager({ store: first });
  const child = first.create(w.root, w.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: w.sessionId,
    sourceBinding: manager.resolve(w.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: w.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  first.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'work.txt'), 'the child wrote this\n');
  w.release(first);

  // A new process over the same file: this is the whole of "restart".
  const second = w.open();
  const reloaded = new WorkspaceManager({ store: second });
  const resolved = reloaded.resolve(child.id);
  assert.equal(resolved.id, binding.id);
  assert.equal(resolved.executionRoot, binding.executionRoot);
  assert.equal(resolved.projectRoot, w.root);
  assert.equal(resolved.state, 'ready');
  // The directory still holds what the child left there, and it is still the one Git registered.
  assert.equal(
    await readFile(path.join(resolved.executionRoot, 'work.txt'), 'utf8'),
    'the child wrote this\n',
  );
  await reloaded.validate(resolved, new AbortController().signal);
  // A session with no binding still reads as shared over its own project after a restart: the synthesised answer is
  // a property of the session, not of the process that happened to write it.
  assert.equal(reloaded.resolve(w.sessionId).kind, 'shared');
});

test('a directory replaced behind the binding is blocked, never adopted', async (t) => {
  const w = await prepared(t);
  const store = w.open();
  const manager = new WorkspaceManager({ store });
  const child = store.create(w.root, w.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: w.sessionId,
    sourceBinding: manager.resolve(w.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: w.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });

  // The directory is removed and a *different* directory is put in its place — the case that must never be adopted,
  // because a result computed there would be attributed to a workspace this session does not own.
  await rm(binding.executionRoot, { recursive: true, force: true });
  await writeFile(binding.executionRoot, 'not a directory any more\n');

  await manager.reconcile(new AbortController().signal);
  assert.equal(store.workspaceById(binding.id)!.state, 'blocked');
  // Recovery does not fall back to the parent's directory: the binding still names the isolated one, which is what
  // lets a person see what happened instead of the service quietly writing into the wrong tree.
  assert.equal(store.workspaceBinding(child.id).executionRoot, binding.executionRoot);
  await assert.rejects(manager.validate(binding, new AbortController().signal));
});

test('an archived workspace is rebuilt from its frozen input, with the same identity', async (t) => {
  const w = await prepared(t);
  const store = w.open();
  const manager = new WorkspaceManager({ store });
  const child = store.create(w.root, w.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: w.sessionId,
    sourceBinding: manager.resolve(w.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: w.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'produced.txt'), 'kept somewhere\n');
  const signal = new AbortController().signal;
  await manager.archive(binding.id, signal);
  assert.equal(store.workspaceById(binding.id)!.state, 'archived');
  // The work is reachable as a Git object, which is what "archived" has to mean: an archive whose contents were not
  // saved is a workspace destroyed to save disk.
  const head = git(binding.executionRoot, ['rev-parse', 'HEAD']);
  assert.equal(git(w.root, ['rev-parse', `refs/yuantu/workspaces/${binding.id}`]), head);

  await rm(binding.executionRoot, { recursive: true, force: true });
  const restored = await manager.restore(binding.id, signal);
  assert.equal(restored.id, binding.id);
  assert.equal(restored.sessionId, child.id);
  assert.equal(restored.state, 'ready');
  // Rebuilt from the *frozen input*, not from the archived directory: the workspace comes back as the child was
  // handed it, which is what makes a restore reproducible rather than a copy of whatever was left behind.
  assert.equal(await readFile(path.join(restored.executionRoot, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(
    await readFile(path.join(restored.executionRoot, 'produced.txt'), 'utf8').catch(() => 'absent'),
    'absent',
  );
});

async function removalFixture(t: test.TestContext) {
  const w = await prepared(t);
  const store = w.open();
  const manager = new WorkspaceManager({ store });
  const child = store.create(w.root, w.sessionId);
  const signal = new AbortController().signal;
  const snapshot = await manager.freeze({
    parentSessionId: w.sessionId,
    sourceBinding: manager.resolve(w.sessionId),
    signal,
  });
  const binding = await manager.allocate({
    parentSessionId: w.sessionId,
    taskId: 'cleanup',
    snapshot,
    signal,
  });
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  return { w, store, manager, child, signal, binding };
}

test('removing an archived workspace retains its uncommitted work for restore', async (t) => {
  const { w, store, manager, child, signal, binding } = await removalFixture(t);
  await writeFile(path.join(binding.executionRoot, 'produced.txt'), 'the only copy\n');
  await manager.archive(binding.id, signal);
  await manager.remove(binding.id, signal);
  assert.equal(store.workspaceById(binding.id)!.state, 'removed');
  assert.equal(
    await readFile(path.join(binding.executionRoot, 'produced.txt')).catch(() => null),
    null,
  );
  assert.equal(await readFile(path.join(w.root, 'a.txt'), 'utf8'), 'a\n');
  assert.throws(
    () => store.beginRun(child.id),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_BUSY',
  );
  const restored = await manager.restore(binding.id, signal);
  assert.equal(restored.id, binding.id);
  assert.equal(
    await readFile(path.join(restored.executionRoot, 'produced.txt'), 'utf8'),
    'the only copy\n',
  );
});

test('workspace cleanup refuses a live session even through the manager directly', async (t) => {
  const { store, manager, child, signal, binding } = await removalFixture(t);
  store.beginRun(child.id);
  await assert.rejects(
    manager.archive(binding.id, signal),
    (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_BUSY',
  );
  assert.equal(store.workspaceById(binding.id)!.state, 'ready');
  assert.equal(await readFile(path.join(binding.executionRoot, 'a.txt'), 'utf8'), 'a\n');
});

test('removing a workspace refuses ignored files that its snapshot would not preserve', async (t) => {
  const { store, manager, signal, binding } = await removalFixture(t);
  await writeFile(path.join(binding.executionRoot, '.gitignore'), 'unique.log\n');
  await writeFile(path.join(binding.executionRoot, 'unique.log'), 'must not be lost\n');
  await manager.archive(binding.id, signal);
  await assert.rejects(manager.remove(binding.id, signal), /preserv|snapshot|ignored/i);
  assert.equal(
    await readFile(path.join(binding.executionRoot, 'unique.log'), 'utf8'),
    'must not be lost\n',
  );
  assert.notEqual(store.workspaceById(binding.id)!.state, 'removed');
});

test('a workspace with no source changes can be removed and restored', async (t) => {
  const { manager, signal, binding } = await removalFixture(t);
  await manager.archive(binding.id, signal);
  await manager.remove(binding.id, signal);
  const restored = await manager.restore(binding.id, signal);
  assert.equal(await readFile(path.join(restored.executionRoot, 'a.txt'), 'utf8'), 'a\n');
});

test('cleanup preserves a deleted source file as a deletion rather than rejecting its index entry', async (t) => {
  const { manager, signal, binding } = await removalFixture(t);
  git(binding.executionRoot, ['add', 'a.txt']);
  await rm(path.join(binding.executionRoot, 'a.txt'));
  await manager.archive(binding.id, signal);
  await manager.remove(binding.id, signal);
  const restored = await manager.restore(binding.id, signal);
  await assert.rejects(readFile(path.join(restored.executionRoot, 'a.txt')), { code: 'ENOENT' });
});

test('recovery converges a removal interrupted after Git deleted the directory', async (t) => {
  const { w, store, manager, signal, binding } = await removalFixture(t);
  await writeFile(path.join(binding.executionRoot, 'produced.txt'), 'saved before deletion\n');
  await manager.archive(binding.id, signal);
  await manager.remove(binding.id, signal);
  // Crash point: filesystem removal succeeded but the final database transition was not written.
  const db = new DatabaseSync(w.db);
  try {
    db.prepare("UPDATE workspace_bindings SET state='removing' WHERE id=?").run(binding.id);
  } finally {
    db.close();
  }
  await manager.reconcile(signal);
  assert.equal(store.workspaceById(binding.id)!.state, 'removed');
  const restored = await manager.restore(binding.id, signal);
  assert.equal(
    await readFile(path.join(restored.executionRoot, 'produced.txt'), 'utf8'),
    'saved before deletion\n',
  );
});

test('a second manager cannot recover or restore a workspace while cleanup owns it', async (t) => {
  const { w, store, manager, signal, binding } = await removalFixture(t);
  await manager.archive(binding.id, signal);
  const token = store.claimWorkspaceOperation(binding.id);
  try {
    store.setWorkspaceState({ bindingId: binding.id, expect: 'archived', to: 'removing' });
    const other = new WorkspaceManager({ store: w.open() });
    await other.reconcile(signal);
    assert.equal(store.workspaceById(binding.id)!.state, 'removing');
    await assert.rejects(
      other.restore(binding.id, signal),
      (error: unknown) => error instanceof WorkspaceFailure && error.code === 'WORKSPACE_BUSY',
    );
    assert.equal(await readFile(path.join(binding.executionRoot, 'a.txt'), 'utf8'), 'a\n');
  } finally {
    store.releaseWorkspaceOperation(binding.id, token);
  }
  await manager.reconcile(signal);
  assert.equal(store.workspaceById(binding.id)!.state, 'blocked');
  assert.equal((await manager.restore(binding.id, signal)).state, 'ready');
});

test('a real process exit leaves a cleanup lease that recovery can safely take over', async (t) => {
  const { w, store, manager, signal, binding } = await removalFixture(t);
  await manager.archive(binding.id, signal);
  const code = `const {SessionStore} = await import(process.argv[1]);
    const store = new SessionStore(process.argv[2]);
    store.claimWorkspaceOperation(process.argv[3]);
    store.setWorkspaceState({bindingId:process.argv[3],expect:'archived',to:'removing'});
    process.exit(0);`;
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      code,
      pathToFileURL(path.resolve('packages/storage/sqlite.ts')).href,
      w.db,
      binding.id,
    ],
    { windowsHide: true },
  );
  assert.equal(store.workspaceById(binding.id)!.state, 'removing');
  await manager.reconcile(signal);
  assert.equal(store.workspaceById(binding.id)!.state, 'blocked');
  assert.equal((await manager.restore(binding.id, signal)).state, 'ready');
  assert.equal(await readFile(path.join(binding.executionRoot, 'a.txt'), 'utf8'), 'a\n');
});

test('a cleanup lease whose pid now belongs to another process can be taken over', async (t) => {
  const { w, store, manager, signal, binding } = await removalFixture(t);
  await manager.archive(binding.id, signal);
  const token = store.claimWorkspaceOperation(binding.id);
  store.setWorkspaceState({ bindingId: binding.id, expect: 'archived', to: 'removing' });
  /**
   * The crashed owner's pid has been handed to a live process — this one stands in for it — whose start time is
   * not the one the lease recorded. By pid alone the lease looked held forever and the worktree could never be
   * archived, removed or restored again.
   */
  const db = new DatabaseSync(w.db);
  try {
    db.prepare('UPDATE workspace_operation_leases SET owner_started_at=1 WHERE binding_id=?').run(
      binding.id,
    );
  } finally {
    db.close();
  }
  assert.equal(store.workspaceById(binding.id)!.state, 'removing');
  await manager.reconcile(signal);
  assert.equal(store.workspaceById(binding.id)!.state, 'blocked');
  assert.equal((await manager.restore(binding.id, signal)).state, 'ready');
  // The forsaken token is no longer the lease's: releasing it now is a no-op, not a release of someone else's.
  store.releaseWorkspaceOperation(binding.id, token);
});

test('a lease an older build renewed is judged by its pid alone', async (t) => {
  const { w, store, manager, signal, binding } = await removalFixture(t);
  await manager.archive(binding.id, signal);
  const token = store.claimWorkspaceOperation(binding.id);
  try {
    store.setWorkspaceState({ bindingId: binding.id, expect: 'archived', to: 'removing' });
    // An older build's upsert changes the token but not the start-time columns it does not know about, so the
    // recorded start time is someone else's. It must not be read as evidence that the live owner is gone.
    const db = new DatabaseSync(w.db);
    try {
      db.prepare(
        "UPDATE workspace_operation_leases SET owner_started_at=1, owner_started_token='stale' WHERE binding_id=?",
      ).run(binding.id);
    } finally {
      db.close();
    }
    await new WorkspaceManager({ store: w.open() }).reconcile(signal);
    assert.equal(store.workspaceById(binding.id)!.state, 'removing');
  } finally {
    store.releaseWorkspaceOperation(binding.id, token);
  }
});

test('recovery leaves a live preparing workspace alone before its directory exists', async (t) => {
  const { w, store, manager, signal, binding } = await removalFixture(t);
  await manager.archive(binding.id, signal);
  await manager.remove(binding.id, signal);
  const token = store.claimWorkspaceOperation(binding.id);
  try {
    store.setWorkspaceState({ bindingId: binding.id, expect: 'removed', to: 'preparing' });
    await new WorkspaceManager({ store: w.open() }).reconcile(signal);
    assert.equal(store.workspaceById(binding.id)!.state, 'preparing');
  } finally {
    store.releaseWorkspaceOperation(binding.id, token);
  }
  await manager.reconcile(signal);
  assert.equal(store.workspaceById(binding.id)!.state, 'removed');
  assert.equal((await manager.restore(binding.id, signal)).state, 'ready');
});

test('the Host converges interrupted allocations and imports before serving', async (t) => {
  const w = await prepared(t);
  const first = w.open();
  const manager = new WorkspaceManager({ store: first });
  const results = new WorkspaceResultsService({ store: first });
  const child = first.create(w.root, w.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: w.sessionId,
    sourceBinding: manager.resolve(w.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: w.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  first.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });

  // A `preparing` row whose directory never appeared: an allocation that died before creating anything. Nothing can
  // be running in a directory that does not exist, so the record is what has to go.
  const never = first.createWorkspaceBinding({
    parentSessionId: w.sessionId,
    projectRoot: w.root,
    executionRoot: path.join(w.root, '.yuantu', 'worktrees', 'never-created'),
    repositoryRoot: w.root,
    kind: 'worktree',
    snapshotId: snapshot.id,
    baseCommit: snapshot.baseCommit,
  });
  // A `blocked` row whose directory is gone as well: recovery keeps the directory record and the state, because
  // deleting it would discard a child's work to tidy a record.
  const gone = await manager.allocate({
    parentSessionId: w.sessionId,
    taskId: 'task-2',
    snapshot,
    signal: new AbortController().signal,
  });
  await rm(gone.executionRoot, { recursive: true, force: true });
  w.release(first);

  // The Host's own start-up path, which is where the two convergence passes live.
  const services = await openHostServices(w.options, w.root);
  // Tracked by the fixture rather than closed here: the *ordering* against the directory removal is the fixture's
  // job, and a store the fixture does not know about is exactly the one that leaves a `-wal` file locked.
  w.track(services.store);
  assert.equal(services.store.workspaceById(never.id)!.state, 'removed');
  assert.equal(services.store.workspaceById(gone.id)!.state, 'blocked');
  // The live workspace is untouched by either pass.
  assert.equal(services.store.workspaceById(binding.id)!.state, 'ready');
  void results;
});

test('a Host restart does not migrate a binding when the default mode changes', async (t) => {
  const w = await prepared(t);
  const first = w.open();
  const manager = new WorkspaceManager({ store: first });
  const child = first.create(w.root, w.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: w.sessionId,
    sourceBinding: manager.resolve(w.sessionId),
    signal: new AbortController().signal,
  });
  const allocated = await manager.allocate({
    parentSessionId: w.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  first.attachWorkspaceBinding({ bindingId: allocated.id, childSessionId: child.id });
  w.release(first);

  // Reading the binding back never consults a mode: a persisted child keeps the directory it was given, whatever a
  // later default says. That is the difference between a setting and a migration, and only one of them is safe.
  const second = w.open();
  const reloaded = new WorkspaceManager({ store: second });
  const binding = reloaded.resolve(child.id);
  assert.equal(binding.kind, 'worktree');
  assert.equal(binding.executionRoot, allocated.executionRoot);
  await reloaded.validate(binding, new AbortController().signal);
});

test('a shared session from before isolation still resolves and reconciles', async (t) => {
  const w = await prepared(t);
  const store = w.open();
  const manager = new WorkspaceManager({ store });
  const binding = manager.resolve(w.sessionId);
  assert.equal(binding.kind, 'shared');
  assert.equal(binding.id, `shared:${w.sessionId}`);
  assert.equal(binding.executionRoot, w.root);
  // A reconciliation pass has nothing to classify for it — it owns no directory this service created — and it must
  // not invent one, which would turn every historical session into a worktree nobody asked for.
  await manager.reconcile(new AbortController().signal);
  assert.deepEqual(store.workspaceBindingsByState(['preparing', 'ready', 'blocked']), []);
  await manager.validate(binding, new AbortController().signal);
});

test('a missing snapshot is refused rather than reconstructed', async (t) => {
  const w = await prepared(t);
  const store = w.open();
  const manager = new WorkspaceManager({ store });
  const child = store.create(w.root, w.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: w.sessionId,
    sourceBinding: manager.resolve(w.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: w.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await rm(binding.executionRoot, { recursive: true, force: true });
  // The frozen metadata is removed too, so a restore has nothing to rebuild from. Guessing a baseline — HEAD, or the
  // current directory — would produce a workspace whose contents nobody chose.
  await rm(path.join(w.root, '.yuantu', 'workspace-snapshots', snapshot.id), {
    recursive: true,
    force: true,
  });
  await assert.rejects(
    manager.restore(binding.id, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceFailure);
      return true;
    },
  );
  // The outcome is a *state*, never a silent success: a restore with nothing to rebuild from has to leave the
  // binding blocked, because `ready` would claim a directory that does not exist.
  assert.equal(store.workspaceById(binding.id)!.state, 'blocked');
});
