import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnedCarrier } from '../packages/carrier/index.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { CarrierService } from '../packages/carrier/service.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';

test('model selection keeps the Host, transcript window and global default while sessions restore their own route', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-live-model-'));
  let carrier: CarrierService | undefined;
  t.after(async () => {
    await carrier?.stop();
    await rm(root, { recursive: true, force: true });
  });
  const seen: string[] = [];
  const url = await httpFixture(t, (body, res) => {
    seen.push(body.model);
    sendFrames(res, frames(`answer-${body.model}`));
  });
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  const first = store.create(root).id;
  for (let index = 0; index < 130; index++)
    store.append(first, { role: 'user', content: `history-${index}` });
  store.close();
  const connections = ['a', 'b'].map((id) => ({
    connectionId: id,
    protocol: 'anthropic' as const,
    model: `model-${id}`,
    apiKey: `key-${id}`,
    baseUrl: url,
    maxContextTokens: 128000,
  }));
  carrier = spawnedCarrier({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db,
    env: {
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_SANDBOX: 'host',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_WORKFLOWS: 'false',
    },
    modelCatalog: { connections, defaultConnectionId: 'a' },
  });
  await carrier.start(first);
  const before = carrier.snapshot;
  await carrier.selectModel('b');
  const after = carrier.snapshot;
  assert.equal(after.hostPid, before.hostPid);
  assert.equal(after.session.sessionId, first);
  assert.equal(after.session.historyStart, before.session.historyStart);
  assert.deepEqual(after.session.messages, before.session.messages);
  assert.equal(after.model, 'model-b');
  assert.equal(seen.length, 0, 'selecting does not test the endpoint or reload the conversation');
  await carrier.dispatch({ type: 'create' });
  const second = carrier.snapshot.session.sessionId;
  assert.notEqual(second, first);
  assert.equal(carrier.snapshot.model, 'model-a');
  await carrier.dispatch({ type: 'send', prompt: 'Reply briefly.' });
  await carrier.dispatch({ type: 'load', id: first });
  assert.equal(carrier.snapshot.model, 'model-b');
  await carrier.dispatch({ type: 'send', prompt: 'Reply briefly.' });
  assert.deepEqual(seen, ['model-a', 'model-b']);
  assert.equal(carrier.snapshot.hostPid, before.hostPid);
  const oldPid = carrier.snapshot.hostPid!;
  process.kill(oldPid, 'SIGKILL');
  const deadline = Date.now() + 12000;
  while (!(
    carrier.snapshot.ready &&
    carrier.snapshot.hostPid !== oldPid &&
    carrier.snapshot.recovery
  )) {
    if (Date.now() > deadline)
      assert.fail(`Host did not recover: ${JSON.stringify(carrier.snapshot.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(carrier.snapshot.model, 'model-b');
  await carrier.dispatch({ type: 'send', prompt: 'Reply after recovery.' });
  assert.equal(seen.at(-1), 'model-b');
});
