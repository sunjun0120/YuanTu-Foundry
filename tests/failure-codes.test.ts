/**
 * Failure codes: why a run ended, in a form a client can branch on.
 *
 * Before this, "why did it fail?" was answerable only by reading `RunResult.error`, and the *kind* of failure
 * was encoded in three places at once: a class chain in the run's catch, a status string, and prose. The tests
 * here pin the two things that make a code worth having — it survives the whole way to the durable record, and
 * the same condition gets the same code whichever protocol reported it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import {
  ModelFailure,
  RunFailure,
  codeForHttpStatus,
  failureCodeOf,
  statusForFailure,
} from '../packages/protocol/failure.ts';
import { httpFixture } from './http-fixture.ts';
import type {
  AgentEvent,
  ModelRequest,
  ModelResponse,
  Provider,
} from '../packages/protocol/index.ts';

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
async function fixture(t: test.TestContext, provider: Provider, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-failure-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { root, db, store, session, agent, events };
}
function request(): ModelRequest {
  return {
    system: 'You are YuanTu',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    onText: () => {},
  };
}
/** A provider that only ever answers with the failure under test. */
const failing = (error: unknown): Provider => ({
  complete: async () => {
    throw error;
  },
});

test('an unsuccessful status is named before anything reads its body', () => {
  assert.equal(codeForHttpStatus(401), 'auth');
  assert.equal(codeForHttpStatus(403), 'auth');
  assert.equal(codeForHttpStatus(429), 'rate-limit');
  assert.equal(codeForHttpStatus(500), 'server');
  assert.equal(codeForHttpStatus(529), 'server');
  // Anything else is still named: "the endpoint said no, in a way we have no better word for" is a real
  // answer, and it is not the same as an anonymous failure.
  assert.equal(codeForHttpStatus(400), 'http');
  assert.equal(codeForHttpStatus(404), 'http');
});

test('a limited run and a failed run are told apart by the code alone', () => {
  for (const code of ['context-window-exceeded', 'output-limit'] as const)
    assert.equal(statusForFailure(code), 'limited');
  for (const code of [
    'auth',
    'rate-limit',
    'server',
    'http',
    'timeout',
    'transport',
    'empty-response',
    'no-stream',
    'tool-cleanup',
  ] as const)
    assert.equal(statusForFailure(code), 'failed');
  // No code is not a code: a caller that gets `undefined` keeps whatever it knew before.
  assert.equal(statusForFailure(undefined), undefined);
});

test('the thrown value a failure code came from is recognised in every shape it arrives in', () => {
  assert.equal(failureCodeOf(new RunFailure('transport', 'x')), 'transport');
  assert.equal(
    failureCodeOf(new ModelFailure('context-window-exceeded', 'x')),
    'context-window-exceeded',
  );
  // `AbortSignal.timeout` aborts with a DOMException named TimeoutError and nothing of ours on it.
  assert.equal(failureCodeOf(AbortSignal.timeout(0).reason ?? new Error()), undefined);
  const aborted = new Error('The operation was aborted due to timeout');
  aborted.name = 'TimeoutError';
  assert.equal(failureCodeOf(aborted), 'timeout');
  // The one prose this runtime matches: an endpoint that describes an overflow in its own words.
  assert.equal(
    failureCodeOf(new Error('prompt is too long: 210000 tokens > 200000 maximum')),
    'context-window-exceeded',
  );
  assert.equal(failureCodeOf(new Error('something else entirely')), undefined);
  assert.equal(
    failureCodeOf('prompt is too long: 1 tokens > 0 maximum'),
    'context-window-exceeded',
  );
});

test('all three protocols name the same status the same way', async (t) => {
  for (const status of [429, 500, 401]) {
    const url = await httpFixture(t, (_body, res) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-request-id': `fixture-${status}`,
      });
      res.end(JSON.stringify({ error: { message: 'fixture refused' } }));
    });
    const providers = [
      new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
      new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
      new ResponsesProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
    ];
    for (const provider of providers) {
      const error = await provider.complete(request()).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.equal(
        failureCodeOf(error),
        codeForHttpStatus(status),
        `${provider.constructor.name} named HTTP ${status}`,
      );
      // The message still says what the status was: the code is for code, the message is for a person.
      assert.match(String((error as Error).message), new RegExp(`HTTP ${status}`));
      /**
       * And the response's own two facts survive with it, for every protocol rather than for the one this was
       * written against: the status is not recoverable from the code (`401`, `403`, `500` and `503` all collapse
       * into two of them), and the endpoint's request id is the only handle a provider's support can look the
       * call up by. Neither is in the message, so losing them here loses them entirely.
       */
      assert.equal(
        (error as RunFailure).httpStatus,
        status,
        `${provider.constructor.name} kept the status it answered with`,
      );
      assert.equal(
        (error as RunFailure).requestId,
        `fixture-${status}`,
        `${provider.constructor.name} kept the request id the endpoint sent`,
      );
    }
  }
});

test('a stream that is not the one this protocol speaks is named, not guessed at', async (t) => {
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  for (const provider of [
    new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
    new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
    new ResponsesProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
  ]) {
    const error = await provider.complete(request()).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.equal(failureCodeOf(error), 'no-stream', provider.constructor.name);
  }
});

test('a request that never reached the endpoint keeps its cause', async () => {
  // Port 1 on loopback with nothing listening: the request fails before any response exists.
  const provider = new AnthropicProvider({
    apiKey: 'k',
    model: 'm',
    baseUrl: 'http://127.0.0.1:1',
  });
  const error = await provider.complete(request()).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  assert.equal(failureCodeOf(error), 'transport');
  // The message stays generic on purpose; the original error is the only place the socket detail lives, so
  // losing it would make this failure undebuggable.
  assert.ok((error as RunFailure).cause instanceof Error);
});

test('a configured total timeout fires, and is reported as a timeout rather than a generic failure', async (t) => {
  /**
   * The regression this pins is the resolved limit being read at all. `resolveRunLimits` is the one place that
   * decides whether an operator asked for a wall-clock limit; while the request seam read the raw options
   * instead, a default could sit in the defaults table and never reach a main request.
   */
  const provider: Provider = {
    complete: (input) =>
      new Promise((_resolve, reject) =>
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }),
      ),
  };
  const { session, agent } = await fixture(t, provider, { requestTimeoutMs: 150 });
  const begun = Date.now();
  const result = await agent.run({ sessionId: session.id, prompt: 'Hang' });
  const elapsed = Date.now() - begun;
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'timeout');
  assert.ok(elapsed < 5_000, `the limit fired (${elapsed}ms) instead of waiting for anything else`);
  assert.match(result.error!, /aborted|timeout/i);
});

test('a run keeps going while the model keeps asking for tools, for as many rounds as that takes', async (t) => {
  /**
   * A run has no round cap. It used to have one — 256 by default, and the run that reached it ended `limited`
   * with the code `rounds` — which cut a long task off mid-way and pushed a task that would have answered on.
   * What ends a run now is the model (it stops asking for tools), a person (a cancel), or the run's own
   * ceiling (the window, the output limit, a tool's wall clock). This run crosses the old default, so a cap
   * that came back would show up here as a `limited` result instead of an answer.
   */
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      return round <= 300
        ? {
            ...reply(''),
            finishReason: 'tool_calls',
            toolCalls: [{ id: `c${round}`, name: 'list_files', arguments: { path: '.' } }],
          }
        : reply('Done after many rounds');
    },
  };
  const { session, agent } = await fixture(t, provider);
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Keep going until you are done',
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(round, 301, 'the loop ran every round the model asked for');
});

test('a run whose conversation cannot fit reports the window, not a spend', async (t) => {
  const { session, agent } = await fixture(t, failing(new Error('never called')), {
    maxContextTokens: 1,
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Anything' });
  assert.equal(result.status, 'limited');
  assert.equal(result.code, 'context-window-exceeded');
  assert.match(result.error!, /context budget/);
});

test('an endpoint that refuses the conversation for size reports the window, and stays limited', async (t) => {
  // A single user message has no boundary to compress, so the one recovery attempt refuses and the provider's
  // own failure is what the run reports.
  const { session, agent } = await fixture(
    t,
    failing(
      new ModelFailure(
        'context-window-exceeded',
        'prompt is too long: 210000 tokens > 200000 maximum',
      ),
    ),
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Too big' });
  assert.equal(result.status, 'limited');
  assert.equal(result.code, 'context-window-exceeded');
});

test('an endpoint that only describes the overflow in prose is named the same way', async (t) => {
  const { session, agent } = await fixture(
    t,
    failing(new Error('This model’s maximum context length is 200000 tokens')),
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Too big' });
  assert.equal(result.status, 'limited');
  assert.equal(result.code, 'context-window-exceeded');
});

test('a tool-call turn with no calls is a failure, and says so', async (t) => {
  const provider: Provider = {
    async complete() {
      return { ...reply(''), finishReason: 'tool_calls', toolCalls: [] };
    },
  };
  // No allowance on purpose: this is about the code the condition gets. The re-send itself is
  // `tests/retry.test.ts`'s subject, and an endpoint that keeps answering this way would otherwise spend the
  // whole default allowance in backoff before the same answer arrived.
  const { session, agent } = await fixture(t, provider, { maxModelRetries: 0 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do something' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'empty-response');
});

test('a completed turn that carried nothing is a failure, and is not stored as an answer', async (t) => {
  const provider: Provider = {
    async complete() {
      return reply('');
    },
  };
  const { session, agent, store } = await fixture(t, provider, { maxModelRetries: 0 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Say something' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'empty-response');
  assert.equal(
    store.messages(session.id).filter((message) => message.role === 'assistant').length,
    0,
    'an empty turn is not an answer the transcript should carry',
  );
});

test('the code reaches the durable record, not just the result the caller happened to hold', async (t) => {
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'request-id': 'req-fixture-429' });
    res.end(JSON.stringify({ error: { message: 'slow down' } }));
  });
  const provider = new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url });
  const { store, session, agent, events, root } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Try' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'rate-limit');
  /**
   * The status and the endpoint's request id survive into the result the caller holds. `429` happens to be
   * recoverable from its code, but `400` and `413` are not — both are `http` — so the number has to travel on
   * its own. The Anthropic-style `request-id` header is sent by an OpenAI-shaped provider on purpose: this also
   * pins that the id is found by header list rather than by whichever protocol happens to be speaking.
   */
  assert.equal(result.httpStatus, 429);
  assert.equal(result.requestId, 'req-fixture-429');
  // The live event carries the whole result; the durable payload flattens what is worth folding from a log.
  const finished = events.filter((event) => event.type === 'run.finished').at(-1)!;
  assert.equal((finished.data.result as { code?: string }).code, 'rate-limit');
  /**
   * Read back from the log rather than from the object the caller is holding: `store.events` folds the
   * `session_events` rows, so this is the record a second process reads, not a value that only exists in this
   * run's memory.
   */
  const logged = store
    .events(session.id)
    .filter((event) => event.type === 'run.finished')
    .at(-1)!;
  assert.equal((logged.data as { code?: string }).code, 'rate-limit');
  assert.equal((logged.data as { status?: string }).status, 'failed');
  // The endpoint's two facts are folded too: a reader who only follows events learns them without the run row.
  assert.equal((logged.data as { httpStatus?: number }).httpStatus, 429);
  assert.equal((logged.data as { requestId?: string }).requestId, 'req-fixture-429');
  assert.equal(path.basename(root).startsWith('yuantu-failure-'), true);
});
