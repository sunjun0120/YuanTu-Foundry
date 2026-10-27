import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { HostModelRuntime } from '../apps/agent-host/model-runtime.ts';
import { SubAgentResidency } from '../packages/core/residency.ts';
import { storeFixture } from './temp-fixture.ts';

test('live model selection preserves the Host and isolates sessions, credentials and limits', async (t) => {
  const requests: { model: string; key: unknown; output: number }[] = [];
  const url = await httpFixture(t, (body, res, headers) => {
    requests.push({ model: body.model, key: headers['x-api-key'], output: body.max_tokens });
    sendFrames(res, frames(`reply-${body.model}`));
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
  host.beforeStop(() => client.stop());
  await client.start();
  const first = await client.request('session.create', {});
  const second = await client.request('session.create', {});
  const catalog = {
    connections: [
      {
        connectionId: 'a',
        protocol: 'anthropic' as const,
        model: 'model-a',
        baseUrl: url,
        apiKey: 'key-a',
        maxContextTokens: 64000,
        maxOutputTokens: 1200,
      },
      {
        connectionId: 'b',
        protocol: 'anthropic' as const,
        model: 'model-b',
        baseUrl: url,
        apiKey: 'key-b',
        maxContextTokens: 32000,
        maxOutputTokens: 600,
        supportsVision: false,
      },
    ],
    defaultConnectionId: 'a',
  };
  await client.request('model.configure', catalog);
  await client.request('model.select', { sessionId: first.id, connectionId: 'b' });
  assert.equal((await client.run(first.id, 'Reply briefly.')).status, 'completed');
  assert.equal((await client.run(second.id, 'Reply briefly.')).status, 'completed');
  assert.deepEqual(requests, [
    { model: 'model-b', key: 'key-b', output: 600 },
    { model: 'model-a', key: 'key-a', output: 1200 },
  ]);
  assert.equal(host.child.exitCode, null);
  assert.equal((await client.request('model.get', { sessionId: first.id })).connectionId, 'b');
  assert.equal((await client.request('model.get', { sessionId: second.id })).connectionId, 'a');
  const audit = await client.request('session.audit', { sessionId: first.id });
  assert.doesNotMatch(JSON.stringify(audit), /key-a|key-b/);
  // Reinstalling the catalog leaves the durable per-session choice alone.
  await client.request('model.configure', catalog);
  assert.equal((await client.request('model.get', { sessionId: first.id })).connectionId, 'b');
  await client.request('model.configure', { ...catalog, defaultConnectionId: 'b' });
  assert.equal(
    (await client.request('model.get', { sessionId: second.id })).connectionId,
    'a',
    'a conversation keeps the model it has already used when the global default changes',
  );
});

test('an active run keeps its admitted configuration across subsequent model calls', async (t) => {
  const models: string[] = [];
  let held: ServerResponse | undefined;
  let arrived!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const url = await httpFixture(t, (body, res) => {
    models.push(body.model);
    if (models.length === 1) {
      held = res;
      arrived();
    } else sendFrames(res, frames('finished'));
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
  host.beforeStop(() => client.stop());
  await client.start();
  const session = await client.request('session.create', {});
  const connection = {
    connectionId: 'same',
    protocol: 'anthropic' as const,
    model: 'before',
    apiKey: 'secret-before',
    baseUrl: url,
    maxContextTokens: 64000,
  };
  await client.request('model.configure', {
    connections: [connection],
    defaultConnectionId: 'same',
  });
  const run = client.run(session.id, 'Use list_files, then reply.');
  await firstRequest;
  await client.request('model.configure', {
    connections: [{ ...connection, model: 'after', apiKey: 'secret-after' }],
    defaultConnectionId: 'same',
  });
  sendFrames(held!, frames('', [{ id: 'read', name: 'list_files', input: { path: '.' } }]));
  assert.equal((await run).status, 'completed');
  assert.deepEqual(models, ['before', 'before']);
  await client.run(session.id, 'Reply again.');
  assert.equal(models.at(-1), 'after');
});

test('invalid model catalogs cannot replace the active catalog or alter execution policy', async (t) => {
  const host = await listeningHost(t, {});
  const { client } = await connectClient(host);
  host.beforeStop(() => client.stop());
  await client.start();
  const session = await client.request('session.create', {});
  const connection = {
    connectionId: 'a',
    protocol: 'anthropic' as const,
    model: 'good',
    apiKey: 'secret',
    baseUrl: 'http://127.0.0.1:1',
    maxContextTokens: 64000,
  };
  await client.request('model.configure', { connections: [connection], defaultConnectionId: 'a' });
  await assert.rejects(
    client.request('model.configure', {
      connections: [{ ...connection, maxContextTokens: -1 }],
      defaultConnectionId: 'a',
    }),
  );
  const malicious = { connections: [{ ...connection, sandbox: 'host' }], defaultConnectionId: 'a' };
  await assert.rejects(client.request('model.configure', malicious));
  assert.equal((await client.request('model.get', { sessionId: session.id })).model, 'good');
});

test('changing a session model releases its old resident descendants and preserves the shared Host cap', async (t) => {
  const { store, session, cleanup } = await storeFixture(t, 'yuantu-model-residents-');
  const pool = new SubAgentResidency();
  cleanup(() => pool.disposeAll());
  const options = { json: false, allowWrite: false, allowCommand: false, help: false };
  const runtime = new HostModelRuntime(store, options, {});
  const closed: string[] = [];
  const old = await Reflect.apply(runtime.residency, runtime, [
    { env: { YUANTU_MODEL: 'old' }, options },
    session.id,
    pool,
  ]);
  const child = (id: string, parentSessionId: string, depth: number) => ({
    id,
    childSessionId: id,
    parentSessionId,
    depth,
    objective: 'fixture',
    async turn(): Promise<never> {
      throw new Error('not run');
    },
    async close() {
      closed.push(id);
    },
  });
  old.open(child('child', session.id, 1));
  old.open(child('grandchild', 'child', 2));
  const next = await Reflect.apply(runtime.residency, runtime, [
    { env: { YUANTU_MODEL: 'new' }, options },
    session.id,
    pool,
  ]);
  assert.equal(old.get('child'), undefined);
  assert.equal(old.get('grandchild'), undefined);
  assert.deepEqual(closed, ['grandchild', 'child']);
  assert.equal(next, pool);
});

test('a model change releases a resident grandchild after its intermediary has been unloaded', async (t) => {
  const { root, store, session, cleanup } = await storeFixture(t, 'yuantu-model-ancestry-');
  const pool = new SubAgentResidency();
  cleanup(() => pool.disposeAll());
  const options = { json: false, allowWrite: false, allowCommand: false, help: false };
  const runtime = new HostModelRuntime(store, options, {});
  const child = store.create(root, session.id);
  const grandchild = store.create(root, child.id);
  const snapshot = { env: { YUANTU_MODEL: 'old' }, options };
  await runtime.residency(snapshot, session.id, pool);
  for (const [entry, parent, depth] of [
    [child, session.id, 1],
    [grandchild, child.id, 2],
  ] as const)
    pool.open({
      id: entry.id,
      childSessionId: entry.id,
      parentSessionId: parent,
      depth,
      objective: 'fixture',
      async turn(): Promise<never> {
        throw new Error('not run');
      },
    });
  await pool.unload(child.id);
  await runtime.residency({ ...snapshot, env: { YUANTU_MODEL: 'new' } }, session.id, pool);
  assert.equal(pool.get(grandchild.id), undefined);
});

test('residents of an unrelated deleted session cannot block another chat model change', async (t) => {
  const { root, store, session, cleanup } = await storeFixture(t, 'yuantu-model-orphans-');
  const pool = new SubAgentResidency();
  cleanup(() => pool.disposeAll());
  const options = { json: false, allowWrite: false, allowCommand: false, help: false };
  const runtime = new HostModelRuntime(store, options, {});
  const unrelated = store.create(root);
  pool.open({
    id: 'orphan',
    childSessionId: 'orphan',
    parentSessionId: unrelated.id,
    depth: 1,
    objective: 'fixture',
    async turn(): Promise<never> {
      throw new Error('not run');
    },
  });
  const snapshot = { env: { YUANTU_MODEL: 'old' }, options };
  await runtime.residency(snapshot, session.id, pool);
  store.delete(unrelated.id);
  assert.equal(
    await runtime.residency({ ...snapshot, env: { YUANTU_MODEL: 'new' } }, session.id, pool),
    pool,
  );
});
