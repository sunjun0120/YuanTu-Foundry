import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClientSideConnection, type AnyMessage } from '@agentclientprotocol/sdk';
import { connectAcp } from '../packages/sdk/acp.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { projectRoot } from './process-fixture.ts';

test('concurrent cold loads reserve a single session before Host startup awaits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-acp-load-'));
  const script = path.join(root, 'host.mjs');
  await writeFile(
    script,
    `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({input: process.stdin})) {
      const request = JSON.parse(line);
      if (request.method === 'host.info') await new Promise(resolve => setTimeout(resolve, 100));
      const result = request.method === 'host.info'
        ? {protocolVersion:1,runtime:'yuantu',workspace:process.cwd(),capabilities:[]}
        : {session:{id:'known'},messages:[{role:'user',content:'once'}]};
      console.log(JSON.stringify({id:request.id,result}));
    }
  `,
  );
  const toAgent = new TransformStream<AnyMessage>();
  const toClient = new TransformStream<AnyMessage>();
  const adapter = connectAcp(
    { readable: toAgent.readable, writable: toClient.writable },
    { nodePath: process.execPath, hostPath: script, workspace: root },
  );
  t.after(async () => {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  const texts: string[] = [];
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate(event) {
        if (
          event.update.sessionUpdate === 'user_message_chunk' &&
          event.update.content.type === 'text'
        )
          texts.push(event.update.content.text);
      },
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    }),
    { readable: toClient.readable, writable: toAgent.writable },
  );
  await client.initialize({ protocolVersion: 1 });
  const results = await Promise.allSettled([
    client.loadSession({ cwd: root, sessionId: 'known', mcpServers: [] }),
    client.loadSession({ cwd: root, sessionId: 'known', mcpServers: [] }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.deepEqual(texts, ['once']);
});

test(
  'real Host chunked history continues with messages after the oversized one',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-acp-chunks-'));
    await mkdir(path.join(root, '.yuantu'));
    const store = new SessionStore(path.join(root, '.yuantu/sessions.sqlite'));
    const session = store.create(root);
    store.append(session.id, { role: 'user', content: 'x'.repeat(15_000_000) });
    store.append(session.id, { role: 'assistant', content: 'AFTER_LARGE_MESSAGE', toolCalls: [] });
    for (let i = 0; i < 101; i++) store.append(session.id, { role: 'user', content: `PAGE_${i}` });
    store.append(session.id, { role: 'assistant', content: 'AFTER_PAGE_BOUNDARY', toolCalls: [] });
    store.close();
    const toAgent = new TransformStream<AnyMessage>();
    const toClient = new TransformStream<AnyMessage>();
    const adapter = connectAcp(
      { readable: toAgent.readable, writable: toClient.writable },
      {
        nodePath: process.execPath,
        hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
        workspace: root,
        env: {
          YUANTU_MODEL: 'fixture',
          YUANTU_MAX_CONTEXT_TOKENS: '128000',
          YUANTU_SESSION_TITLES: '0',
        },
      },
    );
    t.after(async () => {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    });
    const received: { role: string; chars: number; text: string }[] = [];
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate(event) {
          if (
            (event.update.sessionUpdate === 'user_message_chunk' ||
              event.update.sessionUpdate === 'agent_message_chunk') &&
            event.update.content.type === 'text'
          )
            received.push({
              role: event.update.sessionUpdate,
              chars: event.update.content.text.length,
              text: event.update.content.text.slice(0, 30),
            });
        },
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }),
      { readable: toClient.readable, writable: toAgent.writable },
    );
    await client.initialize({ protocolVersion: 1 });
    await client.loadSession({ cwd: root, sessionId: session.id, mcpServers: [] });
    assert.equal(received[0]?.chars, 15_000_000);
    assert.equal(received[1]?.text, 'AFTER_LARGE_MESSAGE');
    assert.equal(received.at(-1)?.text, 'AFTER_PAGE_BOUNDARY');
    assert.equal(received.length, 104);
  },
);
