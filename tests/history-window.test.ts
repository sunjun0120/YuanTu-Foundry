import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import type { AgentHostClient } from '../packages/client/host-client.ts';
import type { AgentEvent, Message } from '../packages/protocol/index.ts';

for (const producedMessages of [true, false])
  test(`an old backwards page cannot replace the tail or release loading owned by a background reconciliation (messages: ${producedMessages})`, async (t) => {
    let listener!: (event: AgentEvent) => void;
    let releaseOlder!: () => void, releaseTail!: () => void;
    const messages: Message[] = Array.from({ length: 350 }, (_, i) => ({
      role: 'user',
      content: `Entry ${i}`,
    }));
    let holdTail = false;
    const client = {
      status: 'ready',
      subscribe(fn: (event: AgentEvent) => void) {
        listener = fn;
        return () => {};
      },
      subscribeStatus() {
        return () => {};
      },
      supports() {
        return false;
      },
      async request(method: string, p: { tail?: number; offset: number; endOffset: number }) {
        if (method === 'session.get') {
          const start = p.tail === undefined ? p.offset : Math.max(0, messages.length - p.tail);
          const page = {
            messages: messages.slice(start, p.tail === undefined ? p.endOffset : undefined),
            offset: start,
            totalMessages: messages.length,
          };
          if (p.tail === undefined)
            return new Promise((resolve) => {
              releaseOlder = () => resolve(page);
            });
          if (holdTail)
            return new Promise((resolve) => {
              releaseTail = () => resolve(page);
            });
          return page;
        }
        if (method === 'plan.get' || method === 'goal.get') return null;
        if (method === 'todos.get') return { todos: [], change: null };
        return [];
      },
    };
    const controller = new SessionController(client as unknown as AgentHostClient);
    t.after(() => controller.dispose());
    await controller.load('s');
    const older = controller.loadOlder();
    listener({ type: 'run.started', sessionId: 's', runId: 'background', seq: 1, data: {} });
    if (producedMessages) {
      messages.push({ role: 'user', content: 'Automatic prompt' });
      const answer: Message = { role: 'assistant', content: 'Automatic reply', toolCalls: [] };
      messages.push(answer);
      listener({
        type: 'message.started',
        sessionId: 's',
        runId: 'background',
        seq: 2,
        data: { messageId: 'm' },
      });
      listener({
        type: 'message.finished',
        sessionId: 's',
        runId: 'background',
        seq: 3,
        data: { messageId: 'm', message: answer },
      });
    }
    holdTail = true;
    listener({
      type: 'run.finished',
      sessionId: 's',
      runId: 'background',
      seq: 4,
      data: { result: { status: 'completed' } },
    });
    releaseOlder();
    await older;
    assert.equal(
      controller.snapshot.loading,
      true,
      'the background reconciliation still owns loading',
    );
    assert.equal(controller.snapshot.historyStart, 250, 'the stale page is discarded');
    releaseTail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(controller.snapshot.historyStart, producedMessages ? 251 : 250);
    assert.equal(controller.snapshot.messages.length, producedMessages ? 101 : 100);
    assert.equal(controller.snapshot.loading, false);
  });

test('a real Host loads recent history and pages backwards without losing messages or statistics', async (t) => {
  let sessionId = '';
  const host = await listeningHost(t, {}, (db) => {
    const store = new SessionStore(db);
    sessionId = store.create(path.dirname(db)).id;
    for (let i = 0; i < 350; i++) store.append(sessionId, { role: 'user', content: `Entry ${i}` });
    store.close();
  });
  const { client } = await connectClient(host.port);
  const controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
  });
  await client.start();
  await controller.load(sessionId);
  assert.equal(controller.snapshot.messages.length, 100);
  assert.equal(controller.snapshot.messages[0]?.content, 'Entry 250');
  assert.equal(controller.snapshot.historyStart, 250);
  const statistics = controller.snapshot.statistics;
  const first = controller.loadOlder();
  await assert.rejects(controller.loadOlder(), /running or loading/);
  await first;
  assert.equal(controller.snapshot.historyStart, 150);
  await controller.loadOlder();
  await controller.loadOlder();
  assert.equal(controller.snapshot.historyStart, 0);
  assert.deepEqual(
    controller.snapshot.messages.map((m) => m.content),
    Array.from({ length: 350 }, (_, i) => `Entry ${i}`),
  );
  assert.deepEqual(controller.snapshot.statistics, statistics);
  await controller.loadOlder();
  assert.equal(controller.snapshot.messages.length, 350);
  assert.equal(
    (await client.request('session.get', { sessionId })).messages.length,
    350,
    'legacy full-history callers keep the same contract',
  );
  await assert.rejects(
    client.request('session.get', { sessionId, view: 'display', offset: 0, tail: -1 }),
  );
  await assert.rejects(
    client.request('session.get', { sessionId, view: 'display', offset: 0, endOffset: 351 }),
  );
  assert.equal((await client.request('session.list', {})).length, 1);
});

test('a bounded history window reconstructs an oversized message without reading the next window', async (t) => {
  let sessionId = '';
  const large = '中'.repeat(5_100_000);
  const host = await listeningHost(t, {}, (db) => {
    const store = new SessionStore(db);
    sessionId = store.create(path.dirname(db)).id;
    store.append(sessionId, {
      role: 'assistant',
      content: large,
      toolCalls: [],
      providerState: {
        protocol: 'openai-responses',
        model: 'm',
        endpoint: 'https://example.test',
        output: [{ opaque: 'never display' }],
      },
    });
    for (let i = 0; i < 100; i++) store.append(sessionId, { role: 'user', content: `Entry ${i}` });
    store.close();
  });
  const { client } = await connectClient(host.port);
  const controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
  });
  await client.start();
  await controller.load(sessionId);
  assert.equal(controller.snapshot.messages.length, 100);
  await controller.loadOlder();
  assert.equal(controller.snapshot.messages.length, 101);
  assert.equal(controller.snapshot.messages[0]?.content, large);
  assert.equal('providerState' in controller.snapshot.messages[0]!, false);
});
