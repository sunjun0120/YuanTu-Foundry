import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import { setBackgroundPolicy } from '../packages/core/background-deliveries.ts';

async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw Error('condition timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('cold completed records notify by default, opt-in wakes once and streams in an idle controller', async (t) => {
  let requests = 0;
  const url = await httpFixture(t, (_body, res) => {
    requests++;
    sendFrames(res, frames('Background reviewed.'));
  });
  let sessionId = '';
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (file) => {
    const store = new SessionStore(file);
    sessionId = store.create(hostRoot(file)).id;
    store.recordEvent(sessionId, 'command.started', { id: 'finished', command: 'fixture' });
    store.recordEvent(sessionId, 'command.settled', {
      id: 'finished',
      status: 'completed',
      output: 'saved tail',
    });
    store.close();
  });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const controller = new SessionController(client);
  t.after(() => controller.dispose());
  await controller.load(sessionId);
  const initial = await client.request('background.state', { sessionId });
  assert.equal(initial.deliveries[0]?.state, 'pending');
  assert.equal(requests, 0);
  assert.equal((await client.request('background.list', { sessionId }))[0]?.status, 'completed');
  assert.equal(
    (await client.request('background.poll', { sessionId, id: 'finished' })).output,
    'saved tail',
  );
  await client.request('background.clear', { sessionId });
  assert.deepEqual(await client.request('background.list', { sessionId }), []);
  assert.equal(
    (await client.request('background.poll', { sessionId, id: 'finished' })).output,
    'saved tail',
  );
  let witnessed = false;
  const off = controller.subscribe((s) => {
    if (s.running) witnessed = true;
  });
  t.after(off);
  await client.request('background.policy', {
    sessionId,
    policy: { mode: 'auto', paused: false, maxWakeups: 1, maxRunMs: 1000 },
  });
  await until(
    async () =>
      (await client.request('background.state', { sessionId })).deliveries[0]?.state ===
      'processed',
  );
  assert.equal(requests, 1);
  assert.equal(witnessed, true);
  await until(async () => !controller.snapshot.running);
  assert.ok(
    controller.snapshot.messages.some(
      (m) => m.role === 'assistant' && m.content === 'Background reviewed.',
    ),
  );
  await client.request('background.policy', {
    sessionId,
    policy: { mode: 'auto', paused: false, maxWakeups: 1, maxRunMs: 1000 },
  });
  assert.equal((await client.request('background.state', { sessionId })).policy.used, 1);
  assert.equal(requests, 1);
});

function hostRoot(file: string) {
  return file.slice(
    0,
    file.lastIndexOf('\\') >= 0 ? file.lastIndexOf('\\') : file.lastIndexOf('/'),
  );
}

test('a completion arriving in the final foreground response continues without losing the next transcript', async (t) => {
  let file = '',
    sessionId = '',
    requests = 0;
  const url = await httpFixture(t, (_body, res) => {
    requests++;
    if (requests === 1) {
      const store = new SessionStore(file);
      store.recordEvent(sessionId, 'command.settled', { id: 'late', status: 'completed' });
      store.close();
      sendFrames(res, frames('Foreground finished.'));
    } else {
      setTimeout(() => sendFrames(res, frames('Automatic finished.')), 100);
    }
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (db) => {
    file = db;
    const store = new SessionStore(db);
    sessionId = store.create(hostRoot(db)).id;
    store.recordEvent(sessionId, 'command.started', { id: 'late' });
    setBackgroundPolicy(store, sessionId, {
      mode: 'auto',
      paused: false,
      maxWakeups: 1,
      maxRunMs: 2000,
    });
    store.close();
  });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const controller = new SessionController(client);
  t.after(() => controller.dispose());
  await controller.load(sessionId);
  await controller.send('Finish the foreground turn');
  await until(
    async () =>
      (await client.request('background.state', { sessionId })).deliveries[0]?.state ===
      'processed',
  );
  await until(async () =>
    controller.snapshot.messages.some(
      (m) => m.role === 'assistant' && m.content === 'Automatic finished.',
    ),
  );
  assert.equal(requests, 2);
  assert.equal(controller.snapshot.running, false);
});

test('automatic wake budget cancels a stalled provider and cancellation pauses future wakes', async (t) => {
  let requests = 0;
  const url = await httpFixture(t, (_body, _res) => {
    requests++;
  });
  let sessionId = '';
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (file) => {
    const store = new SessionStore(file);
    sessionId = store.create(hostRoot(file)).id;
    store.recordEvent(sessionId, 'command.started', { id: 'finished' });
    store.recordEvent(sessionId, 'command.settled', { id: 'finished', status: 'failed' });
    setBackgroundPolicy(
      store,
      sessionId,
      {
        mode: 'auto',
        paused: false,
        maxWakeups: 1,
        maxRunMs: 1000,
      },
      false,
      { sandboxMode: 'host', permissionPolicy: null },
    );
    store.close();
  });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  await until(
    async () =>
      (await client.request('background.state', { sessionId })).deliveries[0]?.state ===
      'processed',
    8000,
  );
  const state = await client.request('background.state', { sessionId });
  assert.equal(state.policy.used, 1);
  assert.match(state.deliveries[0]!.reason!, /cancelled|failed/);
  assert.equal(requests, 1);
  await client.request('run.cancel', { sessionId });
  assert.equal((await client.request('background.state', { sessionId })).policy.paused, true);
});

test('a slow session hook cannot admit a second main run before the first slot is reserved', async (t) => {
  const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('Done')));
  let ids: string[] = [];
  const hookRoot = await mkdtemp(path.join(tmpdir(), 'yuantu-trusted-hook-'));
  t.after(() => rm(hookRoot, { recursive: true, force: true }));
  const hook = path.join(hookRoot, 'slow-hook.mjs');
  writeFileSync(
    hook,
    'export const hooks={sessionStart:async()=>{await new Promise(r=>setTimeout(r,300));}};',
  );
  const host = await listeningHost(
    t,
    { YUANTU_BASE_URL: url, YUANTU_HOOKS_MODULE: hook },
    (file) => {
      const root = path.dirname(file);
      const store = new SessionStore(file);
      ids = [store.create(root).id, store.create(root).id];
      store.close();
    },
  );
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const first = client.run(ids[0]!, 'First');
  await assert.rejects(client.run(ids[1]!, 'Second'), /already has an active run/);
  assert.equal((await first).status, 'completed');
});
