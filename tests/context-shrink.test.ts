/**
 * Shortening old tool results the model can still see.
 *
 * A tool result is bounded when it is produced, but it is replayed in every later request for the rest of the
 * session. These tests are about the two things that make shortening safe rather than merely cheap: the
 * transcript keeps every character, and the model is told — in the result itself — that it is reading a
 * shortened view, with a path it can actually open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SHRINK_MARK, shortenMessages } from '../packages/core/shrink.ts';
import { estimateMessageTokens } from '../packages/core/budget.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { SPILL_DIRECTORY, spillResult } from '../packages/tools/spill.ts';
import type { Message, ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';

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
 * A conversation with one old result and one that the tools just produced.
 *
 * The second batch matters: the newest results are structurally protected, so a fixture whose only result is
 * also its newest one would test the protection instead of the shortening.
 */
const withOldResult = (content: string): Message[] => [
  { role: 'user', content: 'go' },
  call('a'),
  toolResult('a', content),
  call('b'),
  toolResult('b', 'fresh result'),
];
/** Every spill file this session wrote, which is how the tests check that nothing is duplicated. */
async function spillFiles(root: string, sessionId: string): Promise<string[]> {
  return readdir(path.join(root, SPILL_DIRECTORY, sessionId)).catch(() => []);
}
/**
 * The seam's `measure`, as these cases use it: characters.
 *
 * It keeps every assertion below about *where* the cut lands, in the unit the old shape used, so the cases that
 * are not about the unit do not have to be rewritten around it. `measure` is the seam's whole purpose: production
 * passes the round's calibrated estimate, and the case at the end of this file is where the token budget itself
 * is what is being tested.
 */
const measure = (text: string): number => text.length;
/** `shortenMessages` with that measure already supplied. */
function shorten(
  ...args: [
    Parameters<typeof shortenMessages>[0],
    Parameters<typeof shortenMessages>[1],
    Parameters<typeof shortenMessages>[2],
  ]
): ReturnType<typeof shortenMessages> {
  return shortenMessages(...args, measure);
}

test('the newest results are the ones that stay intact', () => {
  const messages: Message[] = [
    { role: 'user', content: 'go' },
    call('a'),
    toolResult('a', 'A'.repeat(5000)),
    call('b'),
    toolResult('b', 'B'.repeat(5000)),
    { role: 'assistant', content: 'thinking', toolCalls: [] },
    { role: 'user', content: 'continue' },
    call('c'),
    toolResult('c', 'C'.repeat(5000)),
  ];
  const shortenedFlags = (outcome: { messages: Message[] }) =>
    outcome.messages.map((message) =>
      message.role === 'tool' && message.content.includes(SHRINK_MARK) ? message.toolCallId : '',
    );
  const notifier = () => ({ path: 'full.txt', bytes: 1, lines: 1 });
  // `keepRecent: 0` protects nothing by count, so this is about the structural rule alone: `c` is the batch the
  // tools produced for the request that is about to be sent, and the model has not read it once.
  const structural = shorten(messages, { keepRecent: 0, tokens: 1000 }, notifier);
  assert.deepEqual(shortenedFlags(structural), ['', '', 'a', '', 'b', '', '', '', '']);
  assert.equal(structural.shortened, 2);
  assert.ok(structural.freedChars > 7000);

  // A count larger than the number of results protects all of them: "the newest six stay whole" cannot mean
  // "the newest six, or whatever happens to exist, minus the ones we felt like cutting".
  assert.equal(shorten(messages, { keepRecent: 6, tokens: 1000 }, notifier).shortened, 0);

  // And a count smaller than what exists protects exactly that many, across batches rather than within one.
  assert.deepEqual(shortenedFlags(shorten(messages, { keepRecent: 2, tokens: 1000 }, notifier)), [
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

test('a result that is already a shortened view is left alone', () => {
  const shortened = `head${SHRINK_MARK} 4000 of 5000 characters removed]tail`;
  const outcome = shorten(withOldResult(shortened), { keepRecent: 0, tokens: 100 }, () => {
    throw new Error('an already shortened result must not be spilled again');
  });
  assert.equal(outcome.shortened, 0);
  const message = outcome.messages[2]!;
  assert.equal(message.role === 'tool' ? message.content : '', shortened);
});

test('shortening keeps both ends and says how much it took, or does nothing at all', () => {
  const content = `HEAD${'m'.repeat(8000)}TAIL`;
  const removed = content.length - 1000;
  const seen: string[] = [];
  const outcome = shorten(
    withOldResult(content),
    { keepRecent: 0, tokens: 1000 },
    ({ content: full }) => {
      seen.push(full);
      return { path: '.yuantu/spill/s/full.txt', bytes: full.length, lines: 3 };
    },
  );
  const old = outcome.messages[2]!;
  const shortened = old.role === 'tool' ? old.content : '';
  assert.ok(shortened.startsWith('HEAD'), 'the beginning survives');
  assert.ok(shortened.endsWith('TAIL'), 'the end survives, because that is where a log concludes');
  assert.ok(
    shortened.includes(`${SHRINK_MARK} ${removed} of ${content.length} characters removed`),
    shortened.slice(0, 200),
  );
  assert.match(shortened, /\.yuantu\/spill\/s\/full\.txt/);
  assert.match(shortened, /read_file/);
  assert.deepEqual(seen, [content], 'the spill gets the whole text, not the shortened view');

  // A result too small to be worth cutting is left alone: shortening it would cost a notice to save nothing.
  const small = shorten(withOldResult('x'.repeat(1500)), { keepRecent: 0, tokens: 1000 }, () => ({
    path: 'p',
    bytes: 1,
    lines: 1,
  }));
  assert.equal(small.shortened, 0);
  const untouched = small.messages[2]!;
  assert.equal(untouched.role === 'tool' ? untouched.content.length : 0, 1500);
});

test('a result with nowhere to put its full text is not shortened', () => {
  const outcome = shorten(
    withOldResult('A'.repeat(9000)),
    { keepRecent: 0, tokens: 1000 },
    () => null,
  );
  assert.equal(outcome.shortened, 0, 'a pointer to nowhere is worse than a long result');
  assert.equal(outcome.freedChars, 0);
  const throwing = shorten(withOldResult('A'.repeat(9000)), { keepRecent: 0, tokens: 1000 }, () => {
    throw new Error('disk full');
  });
  assert.equal(throwing.shortened, 0, 'a failed spill must not fail the projection');
});

test('the budget is tokens, so the same budget costs the same in any script', () => {
  /**
   * The unit the old shape used was characters, and characters are not the same amount of context in every script:
   * at 1,200 characters an English result costs roughly 400 tokens and a Chinese one roughly 1,200, so the policy
   * spent three times as much on one conversation as on another without anybody choosing that. The budget is now
   * stated in the unit the window is measured in, and this is the claim that rests on — priced with the estimator
   * production passes in, on the two scripts that bracket the density range.
   *
   * The notice is part of what is kept, so the kept cost is the budget plus a notice rather than exactly the
   * budget; what matters is that the two scripts land in the same place.
   */
  const price = (text: string): number =>
    estimateMessageTokens({ role: 'tool', toolCallId: '', content: text, isError: false });
  const notifier = () => ({ path: 'full.txt', bytes: 1, lines: 1 });
  const kept = (content: string): { tokens: number; characters: number } => {
    const outcome = shortenMessages(
      withOldResult(content),
      { keepRecent: 0, tokens: 400 },
      notifier,
      price,
    );
    const message = outcome.messages[2]!;
    const text = message.role === 'tool' ? message.content : '';
    return { tokens: price(text), characters: text.length };
  };
  const english = kept('word '.repeat(4000));
  const chinese = kept('上下文内容'.repeat(1500));
  assert.ok(
    Math.abs(english.tokens - chinese.tokens) <= 80,
    `the same budget has to cost the same: English kept ${english.tokens} tokens, Chinese ${chinese.tokens}`,
  );
  // The character counts differ by roughly the density ratio, which is exactly what a character budget could not
  // express: 400 tokens is a few thousand English characters and a few hundred Chinese ones.
  assert.ok(
    english.characters > chinese.characters * 2,
    `English kept ${english.characters} characters, Chinese ${chinese.characters}`,
  );
  assert.ok(
    english.characters > 1000 && english.characters < 1600,
    `about three characters per token: ${english.characters}`,
  );
});

test('the same result always lands in the same file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-shrink-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const first = spillResult({
    workspace: root,
    sessionId: 's1',
    key: 'call-a',
    content: 'A'.repeat(100),
  });
  const again = spillResult({
    workspace: root,
    sessionId: 's1',
    key: 'call-a',
    content: 'A'.repeat(100),
  });
  const other = spillResult({
    workspace: root,
    sessionId: 's1',
    key: 'call-b',
    content: 'B'.repeat(100),
  });
  assert.ok(first && again && other);
  assert.equal(first.path, again.path, 'the path is derived from the result, not from the clock');
  assert.notEqual(first.path, other.path);
  assert.equal(await readFile(path.join(root, first.path), 'utf8'), 'A'.repeat(100));
  assert.deepEqual(
    (await spillFiles(root, 's1')).length,
    2,
    'projecting the same result twice writes one file',
  );
});

test('a long result is shortened for the model while the transcript keeps every character', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-shrink-agent-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const tools = new ToolRegistry();
  const text = (tag: string) => `${tag}${tag.repeat(6000)}`;
  tools.register({
    name: 'noisy',
    description: 'Produces a long result',
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
    maxContextTokens: 30_000,
    // Shorten well before the window is full: that is the point of doing it in good time.
    contextShrinkPercent: 10,
    // Only the newest result is protected by count here; the structural rule protects the current batch anyway.
    toolResultKeepRecent: 1,
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Inspect the noisy tool' });
  assert.equal(result.status, 'completed', result.error);

  const last = requests.at(-1)!;
  const visible = body(last.messages);
  assert.ok(visible.includes(SHRINK_MARK), 'the model is shown a shortened view');
  assert.ok(visible.includes(text('C')), 'the newest result is intact');
  assert.ok(!visible.includes(text('A')), 'the oldest is not replayed in full');
  assert.match(visible, /A{20}/, 'its beginning is still there');

  // The record on disk is untouched: the transcript is the source of truth, the view is a projection of it.
  const stored = store.messages(session.id).filter((message) => message.role === 'tool');
  assert.deepEqual(
    stored.map((message) => (message.role === 'tool' ? message.content : '')),
    [text('A'), text('B'), text('C')],
    'every stored result is still complete',
  );
  // And the shortened text says where it went, in a file that is really there.
  const named = /the full text is in (\S+) —/.exec(visible)?.[1];
  assert.ok(named, `the notice names the file: ${visible.slice(0, 400)}`);
  assert.equal(await readFile(path.join(root, named), 'utf8'), text('A'));

  const forecasts = events.filter((event) => event.type === 'context.forecast');
  const shortened = forecasts.reduce((total, event) => total + Number(event.data.shortened), 0);
  assert.ok(shortened >= 1, 'the round that shortened a result said so');
  // Two shortened results (A and B) and exactly two files: A was projected in two different rounds and landed
  // in the same file both times, which is what keeps the pointer in the model's view stable.
  assert.equal((await spillFiles(root, session.id)).length, 2);
  // Shortening does not turn into compression: the conversation still fits.
  assert.ok(!events.some((event) => event.type === 'context.compacted'));
});

test('a conversation that is nowhere near the window is left alone', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-shrink-early-'));
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
      return { isError: false, content: 'A'.repeat(6000) };
    },
  });
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    async complete(request) {
      requests.push(request);
      return requests.length === 1 ? useTool('call-1', 'A') : reply();
    },
  };
  // Everything is default here: a window wide enough that two 6,000-character results are nowhere near the
  // share at which shortening starts. Doing it anyway would change the conversation the model is reading for
  // no reason, and invalidate the cached prefix with it.
  const agent = new Agent({ store, provider, tools, approve: async () => true });
  const result = await agent.run({ sessionId: session.id, prompt: 'Inspect' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(!body(requests.at(-1)!.messages).includes(SHRINK_MARK));
  assert.equal((await spillFiles(root, session.id)).length, 0);
});
