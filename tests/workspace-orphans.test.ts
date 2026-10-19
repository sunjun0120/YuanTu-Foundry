import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../packages/workspaces/results.ts';
import { createDispatcher } from '../apps/agent-host/dispatch.ts';
import { hostClaim, type HostContext } from '../apps/agent-host/state.ts';
import { ResourceLocks } from '../apps/agent-host/resource-locks.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { spawnedCarrier } from '../packages/carrier/index.ts';
import { projectRoot } from './process-fixture.ts';

/**
 * A workspace whose session is gone.
 *
 * Deleting a session sets `workspace_bindings.session_id` to null — deliberately, because the child's exported
 * results have to outlive the session that produced them. What that leaves behind is a directory this service
 * still owns and nothing can name: every other workspace method is addressed by session id, and the session no
 * longer exists. These tests hold the two halves of the answer: the orphan has to be *visible* for the project it
 * belongs to, and it has to be *addressable by its own id* for the operations that preserve, remove and rebuild it
 * — without ever becoming addressable for a workspace whose session is alive, or for another project's.
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

/** A committed repository, which is the precondition of every managed workspace. */
async function repository(t: test.TestContext, content = 'a\n'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-ws-orphan-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'a.txt'), content);
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
  return root;
}

interface Harness {
  ctx: HostContext;
  store: SessionStore;
  root: string;
  sessionId: string;
  dispatch: ReturnType<typeof createDispatcher>;
}

async function host(t: test.TestContext): Promise<Harness> {
  const root = await repository(t);
  const state = `${root}-state`;
  const store = new SessionStore(path.join(state, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
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
    terminals: { async closeAllAndWait() {} },
    invariants: {
      async run() {
        return [];
      },
    },
    announced: new Set<string>(),
  } as unknown as HostContext;
  return { ctx, store, root, sessionId: session.id, dispatch: createDispatcher(ctx) };
}

/** One delegated child with a filled worktree, an exported result, and (optionally) its session deleted. */
async function delegatedChild(
  h: Harness,
  options: { projectRoot: string; parentSessionId: string; delete: boolean },
) {
  const manager = new WorkspaceManager({ store: h.store });
  const results = new WorkspaceResultsService({ store: h.store });
  const signal = new AbortController().signal;
  const child = h.store.create(options.projectRoot, options.parentSessionId);
  const snapshot = await manager.freeze({
    parentSessionId: options.parentSessionId,
    sourceBinding: manager.resolve(options.parentSessionId),
    signal,
  });
  const binding = await manager.allocate({
    parentSessionId: options.parentSessionId,
    taskId: 'orphan',
    snapshot,
    signal,
  });
  h.store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
  await writeFile(path.join(binding.executionRoot, 'made.txt'), 'by the child\n');
  const result = await results.export({ childSessionId: child.id, signal });
  if (options.delete) await h.dispatch('session.delete', { sessionId: child.id });
  return { childId: child.id, binding, result };
}

interface OrphanEntry {
  binding: { id: string; sessionId: string | null; state: string; executionRoot: string };
  problems: string[];
  results: { id: string; status: string; paths: string[]; digest: string }[];
}

test('a desktop carrier can manage orphan bindings without a living child session', async (t) => {
  const h = await host(t);
  const { binding } = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: true,
  });
  const carrier = spawnedCarrier({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: h.root,
    db: path.join(`${h.root}-state`, 'sessions.sqlite'),
    env: { YUANTU_SANDBOX: 'host', YUANTU_SESSION_TITLES: 'false' },
  });
  try {
    await carrier.start();
    assert.equal((await carrier.orphanWorkspaces())[0]?.binding.id, binding.id);
    await carrier.maintainOrphanWorkspace(binding.id, 'archive');
    await carrier.maintainOrphanWorkspace(binding.id, 'remove');
    await assert.rejects(access(binding.executionRoot));
    assert.equal((await carrier.orphanWorkspaces())[0]?.binding.state, 'removed');
    await carrier.maintainOrphanWorkspace(binding.id, 'restore');
    assert.equal(
      await readFile(path.join(binding.executionRoot, 'made.txt'), 'utf8'),
      'by the child\n',
    );
  } finally {
    await carrier.stop();
  }
});

test('a deleted session leaves a workspace this project can still list, remove and restore', async (t) => {
  const h = await host(t);
  const { childId, binding, result } = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: true,
  });

  // The row is still there with everything that identifies it — project, parent, snapshot — and only the session
  // reference is gone, which is exactly why addressing it by session id can no longer work.
  const orphan = h.store.workspaceById(binding.id)!;
  assert.equal(orphan.sessionId, null);
  assert.equal(orphan.state, 'ready');
  assert.equal(orphan.parentSessionId, h.sessionId);
  await access(binding.executionRoot);
  await assert.rejects(h.dispatch('workspace.archive', { sessionId: childId }), /not found/i);

  const listed = (await h.dispatch('workspaces.orphaned', {})) as OrphanEntry[];
  assert.deepEqual(
    listed.map((entry) => entry.binding.id),
    [binding.id],
  );
  assert.deepEqual(listed[0]!.problems, []);
  // The result record went with the sessions it named (session deletion removes results); the directory, and the
  // bytes the child wrote in it, are what the orphan keeps.
  assert.deepEqual(listed[0]!.results, []);
  assert.equal(h.store.workspaceResult(result.id), null);
  await access(path.join(binding.executionRoot, 'made.txt'));
  // Nothing was merged into the delegator's own directory, which is what makes this work "unmerged" rather than lost.
  await assert.rejects(access(path.join(h.root, 'made.txt')));

  // Later edits were never exported as a result; cleanup must preserve the actual bytes too.
  await writeFile(path.join(binding.executionRoot, 'made.txt'), 'unexported edit\n');
  await writeFile(path.join(binding.executionRoot, 'late.txt'), 'unexported file\n');

  // The preserving path first, then the removing path: an orphan is cleaned up only through the same
  // snapshot-before-delete order a live workspace uses.
  const archived = (await h.dispatch('workspace.archive', { bindingId: binding.id })) as {
    archived: true;
    bindingId: string;
  };
  assert.equal(archived.archived, true);
  assert.equal(archived.bindingId, binding.id);
  const removed = (await h.dispatch('workspace.remove', { bindingId: binding.id })) as {
    removed: true;
  };
  assert.equal(removed.removed, true);
  await assert.rejects(access(binding.executionRoot));
  assert.equal(h.store.workspaceById(binding.id)!.state, 'removed');
  // A removed workspace is not something left to clean up, so the listing stops offering it.
  assert.deepEqual(await h.dispatch('workspaces.orphaned', {}), []);

  // And the directory is recoverable, from the frozen input, under the same identity.
  const restored = (await h.dispatch('workspace.restore', { bindingId: binding.id })) as {
    binding: { id: string; state: string };
  };
  assert.equal(restored.binding.id, binding.id);
  assert.equal(restored.binding.state, 'ready');
  assert.equal(
    await readFile(path.join(binding.executionRoot, 'made.txt'), 'utf8'),
    'unexported edit\n',
  );
  assert.equal(
    await readFile(path.join(binding.executionRoot, 'late.txt'), 'utf8'),
    'unexported file\n',
  );
});

test('a binding id addresses only an orphan of this project', async (t) => {
  const h = await host(t);
  const live = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: false,
  });

  // A workspace whose session is alive keeps being addressed by that session: the id is not a second, weaker door
  // into a directory somebody is working in.
  await assert.rejects(
    h.dispatch('workspace.archive', { bindingId: live.binding.id }),
    /WORKSPACE_INTEGRITY/,
  );
  // An id that names nothing is refused as such, and naming both a session and a binding is ambiguous rather than
  // resolved by preference.
  await assert.rejects(
    h.dispatch('workspace.archive', { bindingId: 'no-such-binding' }),
    /WORKSPACE_NOT_FOUND/,
  );
  await assert.rejects(
    h.dispatch('workspace.archive', { sessionId: live.childId, bindingId: live.binding.id }),
    /either a session or a binding/,
  );
  await assert.rejects(h.dispatch('workspace.archive', {}), /Missing sessionId/);

  // A second project's orphan is neither listed here nor addressable from here, because this Host owns one project.
  const other = await repository(t, 'another project\n');
  const otherParent = h.store.create(other);
  const foreign = await delegatedChild(h, {
    projectRoot: other,
    parentSessionId: otherParent.id,
    delete: false,
  });
  h.store.delete(foreign.childId);
  assert.equal(h.store.workspaceById(foreign.binding.id)!.sessionId, null);
  assert.deepEqual(
    await h.dispatch('workspaces.orphaned', {}),
    [],
    'another project is not listed here',
  );
  await assert.rejects(
    h.dispatch('workspace.archive', { bindingId: foreign.binding.id }),
    /different workspace/,
  );
});

test('deleting the delegating session leaves its descendants workspaces listable', async (t) => {
  const h = await host(t);
  const { binding, result } = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: false,
  });

  // The parent's own deletion cascades to the child sessions, so no session is left that could name the directory.
  await h.dispatch('session.delete', { sessionId: h.sessionId });
  assert.equal(h.store.workspaceById(binding.id)!.sessionId, null);
  const listed = (await h.dispatch('workspaces.orphaned', {})) as OrphanEntry[];
  assert.deepEqual(
    listed.map((entry) => entry.binding.id),
    [binding.id],
  );
  assert.deepEqual(
    listed[0]!.results,
    [],
    'the result record went with the sessions; the directory below still holds the work',
  );
  assert.equal(h.store.workspaceResult(result.id), null);
  await h.dispatch('workspace.archive', { bindingId: binding.id });
  await h.dispatch('workspace.remove', { bindingId: binding.id });
  await h.dispatch('workspace.restore', { bindingId: binding.id });
  assert.equal(
    await readFile(path.join(binding.executionRoot, 'made.txt'), 'utf8'),
    'by the child\n',
  );
});

test('orphan maintenance rechecks the live Host file and execution policy', async (t) => {
  const h = await host(t);
  const { binding } = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: true,
  });
  for (const [method, expectedState] of [
    ['workspace.archive', 'ready'],
    ['workspace.remove', 'archived'],
    ['workspace.restore', 'removed'],
  ] as const) {
    // Only the file policy decides: a native default with workspace-write may maintain a worktree (the Host runs
    // the Git plumbing itself), and a read-only one may not, whichever backend enforces it.
    for (const [mode, files] of [
      ['native', 'read-only'],
      ['host', 'read-only'],
    ] as const) {
      h.ctx.defaultSandboxMode = mode;
      h.ctx.defaultSandboxFiles = files;
      await assert.rejects(
        h.dispatch(method, { bindingId: binding.id }),
        /WORKSPACE_POLICY_UNSUPPORTED/,
        `${method} under ${mode}/${files}`,
      );
      assert.equal(h.store.workspaceById(binding.id)!.state, expectedState);
    }
    h.ctx.defaultSandboxMode = method === 'workspace.remove' ? 'native' : 'host';
    h.ctx.defaultSandboxFiles = 'workspace-write';
    await h.dispatch(method, { bindingId: binding.id });
  }
  assert.equal(
    await readFile(path.join(binding.executionRoot, 'made.txt'), 'utf8'),
    'by the child\n',
  );
});

test('session maintenance uses its current selection rather than the Host default', async (t) => {
  const h = await host(t);
  const { childId, binding } = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: false,
  });
  h.ctx.sessionSandboxes.set(childId, 'native');
  h.ctx.sessionSandboxFiles.set(childId, 'read-only');
  await assert.rejects(
    h.dispatch('workspace.archive', { sessionId: childId }),
    /WORKSPACE_POLICY_UNSUPPORTED/,
  );
  h.ctx.sessionSandboxes.set(childId, 'host');
  await assert.rejects(
    h.dispatch('workspace.archive', { sessionId: childId }),
    /WORKSPACE_POLICY_UNSUPPORTED/,
  );
  assert.equal(h.store.workspaceById(binding.id)!.state, 'ready');
  // The session's own selection wins over a read-only Host default.
  h.ctx.sessionSandboxes.set(childId, 'native');
  h.ctx.sessionSandboxFiles.set(childId, 'workspace-write');
  h.ctx.defaultSandboxFiles = 'read-only';
  await h.dispatch('workspace.archive', { sessionId: childId });
  assert.equal(h.store.workspaceById(binding.id)!.state, 'archived');
});

test('busy Hosts refuse orphan writes while keeping their inventory readable', async (t) => {
  const h = await host(t);
  const { binding } = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: true,
  });
  const holding = h.ctx.locks.tryAcquire([hostClaim('exclusive')])!;
  await assert.rejects(h.dispatch('workspace.archive', { bindingId: binding.id }), /Host is busy/);
  holding.release();
  h.ctx.active.set(h.sessionId, { controller: new AbortController() });
  await assert.rejects(h.dispatch('workspace.archive', { bindingId: binding.id }), /Host is busy/);
  assert.equal(((await h.dispatch('workspaces.orphaned', {})) as OrphanEntry[]).length, 1);
  assert.equal(h.store.workspaceById(binding.id)!.state, 'ready');
  h.ctx.active.clear();
});

test('desktop orphan maintenance uses an owned live policy context without changing Host defaults', async (t) => {
  const h = await host(t);
  const { binding } = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: true,
  });
  h.ctx.defaultSandboxMode = 'native';
  h.ctx.sessionSandboxes.set(h.sessionId, 'host');
  h.ctx.sessionSandboxFiles.set(h.sessionId, 'read-only');
  await assert.rejects(
    h.dispatch('workspace.archive', { bindingId: binding.id, policySessionId: h.sessionId }),
    /WORKSPACE_POLICY_UNSUPPORTED/,
  );
  h.ctx.sessionSandboxFiles.set(h.sessionId, 'workspace-write');
  await h.dispatch('workspace.archive', { bindingId: binding.id, policySessionId: h.sessionId });
  assert.equal(h.ctx.defaultSandboxMode, 'native');
  assert.equal(h.store.workspaceById(binding.id)?.state, 'archived');
  const foreign = h.store.create(path.join(h.root, 'other-project'));
  await assert.rejects(
    h.dispatch('workspace.remove', { bindingId: binding.id, policySessionId: foreign.id }),
    /project|workspace|belong/i,
  );
  await assert.rejects(
    h.dispatch('workspace.remove', { sessionId: h.sessionId, policySessionId: h.sessionId }),
    /Invalid/,
  );
  assert.equal(h.store.workspaceById(binding.id)?.state, 'archived');
});

test('a restarted Host can discover removed orphans and restore their unmerged files', async (t) => {
  const h = await host(t);
  const { binding } = await delegatedChild(h, {
    projectRoot: h.root,
    parentSessionId: h.sessionId,
    delete: true,
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: h.root,
    db: path.join(`${h.root}-state`, 'sessions.sqlite'),
    env: { YUANTU_SANDBOX: 'host', YUANTU_WORKFLOWS: 'false', YUANTU_SESSION_TITLES: '0' },
  });
  // Close the child before the harness deletes its database, even when an assertion fails.
  try {
    const info = await client.start();
    assert.ok(info.capabilities.includes('workspace-orphans-v1'));
    await client.request('workspace.archive', { bindingId: binding.id });
    await client.request('workspace.remove', { bindingId: binding.id });
    await client.stop();
    await client.start();
    assert.deepEqual(await client.request('workspaces.orphaned', {}), []);
    const recoverable = await client.request('workspaces.orphaned', { includeRemoved: true });
    assert.deepEqual(
      recoverable.map((entry) => entry.binding.id),
      [binding.id],
    );
    assert.equal(recoverable[0]!.binding.state, 'removed');
    // The result record went with the deleted sessions; restoring works from the snapshot, as below shows.
    assert.equal(recoverable[0]!.results.length, 0);
    await assert.rejects(
      client.request('workspaces.orphaned', { includeRemoved: 'yes' as unknown as boolean }),
      /Invalid includeRemoved/,
    );
    await client.request('workspace.restore', { bindingId: recoverable[0]!.binding.id });
    assert.equal(
      await readFile(path.join(binding.executionRoot, 'made.txt'), 'utf8'),
      'by the child\n',
    );
  } finally {
    await client.stop();
  }
});
