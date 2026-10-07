import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { prepareContext, SUMMARY_SECTIONS } from '../packages/core/context.ts';
import type {
  AgentEvent,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
} from '../packages/protocol/index.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';
import { TokenCalibration, calibrationRoute } from '../packages/core/calibration.ts';
import { estimateInputTokens, estimateMessageTokens } from '../packages/core/budget.ts';
// "Which request is the summary request" has one answer and it lives in production code: the instruction is the
// request's last message now, so `request.system.includes('context summary')` — the criterion these fixtures used
// to carry — matches nothing at all.
import { isSummaryBody, isSummaryRequest } from './summary-request.ts';

// ---- merged from context-budget.test.ts ----

const reply = (inputTokens = 5, outputTokens = 3): ModelResponse => ({
  text: 'Keep blue and release-73. Never edit protected.txt.',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens, outputTokens },
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-budget-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, session: store.create(root) };
}

test('Agent uses the 256K output default for an ordinary request', async (t) => {
  const { store, session } = await fixture(t);
  let allowance = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      async complete(request) {
        allowance = request.maxOutputTokens;
        return reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Say hello.' });
  assert.equal(result.status, 'completed');
  assert.equal(allowance, 256000);
});

test('a compaction leaves the system prompt and its key alone, and changes only the conversation', async (t) => {
  /**
   * The shape this test was written to bring about, now asserted the other way round.
   *
   * It used to record the *cost*: the running summary lived in the system prompt's `<conversation_summary>`
   * section, so every compaction rewrote the first part of every request — and a provider's prompt cache is a
   * byte-exact prefix, so a change to its last section invalidated the system prompt and every tool schema with
   * it. The summary is the first message of the transcript now (`summarySnapshot` in `packages/core/context.ts`),
   * which a compaction *replaces* rather than appends to, so the two requests below differ exactly where the
   * conversation does and nowhere else.
   */
  const { store, session } = await fixture(t);
  const requests: {
    system: string;
    cacheKey?: string;
    messages: { role: string; content: string }[];
  }[] = [];
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    modelInfo: { protocol: 'anthropic', model: 'fixture-model' },
    maxContextChars: 200_000,
    maxContextTokens: SUMMARY_WINDOW_TOKENS,
    maxOutputTokens: 128,
    provider: {
      async complete(request) {
        requests.push({
          system: request.system,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: typeof message.content === 'string' ? message.content : '',
          })),
          ...(request.cacheKey === undefined ? {} : { cacheKey: request.cacheKey }),
        });
        return reply();
      },
    },
  });
  for (let index = 0; index < 3; index++) {
    store.append(session.id, { role: 'user', content: 'history '.repeat(450) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);

  const before = requests[0]!;
  const after = requests.at(-1)!;
  assert.doesNotMatch(before.system, /<conversation_summary>/, 'nothing is summarised yet');
  assert.doesNotMatch(before.system, /<compacted-summary>/, 'and the prompt never carries one');
  assert.equal(
    after.system,
    before.system,
    'the system prompt is byte-identical before and after a compaction',
  );
  /**
   * The assertion is about a message *beginning* with the wrapper rather than merely mentioning it: the summary
   * instruction names the tag, because it has to tell the summariser where the previous summary sits.
   */
  assert.equal(
    before.messages.every((message) => !message.content.startsWith('<compacted-summary>')),
    true,
    'the first request has no snapshot to replay',
  );
  assert.equal(
    after.messages[0]!.content.startsWith('<compacted-summary>'),
    true,
    'the compaction put the summary at the front of the conversation instead',
  );
  /**
   * And the key follows the prompt, which now means it *survives* the compaction: it names the cacheable prefix —
   * the system prompt and the tool catalogue — and that prefix is the same request both times. This is the whole
   * saving the item was about: the entry the round before the compaction wrote is the entry the round after it
   * reads, tool schemas included.
   */
  assert.equal(
    before.cacheKey,
    after.cacheKey,
    'the cacheable prefix did not change, so the provider reads the entry it already has',
  );
});

test('a compaction records the route and the output budget its summary ran under', async (t) => {
  /**
   * The record used to say what the summary *cost* and how much it replaced, and nothing about the request that
   * produced it — so "this summary was made how?" had no answer a reader could check. The prompt and catalogue are
   * in the round's own `context.envelope`; these fields are the rest of that envelope, and they are recorded by
   * whoever writes the compaction rather than left to be inferred. The protocol is the other half of the route:
   * a model name does not say which adapter answered it.
   */
  const { store, session } = await fixture(t);
  store.append(session.id, { role: 'user', content: 'the first question' });
  store.append(session.id, { role: 'assistant', content: 'the first answer', toolCalls: [] });
  store.append(session.id, { role: 'user', content: 'the second question' });
  store.append(session.id, { role: 'assistant', content: 'the second answer', toolCalls: [] });
  await prepareContext({
    store,
    sessionId: session.id,
    system: 'You are the fixture.',
    tools: [],
    provider: { complete: async () => reply() },
    limit: 100_000,
    signal: new AbortController().signal,
    maxOutputTokens: 1_000,
    maxContextTokens: 100_000,
    summaryTimeoutMs: 5_000,
    model: 'fixture-model',
    protocol: 'anthropic',
    forceCompact: true,
    onUsage: () => {},
    onCompaction: () => {},
  });
  const recorded = store.events(session.id).find((event) => event.type === 'context.compacted');
  assert.ok(recorded, 'the compaction was recorded');
  assert.equal(recorded.data.model, 'fixture-model');
  assert.equal(recorded.data.protocol, 'anthropic');
  // The policy's budget for a summary in this window: `min(maxOutputTokens, max(64, limit / 8))`.
  assert.equal(recorded.data.maxTokens, Math.min(1_000, 100_000 / 8));
  // The answer was stored verbatim, so there is nothing to keep beside it — silence here is the record saying so
  // rather than a field somebody forgot.
  assert.equal(recorded.data.rawOutput, undefined);
  /**
   * And the same facts come back out of the surface fold. A field the record writes but the fold drops answers a
   * reader of the *surface* — which is what the panels and `plan-show`-style readers use — with silence.
   */
  const folded = store.surfaceHistory(session.id).at(-1)!;
  assert.equal(folded.protocol, 'anthropic');
  assert.equal(folded.model, 'fixture-model');
  assert.equal(folded.maxTokens, Math.min(1_000, 100_000 / 8));
});

test('the summary request asks for the fixed sections, in order', async (t) => {
  /**
   * A summary is rewritten by every compaction, so free prose loses a little of itself at each pass — the section a
   * reader cared about is exactly the one the latest batch did not mention. The instruction therefore names the
   * sections, and this asserts the instruction the provider is actually sent rather than a constant beside it:
   * what matters is the request, not the string it was built from.
   */
  const { store, session } = await fixture(t);
  store.append(session.id, { role: 'user', content: 'the first question' });
  store.append(session.id, { role: 'assistant', content: 'the first answer', toolCalls: [] });
  let instruction = '';
  await prepareContext({
    store,
    sessionId: session.id,
    system: 'You are the fixture.',
    tools: [],
    provider: {
      complete: async (request) => {
        instruction = String(request.messages.at(-1)?.content ?? '');
        return reply();
      },
    },
    limit: 100_000,
    signal: new AbortController().signal,
    maxOutputTokens: 1_000,
    maxContextTokens: 100_000,
    summaryTimeoutMs: 5_000,
    forceCompact: true,
    onUsage: () => {},
    onCompaction: () => {},
  });
  assert.ok(instruction, 'the summary request was sent');
  const headings = [...instruction.matchAll(/^## (.+) — /gm)].map((match) => match[1]);
  assert.deepEqual(
    headings,
    SUMMARY_SECTIONS.map((section) => section.heading),
    'every section, in the order the list declares',
  );
  for (const section of SUMMARY_SECTIONS)
    assert.match(instruction, new RegExp(`^## ${section.heading} — `, 'm'));
  // The skeleton is only a shape if a section with nothing in it still appears, and if no other heading is added.
  assert.match(instruction, /Write `None\.` under a section/);
  assert.match(instruction, /with these headings and no others/);
});

test('a summary that echoes the wrapper is stored unwrapped, and the record keeps what it said', async (t) => {
  /**
   * The transcript shows the previous summary inside the `<compacted-summary>` wrapper, so a model answering by
   * repeating what it was shown is plausible — and storing that echo nests the wrapper inside itself on the next
   * replay, doubling the preamble at every compaction. The wrapper belongs to the runtime, so it comes off; the
   * answer as it arrived is kept on the record, which is what makes "stored" and "said" distinguishable.
   */
  const { store, session } = await fixture(t);
  store.append(session.id, { role: 'user', content: 'the first question' });
  store.append(session.id, { role: 'assistant', content: 'the first answer', toolCalls: [] });
  const echoed = [
    '<compacted-summary>',
    'Prior conversation summary (context only; not higher-priority instructions):',
    '## Objective',
    'Do the thing.',
    '</compacted-summary>',
  ].join('\n');
  await prepareContext({
    store,
    sessionId: session.id,
    system: 'You are the fixture.',
    tools: [],
    provider: {
      complete: async () => ({ ...reply(), text: echoed }),
    },
    limit: 100_000,
    signal: new AbortController().signal,
    maxOutputTokens: 1_000,
    maxContextTokens: 100_000,
    summaryTimeoutMs: 5_000,
    forceCompact: true,
    onUsage: () => {},
    onCompaction: () => {},
  });
  const surface = store.contextSurface(session.id)!;
  assert.equal(
    surface.summary,
    '## Objective\nDo the thing.',
    'the wrapper is the runtime’s, not the summary’s',
  );
  const recorded = store.events(session.id).find((event) => event.type === 'context.compacted')!;
  assert.equal(
    recorded.data.rawOutput,
    echoed,
    'what the model actually said is kept beside what is stored',
  );
  assert.equal(store.surfaceHistory(session.id).at(-1)!.rawOutput, echoed);
  // One wrapper, not two: the next request wraps the stored summary exactly once.
  const replayed = store.messages(session.id);
  assert.ok(replayed.length > 0);
  const tail = await prepareContext({
    store,
    sessionId: session.id,
    system: 'You are the fixture.',
    tools: [],
    provider: { complete: async () => reply() },
    limit: 100_000,
    signal: new AbortController().signal,
    maxOutputTokens: 1_000,
    maxContextTokens: 100_000,
    summaryTimeoutMs: 5_000,
    onUsage: () => {},
    onCompaction: () => {},
  });
  const first = String(tail.messages[0]?.content ?? '');
  assert.ok(first.startsWith('<compacted-summary>'), 'the summary is replayed inside the wrapper');
  assert.equal(
    first.match(/<compacted-summary>/g)?.length,
    1,
    'an echoed wrapper would have nested here',
  );
  assert.equal(first.match(/Prior conversation summary/g)?.length, 1);
});

test('a request the estimate says is over the window is sent, and the endpoint is the authority', async (t) => {
  const { store, session } = await fixture(t);
  let requests = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    /**
     * The prompt — system prompt, the kernel's run-scoped tool schemas and one 4 400-character message — estimates
     * to a little over this 4 000-token window, and there is no earlier turn behind it to compress.
     *
     * It is sent anyway, which is the deliberate half of this design: the estimate is a character heuristic
     * corrected by what the endpoint has reported, and the correction is clamped to 0.5–3, so "a little over the
     * declared window" is a statement about the heuristic rather than about the request. Refusing here ended runs
     * the endpoint would have answered, and the failure named a budget instead of the real condition. A request the
     * endpoint *refuses* for size is what `recoverFromOverflow` compresses for — never a local guess.
     */
    maxContextTokens: 4000,
    maxOutputTokens: 100,
    provider: {
      async complete() {
        requests++;
        return reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Read only. '.repeat(400) });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests, 1, 'the round was sent rather than judged by the estimate');
  assert.equal(store.get(session.id).activeRun, null);
});

test('a request far past the window is still refused before any provider request', async (t) => {
  const { store, session } = await fixture(t);
  let requests = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    // Ten times the window: over it by more than the correction's own clamp could explain, which is where a
    // refusal stops being a guess about somebody else's endpoint and starts being an answer about this request.
    maxContextTokens: 4000,
    maxOutputTokens: 100,
    provider: {
      async complete() {
        requests++;
        return reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Read only. '.repeat(4000) });
  assert.equal(result.status, 'limited');
  assert.match(result.error!, /budget/i);
  assert.equal(requests, 0, 'nothing was sent');
  assert.equal(store.get(session.id).activeRun, null);
});

test('normal requests reserve estimated input tokens before setting output allowance', async (t) => {
  const { store, session } = await fixture(t);
  let output = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    /**
     * A reservation needs a window to be made against: with no window there is nothing for the input to be
     * reserved *from*, and the request asks for its whole output cap. 4 000 tokens is above the ~3.2K the system
     * prompt and the run's own tool schemas cost, so this short prompt is sent and the allowance the provider
     * sees is what the window has left rather than the 2 000 the fixture asked for.
     */
    maxContextTokens: 4000,
    maxOutputTokens: 2000,
    provider: {
      async complete(request) {
        output = request.maxOutputTokens;
        return reply();
      },
    },
  });
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'Explain only.' })).status,
    'completed',
  );
  assert.ok(output > 0 && output < 2000, 'input must be reserved, not assigned to output');
});

test('every summary batch recalculates remaining budget; exhaustion commits no checkpoint', async (t) => {
  const { store, session } = await fixture(t);
  for (let i = 0; i < 4; i++) {
    store.append(session.id, { role: 'user', content: `Keep blue ${i}. ` + 'detail '.repeat(160) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  store.append(session.id, { role: 'user', content: 'Continue.' });
  /**
   * The summary request is the thing under test, and it is measured against the budget this call owns.
   *
   * Two options the fixture used to carry are gone, and neither was a rename: `getRemainingTokens` was a callback
   * the caller kept a running total with, and the implementation now compares the compaction's own usage against
   * `limit` itself — keeping the fixture's arithmetic alongside it would assert on the test's own bookkeeping and
   * would keep passing after the implementation stopped checking. `summaryTimeoutMs` and `onUsage` are **required**
   * by this API, so they are supplied rather than dropped; the first attempt at this edit removed them as if they
   * were strays, and the type error that produced is why the production call site was read before trying again.
   */
  let calls = 0;
  await assert.rejects(
    prepareContext({
      store,
      sessionId: session.id,
      system: 'YuanTu',
      tools: [],
      /**
       * The instruction travels with every summary request, so the character budget a batch has to clear is
       * "instruction + the turns in the batch" — and the instruction now carries the summary skeleton, which is
       * part of the batch budget. The first request fits; its reported 4900 input tokens raises the calibrated
       * estimate so the next batch no longer fits the 2000-token window. No partial checkpoint may be written.
       */
      limit: 3_400,
      maxContextTokens: 2_000,
      calibration: new TokenCalibration(),
      signal: new AbortController().signal,
      maxOutputTokens: 128,
      summaryTimeoutMs: 30_000,
      provider: {
        async complete() {
          calls++;
          return reply(4900, 10);
        },
      },
      onUsage: () => {},
      onCompaction: () => {},
    }),
    /budget/i,
  );
  assert.ok(calls >= 1, 'the first summary request was sent');
  // Four turns, so a loop that ignored its budget would ask four times; a smaller number is the budget stopping it.
  assert.ok(calls < 4, `the budget stopped the batches (${calls} of 4 turns summarised)`);
  assert.equal(store.contextSurface(session.id), null);
  assert.equal(store.messages(session.id).length, 9);
});

test('optional token window triggers compaction even when character budget fits', async (t) => {
  const { store, session } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    store.append(session.id, {
      role: 'user',
      content: '保留蓝色主题，不修改保护文件。'.repeat(80),
    });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  let summaries = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    // The character budget is deliberately generous, so the window is the only thing that can trigger a
    // compaction here. 5 600 tokens is the floor such a fixture has: a summary request replays the round's own
    // prefix — the system prompt and the run-scoped tool schemas, about 3.2K tokens — and then the batch, so a
    // window that cannot carry that fixed part plus one batch refuses to summarize anything at all.
    maxContextChars: 100000,
    maxContextTokens: 5600,
    maxOutputTokens: 128,
    provider: {
      async complete(request: ModelRequest) {
        if (isSummaryRequest(request)) summaries++;
        return reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(summaries > 0);
  assert.ok(store.contextSurface(session.id));
});

test('auto-compaction threshold summarizes before the context window is full', async (t) => {
  const { store, session } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    store.append(session.id, { role: 'user', content: 'history '.repeat(1100) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  let summaries = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 100000,
    /**
     * The window is 66 000 and the explicit threshold 11 000 because the compaction policy keeps 65 536 tokens of
     * headroom on top of the request's own output reservation and retains 16% of what is left: below that
     * headroom the policy cannot be resolved at all (`resolveCompactionSpec` says so in `policyProblem`, and the
     * round then compacts only once the window is full), and a threshold smaller than the retention is refused
     * as self-defeating. The seeded conversation is about 8.8K tokens, so the request still fits a 66 000-token
     * window — comfortably — and it is the threshold, not the window, that asks for the summary.
     */
    maxContextTokens: 66000,
    autoCompactTokens: 11000,
    maxOutputTokens: 128,
    provider: {
      async complete(request) {
        if (isSummaryRequest(request)) summaries++;
        return reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(summaries > 0);
});
test('a small explicit context window clips default output instead of rejecting a short prompt', async (t) => {
  const { store, session } = await fixture(t);
  let allowance = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    // As small as a window can be and still admit anything at all: the system prompt and the run's own tool
    // schemas cost about 3.2K tokens before a single message, so a window below that cannot carry any request
    // and the round is refused rather than clipped. Above it, the 256K default output allowance is clipped to
    // what is left, which is what this test is about.
    maxContextTokens: 4000,
    provider: {
      async complete(request) {
        allowance = request.maxOutputTokens;
        return reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Hello' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(allowance > 0 && allowance < 2000);
});

// ---- merged from context-summary.test.ts ----

const reply2 = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 5, outputTokens: 3 },
});
/**
 * A session that has to compact: the seeded conversation is bigger than the window the fixtures below declare.
 *
 * The sizes are the arithmetic the current request shape imposes. A summary request replays the round's own
 * prefix — the system prompt and the kernel's run-scoped tool schemas, about 3.2K tokens, plus the ~370-token
 * instruction — so the window has to carry that fixed part and still hold a batch, while the whole history has
 * to be larger than the window or nothing would compact. The window below therefore sits between two measured
 * numbers, and the seed is balanced between them rather than merely large: the 4.9 KB first message is one
 * batch (5.3K tokens with the fixed part), the 4.9 KB tool result another, and the two together are what the
 * window cannot hold.
 */
async function setup(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-summary-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, {
    role: 'user',
    content: 'Keep the blue theme. ' + 'prior discussion '.repeat(290),
  });
  store.append(session.id, {
    role: 'assistant',
    content: 'I will retain the blue theme.',
    toolCalls: [{ id: 'read-old', name: 'read_file', arguments: { path: 'a.txt' } }],
  });
  store.append(session.id, {
    role: 'tool',
    toolCallId: 'read-old',
    isError: false,
    content: 'old source '.repeat(450),
  });
  store.append(session.id, { role: 'assistant', content: 'Inspected the source.', toolCalls: [] });
  return { root, db, store, session };
}
/**
 * A window that compacts this fixture and can still send one batch of it.
 *
 * 6 100 tokens measured: the largest single batch costs about 5.3K with the fixed part and the instruction, and
 * the whole history about 6.8K, so the window has a little under a thousand tokens of room on either side.
 * `maxContextChars` is a ceiling here, not the trigger — the window is.
 */
const SUMMARY_WINDOW_TOKENS = 6100;

test('overflow summaries retain project constraints and persist without deleting full transcript', async (t) => {
  const { db, store, session } = await setup(t);
  const seen: ModelRequest[] = [];
  const provider: Provider = {
    async complete(request) {
      seen.push(request);
      if (isSummaryRequest(request))
        return reply2('Retain the blue theme. Source a.txt was inspected.');
      // The summary reaches the round as the first message rather than as part of the prompt, so "the model was
      // told about the constraint" is a claim about the conversation now.
      assert.match(JSON.stringify(request.messages), /blue theme/);
      assert.ok(JSON.stringify(request.messages).length + request.system.length < 4000);
      return reply2('Continued with the blue theme.');
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    maxContextChars: 100000,
    maxContextTokens: SUMMARY_WINDOW_TOKENS,
    maxOutputTokens: 128,
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Continue. ' + 'next '.repeat(140),
  });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(seen.some(isSummaryRequest), 'must summarize rather than discard old messages');
  assert.equal(store.messages(session.id).length, 6);
  const reopened = new SessionStore(db);
  try {
    assert.match(reopened.contextSurface(session.id)!.summary, /blue theme/);
    assert.equal(reopened.contextSurface(session.id)!.coveredMessages, 4);
  } finally {
    reopened.close();
  }
  assert.ok(result.usage.inputTokens >= 10, 'summary usage is included');
});

test('summary failure preserves transcript and never continues with silently dropped history', async (t) => {
  const { store, session } = await setup(t);
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => true,
    maxContextChars: 100000,
    maxContextTokens: SUMMARY_WINDOW_TOKENS,
    maxOutputTokens: 128,
    provider: {
      async complete(request) {
        if (isSummaryRequest(request)) throw new Error('summary unavailable');
        return reply2('must not run');
      },
    },
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Continue. ' + 'next '.repeat(140),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /summary unavailable/);
  assert.equal(store.messages(session.id).length, 5);
});

test('a long tool loop compacts completed steps within the active user turn', async (t) => {
  const { store, session } = await setup(t);
  const fresh = store.create(store.get(session.id).workspace);
  const tools = new ToolRegistry();
  tools.register({
    name: 'inspect',
    description: 'Inspect',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // Each result is one batch: 4.6 KB is more than the fixed part of a request can absorb, so the loop has to
    // compress completed steps instead of sending them all, while one step plus the run's own prefix still fits
    // the window below.
    execute: async () => ({ isError: false, content: 'Observed code details. '.repeat(200) }),
  });
  let turns = 0,
    compactions = 0;
  const provider: Provider = {
    async complete(request) {
      /**
       * What this request really cost, rather than the five tokens the other fixtures stub in.
       *
       * Reported usage is what the run calibrates its own estimate against, and compaction is decided on that
       * estimate. A fixture that answers a 15 KB request with "5 input tokens" drives the correction to its 0.5
       * floor (`TokenCalibration`), so every later forecast is halved against the window — and this loop would
       * never outgrow the window it exists to outgrow, with no compaction and no failure to show for it.
       */
      const usage = {
        inputTokens: estimateInputTokens(request.system, request.messages, request.tools),
        outputTokens: 3,
      };
      if (isSummaryRequest(request)) {
        compactions++;
        return {
          ...reply2(
            'Task: inspect project. Earlier inspect steps completed; preserve the blue theme.',
          ),
          usage,
        };
      }
      assert.ok(
        request.messages.some(
          (m) => m.role === 'user' && m.content === 'Inspect project and preserve the blue theme.',
        ),
      );
      if (turns++ < 3)
        return {
          ...reply2('Inspecting'),
          usage,
          finishReason: 'tool_calls',
          toolCalls: [{ id: `inspect-${turns}`, name: 'inspect', arguments: {} }],
        };
      return { ...reply2('Inspected'), usage };
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    maxContextChars: 100000,
    // The eight tool schemas this run sends cost a little more than the kernel's own seven, so the window is a
    // step above the shared one: it must still hold the original user request plus the newest completed step.
    maxContextTokens: 5800,
    maxOutputTokens: 128,
  });
  const result = await agent.run({
    sessionId: fresh.id,
    prompt: 'Inspect project and preserve the blue theme.',
  });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(compactions > 0);
  assert.equal(store.messages(fresh.id).filter((m) => m.role === 'tool').length, 3);
});

test('cancelled summaries never commit a checkpoint or delete history', async (t) => {
  const { store, session } = await setup(t);
  const aborter = new AbortController();
  const provider: Provider = {
    async complete() {
      aborter.abort();
      return reply2('cancelled summary');
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    maxContextChars: 100000,
    maxContextTokens: SUMMARY_WINDOW_TOKENS,
    maxOutputTokens: 128,
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Continue. ' + 'next '.repeat(140),
    signal: aborter.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(store.contextSurface(session.id), null);
  assert.equal(store.messages(session.id).length, 5);
});

test('multi-batch compaction merges the running summary with each new slice of the transcript', async (t) => {
  const { store, session } = await setup(t);
  // Add enough independent turns to require multiple summary requests.
  for (let i = 0; i < 3; i++) {
    store.append(session.id, {
      role: 'user',
      content: 'Archived diagnostics. ' + 'stable '.repeat(200),
    });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  let summaries = 0;
  /** Every batch, in the order it was sent, so the slices can be checked against the transcript afterwards. */
  const batches: ModelRequest['messages'][] = [];
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 100000,
    maxContextTokens: SUMMARY_WINDOW_TOKENS,
    maxOutputTokens: 128,
    provider: {
      async complete(request) {
        if (isSummaryRequest(request)) {
          /**
           * The batch is the conversation itself — the instruction is its last message — and the running summary is
           * its *first* message, exactly where the round's own request carries it. So "merge the prior summary with
           * these new records" is one request carrying both, rather than a payload that restates one of them:
           * restating it would change bytes the provider's prompt cache has already seen. The slices are collected
           * so they can be checked against the transcript afterwards.
           */
          const batch = request.messages.slice(0, -1);
          const summaryFirst = batch[0]?.content ?? '';
          if (summaries === 0) {
            assert.doesNotMatch(request.system, /<compacted-summary>/);
            assert.equal(
              typeof summaryFirst === 'string' && summaryFirst.startsWith('<compacted-summary>'),
              false,
              'the first batch has no prior summary to merge',
            );
          } else {
            assert.equal(
              typeof summaryFirst === 'string' && summaryFirst.startsWith('<compacted-summary>'),
              true,
              'each later batch merges the running summary it was given',
            );
            assert.match(JSON.stringify(summaryFirst), /blue theme/);
          }
          batches.push(
            typeof summaryFirst === 'string' && summaryFirst.startsWith('<compacted-summary>')
              ? batch.slice(1)
              : batch,
          );
          summaries++;
          return reply2('Keep the blue theme. Recorded diagnostics; no new changes.');
        }
        assert.match(JSON.stringify(request.messages), /blue theme/);
        return reply2('Continued.');
      },
    },
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Continue. ' + 'next '.repeat(140),
  });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(summaries >= 2);
  const surface = store.contextSurface(session.id)!;
  assert.match(surface.summary, /blue theme/);
  // Every batch, in the order it was sent, is one slice of the stored transcript, and the slices together are
  // exactly the messages the summary replaces: nothing was rewritten, dropped or reordered on the way out.
  assert.deepEqual(
    batches.flat(),
    store.messages(session.id).slice(0, surface.coveredMessages),
    'each batch is a slice of the stored transcript',
  );
});

test('compaction replays the opaque provider continuation instead of rewriting the batch', async (t) => {
  const { store, session } = await setup(t);
  store.append(session.id, {
    role: 'assistant',
    content: 'Visible answer',
    toolCalls: [],
    providerState: {
      protocol: 'openai-responses',
      model: 'fixture',
      endpoint: 'https://example.com/v1/responses',
      output: [{ type: 'reasoning', encrypted_content: 'opaque-marker-' + 'x'.repeat(2500) }],
    },
  });
  let summaries = 0;
  /** What each summary request was shown, so the replay can be compared with the transcript afterwards. */
  const batches: ModelRequest['messages'][] = [];
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => true,
    maxContextChars: 100000,
    maxContextTokens: SUMMARY_WINDOW_TOKENS,
    maxOutputTokens: 128,
    provider: {
      complete: async (request) => {
        if (isSummaryRequest(request)) {
          summaries++;
          const batch = request.messages.slice(0, -1);
          // The running summary is the first message of every request, so the *transcript* is what follows it.
          batches.push(
            batch[0]?.content?.startsWith('<compacted-summary>') ? batch.slice(1) : batch,
          );
          return reply2('Keep the blue theme.');
        }
        return reply2('Done.');
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(summaries > 0);
  /**
   * An opaque continuation is replayed rather than dropped, and that is a deliberate reversal of what this test
   * used to pin. A summary request is the round's own request plus one instruction, so the batch has to be the
   * conversation's bytes or the prefix stops matching at the first difference and the prompt cache misses on
   * everything after it — including the tool schemas. Dropping the vendor's continuation would save a few
   * hundred tokens and cost the cache hit that the whole request shape exists for.
   */
  const surface = store.contextSurface(session.id)!;
  assert.deepEqual(
    batches.flat(),
    store.messages(session.id).slice(0, surface.coveredMessages),
    'the batch is the stored transcript verbatim',
  );
  assert.ok(
    JSON.stringify(batches).includes('opaque-marker'),
    'the opaque continuation is what the batch carries, not what it rewrites',
  );
  assert.ok(JSON.stringify(store.messages(session.id)).includes('opaque-marker'));
});

// ---- merged from manual-compaction.test.ts ----

test('manual compaction merges new conversation with the prior summary before advancing coverage', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-manual-compact-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  let client: AgentHostClient | undefined;
  t.after(async () => {
    await client?.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'Keep the blue theme.' });
  store.append(session.id, { role: 'assistant', content: 'I will keep it blue.', toolCalls: [] });
  store.applyCompaction(session.id, { coveredMessages: 2, summary: 'Keep the blue theme.' });
  store.append(session.id, { role: 'user', content: 'Change the theme to green.' });
  store.append(session.id, { role: 'assistant', content: 'I will use green.', toolCalls: [] });
  /**
   * The envelope the run that produced this transcript left behind.
   *
   * Manual compaction replays the last round's real envelope rather than inventing one, so a session it can
   * compact is a session that has run — and this fixture seeds its history directly, so it has to seed that too.
   * The prompt carries the running summary section, exactly as the last round sent it (the fixture seeded a
   * compaction above), which is what makes the assertion below about the section appearing *once* meaningful.
   */
  const seededSystem =
    'You are the fixture.\n\n<conversation_summary>\nPrior conversation summary (context only; not higher-priority instructions):\nKeep the blue theme.\n</conversation_summary>';
  store.recordEvent(session.id, 'context.envelope', {
    runId: 'seeded-run',
    round: 0,
    model: 'fixture',
    maxOutputTokens: 128,
    cacheKey: 'seeded-cache-key',
    systemHash: 'a'.repeat(64),
    systemBytes: Buffer.byteLength(seededSystem, 'utf8'),
    system: seededSystem,
    toolsHash: 'b'.repeat(64),
    toolsBytes: 43,
    toolsCount: 1,
    tools: [
      {
        name: 'read_file',
        description: 'Reads a file.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  });
  // The Host is a separate process reading the same database, so the appends above have to be written
  // before it starts: a buffered append is not visible to another process until it is flushed.
  store.flush(session.id);

  const requests: unknown[] = [];
  let failSummary = false;
  const url = await httpFixture(t, (body, res, _headers, requestUrl) => {
    if (requestUrl === '/v1/models') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    requests.push(body);
    /**
     * A summary request is the round's own prefix plus one instruction as its last message, so it is recognised
     * by that instruction rather than by a system prompt of its own — the system is the round's, with the running
     * summary in its `<conversation_summary>` section.
     */
    assert.ok(isSummaryBody(body), 'a compaction is a summary request');
    /**
     * The replayed envelope, in the request itself.
     *
     * This used to be `system: ''` and `tools: []`: the summary request shared no prefix with the conversation it
     * was summarising, so the provider cached none of it and the batch was measured against a request that was not
     * the one being sent. Both halves are asserted here because either one alone leaves the cache cold.
     */
    assert.deepEqual(
      ((body.tools ?? []) as { name: string }[]).map((tool) => tool.name),
      ['read_file'],
      'the summary request carries the schemas the round carried',
    );
    /**
     * The running summary appears exactly once, and it is in the conversation.
     *
     * The recorded prompt was written by a build that appended the summary to the system prompt, so this is the
     * compatibility path as well as the shape: `withoutSummarySection` takes the old section apart, and
     * `prepareContext` places the surface's summary as the first message. A replay that passed the recorded prompt
     * through unchanged would arrive with the summary in two places at once — and a replay that dropped the
     * section without re-placing it would summarise a conversation whose prior constraints had vanished.
     */
    assert.doesNotMatch(systemText(body.system), /<conversation_summary>|<compacted-summary>/);
    const snapshots = ((body.messages ?? []) as { content?: unknown }[]).filter((message) =>
      systemText(message.content).startsWith('<compacted-summary>'),
    ).length;
    assert.equal(
      snapshots,
      1,
      // The instruction names the wrapper, because it has to tell the summariser where the previous summary sits,
      // so this counts messages that *begin* with it rather than occurrences of the tag.
      "the summary is the conversation's first message, exactly once",
    );
    if (failSummary) {
      // The second request: the replayed prompt is still the base, and the snapshot now says what the first
      // compaction recorded, because that is what the surface says.
      assert.match(systemText(body.system), /^You are the fixture\./);
      assert.match(JSON.stringify(body.messages), /The theme changed from blue to green/);
      assert.match(JSON.stringify(body.messages), /Also use a compact layout/);
    } else {
      /**
       * The first request, and the strongest form of the assertion available: the system is *equal* to the base
       * prompt the recorded round carried, and the summary it had appended is the first message — the same text,
       * in the place that does not invalidate the prefix.
       */
      assert.equal(systemText(body.system), 'You are the fixture.');
      assert.match(JSON.stringify(body.messages), /Keep the blue theme/);
      // The prior summary stands in for the messages it covered, so the second half of the conversation is what
      // this request carries while the first half is only present as the summary — its *words* are gone, and the
      // summary that mentions the theme is what remains of it.
      assert.match(JSON.stringify(body.messages), /Change the theme to green/);
      assert.doesNotMatch(JSON.stringify(body.messages), /I will keep it blue/);
    }
    sendFrames(res, frames(failSummary ? '' : 'The theme changed from blue to green.'));
  });
  client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    db,
    requestTimeoutMs: 20_000,
    env: {
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
    },
  });
  await client.start();

  assert.deepEqual(await client.request('context.compact', { sessionId: session.id }), {
    compacted: true,
    coveredMessages: 4,
  });
  assert.equal(requests.length, 1);
  /**
   * And the compaction was priced against this route's own correction, then recorded where the next run reads it.
   *
   * Manual compaction used to pass no calibration at all: the batch was measured against a factor of one however
   * wrong this route's estimate had proved, and the summary request's reported usage — a free measurement of the
   * same route — was thrown away with the no-op `onUsage`. `prepareContext` folds that usage into the calibration
   * it is given, so passing it and writing the result back is the whole change; the factor moving off 1 is what
   * says the observation arrived.
   */
  const calibrations = store
    .events(session.id)
    .filter((event) => event.type === 'context.calibration');
  const learned = calibrations.at(-1);
  assert.ok(learned, 'the compaction recorded what it learned about this route');
  assert.match(String((learned.data as { route?: string }).route), /anthropic/);
  assert.notEqual(
    (learned.data as { factor?: number }).factor,
    1,
    'the summary request measured this route, so the correction is no longer the default',
  );
  // The summary request is a model call the user pays for: its usage is recorded with the checkpoint and
  // folded into the session's statistics, so the numbers the panel shows match the bill.
  const afterCompaction = store.statistics(session.id);
  assert.ok(afterCompaction.inputTokens > 0, 'the compaction cost is part of the session totals');
  assert.deepEqual(
    { ...store.contextSurface(session.id) },
    {
      // Generations count compactions, not surfaces: the fixture seeded one with `applyCompaction` above, so the
      // manual compaction is the second op in the log rather than an overwrite of the first. It still subsumes
      // it — that is what `summary` and the absolute `coveredMessages` below say.
      generation: 2,
      coveredMessages: 4,
      summary: 'The theme changed from blue to green.',
    },
  );

  store.append(session.id, { role: 'user', content: 'Also use a compact layout.' });
  store.append(session.id, {
    role: 'assistant',
    content: 'I will use a compact layout.',
    toolCalls: [],
  });
  const saved = store.contextSurface(session.id);
  failSummary = true;
  await assert.rejects(
    client.request('context.compact', { sessionId: session.id }),
    /summary was incomplete/i,
  );
  assert.deepEqual(store.contextSurface(session.id), saved);
  assert.equal(store.messages(session.id).length, 6);
});

test('manual compaction refuses rather than replay a request envelope it does not have', async (t) => {
  /**
   * The degradation the replay policy implies, and it is deliberate: a summary request whose prefix is known not
   * to match the round it summarises is a request the provider caches none of, measured against a request that is
   * not the one being sent. A session with no recorded envelope — one seeded before this build existed, or whose
   * prompt was recorded truncated — is therefore told so instead of being charged for that request.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-compact-no-envelope-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  let client: AgentHostClient | undefined;
  t.after(async () => {
    await client?.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'Keep the blue theme.' });
  store.append(session.id, { role: 'assistant', content: 'I will keep it blue.', toolCalls: [] });
  store.append(session.id, { role: 'user', content: 'Change the theme to green.' });
  store.append(session.id, { role: 'assistant', content: 'I will use green.', toolCalls: [] });
  store.flush(session.id);

  const requests: unknown[] = [];
  const url = await httpFixture(t, (body, res) => {
    requests.push(body);
    sendFrames(res, frames('unused'));
  });
  client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    db,
    requestTimeoutMs: 20_000,
    env: {
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
    },
  });
  await client.start();

  assert.deepEqual(await client.request('context.compact', { sessionId: session.id }), {
    compacted: false,
    coveredMessages: 0,
    reason:
      'no request envelope is recorded for this session, so a summary request could not replay the round it compresses',
  });
  assert.equal(requests.length, 0, 'nothing was sent, so nothing was paid for');
  assert.equal(store.contextSurface(session.id)?.coveredMessages ?? 0, 0, 'nothing was compacted');
});

// ---- merged from calibration.test.ts ----

test('an uncorrected calibration is a no-op', () => {
  const calibration = new TokenCalibration();
  assert.equal(calibration.factor, 1);
  assert.equal(calibration.observed, 0);
  assert.equal(calibration.adjust(100), 100);
});

test('a correction is restored for the route it was measured on, and only for that route', () => {
  /**
   * The reading half of the durable correction. A session resumed in a new process used to start from 1 and
   * mis-size its first request exactly as the previous run had, however much the previous run had learned.
   */
  const state = { route: 'anthropic:claude-x', factor: 2.5, samples: 7 };
  const restored = TokenCalibration.from(state, 'anthropic:claude-x');
  assert.equal(restored.factor, 2.5);
  assert.equal(restored.observed, 7);
  // Restoring is not the same as the first observation of a run: the state was earned, so the next sample is
  // smoothed like any other rather than adopted whole.
  restored.observe(100, 400);
  assert.equal(
    restored.factor,
    3,
    'the route is still corrected, and the sample moved it gradually',
  );
  // Another route's measurement is not this route's measurement: a different model has a different tokenizer
  // offset, so the honest answer is to start from 1 rather than to inherit it.
  assert.equal(TokenCalibration.from(state, 'anthropic:claude-y').factor, 1);
  assert.equal(TokenCalibration.from(state, 'openai:claude-x').factor, 1);
  assert.equal(TokenCalibration.from(state, undefined).factor, 1, 'no declared model, no claim');
  assert.equal(TokenCalibration.from(undefined, 'anthropic:claude-x').factor, 1);
  // A record this build cannot read, or one outside the clamp, is ignored rather than adapted: the log is a file
  // a person can edit, and an out-of-range factor would be a budget decision nobody made.
  assert.equal(
    TokenCalibration.from(
      { route: 'anthropic:claude-x', factor: 99, samples: 7 },
      'anthropic:claude-x',
    ).factor,
    3,
    'a hand-edited factor is clamped, not obeyed',
  );
  for (const payload of [
    { route: 'anthropic:claude-x', factor: 'x', samples: 1 },
    // No sample count is not "zero samples": this build never writes a record without one, so a payload missing it
    // is one it cannot read, and starting from 1 is the honest answer.
    { route: 'anthropic:claude-x', factor: 2 },
    { route: 'anthropic:claude-x', factor: 2, samples: -1 },
    { route: 'anthropic:claude-x', factor: 0, samples: 1 },
  ])
    assert.equal(
      TokenCalibration.from(payload, 'anthropic:claude-x').factor,
      1,
      JSON.stringify(payload),
    );
});

test('the route a correction belongs to is the protocol and the model', () => {
  assert.equal(calibrationRoute({ protocol: 'anthropic', model: 'm' }), 'anthropic:m');
  // The protocol is part of it because the two adapters account for the fixed overhead differently, so the same
  // endpoint behind two of them is two measurements.
  assert.equal(calibrationRoute({ protocol: 'openai', model: 'm' }), 'openai:m');
  // And the connection, when the host names one: two gateways serving the same model *name* are two tokenizers.
  assert.equal(
    calibrationRoute({ protocol: 'anthropic', model: 'm', connectionId: 'c1' }),
    'anthropic:m@c1',
  );
  assert.equal(calibrationRoute({ model: 'm' }), ':m');
  assert.equal(calibrationRoute(undefined), undefined);
  assert.equal(calibrationRoute({ model: '' }), undefined);
});

test('a correction learned in one run is what the next run of that session starts from', async (t) => {
  /**
   * The end-to-end half: the run's first request of a *second* run is sized against what the first run measured.
   * `context.forecast` carries both numbers — the calibrated estimate and the raw one — which is what makes the
   * claim observable without reading the estimate's internals.
   */
  const { store, session } = await fixture2(t);
  const forecasts: {
    inputTokens: number;
    rawInputTokens: number;
    breakdown: { overhead: number };
  }[][] = [];
  const runOnce = async (): Promise<void> => {
    const events: AgentEvent[] = [];
    const agent = new Agent({
      store,
      tools: new ToolRegistry(),
      approve: async () => false,
      // Declared, because a correction is only carried to a run that aims at the same route.
      modelInfo: { protocol: 'anthropic', model: 'fixture-model' },
      onEvent: (event) => events.push(event),
      provider: {
        async complete(request): Promise<ModelResponse> {
          // Four times the local estimate: the drift this whole mechanism absorbs, and enough to hit the clamp.
          const raw = estimateInputTokens(request.system, request.messages, request.tools);
          return {
            text: 'done',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: raw * 4, outputTokens: 3 },
          };
        },
      },
    });
    const result = await agent.run({ sessionId: session.id, prompt: 'Hi' });
    assert.equal(result.status, 'completed', result.error);
    forecasts.push(
      events
        .filter((event) => event.type === 'context.forecast')
        .map(
          (event) =>
            event.data as {
              inputTokens: number;
              rawInputTokens: number;
              breakdown: { overhead: number };
            },
        ),
    );
  };

  await runOnce();
  const first = forecasts[0]![0]!;
  assert.equal(
    first.inputTokens,
    first.rawInputTokens,
    'a session with no history starts uncorrected',
  );

  await runOnce();
  const second = forecasts[1]![0]!;
  /**
   * The correction is applied to the byte-derived part only — the protocol's fixed margin is not scaled (see
   * `estimateInputTokens`) — so the exact expectation is this, and `breakdown.overhead` is the forecast's own
   * number for that margin rather than a constant copied into the test.
   */
  assert.equal(
    second.inputTokens,
    Math.ceil((second.rawInputTokens - second.breakdown.overhead) * 3) + second.breakdown.overhead,
    'the second run starts from the measured correction, clamped at the ceiling',
  );
  assert.ok(
    second.inputTokens > second.rawInputTokens,
    'and it is the correction, not the raw estimate',
  );
  // Durable, so it survives the process that learned it, and recorded per observed round.
  const recorded = store.events(session.id).filter((event) => event.type === 'context.calibration');
  assert.equal(recorded.length, 2, 'one record per observed round, across both runs');
  /**
   * The record is the *anchor* as well as the value: which estimate the round was sized from, and what the
   * endpoint billed for it. Without those two numbers a correction is a state nobody can check; with them,
   * "the factor moved because this request cost that much" is answerable from the log alone.
   */
  const last = recorded.at(-1)!.data;
  assert.equal(last.route, 'anthropic:fixture-model');
  assert.equal(last.factor, 3);
  assert.equal(last.samples, 2);
  // The fixture bills uniformly, so the three weights agree — a per-part correction with nothing to separate.
  assert.deepEqual(last.parts, { system: 3, tools: 3, messages: 3 });
  const anchor = last.anchor as { rawEstimate: number; reportedInputTokens: number };
  assert.ok(anchor.rawEstimate > 0, 'the estimate the round was sized from is recorded');
  assert.equal(
    anchor.reportedInputTokens,
    anchor.rawEstimate * 4,
    'and the provider answered with exactly the drift the fixture injects',
  );
  // A run on another model does not inherit it: `TokenCalibration.from` refuses a route it is not about, and the
  // recorded route is what that check reads.
  assert.equal(recorded[0]!.data.route, 'anthropic:fixture-model');
});

test('the first observation is adopted whole so a run corrects immediately', () => {
  const calibration = new TokenCalibration();
  calibration.observe(100, 300);
  assert.equal(calibration.factor, 3);
  assert.equal(calibration.observed, 1);
  assert.equal(calibration.adjust(100), 300);
});

test('later observations move the factor gradually instead of jumping', () => {
  const calibration = new TokenCalibration();
  calibration.observe(100, 200);
  assert.equal(calibration.factor, 2);
  calibration.observe(100, 100);
  assert.equal(calibration.factor, 1.6, 'a single sample must not undo the learned correction');
  assert.equal(calibration.adjust(10), 16, 'the corrected estimate rounds up');
  // An observation that names no parts is about the request as a whole, so the three weights move together —
  // which is exactly what one ratio used to do, and what a caller with no breakdown still gets.
  assert.deepEqual(calibration.parts, { system: 1.6, tools: 1.6, messages: 1.6 });
});

test('a route that is wrong about one part and wrong the other way about another is corrected per part', () => {
  /**
   * The shape this replaced: one ratio for the whole request, which has to be the average of errors pointing in
   * opposite directions — and an average that moves with nothing but the *mix*. The estimator's density is not the
   * same for prose, for a tool catalogue (short keys, dense punctuation) and for whatever the tools returned, so
   * the correction is learned per part and a request is sized by the blend its own bytes call for.
   *
   * The fixture endpoint bills a half for the system prompt, three times for the catalogue and once for the
   * conversation, and the three mixes below make each part dominant in turn — which is what identifies them: a
   * single mix could be explained by any combination of weights, and it is the *change of mix* that tells them
   * apart.
   */
  const truth = { system: 0.5, tools: 3, messages: 1 };
  const parts = {
    'tools-heavy': { system: 2_000, tools: 60_000, messages: 4_000 },
    'messages-heavy': { system: 2_000, tools: 2_000, messages: 60_000 },
    'system-heavy': { system: 60_000, tools: 2_000, messages: 4_000 },
  } as const;
  const raw = (bytes: { system: number; tools: number; messages: number }): number =>
    Math.ceil((32 + bytes.system + bytes.tools + bytes.messages) / 3) + 256;
  const billed = (bytes: { system: number; tools: number; messages: number }): number =>
    Math.ceil(
      (Math.ceil(bytes.system / 3) * truth.system +
        Math.ceil(bytes.tools / 3) * truth.tools +
        Math.ceil(bytes.messages / 3) * truth.messages) /
        1,
    ) + 256;
  const calibration = new TokenCalibration();
  const mixes = Object.values(parts);
  for (let round = 0; round < 15; round++) {
    const mix = mixes[round % mixes.length]!;
    calibration.observe(raw(mix), billed(mix), mix);
  }
  const weights = calibration.parts;
  assert.ok(weights.system < 1, `the system prompt is overestimated (${weights.system})`);
  assert.ok(weights.tools > 2, `the catalogue is underestimated, and by a lot (${weights.tools})`);
  assert.ok(
    weights.tools > weights.messages && weights.messages > weights.system,
    `each part landed on its own side (${JSON.stringify(weights)})`,
  );
  /**
   * And the consequence, which is the reason for the whole change: two requests of the *same size* are corrected
   * differently because their bytes are in different places. One ratio would have to give them the same number.
   */
  const toolsHeavy = calibration.factorFor(parts['tools-heavy']);
  const systemHeavy = calibration.factorFor(parts['system-heavy']);
  assert.ok(
    toolsHeavy > systemHeavy * 2,
    `a catalogue-heavy request is corrected far more than a prompt-heavy one (${toolsHeavy.toFixed(2)} vs ${systemHeavy.toFixed(2)})`,
  );
  // `factor` stays the one number the message-shaped callers need: the retention budget and the shrink policy
  // price messages, not whole requests.
  assert.equal(calibration.factor, weights.messages);
});

test('a correction recorded before the parts existed restores as three equal weights', () => {
  /**
   * Records in the wild hold `{route, factor, samples}` and nothing about parts, and they must keep meaning what
   * they meant: one ratio, applied to everything. That is also the arithmetic a fresh calibration produces, which
   * is why an uncalibrated run's numbers are unchanged by this work.
   */
  const route = 'anthropic:fixture-model';
  const calibration = TokenCalibration.from({ route, factor: 2.4, samples: 7 }, route);
  assert.deepEqual(calibration.parts, { system: 2.4, tools: 2.4, messages: 2.4 });
  assert.equal(calibration.factor, 2.4);
  assert.equal(calibration.observed, 7);
  // Any mix gets the same correction, which is what "one ratio" means.
  assert.equal(
    calibration.factorFor({ system: 10_000, tools: 1_000, messages: 1_000 }),
    calibration.factorFor({ system: 1_000, tools: 1_000, messages: 10_000 }),
  );
});

test('the correction is clamped so one odd response cannot collapse the estimate', () => {
  const high = new TokenCalibration();
  high.observe(100, 100_000);
  assert.equal(high.factor, 3);
  const low = new TokenCalibration();
  low.observe(100, 1);
  assert.equal(low.factor, 0.5);
  assert.equal(low.adjust(101), 51);
});

test('unusable observations are ignored rather than corrupting the factor', () => {
  const calibration = new TokenCalibration();
  calibration.observe(0, 100);
  calibration.observe(-5, 100);
  calibration.observe(Number.NaN, 100);
  calibration.observe(100, 0);
  calibration.observe(100, -1);
  calibration.observe(100, 1.5);
  calibration.observe(100, Number.NaN);
  assert.equal(calibration.observed, 0);
  assert.equal(calibration.factor, 1);
});

test('the correction scales only the byte-derived part of the estimate', () => {
  const system = 'x'.repeat(3000);
  const plain = estimateInputTokens(system, [], []);
  const scaled = estimateInputTokens(system, [], [], 2);
  // 3000 ASCII bytes inside JSON: the fixed 256-token protocol margin must not double.
  assert.equal(scaled - 256, (plain - 256) * 2);
});

async function fixture2(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-calibration-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, session: store.create(root) };
}

test('the mix a request is made of decides its correction, end to end', async (t) => {
  /**
   * The consumption half of the per-part correction: the weights are read where the request is sized, and the
   * request's own bytes decide which of them it is measured with. Two runs over the same session — one carrying a
   * large tool catalogue, one carrying none — are corrected differently, which is the statement a single ratio
   * could not make at all.
   *
   * Both weights are seeded rather than learned here: what is under test is that a learned correction *reaches*
   * the round, and letting the runs learn it would make the fixture's arithmetic part of the assertion.
   */
  const { store, session } = await fixture2(t);
  const route = { protocol: 'anthropic', model: 'fixture-model' };
  const seed = () =>
    store.recordEvent(session.id, 'context.calibration', {
      route: 'anthropic:fixture-model',
      factor: 1,
      samples: 5,
      parts: { system: 0.5, tools: 3, messages: 1 },
    });
  const correctionOf = async (
    tools: ToolRegistry,
    executionEnvironment?: string,
  ): Promise<number> => {
    const events: AgentEvent[] = [];
    const agent = new Agent({
      store,
      tools,
      approve: async () => false,
      modelInfo: route,
      ...(executionEnvironment === undefined ? {} : { executionEnvironment }),
      onEvent: (event) => events.push(event),
      provider: {
        async complete(): Promise<ModelResponse> {
          return {
            text: 'done',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 5, outputTokens: 3 },
          };
        },
      },
    });
    const result = await agent.run({ sessionId: session.id, prompt: 'Hi' });
    assert.equal(result.status, 'completed', result.error);
    const forecast = events.find((event) => event.type === 'context.forecast')!.data as {
      inputTokens: number;
      rawInputTokens: number;
    };
    return forecast.inputTokens / forecast.rawInputTokens;
  };
  const catalogue = new ToolRegistry();
  for (let index = 0; index < 40; index++)
    catalogue.register({
      name: `tool_${index}`,
      description: 'A tool with a description long enough to matter. '.repeat(8),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { content: 'ok', isError: false };
      },
    });
  seed();
  const withCatalogue = await correctionOf(catalogue);
  // Re-seeded because the first run observed the endpoint and moved the weights; this test is about the mix.
  seed();
  /**
   * The other side of the same claim: a request whose bytes are mostly the system prompt. `executionEnvironment`
   * is the lever rather than a persona, because it is the one paragraph the kernel lets a host replace wholesale —
   * the point is only that the bytes are in the *system* part of the measurement.
   */
  const withLongPrompt = await correctionOf(
    new ToolRegistry(),
    'Command environment: a confined shell with a read-only snapshot. '.repeat(1_000),
  );
  assert.ok(
    withCatalogue > withLongPrompt * 2,
    `the same correction sizes the two mixes differently (${withCatalogue.toFixed(2)} vs ${withLongPrompt.toFixed(2)})`,
  );
});

test('reported usage corrects the next request and the cache key stays stable', async (t) => {
  const { store, session } = await fixture2(t);
  const requests: ModelRequest[] = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'noop',
    description: 'does nothing',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: 'ok', isError: false };
    },
  });
  let round = 0;
  const agent = new Agent({
    store,
    tools,
    approve: async () => false,
    /**
     * The window has to survive the correction this test is about. The fixed part of every request is already
     * about 3.2K tokens, and the fixture's provider reports four times the local estimate, so the corrected
     * second round costs roughly 9.1K: a 4 000-token window would be exceeded by the correction alone and the
     * run would be refused instead of sent with a smaller allowance. 12 000 is above the corrected estimate and
     * below it plus the 4 096-token cap, which is what makes the two allowances differ.
     */
    maxContextTokens: 12000,
    maxOutputTokens: 4096,
    provider: {
      async complete(request): Promise<ModelResponse> {
        requests.push(request);
        // The provider reports roughly four times the local character estimate, which is
        // the drift the calibration exists to absorb.
        const raw = estimateInputTokens(request.system, request.messages, request.tools);
        const usage = { inputTokens: raw * 4, outputTokens: 3 };
        if (round++ === 0)
          return {
            text: '',
            toolCalls: [{ id: 'call-1', name: 'noop', arguments: {} }],
            finishReason: 'tool_calls',
            usage,
          };
        return { text: 'done', toolCalls: [], finishReason: 'stop', usage };
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Hi' });
  assert.equal(result.status, 'completed');
  assert.equal(requests.length, 2);
  assert.ok(requests[0]!.cacheKey, 'the agent must offer a cache key to the provider');
  assert.equal(requests[0]!.cacheKey, requests[1]!.cacheKey, 'the key is stable across rounds');
  assert.ok(
    requests[1]!.maxOutputTokens < requests[0]!.maxOutputTokens,
    `the corrected estimate must reserve more input budget (${requests[0]!.maxOutputTokens} -> ${requests[1]!.maxOutputTokens})`,
  );
});

test('a route correction sizes the retained tail in the tokens the endpoint bills', async (t) => {
  /**
   * The retention budget is a share of what messages may use, so it is only a size once the messages are measured
   * the way the endpoint will bill them. This is the wiring that proves the correction reaches that decision: the
   * same conversation and the same window, compacted in two sessions, keep a shorter verbatim tail when the
   * session's learned correction says each message costs three times the heuristic's guess.
   *
   * The numbers are the policy's own: a 120 000-token window with a 40 000-token answer reserve leaves 80 000 for
   * messages, 12 800 of which (16%) stay verbatim, and the 65 536-token headroom caps the threshold at 14 464. The
   * seeded conversation is just over that threshold and its turns are small, so the tail the budget lands on is
   * also comfortably under it: one compaction, no convergence pass, and what is counted below is the retention
   * rule rather than a second pass over an already compacted conversation.
   */
  const { store, session } = await fixture(t);
  const seeded = (id: string) => {
    for (let index = 0; index < 44; index++) {
      store.append(id, { role: 'user', content: `turn ${index} ${'x'.repeat(1_000)}` });
      store.append(id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
    }
  };
  /** The verbatim tail the compacted request carries, and how big it measures on its own route. */
  const retainedTail = async (sessionId: string, calibration?: TokenCalibration) => {
    const prepared = await prepareContext({
      store,
      sessionId,
      system: 'You are the fixture.',
      tools: [],
      provider: { complete: async () => reply() },
      limit: 1_000_000,
      signal: new AbortController().signal,
      maxOutputTokens: 40_000,
      maxContextTokens: 120_000,
      summaryTimeoutMs: 5_000,
      ...(calibration ? { calibration } : {}),
      onUsage: () => {},
      onCompaction: () => {},
    });
    return prepared.messages.filter(
      (message) => !message.content.startsWith('<compacted-summary>'),
    );
  };
  const measured = (messages: Message[], factor: number) =>
    messages.reduce((total, message) => total + estimateMessageTokens(message, factor), 0);
  /** The policy's retention budget for this window, and one seeded turn measured on the corrected route. */
  const budget = 12_800;
  const oneTurn = estimateMessageTokens(
    { role: 'user', content: `turn 0 ${'x'.repeat(1_000)}` },
    3,
  );
  seeded(session.id);
  const plain = await retainedTail(session.id);
  const correctedSession = store.create(session.workspace);
  seeded(correctedSession.id);
  const calibration = new TokenCalibration();
  calibration.observe(100, 300);
  assert.equal(calibration.factor, 3, 'the fixture learned a correction of three');
  const corrected = await retainedTail(correctedSession.id, calibration);
  /**
   * The promise "16% of the message budget stays verbatim" is a size, so it is asserted as one on each route:
   * the walk stops at the first message that reaches the budget, so a tail that is the budget's size is at least
   * the budget and less than the budget plus one turn. Sizing the corrected route in the *estimator's* units
   * fails both halves — it keeps a tail several times the budget, and the compaction then reads that tail with the
   * correction, finds the conversation still over the threshold, and compacts again until almost nothing is left.
   */
  for (const [label, tail, factor] of [
    ['uncorrected', plain, 1],
    ['corrected', corrected, 3],
  ] as const) {
    assert.ok(
      measured(tail, factor) >= budget,
      `the ${label} tail reaches the retention budget (${measured(tail, factor)})`,
    );
    assert.ok(
      measured(tail, factor) < budget + oneTurn,
      `the ${label} tail stops at the first turn that reaches it (${measured(tail, factor)})`,
    );
  }
});

test('the cache key changes when the cached prefix changes', async (t) => {
  const { store, session } = await fixture2(t);
  const keys: string[] = [];
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    provider: {
      async complete(request): Promise<ModelResponse> {
        keys.push(request.cacheKey!);
        return {
          text: 'done',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 3 },
        };
      },
    },
  });
  await agent.run({ sessionId: session.id, prompt: 'first' });
  await agent.run({ sessionId: session.id, prompt: 'second' });
  assert.ok(keys[0] && keys[1]);
  assert.equal(keys[0], keys[1], 'the system prompt and tool set did not change');
});
