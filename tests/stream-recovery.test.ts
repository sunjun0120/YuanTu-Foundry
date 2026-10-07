import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';

test('Host restart restores streamed text saved before its process dies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-stream-recovery-'));
  const db = path.join(root, 'sessions.sqlite');
  let reopened: SessionStore | undefined;
  let client: AgentHostClient | undefined;
  t.after(async () => {
    await client?.stop();
    reopened?.close();
    await rm(root, { recursive: true, force: true });
  });
  const initial = new SessionStore(db);
  const session = initial.create(root);
  initial.close();
  const storeUrl = pathToFileURL(path.resolve('packages/storage/sqlite.ts')).href;
  const agentUrl = pathToFileURL(path.resolve('packages/core/agent.ts')).href;
  const toolsUrl = pathToFileURL(path.resolve('packages/tools/index.ts')).href;
  const childCode = `
    import { SessionStore } from ${JSON.stringify(storeUrl)};
    import { Agent } from ${JSON.stringify(agentUrl)};
    import { createTools } from ${JSON.stringify(toolsUrl)};
    const store = new SessionStore(${JSON.stringify(db)});
    const agent = new Agent({
      store,
      tools: createTools(${JSON.stringify(root)}),
      approve: async () => true,
      provider: { async complete(request) {
        request.onText('partial before crash');
        process.exit(0);
      } },
    });
    await agent.run({ sessionId: ${JSON.stringify(session.id)}, prompt: 'Hi' });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr);
  client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db,
    env: {
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'fixture',
    },
  });
  await client.start();
  const page = await client.request('session.get', {
    sessionId: session.id,
    offset: 0,
    view: 'display',
  });
  assert.equal(page.messages.at(-1)?.content, 'partial before crash');
  assert.equal((page.messages.at(-1) as { interrupted?: boolean }).interrupted, true);
  await client.stop();
  client = undefined;
  reopened = new SessionStore(db);
  assert.equal(reopened.recoverInterruptedStreams(root), 0);
  assert.equal(reopened.messages(session.id).length, page.messages.length);
});
