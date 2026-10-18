import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/catalog/index.ts';
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
