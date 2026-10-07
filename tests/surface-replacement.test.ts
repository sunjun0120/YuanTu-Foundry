import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { Agent } from '../packages/core/agent.ts';
import { prepareContext } from '../packages/core/context.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { contextTail, surfaceAt } from '../packages/protocol/context.ts';
import { contextMessageSize } from '../packages/protocol/images.ts';
import type { Message, ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';
import { isSummaryRequest } from './summary-request.ts';

// ---- a compaction is a surface replacement recorded in the log ----
//
// What the model is shown used to be a row in `context_checkpoints`, written next to the same compaction's
// `context.compacted` event. Two records of one fact is how they start to disagree, and the row was the one
// readers believed — so the question "what did the model see?" could only be answered by the writer's own
// table, compaction history was overwritten by each new summary, and there was no way to ask what a
// conversation looked like at an earlier compaction. These tests pin the replacement: the op is an ordered,
// permanent event carrying the log positions it covers, the surface is a fold of the log, and a compaction
// that would not shrink the conversation is refused rather than recorded.

const reply = (text = 'Done', inputTokens = 10, outputTokens = 5): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens, outputTokens },
});
async function fixture(t: test.TestContext): Promise<{
  root: string;
  file: string;
  store: SessionStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-surface-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, file, store };
}
/** A compaction runs when the window is too small for the history; the summary is whatever the provider says. */
function compactingAgent(
  store: SessionStore,
  provider: Provider,
  requests?: ModelRequest[],
): Agent {
  return new Agent({
    store,
    provider: {
      async complete(request) {
        requests?.push(request);
        return provider.complete(request);
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    maxContextChars: 100000,
    /**
     * The window has to hold the fixed part of a request — the system prompt and the kernel's run-scoped tool
     * schemas, about 3.2K tokens — plus a batch of the conversation, because a summary request now replays that
     * same fixed part (its own system prompt and the same tool schemas) before the conversation it summarizes.
     * Below that floor no batch fits, the run fails with "an earlier turn is too large to summarize", and these
     * tests are about the surface rather than about that verdict. It still has to be below three turns of
     * `history()` (about 3.3K tokens) plus the fixed part, or nothing would compact at all.
     */
    maxContextTokens: 5600,
    maxOutputTokens: 128,
  });
}
async function history(store: SessionStore, sessionId: string, turns = 3): Promise<void> {
  for (let index = 0; index < turns; index++) {
    // Large enough that a 2 000-token window cannot hold three turns: the scenario has to compact for the
    // tests below to say anything about compaction.
    store.append(sessionId, {
      role: 'user',
      content: `Question ${index}. ` + 'context '.repeat(400),
    });
    store.append(sessionId, { role: 'assistant', content: `Answer ${index}.`, toolCalls: [] });
  }
}

test('a compaction records the log positions it covers, not just a count', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  await history(store, session.id);
  const provider: Provider = {
    async complete() {
      return reply('The user asked three questions about context.');
    },
  };
  const result = await compactingAgent(store, provider).run({
    sessionId: session.id,
    prompt: 'Continue.',
  });
  assert.equal(result.status, 'completed', result.error);
  const op = store.surfaceHistory(session.id).at(-1);
  assert.ok(op, 'the compaction was recorded');
  assert.equal(op.generation, 1);
  // The transcript's own log positions: the range is checked against the messages it claims to replace,
  // which is what a count alone cannot do.
  const messages = store.events(session.id).filter((event) => event.type.startsWith('message.'));
  assert.equal(op.startSeq, messages[0]!.seq);
  assert.equal(op.endSeq, messages[op.coveredMessages - 1]!.seq);
  assert.deepEqual(store.contextSurface(session.id), {
    generation: 1,
    coveredMessages: op.coveredMessages,
    summary: 'The user asked three questions about context.',
  });
});

test('the surface is what a reader derives from the log, in a process that never saw the run', async (t) => {
  const { root, file, store } = await fixture(t);
  const session = store.create(root);
  await history(store, session.id);
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    async complete(request) {
      if (isSummaryRequest(request)) return reply('Merged summary.');
      return reply('Continued.');
    },
  };
  const result = await compactingAgent(store, provider, requests).run({
    sessionId: session.id,
    prompt: 'Continue.',
  });
  assert.equal(result.status, 'completed', result.error);
  /**
   * The round that was sent against the compacted surface: the first request whose *conversation* opens with the
   * persisted summary. It has to be a round rather than a summary request, because the summary request replays
   * the same first message — the prefix has to match, which is the whole reason the summary sits in the
   * conversation — so "the request mentions the summary" alone would pick up the second summary batch.
   */
  const sent = requests.find(
    (request) =>
      !isSummaryRequest(request) && JSON.stringify(request.messages).includes('Merged summary.'),
  )!;
  assert.ok(sent, 'the compacted round was sent');
  // A second process opening the same file has the log and nothing else: no cached run state, no table.
  const reopened = new SessionStore(file);
  try {
    const surface = reopened.contextSurface(session.id);
    assert.ok(surface, 'the reopened store derives the surface');
    assert.match(JSON.stringify(sent.messages), new RegExp(surface.summary));
    assert.doesNotMatch(
      sent.system,
      /<compacted-summary>|<conversation_summary>/,
      "the prompt is the caller's own: the summary is a message, not a section of it",
    );
    const tail = contextTail(reopened.messages(session.id), surface.coveredMessages);
    const [snapshot, ...round] = sent.messages;
    assert.match(
      (snapshot!.content as string) ?? '',
      /^<compacted-summary>/,
      'the first message is the snapshot the surface derives',
    );
    assert.deepEqual(
      round,
      tail.slice(0, round.length),
      'the messages the model was shown are the tail the log derives',
    );
    assert.ok(
      reopened.messages(session.id).length > sent.messages.length,
      'and the log kept the turns the surface does not show',
    );
  } finally {
    reopened.close();
  }
});

test('each compaction is its own generation, and an earlier one can still be read', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  await history(store, session.id);
  // A first compaction by hand, then a real one: the second summary merges with the first, and both stay
  // readable. This is what "comparable and branchable" means — the history is a list, not a latest value.
  store.applyCompaction(session.id, { coveredMessages: 2, summary: 'First summary.' });
  await history(store, session.id, 2);
  const result = await compactingAgent(store, {
    async complete() {
      return reply('Second summary, merged with the first.');
    },
  }).run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  const ops = store.surfaceHistory(session.id);
  assert.equal(ops.length, 2);
  assert.deepEqual(
    ops.map((op) => op.generation),
    [1, 2],
  );
  assert.equal(ops[0]!.summary, 'First summary.');
  assert.match(ops[1]!.summary, /Second summary/);
  assert.equal(store.contextSurface(session.id)!.generation, 2);
  // A branch from the first generation sees the first summary with the messages it did not cover.
  assert.deepEqual(surfaceAt(ops, 1), {
    generation: 1,
    coveredMessages: 2,
    summary: 'First summary.',
  });
  assert.equal(surfaceAt(ops, 9), null, 'a generation that never happened has no surface');
});

test('the price of the trade is recorded, and a summary that would not shrink it is refused', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  // Four large messages followed by two small ones: covering the large half is a real saving, which is what
  // a compaction is supposed to be.
  for (let index = 0; index < 2; index++) {
    store.append(session.id, { role: 'user', content: `Big ${index}. ` + 'x'.repeat(4000) });
    store.append(session.id, { role: 'assistant', content: `Big answer ${index}.`, toolCalls: [] });
  }
  store.append(session.id, { role: 'user', content: 'Small.' });
  store.append(session.id, { role: 'assistant', content: 'Small answer.', toolCalls: [] });
  const messages = store.messages(session.id);
  const replaced = contextMessageSize(messages.slice(0, 4));
  store.applyCompaction(session.id, {
    coveredMessages: 4,
    summary: 'Short.',
    replacedChars: replaced,
    surfaceChars: 'Short.'.length + contextMessageSize(messages.slice(4)),
  });
  const op = store.surfaceHistory(session.id)[0]!;
  assert.equal(op.replacedChars, replaced);
  assert.ok(op.surfaceChars! < op.replacedChars!);
  // A summary larger than what it replaces is not a compaction: the caller keeps the history instead.
  assert.throws(
    () =>
      store.applyCompaction(session.id, {
        coveredMessages: 6,
        summary: 'x'.repeat(replaced + 1000),
        replacedChars: replaced,
        surfaceChars: replaced + 1000,
      }),
    /would not shrink/,
  );
  assert.equal(store.surfaceHistory(session.id).length, 1, 'the refused op was not recorded');
});

test('a compaction whose range no longer matches the transcript is refused, not guessed at', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  await history(store, session.id, 2);
  const messages = store.events(session.id).filter((event) => event.type.startsWith('message.'));
  // A record claiming to replace a different range than the one its count covers. The log is append-only, so
  // this can only come from a damaged or tampered-with record — and deriving a surface from it would show the
  // model a conversation nobody recorded.
  store.recordEvent(session.id, 'context.compacted', {
    coveredMessages: 2,
    startSeq: messages[2]!.seq,
    endSeq: messages[3]!.seq,
    summary: 'Wrong range.',
  });
  assert.throws(() => store.contextSurface(session.id), /do not describe the same conversation/);
  // A count larger than the transcript is the other half of the same check, in a session of its own so that
  // the first bad record does not answer for it.
  const other = store.create(root);
  await history(store, other.id, 1);
  store.recordEvent(other.id, 'context.compacted', {
    coveredMessages: 8,
    summary: 'Too much.',
  });
  assert.throws(() => store.surfaceHistory(other.id), /only has/);
});

test('a compaction written by an older build is still a surface, with its range derived', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  await history(store, session.id, 2);
  const messages = store.events(session.id).filter((event) => event.type.startsWith('message.'));
  // The v17 shape: a count and a summary, no positions and no price. It has to keep working, because that is
  // what every existing session's log holds.
  store.recordEvent(session.id, 'context.compacted', {
    coveredMessages: 2,
    summary: 'Legacy summary.',
    usage: { inputTokens: 7, outputTokens: 3 },
  });
  assert.deepEqual(store.contextSurface(session.id), {
    generation: 1,
    coveredMessages: 2,
    summary: 'Legacy summary.',
  });
  const op = store.surfaceHistory(session.id)[0]!;
  assert.equal(
    op.startSeq,
    messages[0]!.seq,
    'the range is derived from the log when it was not recorded',
  );
  assert.equal(op.endSeq, messages[1]!.seq);
  assert.deepEqual(op.usage, { inputTokens: 7, outputTokens: 3 });
});

test('schema v18 drops the checkpoint table and carries a row that had no event', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-surface-migrate-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = { current: undefined as SessionStore | undefined };
  // One hook on purpose: the database has to be closed before its directory can be removed, and hooks run in
  // the order they were registered.
  t.after(async () => {
    store.current?.close();
    await rm(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  // A v17 database as a build of that era wrote it: messages and their log events, plus a checkpoint row.
  // The row is the only record of this summary — the case the migration has to preserve.
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA user_version=17;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '');
    CREATE TABLE session_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX session_events_session ON session_events(session_id,seq);
    CREATE TABLE context_checkpoints(session_id TEXT PRIMARY KEY, covered_messages INTEGER NOT NULL, summary TEXT NOT NULL, usage TEXT);
  `);
  legacy
    .prepare('INSERT INTO sessions(id,workspace,created_at) VALUES(?,?,?)')
    .run('old', root, now);
  const body = [
    JSON.stringify({ role: 'user', content: 'legacy question' }),
    JSON.stringify({ role: 'assistant', content: 'legacy answer', toolCalls: [] }),
  ];
  const event = legacy.prepare(
    'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
  );
  body.forEach((message, index) => {
    legacy
      .prepare('INSERT INTO messages(session_id,body,search_text) VALUES(?,?,?)')
      .run('old', message, '');
    event.run(
      'old',
      index === 0 ? 'message.user' : 'message.assistant',
      JSON.stringify({ message: JSON.parse(message) }),
      now,
    );
  });
  legacy
    .prepare(
      'INSERT INTO context_checkpoints(session_id,covered_messages,summary,usage) VALUES(?,?,?,?)',
    )
    .run('old', 2, 'Summary from the table.', JSON.stringify({ inputTokens: 11, outputTokens: 4 }));
  legacy.close();

  const opened = new SessionStore(file);
  store.current = opened;
  const op = opened.surfaceHistory('old')[0]!;
  assert.equal(
    op.summary,
    'Summary from the table.',
    'the row became the surface it should have had',
  );
  assert.equal(op.coveredMessages, 2);
  assert.deepEqual(op.usage, { inputTokens: 11, outputTokens: 4 }, 'and it kept what it cost');
  assert.deepEqual(opened.contextSurface('old'), {
    generation: 1,
    coveredMessages: 2,
    summary: 'Summary from the table.',
  });
  assert.equal(
    opened.messages('old').length,
    2,
    'carrying the row over did not change the transcript',
  );
  const schema = new DatabaseSync(file);
  try {
    assert.equal(
      schema
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_checkpoints'")
        .get(),
      undefined,
    );
  } finally {
    schema.close();
  }
});

test('a compaction that would not shrink the conversation is refused and records nothing', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  await history(store, session.id, 1);
  const before = store.messages(session.id);
  // Forced, so the run compacts whether or not the window demands it, and a summary as large as the history
  // it is meant to replace: the run has to keep the conversation rather than record a replacement that made
  // it bigger.
  await assert.rejects(
    prepareContext({
      store,
      sessionId: session.id,
      system: 'YuanTu',
      tools: [],
      limit: 100000,
      signal: new AbortController().signal,
      maxOutputTokens: 128,
      // A window large enough that the huge summary still fits: the refusal being tested is the price of the
      // trade, not the size of the window.
      maxContextTokens: 200000,
      summaryTimeoutMs: 1000,
      provider: {
        async complete(request) {
          if (isSummaryRequest(request)) return reply('y'.repeat(20000), 10, 4000);
          return reply('Continued.');
        },
      },
      onUsage: () => {},
      onCompaction: () => {},
      forceCompact: true,
    }),
    /did not shrink/,
  );
  assert.equal(store.contextSurface(session.id), null, 'nothing was recorded');
  assert.deepEqual(
    store.messages(session.id).slice(0, before.length),
    before,
    'the history is exactly what it was',
  );
});

test('a surface op is a durable event, readable as such', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  const messages: Message[] = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two', toolCalls: [] },
  ];
  for (const message of messages) store.append(session.id, message);
  store.applyCompaction(session.id, { coveredMessages: 2, summary: 'everything so far' });
  const recorded = store.events(session.id).filter((event) => event.type === 'context.compacted');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]!.data, {
    coveredMessages: 2,
    startSeq: store.events(session.id)[0]!.seq,
    endSeq: store.events(session.id)[1]!.seq,
    summary: 'everything so far',
  });
});
