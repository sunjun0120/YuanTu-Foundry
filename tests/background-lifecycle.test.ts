import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import type { AgentEvent, RunResult } from '../packages/protocol/index.ts';
import { emptyStatistics } from '../packages/protocol/statistics.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { setBackgroundPolicy, backgroundState } from '../packages/core/background-deliveries.ts';
import { listeningHost, connectClient, connectSocket } from './listening-host-fixture.ts';
import { socketTransport } from '../packages/client/host-transport.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

const policy = { mode: 'auto' as const, paused: false, maxWakeups: 2, maxRunMs: 10000 };
async function until(check: () => boolean | Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw Error('condition timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
function fakeController() {
  const listeners = new Set<(e: AgentEvent) => void>(),
    requests: { method: string; params: unknown }[] = [];
  let historyCalls = 0,
    releaseHistory!: (value: unknown) => void,
    releaseRun!: (value: RunResult) => void;
  const history = new Promise((r) => (releaseHistory = r)),
    result = new Promise<RunResult>((r) => (releaseRun = r));
  const client = {
    status: 'ready',
    subscribe: (f: (e: AgentEvent) => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    subscribeStatus: () => () => {},
    run: () => result,
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === 'session.get') {
        historyCalls++;
        return historyCalls > 1
          ? history
          : { session: { id: 's', workspace: '.', activeRun: null }, messages: [] };
      }
      if (method === 'subagents.list') return [];
      if (method === 'plan.get') return null;
      return {};
    },
  };
  const controller = new SessionController(client as unknown as AgentHostClient);
  const emit = (type: AgentEvent['type'], runId: string, data: Record<string, unknown> = {}) => {
    for (const f of listeners) f({ type, runId, sessionId: 's', seq: 1, data });
  };
  return {
    controller,
    requests,
    emit,
    releaseRun,
    releaseHistory,
    historyCalls: () => historyCalls,
  };
}
test('event-owned automatic run cancellation reaches Host', async (t) => {
  const f = fakeController();
  t.after(() => f.controller.dispose());
  await f.controller.load('s');
  f.emit('run.started', 'auto');
  await f.controller.cancel();
  assert.ok(
    f.requests.some(
      (r) => r.method === 'run.cancel' && (r.params as { sessionId: string }).sessionId === 's',
    ),
  );
});
test('foreground history completion preserves a newer automatic run and its stream', async (t) => {
  const f = fakeController();
  t.after(() => f.controller.dispose());
  await f.controller.load('s');
  const sending = f.controller.send('go');
  f.emit('run.started', 'foreground');
  const result = {
    runId: 'foreground',
    sessionId: 's',
    status: 'completed' as const,
    text: 'done',
    usage: { inputTokens: 0, outputTokens: 0 },
    statistics: emptyStatistics(),
  };
  f.emit('run.finished', 'foreground', { result });
  f.releaseRun(result);
  await until(() => f.historyCalls() > 1);
  f.emit('run.started', 'automatic');
  f.releaseHistory({ messages: [] });
  await sending;
  assert.equal(f.controller.snapshot.running, true);
  let deltas = 0;
  f.controller.subscribeDelta(() => deltas++);
  f.emit('message.started', 'automatic', { messageId: 'a' });
  f.emit('message.delta', 'automatic', { messageId: 'a', text: 'still live' });
  assert.equal(deltas, 1);
});
function seed(store: SessionStore, sessionId: string, id: string, authority?: unknown) {
  store.recordEvent(sessionId, 'command.started', { id });
  store.recordEvent(sessionId, 'command.settled', { id, status: 'completed' });
  setBackgroundPolicy(store, sessionId, policy);
  if (authority)
    store.recordEvent(sessionId, 'background.policy', {
      policy: backgroundState(store, sessionId).policy,
      authority,
    });
}
test('cold automatic readiness waits for policy restore and preserves unselected session authority', async (t) => {
  const catalogs: boolean[] = [];
  const url = await httpFixture(t, (body, res) => {
    catalogs.push(JSON.stringify((body as { tools: unknown }).tools).includes('write_file'));
    sendFrames(res, frames('Checked'));
  });
  let ids: string[] = [];
  const deny = {
    version: 1 as const,
    rules: [{ effect: 'deny' as const, kind: 'write' as const }],
  };
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (file) => {
    const store = new SessionStore(file);
    try {
      ids = [store.create(path.dirname(file)).id, store.create(path.dirname(file)).id];
      seed(store, ids[0]!, 'first', { sandboxMode: 'host', permissionPolicy: deny });
      seed(store, ids[1]!, 'second', {
        sandboxMode: 'host',
        permissionPolicy: { version: 1, rules: [{ effect: 'allow', kind: 'write' }] },
      });
    } finally {
      store.close();
    }
  });
  const socket = await connectSocket(host.port);
  const client = new AgentHostClient({ transport: socketTransport(socket), deferAutomatic: true });
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(catalogs.length, 0);
  for (const id of ids)
    assert.equal((await client.request('background.state', { sessionId: id })).policy.used, 0);
  await client.request('sandbox.set', { sessionId: ids[0]!, mode: 'host' });
  await client.request('permission.update', { sessionId: ids[0]!, policy: deny });
  await client.request('runtime.ready', {});
  await until(() => catalogs.length === 2);
  assert.deepEqual(catalogs.sort(), [false, true]);
  for (const id of ids)
    await until(
      async () =>
        (await client.request('background.state', { sessionId: id })).deliveries[0]?.state ===
        'processed',
    );
});
test('normal carrier EOF joins automatic cancellation and persists terminal receipts before Store closes', async (t) => {
  let requests = 0,
    sessionId = '';
  const url = await httpFixture(t, () => {
    requests++;
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (file) => {
    const store = new SessionStore(file);
    try {
      sessionId = store.create(path.dirname(file)).id;
      seed(store, sessionId, 'stalled', { sandboxMode: 'host', permissionPolicy: null });
    } finally {
      store.close();
    }
  });
  const { client, socket } = await connectClient(host.port);
  await client.start();
  await until(() => requests === 1);
  const exited = new Promise<number | null>((r) => host.child.once('exit', r));
  socket.end();
  assert.equal(await exited, 0);
  assert.doesNotMatch(host.stderr(), /database is not open/);
  const store = new SessionStore(host.dbPath);
  try {
    const events = store.events(sessionId);
    assert.ok(events.some((e) => e.type === 'run.finished'));
    assert.ok(events.some((e) => e.type === 'background.processed'));
  } finally {
    store.close();
  }
});

test('controller Stop aborts the real automatic provider and pauses future wakes', async (t) => {
  let requests = 0,
    closed = false,
    sessionId = '';
  const url = await httpFixture(t, (_body, res) => {
    requests++;
    res.once('close', () => (closed = true));
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (file) => {
    const store = new SessionStore(file);
    try {
      sessionId = store.create(path.dirname(file)).id;
      seed(store, sessionId, 'first', { sandboxMode: 'host', permissionPolicy: null });
    } finally {
      store.close();
    }
  });
  const socket = await connectSocket(host.port);
  const client = new AgentHostClient({ transport: socketTransport(socket), deferAutomatic: true });
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const controller = new SessionController(client);
  t.after(() => controller.dispose());
  await controller.load(sessionId);
  await client.request('runtime.ready', {});
  await until(() => requests === 1 && controller.snapshot.running);
  await controller.cancel();
  await until(
    async () =>
      closed &&
      (await client.request('background.state', { sessionId })).deliveries[0]?.state ===
        'processed',
  );
  assert.equal(controller.snapshot.status, 'cancelled');
  assert.equal((await client.request('background.state', { sessionId })).policy.paused, true);
  const store = new SessionStore(host.dbPath);
  try {
    store.recordEvent(sessionId, 'command.started', { id: 'later' });
    store.recordEvent(sessionId, 'command.settled', { id: 'later', status: 'completed' });
  } finally {
    store.close();
  }
  await client.request('runtime.ready', {});
  const state = await client.request('background.state', { sessionId });
  assert.equal(state.deliveries.find((d) => d.producerId === 'later')?.state, 'pending');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(requests, 1);
});

test('legacy automatic opt-in without authority waits for explicit policy restoration', async (t) => {
  let requests = 0,
    sessionId = '';
  const url = await httpFixture(t, (_body, res) => {
    requests++;
    sendFrames(res, frames('Restored'));
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (file) => {
    const store = new SessionStore(file);
    try {
      sessionId = store.create(path.dirname(file)).id;
      seed(store, sessionId, 'legacy');
    } finally {
      store.close();
    }
  });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(requests, 0);
  assert.equal((await client.request('background.state', { sessionId })).policy.used, 0);
  await client.request('background.policy', { sessionId, policy });
  await until(
    async () =>
      (await client.request('background.state', { sessionId })).deliveries[0]?.state ===
      'processed',
  );
  assert.equal(requests, 1);
});

test('automatic completion history survives a pending foreground history request', async (t) => {
  const f = fakeController();
  t.after(() => f.controller.dispose());
  await f.controller.load('s');
  const sending = f.controller.send('go');
  f.emit('run.started', 'foreground');
  const result = {
    runId: 'foreground',
    sessionId: 's',
    status: 'completed' as const,
    text: 'done',
    usage: { inputTokens: 0, outputTokens: 0 },
    statistics: emptyStatistics(),
  };
  f.emit('run.finished', 'foreground', { result });
  f.releaseRun(result);
  await until(() => f.historyCalls() > 1);
  f.emit('run.started', 'automatic');
  f.emit('run.finished', 'automatic', { result: { ...result, runId: 'automatic' } });
  assert.ok(f.historyCalls() > 2);
  f.releaseHistory({ messages: [{ role: 'assistant', content: 'Automatic finished' }] });
  await sending;
  await until(() => !f.controller.snapshot.loading);
  assert.equal(f.controller.snapshot.messages.at(-1)?.content, 'Automatic finished');
});
