/**
 * Re-sending a model request, decided at the step boundary.
 *
 * The transport used to own this: `fetchWithRetry` retried 429 and 5xx before the stream started. That was the
 * wrong place for four independent reasons, and the tests here are the four claims that say so — a broken
 * stream can be retried too, the count is in the log rather than in this process, the wait is visible and
 * cancellable, and the request deadline covers the backoff.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { RunFailure, type FailureCode } from '../packages/protocol/failure.ts';
import {
  RETRY_MAX_WAIT_MS,
  retryAfterMs,
  retryDelayMs,
  retryable,
} from '../packages/protocol/retry.ts';
import { httpFixture } from './http-fixture.ts';
import type { AgentEvent, ModelResponse, Provider } from '../packages/protocol/index.ts';

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
async function fixture(t: test.TestContext, provider: Provider, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-retry-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
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
    // A retry here is a fact about the record, not a thing to wait for: the waits are real seconds, and every
    // test that cares about one sets its own allowance.
    maxModelRetries: 0,
    ...extra,
  });
  const retries = () =>
    events.filter((event) => event.type === 'llm.retry').map((event) => event.data);
  return { root, store, session, agent, events, retries };
}
/** An endpoint that fails every call, so a retry's only possible outcome is the same failure again. */
async function failing(t: test.TestContext, status: number, headers: Record<string, string> = {}) {
  const calls = { n: 0 };
  const url = await httpFixture(t, (_body, res) => {
    calls.n++;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { message: 'fixture refused' } }));
  });
  return { calls, provider: new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url }) };
}

test('what may be re-sent and what may not, one decision per code', () => {
  /**
   * Exhaustive on purpose: the table is a `Record<FailureCode, boolean>`, so this list failing to compile after
   * a new code is added is the mechanism that makes somebody decide. Re-sending changes nothing about the
   * request, so a failure that describes the request itself (auth, a 4xx) or the run's own room (the window,
   * the output limit) is never retried; a failure that describes the weather is — including a turn the endpoint
   * closed with nothing in it, which is a hiccup rather than an answer.
   */
  const expected: Record<FailureCode, boolean> = {
    'context-window-exceeded': false,
    'output-limit': false,
    auth: false,
    'rate-limit': true,
    server: true,
    http: false,
    timeout: true,
    transport: true,
    'empty-response': true,
    unsupported: false,
    'no-stream': true,
    'tool-cleanup': false,
  };
  for (const [code, yes] of Object.entries(expected))
    assert.equal(retryable(code as FailureCode), yes, code);
  // No code is not a licence to try again: an unrecognised defect is a defect.
  assert.equal(retryable(undefined), false);
});

test('the wait grows, is capped, and never shortens what the endpoint asked for', () => {
  // Jitter makes the exact value uninteresting; the band and the ordering are what matter.
  for (const attempt of [1, 2, 3]) {
    const wait = retryDelayMs(attempt);
    assert.ok(
      wait >= 250 * 2 ** (attempt - 1) && wait < 250 * 2 ** (attempt - 1) + 100,
      `${attempt}`,
    );
  }
  assert.equal(retryDelayMs(10), RETRY_MAX_WAIT_MS);
  // A server-directed cooldown wins over the backoff, including one longer than we will wait: the caller
  // compares against the cap rather than accepting a longer wait.
  assert.equal(retryDelayMs(1, 5_000), 5_000);
  assert.equal(retryDelayMs(4, 90_000), 90_000);
  assert.ok(retryDelayMs(4, 90_000) > RETRY_MAX_WAIT_MS);
  // Zero and nonsense are not cooldowns: the wait stays in the backoff's own band.
  for (const value of [0, Number.NaN]) {
    const wait = retryDelayMs(1, value);
    assert.ok(wait >= 250 && wait < 350, `${value} is not a cooldown`);
  }
});

test('a cooldown header is read in both forms the specification allows', () => {
  assert.equal(retryAfterMs('12'), 12_000);
  assert.equal(retryAfterMs('0.5'), 500);
  assert.equal(retryAfterMs('  3  '), 3_000);
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(retryAfterMs('Thu, 01 Oct 2026 00:00:30 GMT', now), 30_000);
  // A date in the past is no wait at all, not a negative one.
  assert.equal(retryAfterMs('Thu, 01 Oct 2026 00:00:00 GMT', now + 60_000), 0);
  for (const value of ['invalid', '', null, undefined, 'next tuesday'])
    assert.equal(retryAfterMs(value, now), undefined, String(value));
});

test('a transient failure is re-sent, and the answer is shown once', async (t) => {
  let calls = 0;
  const url = await httpFixture(t, (_body, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(503, { 'retry-after': '0', 'content-type': 'application/json' });
      res.end('private server body');
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    }
  });
  const { session, agent, retries, store } = await fixture(
    t,
    new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
    { maxModelRetries: 2 },
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Done');
  assert.equal(calls, 3);
  // Each attempt is a record: which failure, which attempt, how long the run waited first.
  assert.deepEqual(
    retries().map((data) => [data.attempt, data.max, data.code]),
    [
      [1, 2, 'server'],
      [2, 2, 'server'],
    ],
  );
  assert.ok(retries().every((data) => Number(data.waitMs) >= 0));
  const logged = store.events(session.id).filter((event) => event.type === 'llm.retry');
  assert.equal(logged.length, 2, 'the retries are in the durable log, not only in the live stream');
});

test('the allowance is spent, and the failure that remains is the endpoint’s own', async (t) => {
  const calls = { n: 0 };
  const credential = 'fixture-api-credential';
  const url = await httpFixture(t, (_body, res) => {
    calls.n++;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end(
      JSON.stringify({
        error: { message: `fixture refused ${credential} Bearer fixture-token` },
        debug: 'PRIVATE_FIXTURE_SERVER_BODY',
      }),
    );
  });
  const provider = new OpenAIProvider({ apiKey: credential, model: 'm', baseUrl: url });
  const { session, agent, retries } = await fixture(t, provider, { maxModelRetries: 2 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'rate-limit');
  // Three attempts for an allowance of two; only the sanitized structured reason reaches the message.
  assert.equal(calls.n, 3);
  assert.equal(retries().length, 2);
  assert.match(result.error!, /HTTP 429: fixture refused \[redacted\] Bearer \[redacted\]/);
  assert.doesNotMatch(
    result.error!,
    /fixture-api-credential|fixture-token|PRIVATE_FIXTURE_SERVER_BODY/,
  );
});

test('an allowance of zero means the first failure ends the run', async (t) => {
  const { calls, provider } = await failing(t, 503);
  const { session, agent, retries } = await fixture(t, provider, { maxModelRetries: 0 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.code, 'server');
  assert.equal(calls.n, 1);
  assert.deepEqual(retries().length, 0);
});

test('a failure the request itself caused is not re-sent', async (t) => {
  // 401 is the clearest case: every attempt gets the same answer, so a retry is only a second bill.
  const { calls, provider } = await failing(t, 401);
  const { session, agent, retries } = await fixture(t, provider, { maxModelRetries: 2 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.code, 'auth');
  assert.equal(calls.n, 1);
  assert.deepEqual(retries().length, 0);
});

test('a cooldown longer than the run will wait is not retried at all', async (t) => {
  const { calls, provider } = await failing(t, 503, { 'retry-after': '3600' });
  const { session, agent, retries } = await fixture(t, provider, { maxModelRetries: 2 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.code, 'server');
  assert.equal(calls.n, 1);
  // Not "retried and gave up": nothing was waited for, so nothing was recorded.
  assert.deepEqual(retries().length, 0);
});

test('a stream cut off before its terminal event is re-sent, end to end', async (t) => {
  /**
   * The case the transport could not cover at all: the request succeeded, the stream started, and then the
   * endpoint stopped before the first token. The adapter names it (`transport`), the step boundary sees that
   * nothing has been shown yet, and the round is re-sent — which is the whole reason this decision belongs here.
   *
   * The stream must die *before* any text for this to be retried, and that is not a limitation of the test: once
   * a delta has reached the user, a second attempt would show the beginning of the turn twice. The next test
   * pins that side.
   */
  let calls = 0;
  const url = await httpFixture(t, (_body, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (calls === 1)
      res.end(
        'data: ' +
          JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] }) +
          '\n\n',
      );
    else
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
  });
  const { session, agent, retries } = await fixture(
    t,
    new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
    { maxModelRetries: 1 },
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.status, 'completed', result.error ?? '');
  assert.equal(result.text, 'Done');
  assert.equal(calls, 2);
  assert.deepEqual(
    retries().map((data) => [data.attempt, data.code]),
    [[1, 'transport']],
  );
});

test('a stream that broke before showing anything is re-sent, and one that showed text is not', async (t) => {
  /**
   * This is the case the transport could never have covered: the request succeeded, the stream started, and
   * then it failed. Re-sending is safe exactly while the user has seen nothing — once a delta has been shown,
   * a retry would show the beginning of the turn twice.
   */
  let calls = 0;
  const silent: Provider = {
    async complete() {
      if (++calls === 1)
        throw new RunFailure('no-stream', 'Model endpoint did not return an SSE stream');
      return reply('Recovered');
    },
  };
  const first = await fixture(t, silent, { maxModelRetries: 1 });
  assert.equal(
    (await first.agent.run({ sessionId: first.session.id, prompt: 'Go' })).text,
    'Recovered',
  );
  assert.equal(calls, 2);
  assert.equal(first.retries().length, 1);

  let shownCalls = 0;
  const speaking: Provider = {
    async complete(input) {
      shownCalls++;
      input.onText('Half an answer');
      throw new RunFailure('timeout', 'Model stream idle timeout');
    },
  };
  const second = await fixture(t, speaking, { maxModelRetries: 2 });
  const result = await second.agent.run({ sessionId: second.session.id, prompt: 'Go' });
  assert.equal(shownCalls, 1);
  assert.deepEqual(second.retries().length, 0);
  // The text the user saw is what the run reports: an interrupted stream is preserved, never re-sent.
  assert.equal(result.text, 'Half an answer');
  assert.equal(result.code, 'timeout');
});

test('a round that streamed only reasoning is still re-sent, and its reasoning is taken back', async (t) => {
  /**
   * Reasoning is displayed, so the guard used to be `!streamedReasoning` as well and refused to retry a round
   * whose endpoint had thought aloud before failing — turning that into a failed run that produced no answer at
   * all. Only `streamedText` blocks a retry now, and the frame that takes the discarded attempt's reasoning back
   * (the one the overflow recovery already sends) goes out with it.
   */
  let calls = 0;
  const provider: Provider = {
    async complete(input) {
      if (++calls === 1) {
        input.onReasoning?.('half a thought');
        throw new RunFailure('transport', 'stream cut');
      }
      return reply('Recovered');
    },
  };
  const { session, agent, retries, events } = await fixture(t, provider, { maxModelRetries: 1 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.status, 'completed', result.error ?? '');
  assert.equal(result.text, 'Recovered');
  assert.equal(calls, 2);
  assert.deepEqual(
    retries().map((data) => data.code),
    ['transport'],
  );
  const resets = events.filter(
    (event) => event.type === 'message.reasoning' && event.data.reset === true,
  );
  assert.equal(
    resets.length,
    1,
    'the discarded attempt’s reasoning is taken back before the re-send',
  );
  assert.equal(resets[0]!.data.text, '');
  // The stored turn is the one whose answer was stored: no reasoning from the attempt that was thrown away.
  const assistant = events.filter((event) => event.type === 'message.finished').at(-1)!;
  assert.equal((assistant.data.message as { reasoning?: string }).reasoning, undefined);
});

test('a turn the endpoint closed with nothing in it is re-sent, not stored as an answer', async (t) => {
  /**
   * `empty-response` used to be terminal on the argument that the identical request already produced that turn.
   * A gateway that answers `stop` with no content is a hiccup rather than a considered answer, so it is treated
   * as weather: the round is re-sent inside the same allowance, and nothing is stored until an attempt produces
   * something.
   */
  let calls = 0;
  const provider: Provider = {
    async complete() {
      return ++calls === 1 ? reply('') : reply('Recovered');
    },
  };
  const { session, agent, retries, store } = await fixture(t, provider, { maxModelRetries: 1 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.status, 'completed', result.error ?? '');
  assert.equal(result.text, 'Recovered');
  assert.equal(calls, 2);
  assert.deepEqual(
    retries().map((data) => data.code),
    ['empty-response'],
  );
  assert.equal(
    store.messages(session.id).filter((message) => message.role === 'assistant').length,
    1,
    'the empty turn never became a message',
  );
});

test('cancelling during the backoff stops before the next request', async (t) => {
  const { calls, provider } = await failing(t, 503, { 'retry-after': '5' });
  const { session, agent, retries } = await fixture(t, provider, { maxModelRetries: 2 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Go',
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(calls.n, 1);
  // The record is written before the wait, so the log says "a retry was decided" even though the second
  // request never happened — which is what a later process needs in order not to make it.
  assert.equal(retries().length, 1);
  assert.equal(retries()[0]!.code, 'server');
});

test('the request deadline covers the backoff, not just the request', async (t) => {
  // A deadline that only bounded the request would let a backoff outlive it, and the run would be re-sent
  // after the operator's limit had already passed.
  const { calls, provider } = await failing(t, 503, { 'retry-after': '10' });
  const { session, agent } = await fixture(t, provider, {
    maxModelRetries: 2,
    requestTimeoutMs: 100,
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(calls.n, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'timeout');
});

test('the retry count is read from the log, so a restarted process does not start over', async (t) => {
  const { store, session } = await fixture(t, { complete: async () => reply() });
  // The count is a property of the session log, not of the run object: two records for the same round mean two
  // attempts have already happened, whoever wrote them.
  store.recordEvent(session.id, 'llm.retry', {
    runId: 'run-1',
    round: 0,
    attempt: 1,
    code: 'server',
  });
  store.recordEvent(session.id, 'llm.retry', {
    runId: 'run-1',
    round: 0,
    attempt: 2,
    code: 'server',
  });
  assert.equal(store.retryCount('run-1', 0), 2);
  // A different round, or a different run, has its own allowance.
  assert.equal(store.retryCount('run-1', 1), 0);
  assert.equal(store.retryCount('run-2', 0), 0);
});
