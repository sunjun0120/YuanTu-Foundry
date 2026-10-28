import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../packages/workspaces/results.ts';
import { createDispatcher } from '../apps/agent-host/dispatch.ts';
import type { HostContext } from '../apps/agent-host/state.ts';
import { ResourceLocks } from '../apps/agent-host/resource-locks.ts';
import { PermissionPolicy } from '../packages/protocol/permission-policy.ts';
import type { Approval } from '../packages/protocol/index.ts';
import { HookRegistry } from '../packages/tools/registry.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { git } from './git-fixture.ts';

/**
 * The workspace RPC surface.
 *
 * Two things are being held here, and they fail differently. The first is *ownership*: the workspace tables are not
 * scoped by project the way `sessions` is, so every handler has to prove the session belongs to this Host before it
 * reads anything — and a request naming another workspace must be refused with the same sentence every other
 * handler uses. The second is that a query must *answer* rather than throw when the thing it describes is broken:
 * "this directory is gone" is the state of a workspace, not an error in asking about it.
 */

interface Harness {
  ctx: HostContext;
  store: SessionStore;
  root: string;
  sessionId: string;
  dispatch: ReturnType<typeof createDispatcher>;
  beforeClose: (() => Promise<void>)[];
}

async function host(t: test.TestContext): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-host-ws-'));
  const state = `${root}-state`;
  const store = new SessionStore(path.join(state, 'sessions.sqlite'));
  const beforeClose: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const cleanup of beforeClose) await cleanup();
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
    locks: new ResourceLocks(),
    manualOperations: new Set(),
    options: { allowWrite: true },
    launchSandbox: { mode: 'host' },
    defaultSandboxMode: 'host',
    defaultSandboxFiles: 'workspace-write',
    sessionSandboxes: new Map(),
    sessionSandboxFiles: new Map(),
    sessionSandboxNetwork: new Map(),
    sessionPermissionPolicies: new Map(),
    approvals: new Map(),
    approvalSources: new WeakMap(),
    carrier: { send() {} },
    background: { async close() {} },
  } as unknown as HostContext;
  return { ctx, store, root, sessionId: session.id, dispatch: createDispatcher(ctx), beforeClose };
}

async function childResult(h: Harness) {
  const manager = new WorkspaceManager({ store: h.store });
  const service = new WorkspaceResultsService({ store: h.store });
  const child = h.store.create(h.root, h.sessionId);
  const signal = new AbortController().signal;
  const snapshot = await manager.freeze({
    parentSessionId: h.sessionId,
    sourceBinding: manager.resolve(h.sessionId),
    signal,
  });
  const binding = await manager.allocate({
    parentSessionId: h.sessionId,
    taskId: 'approval',
    snapshot,
    signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'made.txt'), 'by the child\n');
  return service.export({ childSessionId: child.id, signal });
}

for (const boundary of ['deny', 'read-only', 'revoke-while-approving'] as const) {
  test(`workspace.apply refuses ${boundary} without changing files or the journal`, async (t) => {
    const h = await host(t);
    const result = await childResult(h);
    const deny = new PermissionPolicy({ version: 1, rules: [{ kind: 'write', effect: 'deny' }] });
    if (boundary === 'deny') h.ctx.permissionPolicy = deny;
    if (boundary === 'read-only') h.ctx.sessionSandboxFiles.set(h.sessionId, 'read-only');
    if (boundary === 'revoke-while-approving') {
      h.ctx.options.allowWrite = false;
      h.ctx.carrier.send = (data: unknown) => {
        const frame = data as { event: { data: { approvalId: string } } };
        h.ctx.permissionPolicy = deny;
        void h.dispatch('approval.respond', {
          approvalId: frame.event.data.approvalId,
          allow: true,
        });
      };
    }
    await assert.rejects(
      h.dispatch('workspace.apply', {
        sessionId: h.sessionId,
        resultId: result.id,
        expectedDigest: result.digest,
      }),
      /permission denied|read-only/i,
    );
    await assert.rejects(access(path.join(h.root, 'made.txt')));
    assert.equal(h.store.fileChanges(h.sessionId).length, 0);
    assert.equal(h.store.workspaceResult(result.id)!.status, 'ready');
    assert.deepEqual(h.ctx.locks.claims(), []);
    assert.equal(h.ctx.approvals.size, 0);
  });
}

test('workspace.apply waits for the user to approve the pinned result and file preview', async (t) => {
  const h = await host(t);
  const result = await childResult(h);
  h.ctx.options.allowWrite = false;
  let resolveRequest!: (value: { approvalId: string; approval: Approval }) => void;
  let rejectRequest!: (reason: unknown) => void;
  const requested = new Promise<{ approvalId: string; approval: Approval }>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  h.ctx.carrier.send = (data: unknown) => {
    const frame = data as {
      event: { type: string; data: { approvalId: string; approval: Approval } };
    };
    if (frame.event.type === 'approval.required') resolveRequest(frame.event.data);
  };
  const applying = h.dispatch('workspace.apply', {
    sessionId: h.sessionId,
    resultId: result.id,
    expectedDigest: result.digest,
  });
  // Observe rejection immediately, even if a regression bypasses the prompt.
  void applying.catch(rejectRequest);
  h.beforeClose.push(async () => {
    for (const entry of h.ctx.approvals.values()) entry.resolve(false);
    await applying.catch(() => {});
  });
  const decision = await Promise.race([
    requested,
    applying.then(() => {
      throw new Error('Import completed without asking for approval');
    }),
  ]);
  assert.equal(decision.approval.kind, 'write');
  assert.equal(decision.approval.toolCall.name, 'workspace_result_apply');
  assert.deepEqual(decision.approval.toolCall.arguments, {
    resultId: result.id,
    expectedDigest: result.digest,
  });
  assert.deepEqual(
    decision.approval.change!.changes!.map((change) => change.path),
    ['made.txt'],
  );
  await assert.rejects(access(path.join(h.root, 'made.txt')));
  await h.dispatch('approval.respond', { approvalId: decision.approvalId, allow: true });
  assert.equal(((await applying) as { status: string }).status, 'applied');
  assert.equal(await readFile(path.join(h.root, 'made.txt'), 'utf8'), 'by the child\n');
  assert.equal(h.ctx.approvals.size, 0);
});

test('run.cancel aborts only the manual operation belonging to that session', async (t) => {
  const h = await host(t);
  const other = h.store.create(h.root);
  const controller = new AbortController();
  h.ctx.manualOperations.add({ sessionId: h.sessionId, controller });
  assert.deepEqual(await h.dispatch('run.cancel', { sessionId: other.id }), { cancelled: false });
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(await h.dispatch('run.cancel', { sessionId: h.sessionId }), { cancelled: true });
  assert.equal(controller.signal.aborted, true);
});

test('cancelling workspace.apply settles its approval without importing and releases the Host', async (t) => {
  const h = await host(t);
  const result = await childResult(h);
  h.ctx.options.allowWrite = false;
  h.ctx.carrier.send = () => {
    void h.dispatch('run.cancel', { sessionId: h.sessionId });
  };
  await assert.rejects(
    h.dispatch('workspace.apply', {
      sessionId: h.sessionId,
      resultId: result.id,
      expectedDigest: result.digest,
    }),
    /abort|cancel/i,
  );
  assert.equal(h.ctx.approvals.size, 0);
  assert.equal(h.ctx.manualOperations.size, 0);
  assert.deepEqual(h.ctx.locks.claims(), []);
  await assert.rejects(access(path.join(h.root, 'made.txt')));
  assert.equal(h.store.fileChanges(h.sessionId).length, 0);
  h.ctx.options.allowWrite = true;
  assert.equal(
    (
      (await h.dispatch('workspace.apply', {
        sessionId: h.sessionId,
        resultId: result.id,
        expectedDigest: result.digest,
      })) as { status: string }
    ).status,
    'applied',
  );
});

test('workspace.apply reports a conflict introduced before tool preparation as a structured result', async (t) => {
  const h = await host(t);
  const result = await childResult(h);
  const hooks = new HookRegistry();
  h.ctx.hooks = hooks;
  t.after(() => hooks.close());
  hooks.register({
    beforeTool: async () => {
      await writeFile(path.join(h.root, 'made.txt'), 'parent edited it\n');
    },
  });
  const response = (await h.dispatch('workspace.apply', {
    sessionId: h.sessionId,
    resultId: result.id,
    expectedDigest: result.digest,
  })) as { status: string; conflicts: string[]; files: unknown[] };
  assert.equal(response.status, 'conflict');
  assert.deepEqual(response.conflicts, ['made.txt']);
  assert.deepEqual(response.files, []);
  assert.equal(await readFile(path.join(h.root, 'made.txt'), 'utf8'), 'parent edited it\n');
  assert.equal(h.store.fileChanges(h.sessionId).length, 0);
  assert.deepEqual(h.ctx.locks.claims(), []);
});

test('a real client keeps workspace.apply pending beyond its ordinary request deadline for approval', async (t) => {
  const h = await host(t);
  const result = await childResult(h);
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: h.root,
    db: path.join(`${h.root}-state`, 'sessions.sqlite'),
    requestTimeoutMs: 1000,
    env: { YUANTU_SANDBOX: 'host', YUANTU_SESSION_TITLES: '0', YUANTU_WORKFLOWS: 'false' },
  });
  h.beforeClose.push(() => client.stop());
  await client.start();
  let onApproval!: (id: string) => void;
  const requested = new Promise<string>((resolve) => {
    onApproval = resolve;
  });
  client.subscribe((event) => {
    if (event.type === 'approval.required') onApproval(String(event.data.approvalId));
  });
  const applying = client.request('workspace.apply', {
    sessionId: h.sessionId,
    resultId: result.id,
    expectedDigest: result.digest,
  });
  let failure: unknown;
  void applying.catch((error: unknown) => {
    failure = error;
  });
  const approvalId = await Promise.race([
    requested,
    applying.then(() => {
      throw new Error('Import completed without approval');
    }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(
    failure,
    undefined,
    'the caller must keep waiting while the approval remains pending',
  );
  await assert.rejects(access(path.join(h.root, 'made.txt')));
  await client.request('approval.respond', { approvalId, allow: true });
  assert.equal((await applying).status, 'applied');
  assert.equal(await readFile(path.join(h.root, 'made.txt'), 'utf8'), 'by the child\n');
});

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

  const archiving = h.dispatch('workspace.archive', { sessionId: child.id });
  /**
   * Registered while it runs, so Stop for this session and the Host's own shutdown can reach it. The handler
   * used to pass `new AbortController().signal`, whose abort checks the manager honours and no caller can set.
   */
  assert.equal([...h.ctx.manualOperations][0]?.sessionId, child.id);
  const archived = (await archiving) as {
    archived: true;
    bindingId: string;
    state: string;
  };
  const afterArchive = [...h.ctx.manualOperations][0];
  assert.equal(afterArchive, undefined);
  assert.equal(archived.archived, true);
  assert.equal(archived.bindingId, binding.id);
  assert.equal(h.store.workspaceById(binding.id)!.state, 'archived');
  const removing = h.dispatch('workspace.remove', { sessionId: child.id });
  assert.equal([...h.ctx.manualOperations][0]?.sessionId, child.id);
  const removed = (await removing) as {
    removed: boolean;
  };
  const afterRemove = [...h.ctx.manualOperations][0];
  assert.equal(afterRemove, undefined);
  assert.equal(removed.removed, true);
  const restoring = h.dispatch('workspace.restore', { sessionId: child.id });
  assert.equal([...h.ctx.manualOperations][0]?.sessionId, child.id);
  const restored = (await restoring) as {
    restored: true;
    binding: { id: string; state: string; executionRoot: string };
  };
  const afterRestore = [...h.ctx.manualOperations][0];
  assert.equal(afterRestore, undefined);
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
