import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { dueTasks } from '../packages/protocol/task-trigger.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';

test('an unattended approval survives restart and grants only the exact operation once', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-store-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  let storeClosed = false;
  let reopened: SessionStore | undefined;
  t.after(async () => {
    reopened?.close();
    if (!storeClosed) store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Guarded task',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const approval = {
    kind: 'write' as const,
    description: 'write_file: approved.txt',
    toolCall: {
      id: 'original',
      name: 'write_file',
      arguments: { path: 'approved.txt', content: 'ok' },
    },
  };
  store.deferTaskApproval(session.id, task.id, approval);
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  store.recordTaskRun(session.id, task.id, {
    at: new Date().toISOString(),
    trigger: task.trigger,
    error: 'Approval required',
  });
  assert.equal(store.getTask(session.id, task.id).pendingApproval?.state, 'pending');
  assert.equal(store.getTask(session.id, task.id).nextRunAt, undefined);
  assert.deepEqual(store.resumableTasks(root), []);
  store.close();
  storeClosed = true;

  reopened = new SessionStore(db);
  const waiting = reopened.getTask(session.id, task.id);
  assert.equal(waiting.pendingApproval?.tool, 'write_file');
  assert.equal(waiting.pendingApproval?.description, 'write_file: approved.txt');
  const approved = reopened.resolveTaskApproval(
    session.id,
    task.id,
    true,
    waiting.pendingApproval!.id,
  );
  assert.equal(approved.pendingApproval?.state, 'approved');
  assert.equal(dueTasks([approved], new Date()).at(0)?.source, 'recovery');
  assert.equal(
    reopened.consumeTaskApproval(session.id, task.id, {
      ...approval,
      toolCall: { ...approval.toolCall, arguments: { path: 'other.txt', content: 'ok' } },
    }),
    false,
  );
  assert.equal(
    reopened.consumeTaskApproval(session.id, task.id, {
      ...approval,
      description: 'different operation preview',
    }),
    false,
  );
  assert.equal(
    reopened.consumeTaskApproval(session.id, task.id, {
      ...approval,
      toolCall: { ...approval.toolCall, id: 'new-call' },
    }),
    true,
  );
  assert.equal(reopened.getTask(session.id, task.id).pendingApproval, undefined);
  assert.equal(reopened.consumeTaskApproval(session.id, task.id, approval), false);
});

test('a stale approval view cannot authorize a replacement request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-stale-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Changing request',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const oldRequest = store.deferTaskApproval(session.id, task.id, {
    kind: 'write',
    description: 'write old.txt',
    toolCall: { id: 'one', name: 'write_file', arguments: { path: 'old.txt', content: 'old' } },
  }).pendingApproval!;
  const currentRequest = store.deferTaskApproval(session.id, task.id, {
    kind: 'write',
    description: 'write new.txt',
    toolCall: { id: 'two', name: 'write_file', arguments: { path: 'new.txt', content: 'new' } },
  }).pendingApproval!;
  assert.notEqual(oldRequest.id, currentRequest.id);
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  assert.throws(
    () => store.resolveTaskApproval(session.id, task.id, true, oldRequest.id),
    /approval changed/i,
  );
  assert.equal(store.getTask(session.id, task.id).pendingApproval?.state, 'pending');
  assert.equal(
    store.resolveTaskApproval(session.id, task.id, true, currentRequest.id).pendingApproval?.state,
    'approved',
  );
});

test('rearming a task invalidates an identical old approval request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-rearm-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const trigger = { kind: 'interval' as const, enabled: true, everyMinutes: 60 };
  const task = store.createTask(session.id, { title: 'Repeat request', trigger });
  const approval = {
    kind: 'write' as const,
    description: 'write repeated.txt',
    toolCall: {
      id: 'same',
      name: 'write_file',
      arguments: { path: 'repeated.txt', content: 'ok' },
    },
  };
  const firstAttempt = store.startTaskAttempt(session.id, task.id, {
    kind: 'run',
    trigger: 'interval',
  });
  const stale = store.deferTaskApproval(session.id, task.id, approval).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, firstAttempt.id, { status: 'needs_review' });
  store.updateTask(session.id, task.id, { trigger });
  const secondAttempt = store.startTaskAttempt(session.id, task.id, {
    kind: 'run',
    trigger: 'interval',
  });
  const current = store.deferTaskApproval(session.id, task.id, approval).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, secondAttempt.id, { status: 'needs_review' });
  assert.notEqual(stale.id, current.id);
  assert.throws(
    () => store.resolveTaskApproval(session.id, task.id, true, stale.id),
    /approval changed/i,
  );
  assert.equal(
    store.resolveTaskApproval(session.id, task.id, true, current.id).pendingApproval?.state,
    'approved',
  );
});

test('a consumed approval pauses an interrupted event task for outcome review', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-unknown-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  let reopened: SessionStore | undefined;
  t.after(async () => {
    reopened?.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'External operation',
    trigger: { kind: 'event', enabled: true, on: 'session.created' },
  });
  const firstAttempt = store.startTaskAttempt(session.id, task.id, {
    kind: 'run',
    trigger: 'event',
  });
  const operation = {
    kind: 'external' as const,
    description: 'send data',
    toolCall: { id: 'call', name: 'remote_tool', arguments: { destination: 'service' } },
  };
  const pending = store.deferTaskApproval(session.id, task.id, operation).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, firstAttempt.id, { status: 'needs_review' });
  store.resolveTaskApproval(session.id, task.id, true, pending.id);
  store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'recovery', resume: true });
  assert.equal(store.consumeTaskApproval(session.id, task.id, operation), true);
  store.close();
  reopened = new SessionStore(db);
  reopened.recoverInterruptedTasks(root);
  const interrupted = reopened.getTask(session.id, task.id);
  assert.equal(interrupted.status, 'needs_review');
  assert.equal(interrupted.nextRunAt, undefined);
  assert.match(interrupted.lastTriggerError ?? '', /outcome.*unknown/i);
  assert.deepEqual(reopened.resumableTasks(root), []);
  assert.deepEqual(dueTasks([interrupted], new Date()), []);
  assert.equal(
    reopened.updateTask(session.id, task.id, { title: 'Check external effect' })
      .approvalOutcomeUnknown,
    true,
  );
  const manual = reopened.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'manual' });
  const recovered = reopened.finishTaskAttempt(session.id, task.id, manual.id, {
    status: 'completed',
  });
  assert.equal(recovered.approvalOutcomeUnknown, undefined);
  assert.equal(recovered.lastTriggerError, undefined);
});

test('scheduler finalization preserves an unknown approved-operation outcome', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-finalize-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const trigger = { kind: 'interval' as const, enabled: true, everyMinutes: 5 };
  const task = store.createTask(session.id, { title: 'Guarded effect', trigger });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const operation = {
    kind: 'external' as const,
    description: 'send data',
    toolCall: { id: 'call', name: 'remote_tool', arguments: { destination: 'service' } },
  };
  const pending = store.deferTaskApproval(session.id, task.id, operation).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  store.resolveTaskApproval(session.id, task.id, true, pending.id);
  const recovery = store.startTaskAttempt(session.id, task.id, {
    kind: 'run',
    trigger: 'recovery',
    resume: true,
  });
  assert.equal(store.consumeTaskApproval(session.id, task.id, operation), true);
  store.finishTaskAttempt(session.id, task.id, recovery.id, {
    status: 'needs_review',
    error: 'model failed after tool execution',
  });
  const recorded = store.recordTaskRun(session.id, task.id, {
    at: new Date().toISOString(),
    trigger,
    error: 'model failed after tool execution',
  });
  assert.equal(recorded.approvalOutcomeUnknown, true);
  assert.equal(recorded.nextRunAt, undefined);
  assert.deepEqual(dueTasks([recorded], new Date(Date.now() + 3600_000)), []);
});
test('a rejected event approval stays paused until its trigger is rearmed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-reject-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const trigger = { kind: 'event' as const, enabled: true, on: 'session.created' as const };
  const task = store.createTask(session.id, { title: 'Event task', trigger });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'event' });
  const firstPending = store.deferTaskApproval(session.id, task.id, {
    kind: 'external',
    description: 'send data',
    toolCall: { id: 'call', name: 'remote_tool', arguments: { destination: 'service' } },
  }).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  const rejected = store.resolveTaskApproval(session.id, task.id, false, firstPending.id);
  assert.equal(rejected.pendingApproval?.state, 'rejected');
  assert.equal(rejected.nextRunAt, undefined);
  assert.deepEqual(dueTasks([rejected], new Date()), []);
  assert.deepEqual(store.resumableTasks(root), []);
  assert.throws(
    () => store.resolveTaskApproval(session.id, task.id, true, firstPending.id),
    /no longer pending/,
  );

  const rearmed = store.updateTask(session.id, task.id, { trigger });
  assert.equal(rearmed.pendingApproval, undefined);
  assert.equal(rearmed.trigger?.enabled, true);

  const retry = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'event' });
  const secondPending = store.deferTaskApproval(session.id, task.id, {
    kind: 'external',
    description: 'send data',
    toolCall: { id: 'retry', name: 'remote_tool', arguments: { destination: 'service' } },
  }).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, retry.id, { status: 'needs_review' });
  const approved = store.resolveTaskApproval(session.id, task.id, true, secondPending.id);
  assert.equal(dueTasks([approved], new Date()).at(0)?.source, 'recovery');
  assert.equal(store.resumableTasks(root).at(0)?.id, task.id);
});

test('approving an acceptance command resumes verification without repeating the model run', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-verify-'));
  const db = path.join(root, '.yuantu', 'sessions.sqlite');
  const seed = new SessionStore(db);
  const session = seed.create(root);
  const task = seed.createTask(session.id, {
    title: 'Verify once',
    description: 'finish once',
    acceptance: [
      {
        description: 'Write verification marker',
        met: false,
        check: {
          id: 'marker',
          kind: 'command',
          command: process.execPath,
          args: ['-e', "require('node:fs').writeFileSync('verified.txt','ok')"],
        },
      },
    ],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  seed.scheduleImmediateRun(session.id, task.id);
  seed.close();
  let requests = 0;
  const url = await httpFixture(t, (_body, res) => {
    requests++;
    sendFrames(res, frames('Done'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_SANDBOX: 'host',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_WORKFLOW_INTERVAL_MS: '1000',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const deadline = Date.now() + 20_000;
  let waiting;
  while (Date.now() < deadline) {
    waiting = await client.request('task.get', { sessionId: session.id, taskId: task.id });
    if (waiting.pendingApproval?.state === 'pending' && waiting.lastRunAt) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(waiting?.pendingApproval?.state, 'pending');
  assert.equal(waiting?.pendingApproval?.phase, 'acceptance');
  assert.match(waiting?.lastTriggerError ?? '', /approval required/i);
  assert.equal(requests, 1);
  await assert.rejects(readFile(path.join(root, 'verified.txt')), { code: 'ENOENT' });
  await client.request('task.approval.respond', {
    sessionId: session.id,
    taskId: task.id,
    approvalId: waiting!.pendingApproval!.id,
    allow: true,
  });
  let resumed;
  while (Date.now() < deadline + 20_000) {
    resumed = await client.request('task.get', { sessionId: session.id, taskId: task.id });
    if (resumed.status === 'completed' && !resumed.pendingApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(resumed?.status, 'completed', resumed?.lastTriggerError);
  assert.equal(await readFile(path.join(root, 'verified.txt'), 'utf8'), 'ok');
  assert.equal(requests, 1);
});

test('a scheduled write waits for review, stays paused across Host restart, then resumes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-host-'));
  const db = path.join(root, '.yuantu', 'sessions.sqlite');
  const seed = new SessionStore(db);
  const session = seed.create(root);
  const task = seed.createTask(session.id, {
    title: 'Write after review',
    description: 'create approved.txt',
    steps: [{ description: 'write the file', status: 'pending' }],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
    /**
     * A definition the run can satisfy, and the progress that makes it satisfiable.
     *
     * A task with no criteria used to complete on the strength of its own final message; it now needs a criterion
     * with a check that passes and every declared step completed. The fixture therefore states the file's content
     * as the criterion — which is what this test was always about — and has the model checkpoint its step.
     */
    acceptance: [
      {
        description: 'approved.txt was written',
        met: false,
        check: { id: 'written', kind: 'file-contains', path: 'approved.txt', expected: 'reviewed' },
      },
    ],
  });
  seed.scheduleImmediateRun(session.id, task.id);
  seed.close();

  let requests = 0;
  const url = await httpFixture(t, (_body, res) => {
    requests++;
    if (requests <= 2)
      sendFrames(
        res,
        frames('', [
          { id: 'step-' + requests, name: 'task_step', input: { index: 0, status: 'completed' } },
          {
            id: 'write-' + requests,
            name: 'write_file',
            input: { path: 'approved.txt', content: 'reviewed' },
          },
        ]),
      );
    else sendFrames(res, frames('Done'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_WORKFLOW_INTERVAL_MS: '1000',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const deadline = Date.now() + 20_000;
  let waiting;
  while (Date.now() < deadline) {
    waiting = await client.request('task.get', { sessionId: session.id, taskId: task.id });
    if (waiting.pendingApproval?.state === 'pending' && waiting.lastRunAt) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(waiting?.pendingApproval?.state, 'pending');
  assert.equal(waiting?.status, 'needs_review');
  assert.match(waiting?.lastTriggerError ?? '', /approval/i);
  assert.equal(requests, 1);
  await assert.rejects(readFile(path.join(root, 'approved.txt')), { code: 'ENOENT' });

  await client.stop();
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.equal(requests, 1, 'a pending approval must not be retried after restart');
  const reviewed = await client.request('task.approval.respond', {
    sessionId: session.id,
    taskId: task.id,
    approvalId: waiting!.pendingApproval!.id,
    allow: true,
  });
  assert.equal(reviewed.pendingApproval?.state, 'approved');
  let resumed;
  while (Date.now() < deadline + 20_000) {
    resumed = await client.request('task.get', { sessionId: session.id, taskId: task.id });
    if (resumed.status === 'completed' && !resumed.pendingApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(resumed?.status, 'completed');
  assert.equal(resumed?.pendingApproval, undefined);
  assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'reviewed');
  assert.equal(requests, 3);
});

test('approved tool request ignores JSON property order but still checks approval detail', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-order-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Order-independent write',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const originalArgs = { path: 'approved.txt', content: 'reviewed' };
  const original = {
    kind: 'write' as const,
    description: `write_file: ${JSON.stringify(originalArgs)}\nOnly this reviewed file`,
    toolCall: { id: 'first', name: 'write_file', arguments: originalArgs },
  };
  const pending = store.deferTaskApproval(session.id, task.id, original).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  store.resolveTaskApproval(session.id, task.id, true, pending.id);

  const reorderedArgs = { content: 'reviewed', path: 'approved.txt' };
  const reordered = {
    ...original,
    description: `write_file: ${JSON.stringify(reorderedArgs)}\nOnly this reviewed file`,
    toolCall: { id: 'retry', name: 'write_file', arguments: reorderedArgs },
  };
  assert.equal(
    store.consumeTaskApproval(session.id, task.id, {
      ...reordered,
      description: `write_file: ${JSON.stringify(reorderedArgs)}\nDifferent review detail`,
    }),
    false,
  );
  assert.equal(
    store.consumeTaskApproval(session.id, task.id, {
      ...reordered,
      toolCall: { ...reordered.toolCall, arguments: { content: 'changed', path: 'approved.txt' } },
    }),
    false,
  );
  assert.equal(store.consumeTaskApproval(session.id, task.id, reordered), true);
  assert.equal(store.consumeTaskApproval(session.id, task.id, reordered), false);
});

test('an approval is bound to its operation kind and tool, not only its arguments', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-bound-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Bound operation',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const approved = {
    kind: 'write' as const,
    description: 'write_file: {"path":"bound.txt","content":"ok"}',
    toolCall: { id: 'call', name: 'write_file', arguments: { path: 'bound.txt', content: 'ok' } },
  };
  const pending = store.deferTaskApproval(session.id, task.id, approved).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  store.resolveTaskApproval(session.id, task.id, true, pending.id);
  // Same tool, same arguments, same preview text — only the *kind* differs. That is a different
  // operation, so it must not spend the grant.
  assert.equal(
    store.consumeTaskApproval(session.id, task.id, { ...approved, kind: 'command' }),
    false,
  );
  // Again identical everywhere else, but a different tool.
  assert.equal(
    store.consumeTaskApproval(session.id, task.id, {
      ...approved,
      toolCall: { ...approved.toolCall, name: 'delete_file' },
    }),
    false,
  );
  assert.equal(store.consumeTaskApproval(session.id, task.id, approved), true);
});

test('a pending approval cannot be resolved while the run that raised it is still live', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-window-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const trigger = { kind: 'interval' as const, enabled: true, everyMinutes: 60 };
  const task = store.createTask(session.id, { title: 'Narrow window', trigger });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const approval = {
    kind: 'write' as const,
    description: 'write window.txt',
    toolCall: { id: 'call', name: 'write_file', arguments: { path: 'window.txt', content: 'ok' } },
  };
  const pending = store.deferTaskApproval(session.id, task.id, approval).pendingApproval!;
  // Approving while the attempt that raised the request is still live would race the very run the
  // request belongs to.
  assert.throws(
    () => store.resolveTaskApproval(session.id, task.id, true, pending.id),
    /still running/i,
  );
  // and the same request is reviewable once that attempt has finished
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  assert.equal(
    store.resolveTaskApproval(session.id, task.id, true, pending.id).pendingApproval?.state,
    'approved',
  );
  // The neighbouring guard in resolveTaskApproval ("trigger is disabled") is deliberately *not* asserted:
  // the only way to disable a trigger is updateTask, which deletes the task's approvals in the same
  // transaction (packages/storage/sqlite.ts:597). A pending request and a disabled trigger therefore cannot
  // coexist through this API, so that branch is defensive rather than reachable.
});

test('an oversized approval request is refused before it is stored', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-size-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Oversized request',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  // The stored row carries the tool call verbatim, so the bound has to hold before the write happens.
  assert.throws(
    () =>
      store.deferTaskApproval(session.id, task.id, {
        kind: 'write',
        description: 'write big.txt',
        toolCall: {
          id: 'call',
          name: 'write_file',
          arguments: { path: 'big.txt', content: 'x'.repeat(130_000) },
        },
      }),
    /128KB/i,
  );
  assert.equal(store.getTask(session.id, task.id).pendingApproval, undefined);
});

test('only a live scheduled run may register an approval request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-inactive-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Inactive request',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  const approval = {
    kind: 'write' as const,
    description: 'write inactive.txt',
    toolCall: {
      id: 'call',
      name: 'write_file',
      arguments: { path: 'inactive.txt', content: 'ok' },
    },
  };
  // Nothing has started this task, so a request registered here would be one with no run behind it —
  // and approving it would queue a recovery attempt for work that never happened.
  assert.throws(
    () => store.deferTaskApproval(session.id, task.id, approval),
    /Only an active scheduled task/,
  );
  assert.equal(store.getTask(session.id, task.id).pendingApproval, undefined);
});

test('a finalizing run does not clear a grant made under a later revision', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-revision-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const trigger = { kind: 'interval' as const, enabled: true, everyMinutes: 60 };
  const task = store.createTask(session.id, { title: 'Revision guard', trigger });
  const approval = {
    kind: 'write' as const,
    description: 'write revision.txt',
    toolCall: {
      id: 'call',
      name: 'write_file',
      arguments: { path: 'revision.txt', content: 'ok' },
    },
  };
  const first = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const pending = store.deferTaskApproval(session.id, task.id, approval).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, first.id, { status: 'needs_review' });
  store.resolveTaskApproval(session.id, task.id, true, pending.id);
  const staleRule = store.getTask(session.id, task.id).triggerRevision ?? 'legacy';
  // The task is re-armed while that run is still finalizing: the rearm deletes the *old* approvals, and a
  // run under the new revision produces a fresh grant. The old run's cleanup must not delete that one.
  store.updateTask(session.id, task.id, { trigger: { ...trigger, everyMinutes: 30 } });
  const second = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const current = store.deferTaskApproval(session.id, task.id, approval).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, second.id, { status: 'needs_review' });
  store.resolveTaskApproval(session.id, task.id, true, current.id);
  store.clearApprovedTaskApproval(session.id, task.id, staleRule);
  assert.equal(store.consumeTaskApproval(session.id, task.id, approval), true);
  // The other direction, so the guard cannot pass by never clearing anything: the revision that owns a
  // grant does clear it when its own run finalizes.
  const third = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const latest = store.deferTaskApproval(session.id, task.id, approval).pendingApproval!;
  store.finishTaskAttempt(session.id, task.id, third.id, { status: 'needs_review' });
  store.resolveTaskApproval(session.id, task.id, true, latest.id);
  const currentRule = store.getTask(session.id, task.id).triggerRevision ?? 'legacy';
  store.clearApprovedTaskApproval(session.id, task.id, currentRule);
  assert.equal(store.consumeTaskApproval(session.id, task.id, approval), false);
});
