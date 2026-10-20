import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/catalog/index.ts';
import { InvariantRegistry } from '../packages/core/invariants.ts';
import { HookRegistry } from '../packages/tools/registry.ts';
import { newGoal } from '../packages/protocol/goals.ts';
import type { CompletionSpec, CompletionSummary, Provider } from '../packages/protocol/index.ts';

const definition: CompletionSpec = {
  version: 1,
  objective: 'Produce the verified output',
  constraints: [],
  steps: [],
  acceptance: [
    {
      description: 'output contains the marker',
      met: false,
      check: { id: 'output', kind: 'file-contains', path: 'out.txt', expected: 'verified' },
    },
  ],
  inputs: ['out.txt'],
};

const provider: Provider = {
  async complete() {
    return {
      text: 'Done.',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'stop',
    };
  },
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-completion-final-'));
  const database = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(database);
  let closed = false;
  const closeStore = () => {
    if (!closed) store.close();
    closed = true;
  };
  t.after(async () => {
    closeStore();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  await writeFile(path.join(root, 'out.txt'), 'verified output');
  return { root, database, store, session, closeStore };
}

test('final verification is durable before its live notification and survives reopening', async (t) => {
  const { root, database, store, session, closeStore } = await fixture(t);
  const publishedStates: (string | undefined)[] = [];
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider,
    onEvent(event) {
      const summary = event.data.summary as CompletionSummary | undefined;
      if (event.type === 'completion.updated' && summary?.state === 'verified')
        publishedStates.push(store.completionCurrent(session.id)?.summary.state);
    },
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Verify',
    completion: definition,
  });
  assert.equal(result.completion?.state, 'verified');
  assert.deepEqual(publishedStates, ['verified'], 'a live verdict must already be durable');
  assert.deepEqual(store.completionCurrent(session.id)?.summary, result.completion);
  closeStore();
  const reopened = new SessionStore(database);
  try {
    assert.deepEqual(reopened.completionCurrent(session.id)?.summary, result.completion);
    assert.equal(reopened.get(session.id).activeRun, null);
  } finally {
    reopened.close();
  }
});

test('failed final persistence publishes no verified state and keeps its bound goal active', async (t) => {
  const { root, store, session } = await fixture(t);
  store.recordEvent(session.id, 'goal.changed', {
    action: 'create',
    goal: newGoal({ objective: definition.objective }, new Date().toISOString()),
  });
  const append = store.recordEvent.bind(store);
  let attempts = 0;
  store.recordEvent = (...args: Parameters<SessionStore['recordEvent']>) => {
    if (args[1] === 'run.finished' && ++attempts === 1)
      throw new Error('fixture: final transaction unavailable');
    return append(...args);
  };
  const published: string[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider,
    onEvent(event) {
      const summary = event.data.summary as CompletionSummary | undefined;
      if (event.type === 'completion.updated' && summary?.state) published.push(summary.state);
    },
  }).run({ sessionId: session.id, prompt: 'Verify', completion: definition });
  assert.equal(result.status, 'failed');
  assert.equal(result.completion?.state, 'needs_review');
  assert.ok(!published.includes('verified'));
  assert.equal(store.completionCurrent(session.id)?.summary.state, 'needs_review');
  assert.equal(store.goal(session.id)?.status, 'active');
  assert.ok(
    !store
      .events(session.id)
      .some(
        (event) =>
          event.type === 'completion.updated' &&
          (event.data.summary as CompletionSummary | undefined)?.state === 'verified',
      ),
  );
});

test('a stop hook that changes monitored files invalidates final verification', async (t) => {
  const { root, store, session } = await fixture(t);
  const hooks = new HookRegistry();
  hooks.register({
    async stop() {
      await writeFile(path.join(root, 'out.txt'), 'changed after checks');
    },
  });
  const published: string[] = [];
  const result = await new Agent({
    store,
    tools: createTools(root, undefined, 'standalone', hooks),
    approve: async () => true,
    provider,
    onEvent(event) {
      const summary = event.data.summary as CompletionSummary | undefined;
      if (event.type === 'completion.updated' && summary?.state) published.push(summary.state);
    },
  }).run({ sessionId: session.id, prompt: 'Verify', completion: definition });
  assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), 'changed after checks');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.state, 'needs_review');
  assert.ok(!published.includes('verified'));
  assert.equal(store.completionCurrent(session.id)?.summary.state, 'needs_review');
});

test('a task whose stop hook changed verified inputs remains open for review', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: definition.objective,
    acceptance: definition.acceptance,
  });
  const hooks = new HookRegistry();
  hooks.register({
    async stop() {
      await writeFile(path.join(root, 'out.txt'), 'changed after checks');
    },
  });
  const result = await new Agent({
    store,
    tools: createTools(root, undefined, 'standalone', hooks),
    approve: async () => true,
    provider,
  }).run({
    sessionId: session.id,
    taskId: task.id,
    prompt: 'Verify',
    completionInputs: ['out.txt'],
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(store.getTask(session.id, task.id)?.status, 'needs_review');
  assert.equal(store.listTaskAttempts(session.id, task.id)[0]?.status, 'needs_review');
});

function declaredPaths(store: SessionStore, sessionId: string): string[] {
  return store
    .events(sessionId)
    .flatMap((event) =>
      event.type === 'completion.updated' && Array.isArray(event.data.affectedPaths)
        ? (event.data.affectedPaths as string[])
        : [],
    );
}

/** The shared contract with one step, which is what makes the completion tools available to the model. */
const steppedDefinition: CompletionSpec = {
  ...definition,
  steps: [{ id: 'write', description: 'Write the output', status: 'pending' }],
};

/** A provider that declares `paths` through `completion_scope` once, then finishes. */
function scopeDeclaringProvider(paths: string[]): Provider {
  let turn = 0;
  return {
    async complete() {
      turn += 1;
      if (turn === 1)
        return {
          text: '',
          toolCalls: [
            { id: 'scope-1', name: 'completion_scope', arguments: { paths } },
            {
              id: 'step-1',
              name: 'completion_step',
              arguments: { id: 'write', status: 'completed' },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
          finishReason: 'tool_calls',
        };
      return {
        text: 'Done.',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: 'stop',
      };
    },
  };
}

test('a stop hook that changes a declared affected path invalidates final verification', async (t) => {
  const { root, store, session } = await fixture(t);
  await writeFile(path.join(root, 'b.txt'), 'declared original');
  const hooks = new HookRegistry();
  hooks.register({
    async stop() {
      await writeFile(path.join(root, 'b.txt'), 'changed after checks');
    },
  });
  const result = await new Agent({
    store,
    tools: createTools(root, undefined, 'standalone', hooks),
    approve: async () => true,
    provider: scopeDeclaringProvider(['b.txt']),
  }).run({ sessionId: session.id, prompt: 'Verify', completion: steppedDefinition });
  assert.ok(
    declaredPaths(store, session.id).includes('b.txt'),
    'the scope must have been recorded',
  );
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.state, 'needs_review');
});

test('a declared affected path that stays put still verifies', async (t) => {
  const { root, store, session } = await fixture(t);
  await writeFile(path.join(root, 'b.txt'), 'declared original');
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scopeDeclaringProvider(['b.txt']),
  }).run({ sessionId: session.id, prompt: 'Verify', completion: steppedDefinition });
  assert.equal(result.completion?.state, 'verified');
});

test('completion_scope refuses a protected path instead of monitoring it', async (t) => {
  const { root, store, session } = await fixture(t);
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scopeDeclaringProvider(['.env']),
  }).run({ sessionId: session.id, prompt: 'Verify', completion: steppedDefinition });
  assert.deepEqual(declaredPaths(store, session.id), []);
  assert.equal(result.completion?.state, 'verified');
});

test('a stop hook that changes an explicitly monitored dist file invalidates verification', async (t) => {
  const { root, store, session } = await fixture(t);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist/out.txt'), 'verified output');
  const hooks = new HookRegistry();
  hooks.register({
    async stop() {
      await writeFile(path.join(root, 'dist/out.txt'), 'changed after checks');
    },
  });
  const derived: CompletionSpec = {
    version: 1,
    objective: 'Produce the verified output',
    constraints: [],
    steps: [],
    acceptance: [
      {
        description: 'the dist output contains the marker',
        met: false,
        check: {
          id: 'dist-output',
          kind: 'file-contains',
          path: 'dist/out.txt',
          expected: 'verified',
        },
      },
    ],
    // No declared input list: the check path alone is the acceptance subject, and it must still be fingerprinted
    // even though `dist` is a derived directory in the implicit range.
    inputs: [],
  };
  const result = await new Agent({
    store,
    tools: createTools(root, undefined, 'standalone', hooks),
    approve: async () => true,
    provider,
  }).run({ sessionId: session.id, prompt: 'Verify', completion: derived });
  assert.equal(await readFile(path.join(root, 'dist/out.txt'), 'utf8'), 'changed after checks');
  // A check path is the subject of the evidence even though `dist` is a derived directory by default.
  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.state, 'needs_review');
  assert.equal(store.completionCurrent(session.id)?.summary.state, 'needs_review');
});

/** The fixture's task: one acceptance check against `out.txt`, which the fixture already wrote. */
function createVerifiableTask(store: SessionStore, sessionId: string) {
  return store.createTask(sessionId, {
    title: definition.objective,
    acceptance: definition.acceptance,
  });
}

test('a run-end invariant failure settles the task and attempt with the failed run', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = createVerifiableTask(store, session.id);
  const invariants = new InvariantRegistry();
  invariants.register({
    name: 'fixture.run-end-fails',
    owner: 'tests',
    description: 'A run-end promise that never holds, to exercise finalization ordering.',
    scope: 'run-end',
    check() {
      throw new Error('fixture run-end violation');
    },
  });
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider,
    invariants,
  }).run({
    sessionId: session.id,
    taskId: task.id,
    prompt: 'Verify',
    completionInputs: ['out.txt'],
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /Runtime invariant violated/);
  // The invariant is checked before the terminal rows are written, so the Task and the Attempt take the
  // failed run's status rather than keeping the `completed` they were about to be given.
  assert.equal(store.getTask(session.id, task.id).status, 'blocked');
  assert.equal(store.listTaskAttempts(session.id, task.id)[0]?.status, 'blocked');
  assert.equal(store.completionCurrent(session.id)?.summary.state, 'needs_review');
  assert.equal(store.get(session.id).activeRun, null);
});

test('a failed run finalization leaves no completed task attempt behind', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = createVerifiableTask(store, session.id);
  const append = store.recordEvent.bind(store);
  let attempts = 0;
  store.recordEvent = (...args: Parameters<SessionStore['recordEvent']>) => {
    // Fail the first commit after the task settlement has already run inside it: the whole transaction must roll
    // back, and the retry must write the run and the task together rather than leaving a completed attempt.
    if (args[1] === 'run.finished' && ++attempts === 1)
      throw new Error('fixture: final transaction unavailable');
    return append(...args);
  };
  const result = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider,
  }).run({
    sessionId: session.id,
    taskId: task.id,
    prompt: 'Verify',
    completionInputs: ['out.txt'],
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /persist run finalization/i);
  assert.equal(store.getTask(session.id, task.id).status, 'blocked');
  assert.equal(store.listTaskAttempts(session.id, task.id)[0]?.status, 'blocked');
  assert.equal(store.get(session.id).activeRun, null);
});

test('a later change without a contract invalidates the previous verified verdict', async (t) => {
  const { root, store, session } = await fixture(t);
  await writeFile(path.join(root, 'out.txt'), 'verified output');
  const controller = new AbortController();
  const usage = { inputTokens: 10, outputTokens: 5 };
  let calls = 0;
  const changing: Provider = {
    async complete() {
      calls += 1;
      if (calls === 1) return { text: 'Verified.', toolCalls: [], usage, finishReason: 'stop' };
      if (calls === 2)
        return {
          text: '',
          toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'out.txt' } }],
          usage,
          finishReason: 'tool_calls',
        };
      if (calls === 3)
        return {
          text: '',
          toolCalls: [
            {
              id: 'edit-1',
              name: 'edit_file',
              arguments: {
                path: 'out.txt',
                old_text: 'verified output',
                new_text: 'broken output',
              },
            },
          ],
          usage,
          finishReason: 'tool_calls',
        };
      // The person stops the turn after the edit. No contract is created for it, so nothing in the run's own
      // finalization would otherwise replace the session's previous verdict.
      controller.abort(new Error('fixture: stop'));
      return { text: 'Stopping.', toolCalls: [], usage, finishReason: 'stop' };
    },
  };
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: changing,
  });
  const first = await agent.run({
    sessionId: session.id,
    prompt: 'Verify',
    completion: definition,
  });
  assert.equal(first.completion?.state, 'verified');
  const second = await agent.run({
    sessionId: session.id,
    prompt: 'Change it',
    signal: controller.signal,
  });
  assert.equal(second.status, 'cancelled');
  assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), 'broken output');

  const current = store.completionCurrent(session.id);
  assert.equal(current?.summary.state, 'unverified');
  assert.equal(current?.summary.reason, 'superseded');
  assert.equal(
    current?.latestRunId,
    second.runId,
    'the stale verdict names the run that superseded it',
  );
  assert.deepEqual(
    current?.evidence?.checks,
    [],
    'the old checks are not evidence for the new tree',
  );
});

test('a later turn that changes nothing keeps the previous verified verdict', async (t) => {
  const { root, store, session } = await fixture(t);
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider,
  });
  const first = await agent.run({
    sessionId: session.id,
    prompt: 'Verify',
    completion: definition,
  });
  assert.equal(first.completion?.state, 'verified');
  const asked = await agent.run({ sessionId: session.id, prompt: 'What is in out.txt?' });
  assert.equal(asked.status, 'completed');
  assert.equal(store.completionCurrent(session.id)?.summary.state, 'verified');
});
