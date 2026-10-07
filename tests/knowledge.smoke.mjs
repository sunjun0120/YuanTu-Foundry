import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { KnowledgeStore } from '../packages/knowledge/store.ts';
import { memoryPaths, readMemoryFile } from '../packages/knowledge/memory.ts';
import { createTools } from '../packages/tools/index.ts';

test(
  'desktop has no knowledge settings page while Agent memory persists',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-knowledge-agent-'));
    const db = path.join(root, 'memory.sqlite');
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_KNOWLEDGE_DB: db,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    const launch = async () => {
      app = await electron.launch({
        executablePath: electronPath,
        args: [
          path.resolve('dist/desktop/main.cjs'),
          '--user-data-dir=' + path.join(root, 'profile'),
        ],
        env,
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(10000);
      await page.waitForFunction(() => !document.querySelector('#open-settings').disabled);
      await page.locator('#open-settings').click();
      assert.equal(await page.locator('#knowledge-settings').count(), 0);
      assert.equal(await page.evaluate(() => 'knowledge' in window.yuantu), false);
      return page;
    };
    await launch();
    const previous = {
      knowledge: process.env.YUANTU_KNOWLEDGE_DB,
      memory: process.env.YUANTU_MEMORY_DIR,
    };
    process.env.YUANTU_KNOWLEDGE_DB = db;
    process.env.YUANTU_MEMORY_DIR = path.join(root, 'memory');
    try {
      const tools = createTools(root);
      const signal = new AbortController().signal;
      const created = await tools.execute(
        {
          id: 'save',
          name: 'save_memory',
          arguments: {
            scope: 'workspace',
            key: 'release-choice',
            content: 'Use staging wave 947',
          },
        },
        { signal, approve: async () => true },
      );
      assert.equal(created.isError, false);
      const recalled = await tools.execute(
        { id: 'recall', name: 'recall_knowledge', arguments: { query: 'staging wave 947' } },
        { signal, approve: async () => false },
      );
      assert.match(recalled.content, /Use staging wave 947/);
      await tools.close();
      // The markdown file, not a database row, is the source of truth.
      const memory = readMemoryFile(memoryPaths(root).workspace);
      assert.deepEqual(
        memory.entries.map((entry) => entry.key),
        ['release-choice'],
      );
      const store = new KnowledgeStore(db);
      assert.deepEqual(store.search(root, 'staging wave 947'), []);
      store.close();
    } finally {
      if (previous.knowledge === undefined) delete process.env.YUANTU_KNOWLEDGE_DB;
      else process.env.YUANTU_KNOWLEDGE_DB = previous.knowledge;
      if (previous.memory === undefined) delete process.env.YUANTU_MEMORY_DIR;
      else process.env.YUANTU_MEMORY_DIR = previous.memory;
    }
    await app.close();
    app = undefined;
    await launch();
  },
);
