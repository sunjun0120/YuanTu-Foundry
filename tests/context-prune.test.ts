/**
 * Dropping the middle of an oversized tool result.
 *
 * This pass writes nothing and asks the model nothing, so what has to hold is not "does it save context" but
 * three properties that make it safe to run unattended: one pass lands *inside* the budget rather than near it,
 * the results the model is still reading are never touched, and what the model is handed says the middle is
 * missing instead of letting it reason from a premise that is no longer true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import {
  PRUNE_MARK,
  assertPrunePolicy,
  codePointLength,
  pruneContent,
  pruneMessages,
  protectedBoundary,
  worthPruning,
} from '../packages/core/prune.ts';
import { recentStart } from '../packages/core/shrink.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { SPILL_DIRECTORY } from '../packages/tools/spill.ts';
import type { Message, ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';

/** The shipped policy, restated so a change to the defaults has to be a deliberate change to a test as well. */
const POLICY = { thresholdChars: 32_000, headChars: 12_000, tailChars: 4_000 } as const;
const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const useTool = (id: string, tag: string): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name: 'noisy', arguments: { tag } }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolResult = (id: string, content: string): Message => ({
  role: 'tool',
  toolCallId: id,
  content,
  isError: false,
});
const call = (id: string): Message => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name: 'noisy', arguments: {} }],
});
const body = (messages: readonly Message[]): string =>
  messages.map((message) => ('content' in message ? message.content : '')).join('\n');
/**
 * A conversation with one old result and one the tools just produced.
 *
 * The second batch is what makes these cases about pruning rather than about the protection rules: a fixture
 * whose only result is also its newest one would pass whether or not the rules worked.
 */
const withOldResult = (content: string): Message[] => [
  { role: 'user', content: 'go' },
  call('a'),
  toolResult('a', content),
  call('b'),
  toolResult('b', 'fresh result'),
];

test('the head, the marker and the tail together fit the budget', () => {
  const policy = { thresholdChars: 1_000, headChars: 400, tailChars: 200 };
  assert.doesNotThrow(() => {
    assertPrunePolicy(policy);
  });
  // The invariant is the whole claim: one pass leaves the result *within* the threshold, for every content,
  // rather than for the contents someone happened to try.
  for (const size of [1_001, 5_000, 200_000]) {
    const pruned = pruneContent('x'.repeat(size), policy);
    assert.ok(pruned !== null, `${size} characters should prune`);
    assert.ok(
      codePointLength(pruned) <= policy.thresholdChars,
      `${size} characters pruned to ${codePointLength(pruned)}, over the ${policy.thresholdChars} budget`,
    );
    assert.ok(codePointLength(pruned) < size, 'pruning always makes the result smaller');
  }
  // A policy whose own marker cannot fit between its head and its tail is refused where it is resolved: it would
  // prune a result back over the budget and prune it again on the next round.
  assert.throws(() => {
    assertPrunePolicy({ thresholdChars: 500, headChars: 400, tailChars: 200 });
  }, /does not fit its 500-character threshold/);
});

test('a result within budget is left exactly as it was', () => {
  const content = 'y'.repeat(POLICY.thresholdChars);
  assert.equal(worthPruning(content, POLICY), false);
  assert.equal(pruneContent(content, POLICY), null);
  const outcome = pruneMessages(withOldResult(content), POLICY, 0);
  assert.equal(outcome.pruned, 0);
  assert.equal(outcome.prunedChars, 0);
  assert.deepEqual(outcome.messages, withOldResult(content));
});

test('pruning is idempotent: a marker is not something to cut around', () => {
  const once = pruneContent('z'.repeat(100_000), POLICY);
  assert.ok(once !== null && once.includes(PRUNE_MARK));
  // Already pruned, and now well inside the budget — but even a pruned result that somehow exceeded it again
  // must not be cut a second time, or every round would widen the gap.
  assert.equal(worthPruning(once, POLICY), false);
  assert.equal(pruneContent(once, POLICY), null);
  assert.equal(pruneMessages(withOldResult(once), POLICY, 0).pruned, 0);
});

test('the head and the tail are the parts that survive', () => {
  const content = `HEAD${'m'.repeat(40_000)}TAIL`;
  const pruned = pruneContent(content, POLICY);
  assert.ok(pruned !== null);
  assert.ok(pruned.startsWith('HEAD'), 'the beginning of the result is kept');
  assert.ok(pruned.endsWith('TAIL'), 'the end of the result is kept');
  assert.ok(pruned.includes(PRUNE_MARK));
  // The middle is gone: what survives is the head and the tail, and nothing between them but the notice.
  assert.ok(!pruned.includes('m'.repeat(13_000)), 'the middle is gone');
  // The notice is model-visible, so it has to say what happened rather than only that something did.
  assert.match(pruned, /characters removed to keep this conversation within budget/);
});

test('the newest results and the batch the tools just produced are never touched', () => {
  const messages: Message[] = [
    { role: 'user', content: 'go' },
    call('a'),
    toolResult('a', 'A'.repeat(50_000)),
    call('b'),
    toolResult('b', 'B'.repeat(50_000)),
    { role: 'assistant', content: 'thinking', toolCalls: [] },
    { role: 'user', content: 'continue' },
    call('c'),
    toolResult('c', 'C'.repeat(50_000)),
  ];
  const prunedIds = (outcome: { messages: Message[] }) =>
    outcome.messages.map((message) =>
      message.role === 'tool' && message.content.includes(PRUNE_MARK) ? message.toolCallId : '',
    );
  // `keepRecent: 0` protects nothing by count, so this is the structural rule alone: `c` is the batch the tools
  // produced for the request about to be sent, and the model has not read it once.
  assert.deepEqual(prunedIds(pruneMessages(messages, POLICY, 0)), [
    '',
    '',
    'a',
    '',
    'b',
    '',
    '',
    '',
    '',
  ]);
  // A count larger than the number of results protects all of them.
  assert.equal(pruneMessages(messages, POLICY, 6).pruned, 0);
  // And a count smaller than what exists protects exactly that many, across batches rather than within one.
  // Two results are protected here: the newest by count, and the batch the last call produced.
  assert.deepEqual(prunedIds(pruneMessages(messages, POLICY, 2)), [
    '',
    '',
    'a',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
});

test('the two passes agree about which results are recent', () => {
  const messages: Message[] = [
    { role: 'user', content: 'go' },
    call('a'),
    toolResult('a', 'A'.repeat(50_000)),
    call('b'),
    toolResult('b', 'B'.repeat(50_000)),
    { role: 'assistant', content: 'thinking', toolCalls: [] },
    { role: 'user', content: 'continue' },
    call('c'),
    toolResult('c', 'C'.repeat(50_000)),
  ];
  // `protectedBoundary` is the shared rule; shortening's `recentStart` is the half of it that counts results.
  // Two statements of "which results is the model still reading" would be two answers to one question.
  for (const keep of [0, 1, 2, 6]) {
    assert.equal(protectedBoundary(messages, keep), Math.min(8, recentStart(messages, keep)));
  }
});

test('a cut never splits a surrogate pair', () => {
  // Every character here is outside the basic plane, so a UTF-16 count would place the cut on a lone half.
  const content = '\u{1F600}'.repeat(50_000);
  const pruned = pruneContent(content, POLICY);
  assert.ok(pruned !== null);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(pruned), 'no unpaired high surrogate');
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(pruned), 'no unpaired low surrogate');
  assert.ok(
    codePointLength(pruned) <= POLICY.thresholdChars,
    'the count is code points, so the budget means the same thing in every script',
  );
});

test('an oversized result loses its middle for the model while the transcript keeps every character', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-prune-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const tools = new ToolRegistry();
  const text = (tag: string) => `${tag}${tag.repeat(60_000)}`;
  tools.register({
    name: 'noisy',
    description: 'Produces a very long result',
    inputSchema: { type: 'object', properties: { tag: { type: 'string' } } },
    async execute(input) {
      return { isError: false, content: text(String(input.tag)) };
    },
  });
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    async complete(request) {
      requests.push(request);
      // A, then B, then C: each round runs one tool, so by the third request the first result is old.
      const tag = ['A', 'B', 'C'][requests.length - 1];
      return tag ? useTool(`call-${tag}`, tag) : reply();
    },
  };
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (event) => events.push({ type: event.type, data: event.data }),
    maxContextTokens: 20_000,
    // Prune in good time, the same way the shortening tests do: doing it under pressure is the case that
    // already fails the budget check.
    contextShrinkPercent: 10,
    // Only the newest result is protected by count; the structural rule protects the current batch anyway.
    toolResultKeepRecent: 1,
    /**
     * Shortening is asked for a budget it can never be worth meeting, which is what puts this case on the
     * pruning pass: a result has to cost more than *twice* the budget to be worth shortening, so a 20,000-token
     * budget excludes every result a 24,000-character bound can produce. The two seams then disagree on purpose
     * — shortening declines everything, and pruning is the only thing left that can make the conversation fit.
     */
    toolResultShrinkTokens: 20_000,
    // Below the 24,000-character bound every result is produced with, which is the range in which this pass can
    // fire at all. The shipped defaults sit below it for the same reason.
    toolResultPruneThresholdChars: 10_000,
    toolResultPruneHeadChars: 6_000,
    toolResultPruneTailChars: 2_000,
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Inspect the noisy tool' });
  assert.equal(result.status, 'completed', result.error);

  const prunedRounds = events
    .filter((event) => event.type === 'context.forecast')
    .filter((event) => Number(event.data.pruned) > 0);
  assert.ok(prunedRounds.length >= 1, 'a round reported pruning a result');
  const prunedChars = prunedRounds.reduce(
    (total, event) => total + Number(event.data.prunedChars),
    0,
  );
  assert.ok(prunedChars > 10_000, `pruning freed characters: ${prunedChars}`);
  assert.equal(
    events
      .filter((event) => event.type === 'context.forecast')
      .reduce((total, event) => total + Number(event.data.shortened), 0),
    0,
    'shortening declined every result, so pruning is what carried the round',
  );
  /**
   * The round that pruned, as the model saw it.
   *
   * Not simply the last request: a round the estimate says does not fit still gets compressed, and the summary
   * request that follows carries the *shadowed* batch rather than the conversation the run is sending. And not
   * `requests[round]` either — the forecast is emitted while preparing round N, which the batch the previous
   * round asked for has already preceded by one request.
   */
  const prunedRound = Number(prunedRounds[0]!.data.round);
  const request = requests[Math.min(prunedRound + 1, requests.length - 1)]!;
  const visible = body(request.messages);
  assert.ok(visible.includes(PRUNE_MARK), 'the model is shown a result with its middle removed');
  assert.match(visible, /A{20}/, 'its beginning is still there');
  /**
   * The newest result is untouched. Asserted by its head rather than its whole text: `text('C')` is 60,001
   * characters and no tool result is ever that long — the registry bounds every result at 24,000 and appends a
   * truncation marker, so a containment check on the fixture's own string would fail against an intact result.
   */
  assert.ok(visible.includes('CCC'), 'the newest result is intact');

  /**
   * The record on disk is untouched: the transcript is the source of truth, the view is a projection of it.
   *
   * Asserted as "nothing was pruned" rather than as an exact length or against the tool's own 60,001-character
   * string: the registry already bounded each result and spilled the overflow, so what reaches the log is the
   * capture plus a notice naming the file. What this case owns is the narrower claim that pruning added nothing
   * to it — the stored results are exactly what the tool stage wrote.
   */
  const stored = store.messages(session.id).filter((message) => message.role === 'tool');
  assert.equal(stored.length, 3);
  for (const message of stored) {
    assert.ok(message.role === 'tool');
    assert.ok(!message.content.includes(PRUNE_MARK), 'no stored result was pruned');
    assert.ok(
      message.content.length > 24_000,
      `the capture is whole: ${message.content.length} characters`,
    );
  }
  /**
   * Nothing was written anywhere: this pass trades the text for a marker, not for a pointer.
   *
   * The spill files that are here belong to the *tool* stage, which captures an over-bound result where it is
   * produced — one per result, each holding the tool's whole output. The claim this case owns is that pruning
   * added no file of its own, so the count is exactly the number of results and the capture is still whole
   * rather than a pruned projection.
   */
  const { readdir, readFile: read, stat } = await import('node:fs/promises');
  const spilled = await readdir(path.join(root, SPILL_DIRECTORY, session.id));
  assert.equal(spilled.length, 3, 'one capture per tool result, and none written by pruning');
  for (const name of spilled) {
    const file = path.join(root, SPILL_DIRECTORY, session.id, name);
    assert.equal(
      (await stat(file)).size,
      text('A').length,
      'the capture is the tool output, whole',
    );
    assert.ok(
      !(await read(file, 'utf8')).includes(PRUNE_MARK),
      'nothing pruned was written to disk',
    );
  }

  // Pruning does not turn into compression: the conversation still fits.
  assert.ok(!events.some((event) => event.type === 'context.compacted'));
});

test('a conversation that is nowhere near the window is left alone', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-prune-early-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const tools = new ToolRegistry();
  tools.register({
    name: 'noisy',
    description: 'Produces a long result',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: 'A'.repeat(30_000) };
    },
  });
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    async complete(request) {
      requests.push(request);
      return requests.length === 1 ? useTool('call-1', 'A') : reply();
    },
  };
  // Defaults, including the shipped 32,000-character threshold: two 30,000-character results are under it, and
  // a window wide enough that neither the fit check nor the pressure share asks for anything to be done.
  const agent = new Agent({ store, provider, tools, approve: async () => true });
  const result = await agent.run({ sessionId: session.id, prompt: 'Inspect' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(!body(requests.at(-1)!.messages).includes(PRUNE_MARK));
});
