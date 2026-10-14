import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../packages/workspaces/results.ts';
import { createDispatcher } from '../apps/agent-host/dispatch.ts';
import type { HostContext } from '../apps/agent-host/state.ts';

/**
 * The workspace RPC surface.
 *
 * Two things are being held here, and they fail differently. The first is *ownership*: the workspace tables are not
 * scoped by project the way `sessions` is, so every handler has to prove the session belongs to this Host before it
 * reads anything — and a request naming another workspace must be refused with the same sentence every other
 * handler uses. The second is that a query must *answer* rather than throw when the thing it describes is broken:
 * "this directory is gone" is the state of a workspace, not an error in asking about it.
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

interface Harness {
  ctx: HostContext;
  store: SessionStore;
  root: string;
  sessionId: string;
  dispatch: ReturnType<typeof createDispatcher>;
}

async function host(t: test.TestContext): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-host-ws-'));
  const state = `${root}-state`;
  const store = new SessionStore(path.join(state, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
  const session = store.create(root);
  const ctx = {
    store,
    workspace: root,
    active: new Map(),
    restoring: false,
  } as unknown as HostContext;
  return { ctx, store, root, sessionId: session.id, dispatch: createDispatcher(ctx) };
}

test('a session with no binding reports itself as shared over its own project', async (t) => {
  const h = await host(t);
  const answer = (await h.dispatch('workspaces.get', { sessionId: h.sessionId })) as {
    binding: {
      kind: string;
      state: string;
      executionRoot: string;
      projectRoot: string;
      snapshotId: string | null;
    };
    snapshot: unknown;
    problems: string[];
  };
  // A session written before isolation existed reads as shared rather than as "not found" — otherwise every
  // historical session would look like one this Host cannot describe.
  assert.equal(answer.binding.kind, 'shared');
  assert.equal(answer.binding.state, 'ready');
  assert.equal(answer.binding.executionRoot, h.root);
  assert.equal(answer.binding.projectRoot, h.root);
  assert.equal(answer.binding.snapshotId, null);
  assert.equal(answer.snapshot, null);
  assert.deepEqual(answer.problems, []);
});

test('an isolated Node project reports missing dependencies without blocking source access', async (t) => {
  const h = await host(t);
  await writeFile(
    path.join(h.root, 'package.json'),
    JSON.stringify({ dependencies: { example: '1.0.0' } }),
  );
  const manager = new WorkspaceManager({ store: h.store });
  const signal = new AbortController().signal;
  const snapshot = await manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: manager.resolve(h.sessionId),
    signal,
  });
  const binding = await manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'deps',
    snapshot,
    signal,
  });
  const child = h.store.create(h.root, h.sessionId);
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  const answer = (await h.dispatch('workspaces.get', { sessionId: child.id })) as {
    binding: { state: string };
    problems: string[];
    dependencyWarnings: { code: string }[];
  };
  assert.equal(answer.binding.state, 'ready');
  assert.deepEqual(answer.problems, []);
  assert.equal(answer.dependencyWarnings[0]?.code, 'WORKSPACE_DEPENDENCIES_MISSING');
  assert.equal(await readFile(path.join(binding.executionRoot, 'a.txt'), 'utf8'), 'a\n');
});

test('an isolated workspace reports its frozen input, and its removal as a problem', async (t) => {
  const h = await host(t);
  const manager = new WorkspaceManager({ store: h.store });
  const child = h.store.create(h.root, h.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: manager.resolve(h.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });

  const answer = (await h.dispatch('workspaces.get', { sessionId: child.id })) as {
    binding: { kind: string; executionRoot: string; snapshotId: string | null };
    snapshot: { id: string; baseCommit: string } | null;
    problems: string[];
  };
  assert.equal(answer.binding.kind, 'worktree');
  assert.equal(answer.binding.snapshotId, snapshot.id);
  assert.equal(answer.snapshot?.baseCommit, snapshot.baseCommit);
  assert.deepEqual(answer.problems, []);

  // A directory that is no longer there is reported as a *problem*, not thrown: a client asking about a workspace
  // has to be able to render "this one is broken" without treating the answer as a failed request.
  await rm(binding.executionRoot, { recursive: true, force: true });
  const broken = (await h.dispatch('workspaces.get', { sessionId: child.id })) as {
    problems: string[];
  };
  assert.equal(broken.problems.length, 1);
  assert.match(broken.problems[0]!, /WORKSPACE_MISSING/);
});

test('a session from another project is refused before anything is read', async (t) => {
  const h = await host(t);
  const other = await mkdtemp(path.join(tmpdir(), 'yuantu-host-other-'));
  t.after(() => rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const foreign = h.store.create(other);
  // Every method answers with the same refusal the rest of the Host uses, which is deliberate: a caller learns
  // nothing useful from being told *how* it does not own the session, and one sentence per rule is one rule.
  for (const method of [
    'workspaces.get',
    'workspace.results',
    'workspace.apply',
    'workspace.archive',
    'workspace.restore',
    'workspace.remove',
  ])
    await assert.rejects(
      h.dispatch(method, {
        sessionId: foreign.id,
        resultId: 'any',
        expectedDigest: 'f'.repeat(64),
      }),
      /Session belongs to a different workspace/,
      `${method} must refuse another project's session`,
    );
});

test('workspace.results lists what each child produced, with the file detail', async (t) => {
  const h = await host(t);
  const manager = new WorkspaceManager({ store: h.store });
  const results = new WorkspaceResultsService({ store: h.store });
  const child = h.store.create(h.root, h.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: manager.resolve(h.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'made.txt'), 'by the child\n');
  await results.export({ childSessionId: child.id, signal: new AbortController().signal });

  const listed = (await h.dispatch('workspace.results', { sessionId: h.sessionId })) as {
    id: string;
    digest: string;
    status: string;
    paths: string[];
    files: { path: string; kind: string }[];
    evidence: unknown[];
  }[];
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.status, 'ready');
  assert.deepEqual(listed[0]!.paths, ['made.txt']);
  assert.deepEqual(
    listed[0]!.files.map((file) => [file.path, file.kind]),
    [['made.txt', 'create']],
  );
  // The digest a client quotes on apply is the record's own, so the client never has to compute one.
  assert.match(listed[0]!.digest, /^[0-9a-f]{32,}$/);
});

test('workspace.apply imports a result, and reports a conflict without writing', async (t) => {
  const h = await host(t);
  const manager = new WorkspaceManager({ store: h.store });
  const results = new WorkspaceResultsService({ store: h.store });
  const child = h.store.create(h.root, h.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: manager.resolve(h.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'made.txt'), 'by the child\n');
  const result = await results.export({
    childSessionId: child.id,
    signal: new AbortController().signal,
  });

  const applied = (await h.dispatch('workspace.apply', {
    sessionId: h.sessionId,
    resultId: result.id,
    expectedDigest: result.digest,
  })) as { status: string; changeId?: string; conflicts: string[]; files: { path: string }[] };
  assert.equal(applied.status, 'applied');
  assert.ok(applied.changeId);
  assert.deepEqual(applied.conflicts, []);
  assert.equal(await readFile(path.join(h.root, 'made.txt'), 'utf8'), 'by the child\n');
  // The import is a normal change of the session, so a client's ordinary change list and undo already cover it.
  assert.equal(h.store.fileChanges(h.sessionId).length, 1);

  // A conflict is a result rather than a failure, and it writes nothing.
  await writeFile(path.join(binding.executionRoot, 'made.txt'), 'changed again\n');
  const second = await results.export({
    childSessionId: child.id,
    signal: new AbortController().signal,
  });
  await writeFile(path.join(h.root, 'made.txt'), 'parent edited it\n');
  const conflicted = (await h.dispatch('workspace.apply', {
    sessionId: h.sessionId,
    resultId: second.id,
    expectedDigest: second.digest,
  })) as { status: string; conflicts: string[] };
  assert.equal(conflicted.status, 'conflict');
  assert.deepEqual(conflicted.conflicts, ['made.txt']);
  assert.equal(await readFile(path.join(h.root, 'made.txt'), 'utf8'), 'parent edited it\n');
  assert.equal(h.store.fileChanges(h.sessionId).length, 1, 'no second change was journalled');
});

test('archive and restore keep the same workspace identity through the RPC surface', async (t) => {
  const h = await host(t);
  const manager = new WorkspaceManager({ store: h.store });
  const child = h.store.create(h.root, h.sessionId);
  const snapshot = await manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: manager.resolve(h.sessionId),
    signal: new AbortController().signal,
  });
  const binding = await manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'task-1',
    snapshot,
    signal: new AbortController().signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'work.txt'), 'the child wrote this\n');

  const archived = (await h.dispatch('workspace.archive', { sessionId: child.id })) as {
    archived: true;
    bindingId: string;
    state: string;
  };
  assert.equal(archived.archived, true);
  assert.equal(archived.bindingId, binding.id);
  assert.equal(h.store.workspaceById(binding.id)!.state, 'archived');
  const removed = (await h.dispatch('workspace.remove', { sessionId: child.id })) as {
    removed: boolean;
  };
  assert.equal(removed.removed, true);
  const restored = (await h.dispatch('workspace.restore', { sessionId: child.id })) as {
    restored: true;
    binding: { id: string; state: string; executionRoot: string };
  };
  assert.equal(restored.restored, true);
  assert.equal(restored.binding.id, binding.id, 'a restore is the same workspace, not a new one');
  assert.equal(restored.binding.state, 'ready');
  // Rebuilt from the frozen input rather than from the archived directory, which is what makes it reproducible.
  assert.equal(await readFile(path.join(binding.executionRoot, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(
    await readFile(path.join(binding.executionRoot, 'work.txt'), 'utf8'),
    'the child wrote this\n',
  );
});
