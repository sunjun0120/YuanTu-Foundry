import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareContext } from '../packages/core/context.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { ModelRequest, ModelResponse } from '../packages/protocol/index.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../packages/core/agent.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import { isSummaryRequest } from './summary-request.ts';
import { TokenCalibration } from '../packages/core/calibration.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-summary-performance-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  for (let index = 0; index < 6; index++) {
    store.append(session.id, { role: 'user', content: `Turn ${index}: ` + 'detail '.repeat(600) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  store.append(session.id, { role: 'user', content: 'Continue.' });
  const input = {
    store,
    sessionId: session.id,
    system: 'Fixture',
    tools: [],
    limit: 100000,
    signal: new AbortController().signal,
    maxOutputTokens: 1024,
    maxContextTokens: 4000,
    summaryTimeoutMs: 30000,
    forceCompact: true,
    onUsage: () => {},
    onCompaction: () => {},
  };
  return { store, session, input };
}
const reply = (truncated = false): ModelResponse => ({
  text: truncated ? '' : 'Keep all constraints. Continue remaining work.',
  toolCalls: [],
  finishReason: truncated ? 'length' : 'stop',
  usage: { inputTokens: 100, outputTokens: truncated ? 1024 : 80 },
  outputDiagnostics: {
    reasoningTokens: truncated ? 1024 : 60,
    reasoningChars: 100,
    visibleChars: truncated ? 0 : 44,
    toolArgumentChars: 0,
  },
});

test('summary batching reserves useful output before filling the input window', async (t) => {
  const { input } = await fixture(t);
  const budgets: number[] = [];
  const result = await prepareContext({
    ...input,
    provider: {
      async complete(request) {
        budgets.push(request.maxOutputTokens);
        return reply();
      },
    },
  });
  assert.equal(result.compacted, true);
  assert.ok(budgets.length > 1);
  assert.ok(
    budgets.every((budget) => budget >= 1024),
    JSON.stringify(budgets),
  );
});

test('a length summary retries a smaller batch once and retains the full transcript', async (t) => {
  const { input, store, session } = await fixture(t);
  const before = store.messages(session.id);
  const requests: ModelRequest[] = [];
  const result = await prepareContext({
    ...input,
    maxContextTokens: 128000,
    provider: {
      async complete(request) {
        requests.push(request);
        return reply(requests.length === 1);
      },
    },
  });
  assert.equal(result.compacted, true);
  assert.equal(requests.length, 3);
  assert.ok(requests[1]!.messages.length < requests[0]!.messages.length);
  assert.deepEqual(store.messages(session.id), before);
});

test('repeated length summaries stop with a specific failure and no checkpoint', async (t) => {
  const { input, store, session } = await fixture(t);
  let requests = 0;
  const before = store.messages(session.id);
  await assert.rejects(
    prepareContext({
      ...input,
      maxContextTokens: 128000,
      provider: {
        async complete() {
          requests++;
          return reply(true);
        },
      },
    }),
    /summary.*finish_reason=length.*reasoning_tokens=1024/i,
  );
  assert.equal(requests, 2);
  assert.equal(store.contextSurface(session.id), null);
  assert.deepEqual(store.messages(session.id), before);
});

test('all summary batches share one deadline and timeout leaves no checkpoint', async (t) => {
  const { input, store, session } = await fixture(t);
  const before = store.messages(session.id);
  const signals: AbortSignal[] = [];
  await assert.rejects(
    prepareContext({
      ...input,
      summaryTimeoutMs: 80,
      provider: {
        async complete(request) {
          signals.push(request.signal);
          await delay(50, undefined, { signal: request.signal });
          return reply();
        },
      },
    }),
    /abort|timeout/i,
  );
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(store.contextSurface(session.id), null);
  assert.deepEqual(store.messages(session.id), before);
});

test('successful overflow compaction clears an earlier summary failure', async (t) => {
  const { store, session } = await fixture(t);
  for (let index = 0; index < 3; index++) {
    store.append(session.id, { role: 'user', content: 'history '.repeat(1100) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  let summaries = 0;
  const result = await new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextTokens: 66000,
    maxOutputTokens: 128,
    autoCompactTokens: 11000,
    maxContextChars: 100000,
    provider: {
      async complete(request) {
        if (isSummaryRequest(request)) return reply(++summaries <= 2);
        throw new RunFailure('context-window-exceeded', 'Current fixture request still too large');
      },
    },
  }).run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'limited', result.error);
  assert.ok(store.contextSurface(session.id), 'overflow recovery successfully compacted');
  assert.doesNotMatch(result.error!, /compaction failed|finish_reason=length/);
  assert.match(result.error!, /Current fixture request still too large/);
});

test('summary retry uses the latest calibration and only records sent retries', async (t) => {
  const { input, store, session } = await fixture(t);
  const sizes: number[] = [];
  const result = await prepareContext({
    ...input,
    maxContextTokens: 8000,
    calibration: new TokenCalibration(),
    provider: {
      async complete(request) {
        sizes.push(request.messages.length);
        return sizes.length === 1
          ? { ...reply(true), usage: { inputTokens: 20000, outputTokens: 1024 } }
          : reply();
      },
    },
  });
  assert.equal(result.compacted, true);
  assert.ok(sizes.length > 1);
  const retry = store.events(session.id).find((event) => event.type === 'context.summary.retry')!;
  assert.equal(Number(retry.data.toMessages) + 1, sizes[1]);
  assert.ok(Number(retry.data.toMessages) < Number(retry.data.fromMessages));
});

test('summary failure details preserve the original provider overflow metadata', async (t) => {
  const { store, session } = await fixture(t);
  const result = await new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextTokens: 10000,
    maxOutputTokens: 1024,
    maxContextChars: 100000,
    provider: {
      async complete(request) {
        if (isSummaryRequest(request)) return reply(true);
        throw new RunFailure('context-window-exceeded', 'Fixture overflow', {
          httpStatus: 400,
          requestId: 'req-real-overflow',
        });
      },
    },
  }).run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'limited');
  assert.match(result.error!, /compaction failed/);
  assert.equal(result.httpStatus, 400);
  assert.equal(result.requestId, 'req-real-overflow');
});

test('committed multi-batch summaries retain unknown cache usage before run finalization', async (t) => {
  const { input, store, session } = await fixture(t);
  let calls = 0;
  await prepareContext({
    ...input,
    provider: {
      async complete() {
        calls++;
        const response = reply();
        if (calls !== 2) response.usage.cachedInputTokens = 80;
        return response;
      },
    },
  });
  assert.ok(calls >= 2);
  assert.equal(store.statistics(session.id).cacheKnown, false);
  assert.equal(store.statistics(session.id).cachedInputTokens, 80 * (calls - 1));
});
