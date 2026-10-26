import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/catalog/index.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import { resolveRunLimits } from '../packages/protocol/settings.ts';
import type { AgentEvent, ModelRequest } from '../packages/protocol/index.ts';
import { storeFixture } from './temp-fixture.ts';

/**
 * The two clocks one model request is bounded by, and the one re-send an empty attempt earns.
 *
 * Everything here is offline: `fetch` is replaced by a synthetic endpoint, and every delay is tens of
 * milliseconds rather than the minutes the real settings express. What is being tested is *which* clock a
 * failure is judged by, not how long a second is.
 */

const answer = (): Response =>
  new Response(
    [
      { choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
/** A 2xx SSE response that closes without sending a single byte. */
const emptyStream = (): Response =>
  new Response(new ReadableStream({ start: (controller) => controller.close() }), {
    headers: { 'content-type': 'text/event-stream' },
  });
/** One reasoning event, then the connection is cut. */
const cutAfterReasoning = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          Buffer.from(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] })}\n\n`,
          ),
        );
        setTimeout(() => controller.error(new Error('fixture cut')), 20);
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
/** Response headers refusing the request, with no body. */
const refused = (status: number): Response => new Response('', { status });

const provider = (
  config: { streamIdleTimeoutMs?: number; responseHeadersTimeoutMs?: number } = {},
) =>
  new OpenAIProvider({
    apiKey: 'fixture-secret',
    model: 'fixture',
    baseUrl: 'https://fixture.invalid',
    ...config,
  });
const request = (): ModelRequest => ({
  system: 'fixture',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxOutputTokens: 8192,
  signal: new AbortController().signal,
  onText: () => {},
});
async function fixture(
  t: test.TestContext,
  responses: ((url?: unknown, init?: RequestInit) => Response | Promise<Response>)[],
  options: {
    providerConfig?: { streamIdleTimeoutMs?: number; responseHeadersTimeoutMs?: number };
    extra?: object;
  } = {},
) {
  const { root, store, session } = await storeFixture(t, 'yuantu-zero-byte-');
  const events: AgentEvent[] = [];
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    assert.ok(next, 'unexpected extra request');
    return next(url, init);
  });
  const agent = new Agent({
    store,
    provider: provider(options.providerConfig),
    tools: createTools(root),
    approve: async () => true,
    maxModelRetries: 0,
    onEvent: (event) => events.push(event),
    ...options.extra,
  });
  return { root, store, session, agent, events, bodies };
}

test('the wait for headers is its own clock, and not the stream idle timeout', async (t) => {
  /**
   * Headers arrive after 120 ms, and the mock honours an abort the way the real transport does.
   *
   * The idle clock here is 40 ms, so a run that used it for this wait would give up before the headers exist —
   * which is exactly what the second half of this test shows.
   */
  const slowHeaders = (_url?: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(answer()), 120);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('fixture aborted'));
      });
    });
  const ctx = await fixture(t, [slowHeaders], {
    providerConfig: { streamIdleTimeoutMs: 40, responseHeadersTimeoutMs: 5_000 },
  });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hi' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(ctx.bodies.length, 1);
  // The same endpoint under the old arrangement — one number for both waits — fails, which is the bug.
  const timedOut = await fixture(t, [slowHeaders], {
    providerConfig: { streamIdleTimeoutMs: 40 },
  });
  const failed = await timedOut.agent.run({ sessionId: timedOut.session.id, prompt: 'hi' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /Model response headers timeout/);
});

test('a header wait that runs out is a failure of the header clock, not of the stream', async (t) => {
  const neverResponds = (_url?: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('fixture aborted')));
    });
  const ctx = await fixture(t, [neverResponds, neverResponds, neverResponds], {
    providerConfig: { streamIdleTimeoutMs: 5_000, responseHeadersTimeoutMs: 30 },
  });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hi' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Model response headers timeout/);
});

test('a header timeout is re-sent once with the same request and its own durable allowance', async (t) => {
  const neverResponds = (_url?: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  const ctx = await fixture(t, [neverResponds, answer], {
    providerConfig: { responseHeadersTimeoutMs: 40, streamIdleTimeoutMs: 5_000 },
    extra: { zeroByteRetries: 1, maxModelRetries: 0 },
  });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hi' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'Done');
  assert.equal(ctx.bodies.length, 2);
  assert.deepEqual(ctx.bodies[0], ctx.bodies[1]);
  const retries = ctx.store.events(ctx.session.id).filter((e) => e.type === 'llm.zero-byte-retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0]!.data.attempt, 1);
  assert.equal(ctx.store.events(ctx.session.id).filter((e) => e.type === 'llm.retry').length, 0);
});

test('header timeouts stop after the empty retry allowance is spent', async (t) => {
  const neverResponds = (_url?: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  const ctx = await fixture(t, [neverResponds, neverResponds, answer], {
    providerConfig: { responseHeadersTimeoutMs: 40 },
    extra: { zeroByteRetries: 1, maxModelRetries: 0 },
  });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hi' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'timeout');
  assert.match(result.error ?? '', /Model response headers timeout/);
  assert.equal(ctx.bodies.length, 2);
});

test('cancelling the header wait preserves the caller reason and never retries', async (t) => {
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const neverResponds = (_url?: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      started();
    });
  const ctx = await fixture(t, [neverResponds, answer], {
    providerConfig: { responseHeadersTimeoutMs: 5_000 },
    extra: { zeroByteRetries: 1, maxModelRetries: 0 },
  });
  const controller = new AbortController();
  const running = ctx.agent.run({
    sessionId: ctx.session.id,
    prompt: 'hi',
    signal: controller.signal,
  });
  await pending;
  controller.abort(new Error('Stopped by fixture caller'));
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(ctx.bodies.length, 1);
  assert.equal(
    ctx.store.events(ctx.session.id).filter((e) => e.type === 'llm.zero-byte-retry').length,
    0,
  );
});

test('an empty attempt is re-sent once on its own allowance and recorded as such', async (t) => {
  const ctx = await fixture(t, [emptyStream, answer], {
    extra: { zeroByteRetries: 1, maxModelRetries: 0 },
  });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hi' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(ctx.bodies.length, 2, 'the empty attempt was sent again exactly once');
  const logged = ctx.store.events(ctx.session.id);
  assert.equal(logged.filter((event) => event.type === 'llm.zero-byte-retry').length, 1);
  assert.equal(logged.filter((event) => event.type === 'llm.retry').length, 0);
  assert.ok(ctx.events.some((event) => event.type === 'llm.zero-byte-retry'));
  const record = logged.find((event) => event.type === 'llm.zero-byte-retry')!;
  assert.equal(record.data.round, 0);
  assert.equal(record.data.attempt, 1);
  assert.equal(typeof record.data.firstRequestMs, 'number');
});

test('the allowance is one re-send, not a loop', async (t) => {
  const ctx = await fixture(t, [emptyStream, emptyStream, answer], {
    extra: { zeroByteRetries: 1 },
  });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hi' });
  assert.equal(result.status, 'failed');
  assert.equal(ctx.bodies.length, 2, 'a third request is never made');
  assert.equal(
    ctx.store.events(ctx.session.id).filter((event) => event.type === 'llm.zero-byte-retry').length,
    1,
  );
});

test('an empty re-send does not consume the ordinary retry allowance', async (t) => {
  const ctx = await fixture(t, [emptyStream, () => refused(503), answer], {
    extra: { zeroByteRetries: 1, maxModelRetries: 2 },
  });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hi' });
  assert.equal(result.status, 'completed', result.error);
  const logged = ctx.store.events(ctx.session.id);
  // The 503 is an ordinary transient failure: it is counted as one retry and spends one of the two.
  assert.equal(logged.filter((event) => event.type === 'llm.retry').length, 1);
  assert.equal(logged.filter((event) => event.type === 'llm.zero-byte-retry').length, 1);
  assert.equal(ctx.bodies.length, 3);
});

test('an attempt that streamed anything is not empty, however it ended', async (t) => {
  const ctx = await fixture(t, [cutAfterReasoning], { extra: { zeroByteRetries: 2 } });
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'hi' });
  assert.equal(result.status, 'failed');
  assert.equal(ctx.bodies.length, 1, 'a streamed thought is never paid for twice');
  assert.equal(
    ctx.store.events(ctx.session.id).filter((event) => event.type === 'llm.zero-byte-retry').length,
    0,
  );
});

test('a refused request is not an empty attempt, and the product default re-sends nothing', async (t) => {
  // A 503 with no body is classified by its status, so it is an ordinary transient failure: the evaluation's
  // `maxModelRetries=0` refuses to re-send it, and the empty-attempt allowance is not what decides.
  const refusedOnce = await fixture(t, [() => refused(503), answer], {
    extra: { zeroByteRetries: 1 },
  });
  const failedRefusal = await refusedOnce.agent.run({
    sessionId: refusedOnce.session.id,
    prompt: 'hi',
  });
  assert.equal(failedRefusal.status, 'failed');
  assert.equal(refusedOnce.bodies.length, 1);
  assert.equal(
    refusedOnce.store.events(refusedOnce.session.id).filter((e) => e.type === 'llm.zero-byte-retry')
      .length,
    0,
    'a 503 is classified by its status, not by the bytes it did not send',
  );
  // Nothing configured: the empty attempt fails the run, exactly as before the feature existed.
  const defaults = await fixture(t, [emptyStream, answer]);
  const failed = await defaults.agent.run({ sessionId: defaults.session.id, prompt: 'hi' });
  assert.equal(failed.status, 'failed');
  assert.equal(defaults.bodies.length, 1);
});

test('the settings resolve their own defaults and bounds', () => {
  const resolved = resolveRunLimits({});
  assert.equal(resolved.zeroByteRetries, 0);
  assert.equal(resolved.responseHeadersTimeoutMs, resolved.streamIdleTimeoutMs);
  assert.equal(resolveRunLimits({ zeroByteRetries: 3 }).zeroByteRetries, 3);
  assert.throws(() => resolveRunLimits({ zeroByteRetries: -1 }), /zeroByteRetries/);
  assert.throws(
    () => resolveRunLimits({ responseHeadersTimeoutMs: 0 }),
    /responseHeadersTimeoutMs/,
  );
});

test('the provider carries the byte and event counts on its failures', async (t) => {
  const cases: { response: () => Response; code: string; bytes: number; events: number }[] = [
    { response: emptyStream, code: 'transport', bytes: 0, events: 0 },
    { response: cutAfterReasoning, code: 'transport', bytes: expectBytesAboveZero, events: 1 },
  ];
  for (const item of cases) {
    t.mock.method(globalThis, 'fetch', async () => item.response());
    const failure = await provider()
      .complete(request())
      .then(
        () => assert.fail('expected a failure'),
        (error: unknown) => error,
      );
    assert.ok(failure instanceof RunFailure, String(failure));
    assert.equal(failure.code, item.code);
    assert.equal(failure.details?.events, item.events);
    if (item.bytes === expectBytesAboveZero)
      assert.ok((failure.details?.responseBytes ?? 0) > 0, 'a streamed event implies bytes');
    else assert.equal(failure.details?.responseBytes, 0);
  }
});
/** A sentinel meaning "some bytes, not none": the counts are compared, not the number. */
const expectBytesAboveZero = -1;
