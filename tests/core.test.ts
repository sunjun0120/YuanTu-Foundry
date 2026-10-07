import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  AgentEvent,
  Approver,
} from '../packages/protocol/index.ts';
import { RunQueue } from '../packages/core/run-queue.ts';
import { emptyStatistics, addStatistics, addUsage } from '../packages/protocol/statistics.ts';
import { redactSecrets } from '../packages/core/errors.ts';

// ---- merged from core.test.ts ----

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
async function fixture(t: test.TestContext, provider: Provider, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-core-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const tools = createTools(root);
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { root, store, session, agent, events, tools };
}

test('agent executes tools, returns results to provider and persists history across reopen', async (t) => {
  let turn = 0;
  const provider: Provider = {
    async complete(request: ModelRequest) {
      // Read, then edit: a change to a file this run has not read is refused, so the flow that reaches a
      // *successful* mutation is exactly this one. The round count below follows it.
      if (turn++ === 0)
        return {
          ...reply('Reading'),
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'a.txt' } }],
        };
      if (turn === 2)
        return {
          ...reply('Editing'),
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'edit-1',
              name: 'edit_file',
              arguments: { path: 'a.txt', old_text: 'bad', new_text: 'good' },
            },
          ],
        };
      assert.ok(
        request.messages.some((m) => m.role === 'tool' && m.toolCallId === 'edit-1' && !m.isError),
      );
      return reply('Fixed');
    },
  };
  const { root, store, session, agent, events } = await fixture(t, provider);
  await writeFile(path.join(root, 'a.txt'), 'bad');
  const result = await agent.run({ sessionId: session.id, prompt: 'Fix a.txt' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Fixed');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'good');
  assert.ok(events.some((e) => e.type === 'tool.finished'));
  const starts = events.filter((e) => e.type === 'message.started');
  const ends = events.filter((e) => e.type === 'message.finished');
  assert.equal(starts.length, 3);
  assert.equal(ends.length, 3);
  assert.notEqual(starts[0]!.data.messageId, starts[1]!.data.messageId);
  assert.equal(ends[0]!.data.messageId, starts[0]!.data.messageId);
  assert.equal((ends[0]!.data.message as { toolCalls: unknown[] }).toolCalls.length, 1);
  const reopened = new SessionStore(path.join(root, 'sessions.sqlite'));
  assert.equal(reopened.messages(session.id).length, 6);
  assert.equal(reopened.messages(session.id).at(-1)?.role, 'assistant');
  reopened.close();
  assert.equal(store.get(session.id).activeRun, null);
});

test('tool errors go back to model and do not end the loop', async (t) => {
  let step = 0;
  const provider: Provider = {
    async complete(request) {
      if (step++ === 0)
        return {
          ...reply(),
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'bad', name: 'missing_tool', arguments: {} }],
        };
      assert.ok(request.messages.some((m) => m.role === 'tool' && m.isError));
      return reply('Unable to use that tool');
    },
  };
  const { session, agent } = await fixture(t, provider);
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Try' })).status, 'completed');
});

test('token truncation never executes returned tool calls', async (t) => {
  const provider: Provider = {
    async complete() {
      return {
        ...reply(),
        finishReason: 'length',
        toolCalls: [
          { id: 'write', name: 'write_file', arguments: { path: 'bad.txt', content: 'bad' } },
        ],
      };
    },
  };
  const { root, session, agent } = await fixture(t, provider);
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Write' })).status, 'limited');
  await assert.rejects(readFile(path.join(root, 'bad.txt')), { code: 'ENOENT' });
});

test('abort propagates to provider and session is unlocked', async (t) => {
  const provider: Provider = {
    async complete({ signal }) {
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  };
  const { session, agent, store } = await fixture(t, provider);
  const controller = new AbortController();
  const running = agent.run({ sessionId: session.id, prompt: 'Wait', signal: controller.signal });
  controller.abort();
  assert.equal((await running).status, 'cancelled');
  assert.equal(store.get(session.id).activeRun, null);
});

test('concurrent run is rejected without corrupting the first run', async (t) => {
  let finish!: (response: ModelResponse) => void;
  const provider: Provider = {
    complete: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const { session, agent, store } = await fixture(t, provider);
  const first = agent.run({ sessionId: session.id, prompt: 'one' });
  await assert.rejects(agent.run({ sessionId: session.id, prompt: 'two' }), /already running/i);
  finish(reply());
  await first;
  assert.equal(store.messages(session.id).filter((m) => m.role === 'user').length, 1);
});

test('cancelled approval resolves every pending call without side effects', async (t) => {
  const provider: Provider = {
    async complete() {
      return {
        ...reply(),
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'a', name: 'write_file', arguments: { path: 'a.txt', content: 'bad' } },
          { id: 'b', name: 'write_file', arguments: { path: 'b.txt', content: 'bad' } },
        ],
      };
    },
  };
  const controller = new AbortController();
  const { session, agent, store, root } = await fixture(t, provider, {
    approve: async () => {
      controller.abort();
      return false;
    },
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'write',
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(store.messages(session.id).filter((m) => m.role === 'tool').length, 2);
  await assert.rejects(readFile(path.join(root, 'a.txt')), { code: 'ENOENT' });
});

test('oversized active context fails before requesting the provider', async (t) => {
  const provider: Provider = {
    async complete() {
      assert.fail('must not request oversized context');
    },
  };
  const { session, agent } = await fixture(t, provider, { maxContextChars: 1000 });
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'x'.repeat(2000) })).status,
    'limited',
  );
});

test('a turn truncated at the output limit does not execute its tool calls', async (t) => {
  /**
   * The bound that stops a turn before its tool calls run is the *output* limit, not a spend: a response
   * that hit its cap is a partial answer by construction, and executing the calls inside it would act on a
   * decision the model never finished making.
   */
  const provider: Provider = {
    async complete() {
      return {
        text: '',
        toolCalls: [
          {
            id: 'truncated',
            name: 'write_file',
            arguments: { path: 'truncated.txt', content: 'x' },
          },
        ],
        finishReason: 'length',
        usage: { inputTokens: 10_000, outputTokens: 10 },
      };
    },
  };
  const { root, session, agent } = await fixture(t, provider, { maxOutputTokens: 512 });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'write' })).status, 'limited');
  await assert.rejects(readFile(path.join(root, 'truncated.txt')), { code: 'ENOENT' });
});

test('request timeout is a failed run and releases the session lock', async (t) => {
  const provider: Provider = {
    async complete({ signal }) {
      return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Test request never timed out')), 1000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
  const { session, agent, store } = await fixture(t, provider, { requestTimeoutMs: 20 });
  const result = await agent.run({ sessionId: session.id, prompt: 'wait' });
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /timeout|timed out/i);
  assert.equal(store.get(session.id).activeRun, null);
});

test('event listener failures are isolated from run execution and finalization', async (t) => {
  let eventCount = 0;
  const ctx = await fixture(
    t,
    {
      async complete() {
        return reply('done');
      },
    },
    {
      onEvent: () => {
        if (eventCount++ === 0) throw new Error('listener failed');
        return Promise.reject(new Error('async listener failed'));
      },
    },
  );
  let closed = 0;
  const close = ctx.tools.close.bind(ctx.tools);
  ctx.tools.close = async () => {
    closed++;
    await close();
  };

  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(result.status, 'completed');
  assert.equal(closed, 1);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
  assert.throws(
    () => ctx.agent.enqueue(ctx.session.id, { prompt: 'late' }, 'steer'),
    /not running/i,
  );
});

test('resolvePending failure cannot bypass tool cleanup or leave an active run', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      throw new Error('provider failed');
    },
  });
  let closed = 0;
  const close = ctx.tools.close.bind(ctx.tools);
  ctx.tools.close = async () => {
    closed++;
    await close();
  };
  ctx.store.resolvePending = () => {
    throw new Error('resolve failed');
  };

  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(result.status, 'failed');
  assert.match(result.error!, /resolve pending tool calls/i);
  assert.equal(closed, 1);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
});

test('tool cleanup failure is persisted as failed and releases the session lock', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  ctx.tools.close = async () => {
    throw new Error('close failed');
  };

  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(result.status, 'failed');
  assert.match(result.error!, /tool resource cleanup failed/i);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
});

test('finishRun failure is reflected and retried to release the session lock', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  const finishRun = ctx.store.finishRun.bind(ctx.store);
  let attempts = 0;
  ctx.store.finishRun = (result) => {
    attempts++;
    if (attempts === 1) throw new Error('transient finish failure');
    finishRun(result);
  };

  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' });

  assert.equal(attempts, 2);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /persist run finalization/i);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
});

test('task runs complete only after persisted acceptance passes', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  await writeFile(path.join(ctx.root, 'result.txt'), 'verified');
  const task = ctx.store.createTask(ctx.session.id, {
    title: 'verify output',
    acceptance: [
      {
        description: 'result file is verified',
        met: false,
        check: { id: 'result', kind: 'file-exact', path: 'result.txt', expected: 'verified' },
      },
    ],
  });
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'finish',
    taskId: task.id,
  });
  assert.equal(result.status, 'completed');
  assert.equal((result.acceptance as { passed: boolean }).passed, true);
  const persisted = ctx.store.getTask(ctx.session.id, task.id);
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.acceptance[0]?.met, true);
  assert.equal(persisted.verification?.passed, true);
});

test('a task with no acceptance criteria completes vacuously after a run', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('done');
    },
  });
  const task = ctx.store.createTask(ctx.session.id, { title: 'no criteria' });
  assert.deepEqual(task.acceptance, []);
  const result = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'finish',
    taskId: task.id,
  });
  assert.equal(result.status, 'completed');
  assert.equal(ctx.store.getTask(ctx.session.id, task.id).status, 'completed');
});

test('failed or non-executable task acceptance requires review', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('claimed done');
    },
  });
  const failed = ctx.store.createTask(ctx.session.id, {
    title: 'missing output',
    acceptance: [
      {
        description: 'output exists',
        met: false,
        check: { id: 'missing', kind: 'file-contains', path: 'missing.txt', expected: 'done' },
      },
    ],
  });
  const failedResult = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'finish',
    taskId: failed.id,
  });
  assert.equal(failedResult.status, 'needs_review');
  assert.equal(ctx.store.getTask(ctx.session.id, failed.id).status, 'needs_review');

  const manual = ctx.store.createTask(ctx.session.id, {
    title: 'manual review',
    acceptance: [{ description: 'human confirms appearance', met: false }],
  });
  const manualResult = await ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'finish',
    taskId: manual.id,
  });
  assert.equal(manualResult.status, 'needs_review');
  assert.match(manualResult.error!, /review/i);
});

test('text-only connections reject new and historical images before provider requests', async (t) => {
  let requests = 0;
  const ctx = await fixture(
    t,
    {
      async complete() {
        requests++;
        return reply();
      },
    },
    { supportsVision: false },
  );
  const image = {
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5u8AAAAASUVORK5CYII=',
  };
  await assert.rejects(
    ctx.agent.run({ sessionId: ctx.session.id, prompt: 'inspect', images: [image] }),
    /图片/,
  );
  assert.equal(ctx.store.messages(ctx.session.id).length, 0);
  ctx.store.append(ctx.session.id, { role: 'user', content: 'old image', images: [image] });
  await assert.rejects(ctx.agent.run({ sessionId: ctx.session.id, prompt: 'continue' }), /图片/);
  assert.equal(requests, 0);
  assert.equal(ctx.store.get(ctx.session.id).activeRun, null);
});
test('each user turn persists the selected model identity without changing provider content', async (t) => {
  const identity = { model: 'model-a', protocol: 'openai', connectionId: 'connection-a' };
  const ctx = await fixture(
    t,
    {
      async complete() {
        return reply();
      },
    },
    { modelInfo: identity },
  );
  assert.equal(
    (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hello' })).status,
    'completed',
  );
  const first = ctx.store.messages(ctx.session.id)[0];
  assert.ok(first?.role === 'user');
  assert.deepEqual(first.modelInfo, identity);
  const second = new Agent({
    store: ctx.store,
    tools: createTools(ctx.root),
    approve: async () => false,
    provider: {
      async complete() {
        return reply();
      },
    },
    modelInfo: { ...identity, model: 'model-b' },
  });
  await second.run({ sessionId: ctx.session.id, prompt: 'continue' });
  const users = ctx.store.messages(ctx.session.id).filter((m) => m.role === 'user');
  assert.deepEqual(
    users.map((m) => m.modelInfo?.model),
    ['model-a', 'model-b'],
  );
});

test('default runs continue beyond twenty rounds and cumulative token budget', async (t) => {
  let rounds = 0;
  const { root, session, agent, store } = await fixture(t, {
    async complete(request) {
      assert.ok(Number.isFinite(request.maxOutputTokens));
      rounds++;
      return {
        ...reply(rounds > 24 ? 'Completed long task' : 'Reading'),
        usage: { inputTokens: 12000, outputTokens: 100 },
        ...(rounds <= 24
          ? {
              finishReason: 'tool_calls' as const,
              toolCalls: [
                { id: 'read-' + rounds, name: 'read_file', arguments: { path: 'a.txt' } },
              ],
            }
          : {}),
      };
    },
  });
  await writeFile(path.join(root, 'a.txt'), 'content');
  const result = await agent.run({ sessionId: session.id, prompt: 'Complete a long task' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(rounds, 25);
  assert.ok(result.usage.inputTokens > 100000);
  assert.equal(store.get(session.id).activeRun, null);
});

test('a retried task receives persisted attempt evidence and a no-replay recovery instruction', async (t) => {
  let calls = 0;
  const ctx = await fixture(t, {
    async complete(request) {
      calls++;
      if (calls === 1) throw new Error('Simulated provider interruption');
      assert.match(request.system, /Previous task attempt/);
      assert.match(request.system, /inspect.*before.*repeat/i);
      assert.match(request.system, /Simulated provider interruption/);
      return reply('Recovered');
    },
  });
  const task = ctx.store.createTask(ctx.session.id, { title: 'Long task' });
  const first = await ctx.agent.run({
    sessionId: ctx.session.id,
    taskId: task.id,
    prompt: 'Do work',
  });
  assert.equal(first.status, 'failed');
  const resumed = new Agent({
    store: ctx.store,
    tools: createTools(ctx.root),
    approve: async () => true,
    provider: {
      async complete(request) {
        assert.match(request.system, /Previous task attempt/);
        assert.match(request.system, /inspect.*before.*repeat/i);
        assert.match(request.system, /Simulated provider interruption/);
        return reply('Recovered');
      },
    },
  });
  const second = await resumed.run({
    sessionId: ctx.session.id,
    taskId: task.id,
    prompt: 'Continue safely',
  });
  assert.equal(second.status, 'completed');
});

test('task delivery stays in review until the declared artifact exists and verifies', async (t) => {
  const ctx = await fixture(t, {
    async complete() {
      return reply('Delivered report.txt');
    },
  });
  const task = ctx.store.createTask(ctx.session.id, {
    title: 'Deliver report',
    acceptance: [
      {
        description: 'Report is delivered',
        met: false,
        check: {
          id: 'report',
          kind: 'file-delivery',
          path: 'report.txt',
          format: 'text',
          minBytes: 5,
        },
      },
    ],
  });
  const first = await ctx.agent.run({
    sessionId: ctx.session.id,
    taskId: task.id,
    prompt: 'Deliver',
  });
  assert.equal(first.status, 'needs_review');
  await writeFile(path.join(ctx.root, 'report.txt'), 'Verified delivery content');
  const resumed = new Agent({
    store: ctx.store,
    tools: createTools(ctx.root),
    approve: async () => true,
    provider: {
      async complete() {
        return reply('Delivered after verification');
      },
    },
  });
  const second = await resumed.run({
    sessionId: ctx.session.id,
    taskId: task.id,
    prompt: 'Verify delivery',
  });
  assert.equal(second.status, 'completed');
  assert.match(second.acceptance?.checks[0]?.detail ?? '', /sha256/);
});

test('output truncation reports token breakdown and live model phase without leaking reasoning', async (t) => {
  const provider: Provider = {
    async complete(request) {
      request.onProgress?.({
        phase: 'reasoning',
        reasoningChars: 14,
        toolArgumentChars: 0,
        visibleChars: 0,
      });
      return {
        ...reply(''),
        finishReason: 'length',
        usage: { inputTokens: 9, outputTokens: 100 },
        outputDiagnostics: {
          reasoningTokens: 95,
          reasoningChars: 14,
          toolArgumentChars: 0,
          visibleChars: 0,
        },
      };
    },
  };
  const { session, agent, events } = await fixture(t, provider, { maxOutputTokens: 100 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Work' });
  assert.equal(result.status, 'limited');
  assert.match(result.error!, /100\/100 output tokens/);
  assert.match(result.error!, /95 reasoning tokens/);
  assert.match(result.error!, /14 reasoning characters/);
  assert.doesNotMatch(result.error!, /private thought/);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'statistics.updated' &&
        (event.data.activity as { phase?: string } | null)?.phase === 'reasoning',
    ),
  );
});

// ---- merged from run-queue.test.ts ----

const reply2 = (text = 'done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
});
async function setup(
  t: test.TestContext,
  provider: Provider,
  approve: Approver = async () => true,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-queue-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const tools = createTools(root);
  const agent = new Agent({
    store,
    provider,
    approve,
    tools,
    onEvent: (e) => events.push(e),
  });
  return { root, store, session, agent, events, tools };
}
test('steer interrupts pending approval and skips remaining stale calls before requesting the model', async (t) => {
  let awaiting!: () => void;
  const waiting = new Promise<void>((resolve) => (awaiting = resolve));
  let requests = 0;
  const { root, store, session, agent } = await setup(
    t,
    {
      async complete(request) {
        if (requests++ === 0)
          return {
            ...reply2(),
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'first', name: 'write_file', arguments: { path: 'one.txt', content: 'bad' } },
              { id: 'second', name: 'write_file', arguments: { path: 'two.txt', content: 'bad' } },
            ],
          };
        assert.equal(request.messages.at(-1)?.content, 'Do not write; just explain.');
        assert.equal(request.messages.filter((m) => m.role === 'tool').length, 2);
        return reply2('Explained only');
      },
    },
    async (_approval, signal) => {
      awaiting();
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(false), { once: true }),
      );
    },
  );
  const run = agent.run({ sessionId: session.id, prompt: 'Write files' });
  await waiting;
  agent.enqueue(session.id, { prompt: 'Do not write; just explain.' }, 'steer');
  const result = await run;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Explained only');
  await assert.rejects(readFile(path.join(root, 'one.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'two.txt')), { code: 'ENOENT' });
  assert.equal(store.messages(session.id).filter((m) => m.role === 'user').length, 2);
});
test('steering wins an approval race even when the approver returns allow', async (t) => {
  let calls = 0;
  const { agent, session, root } = await setup(
    t,
    {
      async complete() {
        return calls++ === 0
          ? {
              ...reply2(),
              finishReason: 'tool_calls',
              toolCalls: [
                { id: 'w', name: 'write_file', arguments: { path: 'race.txt', content: 'bad' } },
              ],
            }
          : reply2();
      },
    },
    async () => {
      agent.enqueue(session.id, { prompt: 'Do not write' }, 'steer');
      return true;
    },
  );
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Write' })).status, 'completed');
  await assert.rejects(readFile(path.join(root, 'race.txt')), { code: 'ENOENT' });
});

test('steer lets a running tool finish and skips the next stale tool', async (t) => {
  let release!: () => void;
  const runningTool = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const readyTool = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let requests = 0,
    executed = 0;
  const { agent, session, tools, store } = await setup(t, {
    async complete(request) {
      if (requests++ === 0)
        return {
          ...reply2(),
          finishReason: 'tool_calls',
          toolCalls: ['first', 'second'].map((id) => ({ id, name: 'held_tool', arguments: {} })),
        };
      assert.equal(request.messages.at(-1)?.content, 'Change direction');
      return reply2();
    },
  });
  tools.register({
    name: 'held_tool',
    description: 'A tool in progress',
    inputSchema: { type: 'object' },
    async execute() {
      executed++;
      ready();
      await runningTool;
      return { isError: false, content: 'Actual tool completed' };
    },
  });
  const run = agent.run({ sessionId: session.id, prompt: 'Run two tools' });
  await readyTool;
  assert.throws(() => agent.enqueue('other-session', { prompt: 'Wrong' }, 'steer'), /not running/);
  agent.enqueue(session.id, { prompt: 'Change direction' }, 'steer');
  release();
  assert.equal((await run).status, 'completed');
  assert.equal(executed, 1);
  const results = store.messages(session.id).filter((m) => m.role === 'tool');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.isError, false);
  assert.equal(results[1]!.isError, true);
});

test('follow-ups execute in FIFO order after the current turn and are durable once consumed', async (t) => {
  let release!: (v: ModelResponse) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let turns = 0;
  const { agent, session, store } = await setup(t, {
    async complete(request) {
      if (turns++ === 0) {
        started();
        return new Promise<ModelResponse>((r) => (release = r));
      }
      return reply2('answer ' + request.messages.at(-1)?.content);
    },
  });
  const running = agent.run({ sessionId: session.id, prompt: 'first' });
  await ready;
  agent.enqueue(session.id, { prompt: 'second' }, 'follow-up');
  agent.enqueue(session.id, { prompt: 'third' }, 'follow-up');
  assert.equal(agent.getQueue(session.id).length, 2);
  release(reply2('answer first'));
  assert.equal((await running).text, 'answer third');
  assert.deepEqual(
    store
      .messages(session.id)
      .filter((m) => m.role === 'user')
      .map((m) => m.content),
    ['first', 'second', 'third'],
  );
  assert.equal(agent.getQueue(session.id).length, 0);
  assert.throws(() => agent.enqueue(session.id, { prompt: 'late' }, 'steer'), /not running/);
});
test('cancel clears unconsumed inputs and does not replay them into history', async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const { agent, session, store } = await setup(t, {
    complete: ({ signal }) => {
      started();
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  const aborter = new AbortController();
  const running = agent.run({ sessionId: session.id, prompt: 'first', signal: aborter.signal });
  await ready;
  agent.enqueue(session.id, { prompt: 'never execute' }, 'follow-up');
  aborter.abort();
  assert.equal((await running).status, 'cancelled');
  assert.equal(agent.getQueue(session.id).length, 0);
  assert.equal(store.messages(session.id).filter((m) => m.role === 'user').length, 1);
});

test('queued image metadata does not duplicate base64 data into queue events', async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let release!: (v: ModelResponse) => void;
  const { agent, session, events } = await setup(t, {
    complete: () => {
      started();
      return new Promise((r) => (release = r));
    },
  });
  const running = agent.run({ sessionId: session.id, prompt: 'first' });
  await ready;
  const image = {
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5u8AAAAASUVORK5CYII=',
  };
  agent.enqueue(session.id, { prompt: 'image later', images: [image] }, 'follow-up');
  assert.doesNotMatch(JSON.stringify(events.filter((e) => e.type === 'input.queued')), /iVBOR/);
  assert.equal(agent.getQueue(session.id)[0]!.imageCount, 1);
  agent.clearQueue(session.id);
  release(reply2());
  await running;
});

test('queued messages retain submission time when consumed later', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-22T02:00:00.000Z') });
  const queue = new RunQueue();
  queue.add({ prompt: 'later' }, 'follow-up');
  t.mock.timers.setTime(new Date('2026-09-22T02:10:00.000Z').getTime());
  assert.equal(queue.take('follow-up')?.createdAt, '2026-09-22T02:00:00.000Z');
});

// ---- merged from statistics.test.ts ----

test('statistics aggregate usage without inventing missing cache information', () => {
  const stats = emptyStatistics();
  addUsage(stats, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 });
  assert.equal(stats.cachedInputTokens, 80);
  assert.equal(stats.cacheKnown, true);
  // A cache write is a part of the reported input total, kept separately so "is the prompt cache paying for
  // itself?" has an answer: a write is billed differently from a read and is what makes the next read cheap.
  addUsage(stats, {
    inputTokens: 200,
    outputTokens: 5,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 150,
  });
  assert.equal(stats.cacheWriteInputTokens, 150);
  assert.equal(stats.inputTokens, 300);
  // A provider that does not report cache writes at all leaves the total at what it did report.
  addUsage(stats, { inputTokens: 50, outputTokens: 10 });
  assert.equal(stats.inputTokens, 350);
  assert.equal(stats.outputTokens, 35);
  assert.equal(stats.cacheWriteInputTokens, 150, 'an unreported write is not a zero');
  assert.equal(stats.cacheKnown, false);
});

test('statistics combine completed runs without mutating their stored values', () => {
  const first = {
    ...emptyStatistics(),
    turns: 1,
    steps: 2,
    inputTokens: 100,
    outputTokens: 20,
    modelMs: 2000,
    toolMs: 500,
    firstTokenMs: 300,
    firstTokenCount: 1,
    decodeMs: 1200,
    decodeTokens: 20,
  };
  const combined = addStatistics(first, {
    ...emptyStatistics(),
    turns: 1,
    steps: 1,
    modelMs: 1000,
    firstTokenMs: 100,
    firstTokenCount: 1,
    decodeMs: 400,
    decodeTokens: 5,
    cachedInputTokens: 30,
  });
  assert.equal(combined.modelMs, 3000);
  assert.equal(combined.toolMs, 500);
  assert.equal(combined.firstTokenMs / combined.firstTokenCount, 200);
  // The output speed is output over the *decode* half of a step, so both halves have to add up: a total that
  // summed one and not the other would report a throughput no step ever had.
  assert.equal(combined.decodeTokens / (combined.decodeMs / 1000), 25 / 1.6);
  assert.equal(combined.turns, 2);
  assert.equal(combined.steps, 3);
  assert.equal(first.modelMs, 2000);
  assert.equal(first.steps, 2);
});

test('a run recorded before the boundary and decode fields still sums', () => {
  // The log is read by builds that did not write these fields: the ones that predate them contribute zero
  // rather than `NaN`, which is what keeps a session's totals finite after an upgrade.
  const legacy = { ...emptyStatistics() } as Record<string, unknown>;
  delete legacy.turns;
  delete legacy.steps;
  delete legacy.decodeMs;
  delete legacy.decodeTokens;
  const combined = addStatistics(emptyStatistics(), legacy as never);
  assert.equal(combined.turns, 0);
  assert.equal(combined.steps, 0);
  assert.equal(combined.decodeMs, 0);
  assert.equal(combined.decodeTokens, 0);
});

// ---- merged from errors.test.ts ----

test('diagnostics keep numeric token limits while redacting credential values', () => {
  const message = '100/100 output tokens; key is secret-value';
  const env = {
    YUANTU_MAX_OUTPUT_TOKENS: '100',
    YUANTU_API_KEY: 'secret-value',
    GITHUB_TOKEN: 'github-secret',
  };
  assert.equal(
    redactSecrets(message + '; github-secret', env),
    '100/100 output tokens; key is [redacted]; [redacted]',
  );
});
