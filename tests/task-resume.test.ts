import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/tools/index.ts';
import type { Provider, TaskTrigger } from '../packages/protocol/index.ts';
import { TaskScheduler } from '../apps/agent-host/scheduler.ts';
import { dueTasks } from '../packages/core/task-trigger.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-resume-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, session: store.create(root) };
}

/** A provider that plays a fixed script of tool-call turns and then stops. */
function scripted(...turns: { name: string; input: Record<string, unknown> }[][]): Provider {
  let index = 0;
  return {
    async complete() {
      const calls = turns[index++] ?? [];
      return {
        text: calls.length ? '' : 'Done',
        toolCalls: calls.map((call, position) => ({
          id: `call-${index}-${position}`,
          name: call.name,
          arguments: call.input,
        })),
        finishReason: calls.length ? ('tool_calls' as const) : ('stop' as const),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

test('step checkpoints are append-only and refuse stale or out-of-range writes', async (t) => {
  const { store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Checkpointed',
    steps: [
      { description: 'one', status: 'pending' },
      { description: 'two', status: 'pending' },
    ],
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run' });
  const first = store.checkpointTaskStep(session.id, task.id, {
    attemptId: attempt.id,
    index: 0,
    status: 'completed',
    note: 'wrote the file',
  });
  assert.equal(first.steps[0]!.status, 'completed');
  assert.equal(first.steps[1]!.status, 'pending');
  store.checkpointTaskStep(session.id, task.id, {
    attemptId: attempt.id,
    index: 1,
    status: 'in_progress',
  });
  // The journal keeps both transitions instead of overwriting one row per step.
  const journal = store.taskStepCheckpoints(session.id, task.id);
  assert.equal(journal.length, 2);
  assert.equal(journal[0]!.note, 'wrote the file');
  assert.deepEqual(store.completedStepIndexes(task.id), [0]);

  assert.throws(
    () =>
      store.checkpointTaskStep(session.id, task.id, {
        attemptId: attempt.id,
        index: 5,
        status: 'completed',
      }),
    /Invalid task step index/,
  );
  assert.throws(
    () =>
      store.checkpointTaskStep(session.id, task.id, {
        attemptId: attempt.id,
        index: 0,
        status: 'unknown' as never,
      }),
    /Invalid task step status/,
  );
  store.finishTaskAttempt(session.id, task.id, attempt.id, { status: 'needs_review' });
  // A finished attempt can no longer be written to, so a late tool call cannot rewrite history.
  assert.throws(
    () =>
      store.checkpointTaskStep(session.id, task.id, {
        attemptId: attempt.id,
        index: 0,
        status: 'blocked',
      }),
    /not active/,
  );
});

test('a scheduled task journals permissioned effects before execution', async (t) => {
  const { root, store, session } = await fixture(t);
  const trigger: TaskTrigger = { kind: 'interval', enabled: true, everyMinutes: 5 };
  const task = store.createTask(session.id, { title: 'External effect', trigger });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  const nextRunAt = task.nextRunAt;
  const completed = store.beginTaskEffect(session.id, task.id, attempt.id, 'remote_tool');
  assert.equal(store.getTask(session.id, task.id).approvalOutcomeUnknown, true);
  assert.equal(store.getTask(session.id, task.id).nextRunAt, nextRunAt);
  store.completeTaskEffect(session.id, task.id, completed);
  assert.equal(store.getTask(session.id, task.id).approvalOutcomeUnknown, undefined);

  store.beginTaskEffect(session.id, task.id, attempt.id, 'remote_tool');
  store.finishTaskAttempt(session.id, task.id, attempt.id, {
    status: 'needs_review',
    error: 'Host stopped',
  });
  const recorded = store.recordTaskRun(session.id, task.id, {
    at: new Date().toISOString(),
    trigger,
    error: 'Host stopped',
  });
  assert.equal(recorded.approvalOutcomeUnknown, true);
  assert.equal(recorded.nextRunAt, undefined);
  assert.deepEqual(store.resumableTasks(root), []);
  assert.deepEqual(dueTasks([recorded], new Date(Date.now() + 3600_000)), []);
});
test('a crash during a permissioned effect stays paused after database reopen', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Crash during effect',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 5 },
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  store.beginTaskEffect(session.id, task.id, attempt.id, 'remote_tool');
  const reopened = new SessionStore(path.join(root, 'sessions.sqlite'));
  try {
    assert.equal(reopened.recoverInterruptedTasks(root), 1);
    const recovered = reopened.getTask(session.id, task.id);
    assert.equal(recovered.status, 'needs_review');
    assert.equal(recovered.approvalOutcomeUnknown, true);
    assert.equal(recovered.nextRunAt, undefined);
    assert.deepEqual(reopened.resumableTasks(root), []);
    assert.deepEqual(dueTasks([recovered], new Date(Date.now() + 3600_000)), []);
  } finally {
    reopened.close();
  }
});
test('a successful manual task effect preserves its existing automatic schedule', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Scheduled task',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 30 },
  });
  const nextRunAt = task.nextRunAt;
  const tools = createTools(root);
  tools.register({
    name: 'external_success',
    description: 'Simulated successful external operation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'external',
    async execute() {
      return { isError: false, content: 'done' };
    },
  });
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: scripted([{ name: 'external_success', input: {} }], []),
  });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'do it' });
  assert.equal(result.status, 'completed');
  assert.equal(store.getTask(session.id, task.id).nextRunAt, nextRunAt);
});
test('a verified command effect and task completion commit together', async (t) => {
  const { store, session } = await fixture(t);
  const task = store.createTask(session.id, { title: 'Verify command' });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'verify' });
  const effectId = store.beginTaskEffect(session.id, task.id, attempt.id, 'run_command');
  const finished = store.finishTaskAttempt(session.id, task.id, attempt.id, {
    status: 'completed',
    resolvedEffectIds: [effectId],
  });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.approvalOutcomeUnknown, undefined);
  assert.equal(store.getTaskAttempt(session.id, task.id, attempt.id).status, 'completed');
});
test('a delegated task tool inherits the parent effect journal', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Delegated external action',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 5 },
  });
  let markedBeforeExecution = false;
  const tools = createTools(root);
  tools.register({
    name: 'remote_tool',
    description: 'Simulate an uncertain child operation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'external',
    async execute() {
      markedBeforeExecution = store.getTask(session.id, task.id).approvalOutcomeUnknown === true;
      return { isError: true, content: 'Connection dropped after request was sent' };
    },
  });
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    subagents: { enabled: true },
    provider: scripted(
      [
        {
          name: 'delegate_task',
          input: { tasks: [{ objective: 'Send externally', role: 'general' }] },
        },
      ],
      [{ name: 'remote_tool', input: {} }],
      [],
      [],
    ),
  });
  const result = await agent.run({
    sessionId: session.id,
    taskId: task.id,
    taskTrigger: 'interval',
    prompt: 'delegate the send',
  });
  assert.equal(markedBeforeExecution, true);
  assert.equal(result.status, 'needs_review');
  assert.equal(store.getTask(session.id, task.id).approvalOutcomeUnknown, true);
  assert.equal(store.getTask(session.id, task.id).nextRunAt, undefined);
});

test('a permissioned task tool records its effect before execution and pauses after an uncertain result', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Send externally',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 5 },
  });
  const tools = createTools(root);
  let markedBeforeExecution = false;
  tools.register({
    name: 'remote_tool',
    description: 'Simulate an external operation with an uncertain result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'external',
    async execute() {
      markedBeforeExecution = store.getTask(session.id, task.id).approvalOutcomeUnknown === true;
      return { isError: true, content: 'Connection dropped after request was sent' };
    },
  });
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: scripted([{ name: 'remote_tool', input: {} }], []),
  });
  const result = await agent.run({
    sessionId: session.id,
    taskId: task.id,
    taskTrigger: 'interval',
    prompt: 'send it',
  });
  assert.equal(markedBeforeExecution, true);
  assert.equal(result.status, 'needs_review');
  assert.equal(store.getTask(session.id, task.id).approvalOutcomeUnknown, true);
});
test('a resumed attempt continues from completed steps and a fresh attempt starts over', async (t) => {
  const { store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Resumable',
    steps: [
      { description: 'one', status: 'pending' },
      { description: 'two', status: 'pending' },
      { description: 'three', status: 'pending' },
    ],
  });
  const first = store.startTaskAttempt(session.id, task.id, { kind: 'run' });
  store.checkpointTaskStep(session.id, task.id, {
    attemptId: first.id,
    index: 0,
    status: 'completed',
  });
  store.checkpointTaskStep(session.id, task.id, {
    attemptId: first.id,
    index: 1,
    status: 'blocked',
  });
  store.finishTaskAttempt(session.id, task.id, first.id, {
    status: 'blocked',
    error: 'host stopped',
  });

  const resumed = store.startTaskAttempt(session.id, task.id, { kind: 'run', resume: true });
  const during = store.getTask(session.id, task.id);
  assert.deepEqual(
    during.steps.map((step) => step.status),
    ['completed', 'in_progress', 'pending'],
  );
  assert.equal(store.getTaskAttempt(session.id, task.id, resumed.id).resume, true);
  store.finishTaskAttempt(session.id, task.id, resumed.id, { status: 'needs_review' });

  const fresh = store.startTaskAttempt(session.id, task.id, { kind: 'run' });
  assert.deepEqual(
    store.getTask(session.id, task.id).steps.map((step) => step.status),
    ['in_progress', 'pending', 'pending'],
  );
  assert.equal(store.getTaskAttempt(session.id, task.id, fresh.id).resume, false);
  // Editing the definition invalidates the indexes the journal was recorded against.
  store.finishTaskAttempt(session.id, task.id, fresh.id, { status: 'needs_review' });
  store.replaceTaskDefinition(session.id, task.id, {
    title: 'Resumable',
    description: '',
    steps: [{ description: 'only', status: 'pending' }],
    acceptance: [{ description: 'manual', met: false }],
  });
  assert.deepEqual(store.taskStepCheckpoints(session.id, task.id), []);
});

test('a failed verification keeps checkpointed steps complete instead of erasing them', async (t) => {
  const { store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Partial',
    steps: [
      { description: 'one', status: 'pending' },
      { description: 'two', status: 'pending' },
    ],
    acceptance: [
      {
        description: 'file exists',
        met: false,
        check: { id: 'a', kind: 'file-exact', path: 'never.txt', expected: 'x' },
      },
    ],
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run' });
  store.checkpointTaskStep(session.id, task.id, {
    attemptId: attempt.id,
    index: 0,
    status: 'completed',
  });
  const finished = store.finishTaskAttempt(session.id, task.id, attempt.id, {
    status: 'needs_review',
    steps: [
      { description: 'one', status: 'blocked' },
      { description: 'two', status: 'blocked' },
    ],
  });
  assert.deepEqual(
    finished.steps.map((step) => step.status),
    ['completed', 'blocked'],
  );
});

test('the agent checkpoints task steps through the task_step tool', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'Tool driven',
    steps: [
      { description: 'inspect', status: 'pending' },
      { description: 'implement', status: 'pending' },
    ],
  });
  const provider = scripted([{ name: 'task_step', input: { index: 0, status: 'completed' } }], []);
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider,
  });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'do it' });
  // The task declares no acceptance criteria, so a clean finish completes it.
  assert.equal(result.status, 'completed');
  const attempts = store.listTaskAttempts(session.id, task.id);
  assert.equal(attempts.length, 1);
  const journal = store.taskStepCheckpoints(session.id, task.id);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.index, 0);
  assert.equal(journal[0]!.attemptId, attempts[0]!.id);
  const toolMessage = store
    .messages(session.id)
    .find((message) => message.role === 'tool' && message.toolCallId?.startsWith('call-'));
  assert.ok(toolMessage?.role === 'tool' && !toolMessage.isError);
  assert.match(toolMessage.content, /\[completed\] inspect/);
});

test('scheduled runs re-arm their clock and interrupted ones are queued for resume', async (t) => {
  const { root, store, session } = await fixture(t);
  const trigger: TaskTrigger = { kind: 'interval', enabled: true, everyMinutes: 30 };
  const scheduled = store.createTask(session.id, {
    title: 'Nightly',
    steps: [
      { description: 'one', status: 'pending' },
      { description: 'two', status: 'pending' },
    ],
    trigger,
  });
  assert.ok(scheduled.nextRunAt);
  assert.deepEqual(
    store.listScheduledTasks(root).map((task) => task.id),
    [scheduled.id],
  );
  const manual = store.createTask(session.id, { title: 'Manual' });
  assert.equal(manual.trigger, undefined);

  const attempt = store.startTaskAttempt(session.id, scheduled.id, {
    kind: 'run',
    trigger: 'interval',
  });
  assert.equal(store.getTaskAttempt(session.id, scheduled.id, attempt.id).trigger, 'interval');
  store.checkpointTaskStep(session.id, scheduled.id, {
    attemptId: attempt.id,
    index: 0,
    status: 'completed',
  });
  // Simulate a crash mid-run: the attempt ends without verification and the task is left blocked.
  store.finishTaskAttempt(session.id, scheduled.id, attempt.id, {
    status: 'blocked',
    error: 'host stopped',
  });

  const recorded = store.recordTaskRun(session.id, scheduled.id, {
    at: new Date().toISOString(),
    trigger,
  });
  assert.ok(recorded.lastRunAt);
  assert.ok(Date.parse(recorded.nextRunAt!) > Date.now());

  const failed = store.recordTaskRun(session.id, scheduled.id, {
    at: new Date().toISOString(),
    trigger,
    error: 'approval denied',
  });
  assert.equal(failed.lastTriggerError, 'approval denied');

  const resumable = store.resumableTasks(root);
  assert.deepEqual(
    resumable.map((task) => task.id),
    [scheduled.id],
  );
  assert.match(resumable[0]!.lastTriggerError!, /resuming from the last completed step/i);
  // Re-queueing is idempotent: a second Host start must not duplicate the obligation.
  assert.equal(store.resumableTasks(root).length, 1);
  // Clearing the trigger removes it from the schedule entirely.
  const cleared = store.updateTask(session.id, scheduled.id, { trigger: null as never });
  assert.equal(cleared.trigger, undefined);
  assert.equal(cleared.nextRunAt, undefined);
  assert.deepEqual(store.listScheduledTasks(root), []);
});

test('the scheduler fires due tasks one at a time and refuses to re-enter a task', async (t) => {
  const { store, session } = await fixture(t);
  const trigger: TaskTrigger = { kind: 'interval', enabled: true, everyMinutes: 5 };
  const first = store.createTask(session.id, {
    title: 'First',
    steps: [{ description: 'one', status: 'pending' }],
    trigger,
  });
  const second = store.createTask(session.id, {
    title: 'Second',
    steps: [{ description: 'one', status: 'pending' }],
    trigger,
  });
  for (const task of [first, second])
    store.recordTaskRun(session.id, task.id, {
      at: new Date(Date.now() - 10 * 60_000).toISOString(),
      trigger,
    });
  // Push both into the past so they are due on the first tick.
  store.scheduleImmediateRun(session.id, first.id);
  store.scheduleImmediateRun(session.id, second.id);

  let busy = false;
  const runs: string[] = [];
  const scheduler = new TaskScheduler({
    store,
    workspace: (await fixtureWorkspace(store, session.id)) ?? '',
    canRun: () => !busy,
    run: async (scheduled) => {
      assert.equal(busy, false);
      busy = true;
      runs.push(scheduled.task.title);
      busy = false;
    },
  });
  const started = await scheduler.tick();
  assert.deepEqual(started.map((entry) => entry.task.id).sort(), [first.id, second.id].sort());
  assert.deepEqual(runs.sort(), ['First', 'Second']);
  // A second tick finds nothing due because the first tick re-armed both clocks.
  assert.deepEqual(await scheduler.tick(), []);

  // A failed run must still re-arm, otherwise the task would be retried on every tick forever.
  const failing = store.createTask(session.id, {
    title: 'Failing',
    steps: [{ description: 'one', status: 'pending' }],
    trigger,
  });
  store.scheduleImmediateRun(session.id, failing.id);
  const failingScheduler = new TaskScheduler({
    store,
    workspace: (await fixtureWorkspace(store, session.id)) ?? '',
    canRun: () => true,
    run: async () => {
      throw new Error('approval denied');
    },
  });
  assert.equal((await failingScheduler.tick()).length, 1);
  assert.equal(store.getTask(session.id, failing.id).lastTriggerError, 'approval denied');
  assert.deepEqual(await failingScheduler.tick(), []);
  // Agent.run returns failure as a result rather than throwing. The scheduler must surface it.
  const returnedFailure = store.createTask(session.id, {
    title: 'Returned failure',
    trigger,
  });
  store.scheduleImmediateRun(session.id, returnedFailure.id);
  const resultScheduler = new TaskScheduler({
    store,
    workspace: (await fixtureWorkspace(store, session.id)) ?? '',
    canRun: () => true,
    run: async () => ({ status: 'failed' as const, error: 'model unavailable' }),
  });
  assert.equal((await resultScheduler.tick()).length, 1);
  assert.equal(store.getTask(session.id, returnedFailure.id).lastTriggerError, 'model unavailable');

  scheduler.stop();
  failingScheduler.stop();
  resultScheduler.stop();
});

test('event triggers fire on matching events and cannot be restarted by their own run', async (t) => {
  const { store, session } = await fixture(t);
  const source = store.createTask(session.id, { title: 'Source' });
  const chained = store.createTask(session.id, {
    title: 'Chained',
    trigger: { kind: 'event', enabled: true, on: 'task.completed', taskId: source.id },
  });
  store.createTask(session.id, {
    title: 'Other',
    trigger: { kind: 'event', enabled: true, on: 'task.completed', taskId: 'different' },
  });
  const workspace = (await fixtureWorkspace(store, session.id)) ?? '';
  const fired: string[] = [];
  const nested: string[][] = [];
  const scheduler: TaskScheduler = new TaskScheduler({
    store,
    workspace,
    canRun: () => true,
    run: async (scheduled) => {
      fired.push(scheduled.task.id);
      // The run announces its own completion while this cascade is still on the stack.
      const again = await scheduler.notify({
        name: 'task.completed',
        sessionId: session.id,
        taskId: scheduled.task.id,
      });
      nested.push(again.map((entry) => entry.task.id));
    },
  });
  const started = await scheduler.notify({
    name: 'task.completed',
    sessionId: session.id,
    taskId: source.id,
  });
  assert.deepEqual(
    started.map((entry) => entry.task.id),
    [chained.id],
  );
  // The self-announcement must not restart the task that produced it.
  assert.deepEqual(fired, [chained.id]);
  assert.deepEqual(nested, [[]]);
  scheduler.stop();
});

async function fixtureWorkspace(
  store: SessionStore,
  sessionId: string,
): Promise<string | undefined> {
  return store.get(sessionId).workspace;
}
