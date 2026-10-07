/**
 * The summary request replays the main request's own prefix.
 *
 * A provider's prompt cache hits on a cacheable prefix that is identical byte for byte, so "the summary request
 * reuses the hot prefix" is a claim about *bytes* — and about the request carrying a cache key of its own, without
 * which the Anthropic adapter places no cache breakpoint and reads nothing at all. Both halves are asserted here
 * against the request the round really sends, because neither is observable from the outside in any other way: a
 * cache hit is the provider's answer, and "the prefix would have hit" is the testable premise.
 *
 * The summary request is built twice over: once in the two-call shape below, where the first call is the round's
 * context and the second is its compaction, and once through a real `Agent` run, where the wiring in
 * `agent.ts` — not this file — is what supplies the system prompt, the tool schemas and the cache key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { cacheKeyFor } from '../packages/core/cache-key.ts';
import { prepareContext } from '../packages/core/context.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { ModelRequest, ModelResponse, ToolSpec } from '../packages/protocol/index.ts';
import { isSummaryRequest } from './summary-request.ts';

const TOOLS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'edit_file',
    description: 'Edit a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];
const reply = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-summary-prefix-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  return { store, session };
}

/** The conversation a round would send, and then the summary request its compaction makes. */
async function roundThenSummary(input: {
  store: SessionStore;
  sessionId: string;
  system: string;
  limit: number;
  maxContextTokens: number;
  forceCompact: boolean;
}) {
  const summaryRequests: ModelRequest[] = [];
  const provider = {
    async complete(request: ModelRequest) {
      summaryRequests.push(request);
      return reply('Merged summary of the earlier turns.');
    },
  };
  const common = {
    store: input.store,
    sessionId: input.sessionId,
    system: input.system,
    tools: TOOLS,
    provider,
    limit: input.limit,
    signal: new AbortController().signal,
    maxOutputTokens: 512,
    maxContextTokens: input.maxContextTokens,
    summaryTimeoutMs: 1000,
    // The real digest the kernel uses, so these tests assert the property rather than a fixture constant: the key
    // is a function of the request, and the request here is the summary request's own prompt.
    cacheKeyFor: (systemText: string, toolSpecs: readonly ToolSpec[]) =>
      cacheKeyFor(undefined, systemText, toolSpecs),
    onUsage: () => {},
    onCompaction: () => {},
  };
  const round = await prepareContext(common);
  summaryRequests.length = 0;
  await prepareContext({ ...common, forceCompact: input.forceCompact });
  return { round, summary: summaryRequests[0]! };
}

test('the summary request carries the round the round would have sent, plus one instruction', async (t) => {
  const { store, session } = await fixture(t);
  for (let index = 0; index < 4; index++) {
    store.append(session.id, {
      role: 'user',
      content: `Question ${index}. ` + 'context '.repeat(200),
    });
    store.append(session.id, { role: 'assistant', content: `Answer ${index}.`, toolCalls: [] });
  }
  const history = store.messages(session.id);
  const { round, summary } = await roundThenSummary({
    store,
    sessionId: session.id,
    system: 'You are a fixture.',
    limit: 10_000_000,
    maxContextTokens: 100_000,
    forceCompact: true,
  });

  assert.ok(
    isSummaryRequest(summary),
    'the last message identifies the request as a summary request',
  );
  // The system prompt and the tool schemas are the round's own, byte for byte: that is the cacheable prefix.
  // `PreparedContext` carries the system prompt but not the tools (the caller owns those), so the tool half of
  // the claim is that the summary request carries exactly the list the round is given.
  assert.equal(summary.system, round.system, 'the system prompt is the one the round sends');
  assert.equal(
    JSON.stringify(summary.tools),
    JSON.stringify(TOOLS),
    'the same tool schemas, in the same order',
  );
  // And so is the conversation: the batch is a verbatim prefix of the round's messages, unrewritten.
  const batch = summary.messages.slice(0, -1);
  assert.ok(batch.length > 0, 'the batch is the conversation being summarized');
  assert.ok(
    batch.length <= round.messages.length,
    'the batch is a cut of the round, not more than it',
  );
  assert.deepEqual(batch, history.slice(0, batch.length));
  assert.deepEqual(batch, round.messages.slice(0, batch.length));
});

test('a summary buys its own output allowance instead of inheriting the round answer budget', async (t) => {
  const { store, session } = await fixture(t);
  // A small conversation and a character budget small enough that the summary's own formula — `min(
  // maxOutputTokens, max(64, limit / 8))` — lands *below* the round's 512. Without that gap the two numbers are
  // equal and this test would pass whichever budget the code used.
  store.append(session.id, { role: 'user', content: 'Short question. ' + 'x'.repeat(400) });
  store.append(session.id, { role: 'assistant', content: 'Short answer.', toolCalls: [] });
  store.append(session.id, { role: 'user', content: 'Another question. ' + 'y'.repeat(400) });
  const { summary } = await roundThenSummary({
    store,
    sessionId: session.id,
    system: 'You are a fixture.',
    limit: 4_000,
    maxContextTokens: 100_000,
    forceCompact: true,
  });
  assert.equal(
    summary.maxOutputTokens,
    500,
    'the summary asks for limit/8, not the round answer allowance',
  );
});

test('a summary request asks for the key of the prompt it replays, so that prefix is one the provider reads', async (t) => {
  const { store, session } = await fixture(t);
  /**
   * A session that has already been compacted once, because that is what makes this test able to tell the two
   * rules apart: with a running summary in the prompt, "the key of the request" and "the key of the system prompt
   * the caller passed in" are different keys, and only the first one is the entry the summary request reads.
   */
  store.append(session.id, { role: 'user', content: 'Keep the blue theme.' });
  store.append(session.id, { role: 'assistant', content: 'I will keep it blue.', toolCalls: [] });
  store.applyCompaction(session.id, { coveredMessages: 2, summary: 'Keep the blue theme.' });
  for (let index = 0; index < 4; index++) {
    store.append(session.id, {
      role: 'user',
      content: `Question ${index}. ` + 'context '.repeat(200),
    });
    store.append(session.id, { role: 'assistant', content: `Answer ${index}.`, toolCalls: [] });
  }
  const { round, summary } = await roundThenSummary({
    store,
    sessionId: session.id,
    system: 'You are a fixture.',
    limit: 10_000_000,
    maxContextTokens: 100_000,
    forceCompact: true,
  });
  assert.equal(
    round.system,
    'You are a fixture.',
    "the premise: the prompt is the caller's own, with no summary appended to it",
  );
  assert.equal(
    round.messages[0]?.content.startsWith('<compacted-summary>'),
    true,
    'and the running summary is the first thing in the conversation instead',
  );
  assert.ok(
    summary.cacheKey,
    'an Anthropic request without a key gets no cache breakpoint at all, so the replay would be unread',
  );
  assert.equal(
    summary.cacheKey,
    cacheKeyFor(undefined, round.system, TOOLS),
    'the key is the one belonging to the prompt this request carries, which is the round it replays',
  );
});

test('a caller that will not name a request gets no key rather than a stale one', async (t) => {
  /**
   * The other half of the rule, and the one a replay needs.
   *
   * The host's manual compaction replays a *recorded* prompt, so it can name the recorded key only while the
   * request is still that recorded request — a compaction since then has moved the running summary on, and the
   * key would point at an entry whose contents are a different conversation. Declining has to mean *no* key: a
   * request that carries the stale one is worse than a request that caches nothing, because only one of the two
   * can be read by the provider as somebody else's prefix.
   */
  const { store, session } = await fixture(t);
  for (let index = 0; index < 4; index++) {
    store.append(session.id, {
      role: 'user',
      content: `Question ${index}. ` + 'context '.repeat(200),
    });
    store.append(session.id, { role: 'assistant', content: `Answer ${index}.`, toolCalls: [] });
  }
  const requests: ModelRequest[] = [];
  await prepareContext({
    store,
    sessionId: session.id,
    system: 'You are a fixture.',
    tools: TOOLS,
    provider: {
      async complete(request: ModelRequest) {
        requests.push(request);
        return reply('Merged summary of the earlier turns.');
      },
    },
    limit: 10_000_000,
    signal: new AbortController().signal,
    maxOutputTokens: 512,
    maxContextTokens: 100_000,
    summaryTimeoutMs: 1000,
    cacheKeyFor: () => undefined,
    onUsage: () => {},
    onCompaction: () => {},
    forceCompact: true,
  });
  const summary = requests[0]!;
  assert.ok(isSummaryRequest(summary), 'the scenario has to make a summary request');
  assert.ok(
    !('cacheKey' in summary),
    'a declined key is absent from the request, not carried along as the last one that was known',
  );
});

test('a real run names every request after the prompt that request carries', async (t) => {
  const { store, session } = await fixture(t);
  for (let index = 0; index < 3; index++) {
    store.append(session.id, {
      role: 'user',
      content: '保留蓝色主题，不修改保护文件。'.repeat(80),
    });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  const requests: ModelRequest[] = [];
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 100000,
    // High enough to hold a batch of the conversation, low enough that the conversation itself does not fit.
    maxContextTokens: 5800,
    maxOutputTokens: 128,
    provider: {
      async complete(request: ModelRequest) {
        requests.push(request);
        return reply('Keep the blue theme.');
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  const summaries = requests.filter(isSummaryRequest);
  const rounds = requests.filter((request) => !isSummaryRequest(request));
  assert.ok(summaries.length > 0, 'the scenario has to compact');
  assert.ok(rounds.length > 0, 'and it has to send the round it compacted for');
  assert.ok(summaries[0]!.cacheKey, 'the summary request carries a cache key');
  assert.equal(
    summaries[0]!.cacheKey,
    cacheKeyFor(undefined, summaries[0]!.system!, summaries[0]!.tools),
    'the key is the one belonging to the prompt this request carries',
  );
  /**
   * And that *is* the key of the round the compaction is for, which is the saving this shape buys.
   *
   * The assertion used to be the other way round, and it was right at the time: the compaction appended the new
   * summary to the system prompt, so the round that followed sent a different prefix, and a key shared by two
   * prefixes is an entry the provider either misses on or reads the wrong contents from. Now that the summary is
   * the first *message*, the prefix — system prompt and tool catalogue, which is what the key names — is the same
   * request on both sides, and sharing the entry is the whole point: the round after a compaction reads what the
   * round before it wrote.
   */
  assert.equal(
    summaries[0]!.cacheKey,
    rounds.at(-1)!.cacheKey,
    'the compaction did not change the cacheable prefix, so both requests name the same entry',
  );
  assert.ok(
    summaries.some((request) => request.tools.length > 0),
    'the summary request carries the tool schemas rather than an empty list',
  );
  /**
   * Every batch is the stored transcript in order, so consecutive batches tile it — with the running summary in
   * front, because that is the shape the round's own request has and the cache prefix has to match it.
   */
  const replayed = summaries.flatMap((request) => {
    const messages = request.messages.slice(0, -1);
    return messages[0]?.content.startsWith('<compacted-summary>') ? messages.slice(1) : messages;
  });
  const stored = store.messages(session.id);
  assert.deepEqual(
    replayed,
    stored.slice(0, replayed.length),
    'every batch is the stored transcript in order, so consecutive batches tile it',
  );
});
