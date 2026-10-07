/**
 * The live stream's cursor: every frame says where the log stands, and the log can be read from there.
 *
 * The live channel used to have no position at all. A client could receive frames and still be unable to say
 * what it had seen, so a dropped or missed frame was invisible and unrecoverable: the only safe response to any
 * interruption was to read the whole session again — and on a carrier that owns its Host, to restart the
 * process. Two properties fix that, and they are the two this file pins: every frame carries the session's
 * durable cursor at the moment it was emitted (`AgentEvent.seq`, and it is the *log's* number, not a second
 * numbering), and the log can be replayed from a cursor (`session.events`), so "what did I miss?" is answerable
 * and the answer is exact.
 *
 * The last test is the one that matters operationally: a client whose stream never delivered a fact can find
 * out that it is behind — and catch up — without the Host being restarted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry, HookRegistry } from '../packages/tools/registry.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import { connectClient, listeningHost } from './listening-host-fixture.ts';
import type { AgentEvent, ModelResponse, Provider } from '../packages/protocol/index.ts';

const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});

async function fixture(t: test.TestContext, provider: Provider) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cursor-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(new HookRegistry()),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  return { root, store, session, agent, events };
}

test('every live frame carries the log position it is ordered against', async (t) => {
  let turn = 0;
  const { agent, store, session, events } = await fixture(t, {
    async complete() {
      // One tool call that needs an approval, then an ordinary answer: the run writes durable facts, and each
      // one is announced, so the frames can be checked against the log they claim to be ordered against.
      return turn++ === 0
        ? {
            text: '',
            finishReason: 'tool_calls' as const,
            toolCalls: [
              { id: 'write-1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } },
            ],
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        : reply('wrote it');
    },
  });
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'write a file' })).status,
    'completed',
  );

  assert.ok(events.length > 5, 'the run emitted frames');
  for (const event of events)
    assert.ok(
      Number.isSafeInteger(event.seq) && event.seq > 0,
      `${event.type} carried no usable cursor: ${String(event.seq)}`,
    );
  // Non-decreasing, because a frame is stamped with the log's high-water mark at the moment it is emitted, and
  // the mark never goes backwards.
  for (let index = 1; index < events.length; index++)
    assert.ok(
      events[index]!.seq >= events[index - 1]!.seq,
      `${events[index]!.type} went backwards: ${events[index - 1]!.seq} → ${events[index]!.seq}`,
    );

  const log = store.events(session.id);
  const typeAtSeq = new Map(log.map((event) => [event.seq, event.type]));
  // A frame that announces a durable fact carries that fact's own seq, which is what makes the cursor
  // comparable with a log read rather than merely monotonic: the client's position names a record.
  for (const frame of events.filter((event) => event.type === 'message.finished'))
    assert.equal(
      typeAtSeq.get(frame.seq),
      'message.assistant',
      'the completed message was written at the seq the frame announced',
    );
  assert.equal(
    events.find((event) => event.type === 'run.finished')!.seq,
    store.lastSeq(session.id),
  );
  // A frame that announces nothing durable is stamped with the mark as it stands: it is ordered against the
  // same log position as the fact before it, and a client that loses it has lost nothing the log does not hold.
  const statistics = events.filter((event) => event.type === 'statistics.updated');
  assert.ok(statistics.length > 1, 'the run reported statistics more than once');
  assert.ok(statistics.every((event) => Number.isSafeInteger(event.seq)));
});

test('a session can be replayed from a cursor, and only what is missing comes back', async (t) => {
  const host = await listeningHost(t, {});
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => undefined));
  await client.start();
  const session = await client.request('session.create', {});
  // Seed history through a second connection to the same database: these are facts the Host's store did not
  // write, which is exactly the case a cursor has to survive (see the last test).
  // Written and committed by a second connection, then closed at once: the facts are in the log, and nothing
  // of the test's own holds the database open (a Windows temp directory cannot be removed while it is).
  const other = new SessionStore(host.dbPath);
  try {
    other.append(session.id, { role: 'user', content: 'first' });
    other.append(session.id, { role: 'assistant', content: 'second', toolCalls: [] });
    other.flush(session.id);
  } finally {
    other.close();
  }

  const all = await client.request('session.events', { sessionId: session.id });
  assert.deepEqual(
    all.entries.map((entry) => entry.type),
    ['message.user', 'message.assistant'],
  );
  assert.equal(all.more, false);
  assert.equal(all.latestSeq, all.entries.at(-1)!.seq);
  const [user, assistant] = all.entries;
  // One page at a time: the cursor is the last record *returned*, and `more` says whether to keep reading.
  const firstPage = await client.request('session.events', { sessionId: session.id, limit: 1 });
  assert.deepEqual(
    firstPage.entries.map((entry) => entry.seq),
    [user!.seq],
  );
  assert.equal(firstPage.more, true);
  assert.equal(firstPage.nextSeq, user!.seq);
  const secondPage = await client.request('session.events', {
    sessionId: session.id,
    afterSeq: firstPage.nextSeq,
  });
  assert.deepEqual(
    secondPage.entries.map((entry) => entry.seq),
    [assistant!.seq],
  );
  assert.equal(secondPage.more, false);
  // Reading from the end is level, not empty-and-unsure: `latestSeq` answers without shipping the log.
  const level = await client.request('session.events', {
    sessionId: session.id,
    afterSeq: assistant!.seq,
  });
  assert.deepEqual(level.entries, []);
  assert.equal(level.latestSeq, assistant!.seq);
  assert.equal(level.more, false);
});

test('a client that missed a fact finds out and catches up without the Host restarting', async (t) => {
  const host = await listeningHost(t, {});
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => undefined));
  await client.start();
  const session = await client.request('session.create', {});
  const controller = new SessionController(client);
  t.after(() => controller.dispose());
  await controller.load(session.id);
  // A load ends level with the log, so the first check costs one request and changes nothing.
  assert.equal(await controller.catchUp(), false);
  assert.equal(
    client.cursorOf(session.id),
    (await client.request('session.events', { sessionId: session.id })).latestSeq,
  );

  // A fact reaches the log that this client's stream never delivered — another writer on the same database,
  // which is the shape of every interruption: the client holds a position, and the log moved past it.
  const other = new SessionStore(host.dbPath);
  try {
    other.append(session.id, { role: 'user', content: 'written by somebody else' });
    other.flush(session.id);
  } finally {
    other.close();
  }
  assert.ok(
    (await client.request('session.events', { sessionId: session.id })).latestSeq >
      client.cursorOf(session.id),
    'the log moved past the client, which is what makes the gap detectable at all',
  );

  assert.equal(await controller.catchUp(), true, 'the client noticed it was behind');
  assert.equal(
    controller.snapshot.messages.map((message) => message.content).at(-1),
    'written by somebody else',
    'and rebuilt from the log rather than showing a stale view',
  );
  // Caught up means caught up: the next check is a no-op again.
  assert.equal(await controller.catchUp(), false);
});
