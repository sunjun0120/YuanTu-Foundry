/**
 * The request forecast, and the decisions it drives.
 *
 * The numbers here are the two a person asks about when a run gets expensive — *how much will this request
 * need* and *how much room does the model have left for it* — and they are also what the run decides on:
 * shorten, compress, or send. These tests are therefore as much about the numbers *agreeing* with the decision
 * as about the arithmetic.
 *
 * There is no third number: a run has no cumulative token allowance to spend down, so the only ceiling a
 * request can miss is the window, and every "cannot be sent" here is a window verdict.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { prepareContext } from '../packages/core/context.ts';
import { estimateInputTokens } from '../packages/core/budget.ts';
import { forecastRequest, windowPressure } from '../packages/core/forecast.ts';
import { COMPACTION_DEFAULTS } from '../packages/core/compaction-policy.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { Message, ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';
import { isSummaryRequest } from './summary-request.ts';

const reply = (text = 'Done', inputTokens = 10): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens, outputTokens: 5 },
});
const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content, toolCalls: [] });
/** A conversation of complete turns, long enough that the token estimate is not dominated by the prompt. */
function transcript(turns: number, chars = 4000): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < turns; index++) {
    messages.push(user(`Turn ${index} ${'u'.repeat(chars)}`));
    messages.push(assistant(`Answer ${index} ${'a'.repeat(chars)}`));
  }
  return messages;
}
async function store(
  t: test.TestContext,
): Promise<{ root: string; store: SessionStore; id: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-forecast-'));
  const database = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store: database, id: database.create(root).id };
}

test('the forecast reports what the request costs and the room the window leaves, together', () => {
  const messages = transcript(4);
  const raw = estimateInputTokens('sys', messages, []);
  const forecast = forecastRequest({
    system: 'sys',
    messages,
    tools: [],
    maxOutputTokens: 8_000,
    maxContextTokens: 100_000,
  });
  assert.equal(forecast.rawInputTokens, raw);
  assert.equal(forecast.inputTokens, raw, 'an uncorrected forecast is the raw estimate');
  assert.equal(
    forecast.outputTokens,
    8_000,
    'the window does not bind, so the request gets the output it asked for',
  );
  assert.equal(
    forecast.windowRoom,
    100_000 - raw,
    'the window room is measured before the output cap',
  );
  assert.equal(forecast.problem, undefined);

  // The learned correction applies to the input, and the uncorrected figure stays available for calibration.
  const corrected = forecastRequest({
    system: 'sys',
    messages,
    tools: [],
    maxOutputTokens: 8_000,
    factor: 2,
  });
  assert.equal(corrected.rawInputTokens, raw);
  assert.ok(
    corrected.inputTokens > raw,
    'the correction raises a request the provider billed more for',
  );
  // No window configured is not a permissive window: it is an unknown one, so nothing is claimed about it.
  assert.equal(corrected.windowRoom, undefined);
});

test('a request the window cannot take says so; one that fits is clipped, not refused', () => {
  const messages = transcript(4);
  const needs = estimateInputTokens('sys', messages, []);
  const tooLarge = forecastRequest({
    system: 'sys',
    messages,
    tools: [],
    maxOutputTokens: 8_000,
    maxContextTokens: needs - 1,
  });
  assert.equal(tooLarge.problem, 'window');
  assert.equal(
    tooLarge.outputTokens,
    0,
    'a request with no room is not given a quota to pretend with',
  );

  // Exactly the input's size is still too small: a request has to fit with room to answer.
  assert.equal(
    forecastRequest({
      system: 'sys',
      messages,
      tools: [],
      maxOutputTokens: 8_000,
      maxContextTokens: needs,
    }).problem,
    'window',
  );

  // A request that fits the window but not the output it asked for is clipped, not refused.
  const clipped = forecastRequest({
    system: 'sys',
    messages,
    tools: [],
    maxOutputTokens: 8_000,
    maxContextTokens: needs + 100,
  });
  assert.equal(clipped.outputTokens, 100);
  assert.equal(clipped.problem, undefined);
});

test('window pressure is a share of the window, and no window means none', () => {
  const messages = transcript(4);
  const forecast = forecastRequest({
    system: 'sys',
    messages,
    tools: [],
    maxOutputTokens: 1_000,
    maxContextTokens: 30_000,
  });
  assert.equal(windowPressure(forecast, undefined, 60), false, 'nothing to fill up');
  assert.equal(windowPressure(forecast, 100_000, 60), false, 'a wide window is not under pressure');
  assert.equal(windowPressure(forecast, 30_000, 60), forecast.inputTokens + 1000 > 18_000);
  // A request that cannot be sent at all counts as pressure whatever the share says: something must be done.
  assert.equal(
    windowPressure(
      { ...forecast, problem: 'window', inputTokens: 1, outputTokens: 0 },
      1_000_000,
      95,
    ),
    true,
  );
});

test('the numbers reported for a round are the numbers the request was built from', async (t) => {
  const { store: database, id } = await store(t);
  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    description: 'Echoes its argument',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    async execute(args) {
      return { isError: false, content: `echo: ${String(args.text)}` };
    },
  });
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    async complete(request) {
      requests.push(request);
      if (request.messages.at(-1)?.role === 'tool') {
        return requests.length < 3
          ? {
              text: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: `c${requests.length}`, name: 'echo', arguments: { text: 'x' } }],
              usage: { inputTokens: 100, outputTokens: 5 },
            }
          : reply();
      }
      return {
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: `c${requests.length}`, name: 'echo', arguments: { text: 'x' } }],
        usage: { inputTokens: 100, outputTokens: 5 },
      };
    },
  };
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const agent = new Agent({
    store: database,
    provider,
    tools,
    approve: async () => true,
    onEvent: (event) => events.push({ type: event.type, data: event.data }),
    maxOutputTokens: 4_000,
  });
  const result = await agent.run({ sessionId: id, prompt: 'Keep going' });
  assert.equal(result.status, 'completed', result.error);
  const forecasts = events.filter((event) => event.type === 'context.forecast');
  assert.equal(
    forecasts.length,
    requests.length,
    'one forecast per request, reported before it is sent',
  );
  forecasts.forEach((event, index) => {
    const request = requests[index]!;
    assert.equal(
      Number(event.data.outputTokens),
      request.maxOutputTokens,
      'the quota the request carried is the one the forecast decided',
    );
    assert.equal(
      Number(event.data.rawInputTokens),
      estimateInputTokens(request.system, request.messages, request.tools),
      'the request that was predicted is the request that was sent',
    );
    // No cumulative counter is reported, because there is none: the run's cost is the providers' own usage,
    // which the statistics and the session log already carry.
    assert.equal(event.data.remainingTokens, undefined);
  });
});

test('a conversation the window cannot take is compressed before the request is refused', async (t) => {
  const { store: database, id } = await store(t);
  for (const message of transcript(6, 5000)) database.append(id, message);
  database.append(id, user('Continue.'));
  const calls: ModelRequest[] = [];
  const prepared = await prepareContext({
    store: database,
    sessionId: id,
    system: 'YuanTu',
    tools: [],
    provider: {
      async complete(request) {
        calls.push(request);
        return reply('Merged summary of everything so far.');
      },
    },
    limit: 10_000_000,
    signal: new AbortController().signal,
    maxOutputTokens: 1_000,
    // Smaller than the conversation: the compression is what makes this request sendable at all.
    maxContextTokens: 12_000,
    shrinkPercent: 60,
    summaryTimeoutMs: 1_000,
    onUsage: () => {},
    onCompaction: () => {},
  });
  assert.ok(calls.length >= 1, 'the summary request was made so the round could be sent at all');
  assert.equal(isSummaryRequest(calls[0]!), true);
  assert.equal(prepared.compacted, true);
  assert.ok(prepared.messages.length < 13, 'old turns were replaced by the summary');
  assert.ok(database.contextSurface(id), 'the summary was persisted');
});

test('a conversation above the threshold is compressed while it would still fit', async (t) => {
  const { store: database, id } = await store(t);
  // About 30,000 estimated tokens in a 100,000-token window: this request would be accepted as it stands, so a
  // policy that only reacted to "does it not fit" would send it unchanged.
  for (const message of transcript(9, 5000)) database.append(id, message);
  database.append(id, user('Continue.'));
  const calls: ModelRequest[] = [];
  const prepared = await prepareContext({
    store: database,
    sessionId: id,
    system: 'YuanTu',
    tools: [],
    provider: {
      async complete(request) {
        calls.push(request);
        return reply('Merged summary of the earlier turns.');
      },
    },
    limit: 10_000_000,
    signal: new AbortController().signal,
    maxOutputTokens: 8_000,
    /**
     * The policy's own arithmetic, so the test fails loudly if any term moves:
     * messageBudget 92,000; pressureBudget 26,464; threshold min(80,000, 26,464) = 26,464; retain ≈ 14,720.
     */
    maxContextTokens: 100_000,
    shrinkPercent: 100,
    summaryTimeoutMs: 1_000,
    onUsage: () => {},
    onCompaction: () => {},
  });
  assert.ok(calls.length >= 1, 'the threshold triggered compression on its own');
  assert.equal(isSummaryRequest(calls[0]!), true);
  assert.equal(prepared.compacted, true);
  assert.equal(prepared.policyProblem, undefined);
  // Compression happens before the conversation is anywhere near the window, which is what leaves the summary
  // request itself room to be sent.
  assert.ok(
    prepared.forecast.inputTokens < 26_464,
    `expected the compacted surface under the threshold, got ${prepared.forecast.inputTokens}`,
  );
});

test('compression converges: a retry is allowed, and then it stops', async (t) => {
  const { store: database, id } = await store(t);
  for (const message of transcript(6, 5000)) database.append(id, message);
  // One trailing result bigger than the retention budget: the tail cannot be made small enough by the first
  // compression alone, so the policy pays for one more attempt instead of leaving the round at the wall.
  database.append(id, user(`Huge ${'z'.repeat(120_000)}`));
  const calls: ModelRequest[] = [];
  const prepared = await prepareContext({
    store: database,
    sessionId: id,
    system: 'YuanTu',
    tools: [],
    provider: {
      async complete(request) {
        calls.push(request);
        return reply('Merged summary.');
      },
    },
    limit: 10_000_000,
    signal: new AbortController().signal,
    maxOutputTokens: 8_000,
    maxContextTokens: 100_000,
    shrinkPercent: 100,
    summaryTimeoutMs: 1_000,
    onUsage: () => {},
    onCompaction: () => {},
  });
  /**
   * The bound is the claim: one attempt plus `compactionRetries`. A policy that retried on every pass would be
   * a loop that bills the operator for compressing a conversation down to nothing.
   */
  assert.ok(
    calls.length <= 1 + COMPACTION_DEFAULTS.compactionRetries,
    `${calls.length} summary requests`,
  );
  assert.ok(calls.length >= 1, 'it did compress');
  assert.equal(prepared.compacted, true);
});

test('a conversation that fits is sent as it is, with no summary request', async (t) => {
  const { store: database, id } = await store(t);
  for (const message of transcript(6, 5000)) database.append(id, message);
  database.append(id, user('Continue.'));
  let calls = 0;
  const prepared = await prepareContext({
    store: database,
    sessionId: id,
    system: 'YuanTu',
    tools: [],
    provider: {
      async complete() {
        calls++;
        return reply();
      },
    },
    limit: 10_000_000,
    signal: new AbortController().signal,
    maxOutputTokens: 1_000,
    maxContextTokens: 100_000,
    shrinkPercent: 60,
    summaryTimeoutMs: 1_000,
    onUsage: () => {},
    onCompaction: () => {},
  });
  assert.equal(calls, 0, 'a summary nobody needs is a request the user pays for');
  assert.equal(prepared.compacted, false);
  assert.equal(prepared.messages.length, 13, 'the conversation is sent as it is');
});

test('a request with no boundary to compress at names the window, and keeps the history', async (t) => {
  const { store: database, id } = await store(t);
  // One message larger than the window: compression has no earlier turn to cut at, so there is nothing left
  // to try — and the honest answer is the ceiling, not a summary that cannot exist.
  database.append(id, user('u'.repeat(60_000)));
  await assert.rejects(
    prepareContext({
      store: database,
      sessionId: id,
      system: 'YuanTu',
      tools: [],
      provider: {
        async complete() {
          throw new Error('no summary request may be attempted');
        },
      },
      limit: 10_000_000,
      signal: new AbortController().signal,
      maxOutputTokens: 1_000,
      maxContextTokens: 1_000,
      shrinkPercent: 60,
      summaryTimeoutMs: 1_000,
      onUsage: () => {},
      onCompaction: () => {},
    }),
    (error: unknown) =>
      error instanceof Error &&
      /context budget/.test(error.message) &&
      error.name === 'ContextLimitError',
    'the context budget is named, and nothing was compressed to find out',
  );
  assert.equal(
    database.contextSurface(id),
    null,
    'nothing was compressed, so nothing was recorded',
  );
  assert.equal(database.messages(id).length, 1, 'history was preserved');
});
