import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { AgentEvent, ModelResponse } from '../packages/protocol/index.ts';
import { isSummaryRequest } from './summary-request.ts';
import { addStatistics, emptyStatistics } from '../packages/protocol/statistics.ts';
import { createRunEmit, type RunEmission } from '../packages/core/run-emit.ts';
import { RunFailure } from '../packages/protocol/failure.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-performance-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, session: store.create(root) };
}

const answer = (): ModelResponse => ({
  text: 'Done.',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 64, cachedInputTokens: 80, cacheWriteInputTokens: 10 },
  outputDiagnostics: {
    reasoningTokens: 60,
    reasoningChars: 120,
    visibleChars: 5,
    toolArgumentChars: 0,
  },
});

for (const truncated of [false, true]) {
  test(`summary ${truncated ? 'fallback' : 'success'} cannot set the visible first token or decode span`, async (t) => {
    const { store, session } = await fixture(t);
    for (let i = 0; i < 3; i++) {
      store.append(session.id, { role: 'user', content: 'history '.repeat(1100) });
      store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
    }
    const events: AgentEvent[] = [];
    let deltaAt = 0;
    let summaries = 0;
    const agent = new Agent({
      store,
      tools: new ToolRegistry(),
      approve: async () => false,
      maxContextChars: 100000,
      maxContextTokens: 66000,
      autoCompactTokens: 11000,
      maxOutputTokens: 128,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'message.delta' && !deltaAt) deltaAt = Date.now();
      },
      provider: {
        async complete(request) {
          if (isSummaryRequest(request)) {
            summaries++;
            request.onText('Summary.');
            await delay(60);
            return { ...answer(), text: 'Summary.', finishReason: truncated ? 'length' : 'stop' };
          }
          assert.equal(events.filter((e) => e.type === 'message.delta').length, 0);
          const latest = events.filter((e) => e.type === 'statistics.updated').at(-1)!;
          assert.equal(
            (latest.data.statistics as { firstTokenCount: number }).firstTokenCount,
            0,
            'internal summary text must not count as a user-visible token',
          );
          request.onReasoning?.('Thinking');
          request.onText('Done.');
          await delay(5);
          return answer();
        },
      },
    });
    const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
    assert.equal(result.status, 'completed', result.error);
    assert.ok(summaries > 0);
    assert.equal(result.statistics!.firstTokenCount, 1);
    assert.equal(result.statistics!.decodeTokens, 4, 'reasoning tokens are excluded');
    assert.ok(result.statistics!.firstTokenMs >= 60);
    assert.ok(result.statistics!.decodeMs < result.statistics!.firstTokenMs);
    const step = store.events(session.id).find((event) => event.type === 'step.started')!;
    assert.ok(Math.abs(result.statistics!.firstTokenMs - (deltaAt - Date.parse(step.at))) < 50);
    const requests = events.filter((event) => event.type === 'provider.request.finished');
    const timing = result.statistics!.requestTiming!;
    assert.equal(timing.requests, summaries + 1);
    assert.equal(timing.summaryRequests, summaries);
    assert.equal(timing.lengthCount, truncated ? summaries : 0);
    assert.equal(
      timing.providerMs,
      requests.reduce((sum, event) => sum + Number(event.data.durationMs), 0),
    );
    assert.equal(
      timing.summaryMs,
      requests
        .filter((event) => event.data.purpose === 'summary')
        .reduce((sum, event) => sum + Number(event.data.durationMs), 0),
    );
    assert.equal(store.statistics(session.id).inputTokens, result.statistics!.inputTokens);
    assert.equal(store.statistics(session.id).outputTokens, result.statistics!.outputTokens);
    assert.equal(
      store.statistics(session.id).cachedInputTokens,
      result.statistics!.cachedInputTokens,
    );
    assert.equal(
      store.statistics(session.id).cacheWriteInputTokens,
      result.statistics!.cacheWriteInputTokens,
    );
    assert.deepEqual(store.statistics(session.id), result.statistics);
  });
}

test('unknown reasoning usage does not become a precise visible token count', async (t) => {
  const { store, session } = await fixture(t);
  const result = await new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      async complete(request) {
        request.onText('Done.');
        const response = answer();
        delete response.outputDiagnostics;
        return response;
      },
    },
  }).run({ sessionId: session.id, prompt: 'Hello.' });
  assert.equal(result.status, 'completed');
  assert.equal(result.statistics!.decodeTokens, 0);
  assert.equal((result.statistics as unknown as { decodeKnown: boolean }).decodeKnown, false);
  assert.deepEqual(store.statistics(session.id), result.statistics);
});

test('retry waits and failed attempts are counted separately from provider work', async (t) => {
  const { store, session } = await fixture(t);
  let calls = 0;
  let firstAttemptMs = 0;
  const result = await new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxModelRetries: 1,
    provider: {
      async complete(request) {
        const started = performance.now();
        await delay(10);
        if (calls++ === 0) {
          firstAttemptMs = performance.now() - started;
          throw new RunFailure('server', 'Temporary fixture failure');
        }
        request.onText('Done.');
        return answer();
      },
    },
  }).run({ sessionId: session.id, prompt: 'Hello.' });
  assert.equal(result.status, 'completed', result.error);
  const timing = result.statistics!.requestTiming!;
  assert.equal(timing.requests, 2);
  assert.equal(timing.failedRequests, 1);
  assert.ok(firstAttemptMs > 0);
  assert.ok(Math.abs(timing.failedMs - firstAttemptMs) < 50);
  assert.ok(timing.providerMs > timing.failedMs);
  assert.ok(timing.retryWaitMs >= 240);
  assert.ok(result.statistics!.modelMs >= timing.providerMs + timing.retryWaitMs);
});

test('tool argument progress alone is not a visible first token', async (t) => {
  const { store, session } = await fixture(t);
  const result = await new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      async complete(request) {
        request.onProgress?.({
          phase: 'tool_call',
          reasoningChars: 0,
          toolArgumentChars: 20,
          visibleChars: 0,
        });
        return {
          ...answer(),
          text: '',
          finishReason: 'length',
          outputDiagnostics: {
            reasoningTokens: 0,
            reasoningChars: 0,
            toolArgumentChars: 20,
            visibleChars: 0,
          },
        };
      },
    },
  }).run({ sessionId: session.id, prompt: 'Call a tool.' });
  assert.equal(result.status, 'limited');
  assert.equal(result.statistics!.firstTokenCount, 0);
  assert.equal(result.statistics!.decodeMs, 0);
});

test('truncated tool arguments cannot count as body tokens even with empty toolCalls', async (t) => {
  const { store, session } = await fixture(t);
  const result = await new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      async complete(request) {
        request.onText('Done.');
        return {
          ...answer(),
          finishReason: 'length',
          outputDiagnostics: {
            reasoningTokens: 0,
            reasoningChars: 0,
            toolArgumentChars: 20,
            visibleChars: 5,
          },
        };
      },
    },
  }).run({ sessionId: session.id, prompt: 'Call a tool.' });
  assert.equal(result.status, 'limited');
  assert.equal(result.statistics!.decodeTokens, 0);
  assert.equal(result.statistics!.decodeKnown, false);
});

test('mixing legacy timed usage with split usage keeps visible throughput unknown', () => {
  const legacy = { ...emptyStatistics(), decodeMs: 100, decodeTokens: 64 };
  const split = { ...emptyStatistics(), decodeMs: 50, decodeTokens: 4, decodeKnown: true };
  assert.equal(addStatistics(legacy, split).decodeKnown, false);
  assert.equal(addStatistics(split, legacy).decodeKnown, false);
  assert.equal(addStatistics(emptyStatistics(), split).decodeKnown, true);
});

test('a failed provider request records its span without changing legacy modelMs', async (t) => {
  const { store, session } = await fixture(t);
  const events: AgentEvent[] = [];
  let observedProviderMs = 0;
  const result = await new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    onEvent: (event) => {
      events.push(event);
    },
    provider: {
      async complete() {
        const started = performance.now();
        await delay(20);
        observedProviderMs = performance.now() - started;
        throw new Error('Non-retryable fixture failure');
      },
    },
  }).run({ sessionId: session.id, prompt: 'Hello.' });
  assert.equal(result.status, 'failed');
  assert.equal(result.statistics!.modelMs, 0);
  const timing = (
    result.statistics as unknown as {
      requestTiming: { providerMs: number; failedMs: number; requests: number };
    }
  ).requestTiming;
  assert.equal(timing?.requests, 1);
  assert.ok(observedProviderMs > 0);
  assert.ok(Math.abs(timing.providerMs - observedProviderMs) < 50);
  assert.equal(timing.failedMs, timing.providerMs);
  const finished = events.filter((event) => event.type === 'provider.request.finished');
  assert.equal(finished.length, 1);
  assert.equal(finished[0]!.data.durationMs, timing.providerMs);
  assert.deepEqual(store.statistics(session.id), result.statistics);
});

test('at the emission seam, the tool wall clock is a union of spans and repeats or strays change nothing', async (t) => {
  /**
   * A test of the emission seam, not of a run: frames are fed to the emitter directly.
   *
   * The rule it pins is `toolMs` is the wall clock during which the run was waiting on *at least one* tool.
   * Driven by frames because the interesting shapes are hard to schedule and easy to state — a finish that arrives
   * before its sibling's, a finish for a call that never started, and the same finish twice. None of them may
   * produce a negative span or be charged twice, and a call that opens while another is still running must not
   * start a second clock: that is how the total came out as the shortest call instead of the union.
   *
   * Interleaved finishes are not reachable from today's single emitter — the loop announces a whole group's
   * `tool.started` up front and emits its `tool.finished` frames together once the group resolves — so this is
   * *not* a claim that a run shows the defect, and the plan's probe numbers are not a real-run observation. The
   * emitter's rule was wrong regardless, and this is where it can be witnessed; a second producer of tool frames
   * is what would make it reachable from a run.
   *
   * The schedule is the plan's probe shape — A over [0, 140] and B over [60, 100], so the union is 140 ms while
   * the old single scalar reported 40 ms (it was overwritten by B's start and cleared by B's finish). The
   * assertions are bounds rather than the exact `50` the plan names: `performance.now()` is not one of the clocks
   * Node's `mock.timers` can fake, and injecting a clock into the emitter to make it exact would widen an API the
   * plan did not authorize. What the bounds have to do is tell 140 from 40, with room for a scheduler that runs
   * late; the duplicate and unmatched cases below assert exact equality because they need no clock at all.
   */
  const { store, session } = await fixture(t);
  const statistics = emptyStatistics();
  const state: RunEmission = {
    statistics,
    emittedTypes: new Set<string>(),
    toolCalls: new Map<string, number>(),
    toolSpanStarted: undefined,
    toolActivityStartedAt: undefined,
    childOutputTokens: new Map<string, number>(),
  };
  const emit = createRunEmit({ store, sessionId: session.id, runId: 'fixture-run', state });
  emit('tool.started', { call: { id: 'a', name: 'read_one', arguments: {} } });
  await delay(60);
  emit('tool.started', { call: { id: 'b', name: 'read_two', arguments: {} } });
  await delay(40);
  // `b` finishes first, while `a` is still running: the run is still waiting, so nothing may be charged yet.
  emit('tool.finished', { callId: 'b', isError: false, content: 'b' });
  assert.ok(
    statistics.toolMs < 20,
    `a span is not charged while another call is still running, saw ${statistics.toolMs}`,
  );
  await delay(40);
  emit('tool.finished', { callId: 'a', isError: false, content: 'a' });
  const union = statistics.toolMs;
  assert.ok(union >= 120, `the union of the two spans is about 140 ms, saw ${union}`);
  assert.ok(
    union < 400,
    `and it is not counted twice, nor carried past the last finish, saw ${union}`,
  );
  // A finish nobody opened, and the same finish again: neither may move the total, and neither may go negative.
  emit('tool.finished', { callId: 'ghost', isError: false, content: 'ghost' });
  emit('tool.finished', { callId: 'a', isError: false, content: 'a' });
  assert.equal(statistics.toolMs, union, 'a repeated or unmatched finish changes nothing');
  // A later call that overlaps nothing is its own span, so disjoint spans add up.
  emit('tool.started', { call: { id: 'c', name: 'read_three', arguments: {} } });
  await delay(40);
  emit('tool.finished', { callId: 'c', isError: false, content: 'c' });
  assert.ok(
    statistics.toolMs >= union + 25,
    `a serial span adds to the union, saw ${statistics.toolMs} after ${union}`,
  );
});
