import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { AgentEvent, ModelResponse } from '../packages/protocol/index.ts';

for (const limit of [1, 4]) {
  test(`actual tool intervals show concurrency ${limit} and keep result order`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-tool-performance-'));
    const store = new SessionStore(path.join(root, 'session.sqlite'));
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const session = store.create(root);
    const tools = new ToolRegistry();
    const intervals = new Map<string, { startedAt: number; finishedAt: number }>();
    let active = 0;
    let peak = 0;
    tools.register({
      name: 'read_probe',
      description: 'Controlled read',
      inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
      isConcurrencySafe: () => true,
      async execute(args: { ms: number }, context) {
        const span = { startedAt: Date.now(), finishedAt: 0 };
        intervals.set(context.callId!, span);
        peak = Math.max(peak, ++active);
        await delay(args.ms, undefined, { signal: context.signal });
        active--;
        span.finishedAt = Date.now();
        return { isError: false, content: context.callId! };
      },
    });
    const events: AgentEvent[] = [];
    let requests = 0;
    const reply = (): ModelResponse => ({
      text: 'Done.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await new Agent({
      store,
      tools,
      approve: async () => false,
      maxParallelToolCalls: limit,
      onEvent: (event) => {
        events.push(event);
      },
      provider: {
        async complete(request) {
          if (requests++ === 0)
            return {
              ...reply(),
              text: '',
              finishReason: 'tool_calls',
              toolCalls: [80, 10, 10, 10].map((ms, index) => ({
                id: 'call-' + index,
                name: 'read_probe',
                arguments: { ms },
              })),
            };
          request.onText('Done.');
          return reply();
        },
      },
    }).run({ sessionId: session.id, prompt: 'Read four probes.' });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(peak, limit);
    const finished = events.filter((event) => String(event.type) === 'tool.execution.finished');
    assert.equal(finished.length, 4);
    assert.equal(Math.max(...finished.map((event) => Number(event.data.peakConcurrency))), peak);
    for (const event of finished) {
      const span = intervals.get(String(event.data.callId))!;
      assert.ok(Math.abs(Number(event.data.startedAt) - span.startedAt) < 50);
      assert.ok(Math.abs(Number(event.data.finishedAt) - span.finishedAt) < 50);
      assert.ok(Number(event.data.durationMs) >= (event.data.callId === 'call-0' ? 70 : 5));
    }
    const results = events.filter((event) => event.type === 'tool.finished');
    assert.deepEqual(
      results.map((event) => event.data.callId),
      [0, 1, 2, 3].map((index) => 'call-' + index),
    );
    const lastTiming = results[3]!.data.timing as { queueMs: number; durationMs: number };
    assert.equal(
      (results[3]!.data.timing as { executionComplete: boolean }).executionComplete,
      true,
    );
    if (limit === 1) assert.ok(lastTiming.queueMs >= 80);
    else
      assert.notEqual(
        finished[0]!.data.callId,
        'call-0',
        'fast execution is announced before the slow result',
      );
  });
}

test('denied approval produces no execution interval and diagnostic failures cannot repeat an effect', async () => {
  const tools = new ToolRegistry();
  let effects = 0;
  tools.register({
    name: 'write_probe',
    description: 'Controlled write',
    permission: 'write',
    inputSchema: { type: 'object' },
    async execute() {
      effects++;
      return { isError: false, content: 'Written once.' };
    },
  });
  const phases: string[] = [];
  const call = { id: 'write-1', name: 'write_probe', arguments: {} };
  const denied = await tools.execute(call, {
    signal: new AbortController().signal,
    approve: async () => {
      await delay(20);
      return false;
    },
    onExecution: (event) => {
      phases.push(event.phase);
    },
  });
  assert.equal(denied.isError, true);
  assert.equal(effects, 0);
  assert.equal(phases.length, 0);
  const allowed = await tools.execute(call, {
    signal: new AbortController().signal,
    approve: async () => true,
    onExecution: (event) => {
      phases.push(event.phase);
      throw new Error('Broken diagnostics');
    },
  });
  assert.equal(allowed.isError, false);
  assert.equal(effects, 1);
  assert.deepEqual(phases, ['started', 'finished']);
  const asyncObserved = await tools.execute(call, {
    signal: new AbortController().signal,
    approve: async () => true,
    onExecution: async () => {
      throw new Error('Async diagnostics failed');
    },
  });
  await delay(0);
  assert.equal(asyncObserved.isError, false);
  assert.equal(effects, 2);
});

test('a timeout retry marks result timing incomplete until older attempts actually finish', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-tool-overlap-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const tools = new ToolRegistry();
  let bodies = 0;
  let finishOld!: () => void;
  const old = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  tools.deadlines = { defaultMs: 20 };
  tools.register({
    name: 'read_overlap',
    description: 'Controlled read',
    inputSchema: { type: 'object' },
    async execute() {
      if (++bodies === 1) await old;
      return { isError: false, content: 'Read.' };
    },
  });
  tools.registerHooks({
    aroundTool: async (dispatch, next) => {
      try {
        return await next();
      } catch {
        const retryAbort = new AbortController();
        return await next(dispatch.withSignal(retryAbort.signal, retryAbort));
      }
    },
  });
  const events: AgentEvent[] = [];
  let requests = 0;
  const result = await new Agent({
    store,
    tools,
    approve: async () => false,
    onEvent: (event) => {
      events.push(event);
    },
    provider: {
      async complete(request) {
        if (requests++ === 0)
          return {
            text: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'overlap', name: 'read_overlap', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        request.onText('Done.');
        return {
          text: 'Done.',
          finishReason: 'stop',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  }).run({ sessionId: session.id, prompt: 'Read a probe.' });
  assert.equal(result.status, 'completed', result.error);
  const finished = events.find((event) => event.type === 'tool.finished')!;
  const timing = finished.data.timing as {
    attempts: number;
    finishedAttempts: number;
    executionComplete: boolean;
  };
  assert.equal(timing.attempts, 2);
  assert.equal(timing.finishedAttempts, 1);
  assert.equal(timing.executionComplete, false);
  finishOld();
  await delay(0);
  assert.equal(
    events.filter((event) => String(event.type) === 'tool.execution.finished').length,
    2,
  );
  assert.equal(timing.finishedAttempts, 1, 'the previously emitted result snapshot is immutable');
});
