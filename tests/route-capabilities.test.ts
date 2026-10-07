import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../packages/providers/config.ts';
import { routeSupports } from '../packages/protocol/cache-modes.ts';
import { AgentHostClient } from '../packages/sdk/index.ts';
import { ModelSettingsStore } from '../apps/desktop/model-settings.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';

test('vision declarations use the same boolean parser in config and desktop', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
  for (const value of ['0', 'false']) {
    const env = {
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_SUPPORTS_VISION: value,
    };
    assert.equal(readConfig(env).supportsVision, false);
    const store = new ModelSettingsStore(path.join(root, 'models.json'), cipher, env);
    await store.load();
    assert.equal(store.view.supportsVision, false);
  }
});

test('unknown vendor-like route names do not advertise implicit cache support', () => {
  for (const route of ['not-openai', 'custom-anthropic-proxy', 'acme']) {
    assert.equal(routeSupports(route, 'prompt-cache-key'), false);
    assert.equal(routeSupports(route, 'prompt-cache-blocks'), false);
  }
  assert.equal(routeSupports('anthropic', 'prompt-cache-blocks'), true);
  assert.equal(routeSupports('openai', 'prompt-cache-key'), true);
});

test('real Host vision=0 rejects images before making a model request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-vision-zero-'));
  let requests = 0;
  const url = await httpFixture(t, (_, res) => {
    requests++;
    sendFrames(res, frames('image accepted'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_SUPPORTS_VISION: '0',
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = await client.request('session.create', {});
  await assert.rejects(
    client.run(session.id, 'inspect', {
      images: [
        {
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5u8AAAAASUVORK5CYII=',
        },
      ],
    }),
    /图片/,
  );
  assert.equal(requests, 0);
  assert.equal((await client.request('session.get', { sessionId: session.id })).messages.length, 0);
});
