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
import { AgentHostClient } from '../packages/client/host-client.ts';
import { connectClient, listeningHost } from './listening-host-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
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

test('a cursor is a position in the log, and it only ever moves forward', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cursor-mark-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  // The mark is local bookkeeping, so it needs no Host — which is exactly why it can be pinned this directly.
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: { YUANTU_MODEL: 'fixture', YUANTU_API_KEY: 'fixture' },
  });
  // A session nothing has been received for is at the start of the log. 0 is that position; "before the
  // beginning" is not a position a Host could answer a question about.
  assert.equal(client.cursorOf('unknown-session'), 0);
  // Something that is not a position is not recorded. `Infinity` is the one that matters: it compares greater
  // than every real cursor, so a single unvalidated frame would pin the mark past the end of the log forever
  // and no gap could ever be detected again.
  client.noteCursor('s1', Number.NaN);
  client.noteCursor('s1', Number.POSITIVE_INFINITY);
  client.noteCursor('s1', -5);
  assert.equal(client.cursorOf('s1'), 0);
  client.noteCursor('s1', 7);
  assert.equal(client.cursorOf('s1'), 7);
  // The mark is what the client has *received*. Receiving something older afterwards does not un-receive it,
  // and letting the mark walk backwards would make a real gap look like a smaller one.
  client.noteCursor('s1', 3);
  assert.equal(client.cursorOf('s1'), 7);
  // And it is per session: one session's position says nothing about another's.
  assert.equal(client.cursorOf('another-session'), 0);
});

test('a client that cannot check assumes a gap rather than reporting a level view', async (t) => {
  const host = await listeningHost(t, {});
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => undefined));
  await client.start();
  const session = await client.request('session.create', {});
  // A Host that does not advertise the cursor capability. "Did I miss anything?" cannot be asked, and the only
  // safe reading of "I cannot check" is "assume a gap": reporting a level view would show a stale transcript
  // with nothing to say that it is stale.
  const blind = new Proxy(client, {
    get(target, property) {
      if (property === 'supports') return () => false;
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as AgentHostClient;
  const controller = new SessionController(blind);
  t.after(() => controller.dispose());
  await controller.load(session.id);
  // The log moves on while this client cannot find out how far.
  const other = new SessionStore(host.dbPath);
  try {
    other.append(session.id, { role: 'user', content: 'written while nobody was watching' });
    other.flush(session.id);
  } finally {
    other.close();
  }
  assert.equal(
    await controller.catchUp(),
    true,
    'a check that could not be made is not a level view',
  );
  assert.equal(
    controller.snapshot.messages.map((message) => message.content).at(-1),
    'written while nobody was watching',
  );
});

test('a catch-up during a live run leaves the run alone', async (t) => {
  // The endpoint holds its answer until the test says so, instead of sleeping for a fixed span. A fixed sleep
  // makes "the turn is still in flight when the check runs" a bet on the scheduler: too short and the check runs
  // after the turn ended (passing for the wrong reason), too long and every run pays for the margin. A handshake
  // makes the in-flight window a fact the test establishes before it asserts anything about it.
  const marks: { arrived?: () => void } = {};
  const arrived = new Promise<void>((resolve) => (marks.arrived = resolve));
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const requests: string[] = [];
  const url = await httpFixture(t, (body, res) => {
    requests.push(typeof body?.model === 'string' ? body.model : '');
    marks.arrived?.();
    // The protocol this Host speaks is SSE, and the answer is framed as SSE: a JSON body here is not a slower
    // answer, it is a `no-stream` failure (packages/providers/anthropic.ts) that the retry policy treats as
    // retryable (packages/protocol/retry.ts), which turns a one-request test into a retry ladder.
    return held.then(() => sendFrames(res, frames('late answer')));
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => undefined));
  await client.start();
  const session = await client.request('session.create', {});
  const controller = new SessionController(client);
  t.after(() => controller.dispose());
  await controller.load(session.id);
  const running = controller.send('Hi');
  // A diagnostic deadline that does not outlive its own purpose: `AbortSignal.timeout` is unref'd, so an
  // endpoint that never answers fails this test instead of holding the run open for the rest of the timeout.
  const deadline = AbortSignal.timeout(15_000);
  const expired = () =>
    new Error(
      'the run never reached the point where the check could interrupt it; nothing was asserted',
    );
  await Promise.race([
    arrived,
    new Promise((_, reject) =>
      deadline.addEventListener('abort', () => reject(expired()), { once: true }),
    ),
  ]);
  try {
    // The turn is provably in flight: the Host is holding a request open for it.
    assert.equal(controller.snapshot.running, true, 'the run never started');
    // A re-read here would rebuild the state mid-turn and drop the in-flight turn the window is showing, so the
    // check has to decline even though it could answer.
    assert.equal(await controller.catchUp(), false, 'a live run must not be re-read');
  } finally {
    // Released even when an assertion above failed, so a failure is reported rather than left hanging on teardown.
    release();
  }
  // The answer the endpoint was holding belongs to the run, and the run has to end well: `running.catch(() =>
  // undefined)` used to make this test pass while the turn actually failed with a protocol error, which is the
  // failure the fixture's non-SSE JSON body was producing.
  const answer = await running;
  assert.equal(answer.status, 'completed');
  assert.equal(controller.snapshot.error, null);
  // One request: the run asked once and the held answer satisfied it. A retry ladder would show up here.
  assert.equal(requests.length, 1);
});

test('the success assertions above are not vacuous: a run refused by the endpoint fails them', async (t) => {
  // Negative control for the assertions directly above. Those assertions are only worth having if the failure
  // they are meant to catch actually trips them, so this runs the same shape against an endpoint that refuses the
  // request outright. Without it, "the answer was completed" could be a property of the fixture rather than of the
  // code under test — which is exactly how the JSON-body fixture used to pass while the turn was failing.
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'refused' },
      }),
    );
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => undefined));
  await client.start();
  const session = await client.request('session.create', {});
  const controller = new SessionController(client);
  t.after(() => controller.dispose());
  await controller.load(session.id);
  const answer = await controller.send('Hi');
  assert.notEqual(answer.status, 'completed', 'a refused run is not a completed run');
  assert.ok(controller.snapshot.error, 'the refusal is visible on the controller, not swallowed');
});
