// @test-serial desktop-ui: Launches real Electron windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import { waitForPage } from './page-wait.mjs';

test(
  'desktop discovers, archives, removes and restores a deleted session workspace',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-orphan-ui-'));
    let app;
    let store;
    t.after(async () => {
      await app?.close();
      store?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const git = (args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
    git(['init', '-q', '-b', 'main']);
    await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
    await writeFile(path.join(root, 'a.txt'), 'original\n');
    git(['add', 'a.txt']);
    git(['commit', '-qm', 'initial']);
    store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const parent = store.create(root),
      child = store.create(root, parent.id);
    const manager = new WorkspaceManager({ store });
    const signal = new AbortController().signal;
    const snapshot = await manager.freeze({
      parentSessionId: parent.id,
      sourceBinding: manager.resolve(parent.id),
      signal,
    });
    const binding = await manager.allocate({
      parentSessionId: parent.id,
      taskId: 'orphan-ui',
      snapshot,
      signal,
    });
    store.attachWorkspaceBinding({ bindingId: binding.id, childSessionId: child.id });
    await writeFile(path.join(binding.executionRoot, 'edited.txt'), 'retained child work\n');
    store.delete(child.id);
    store.close();
    store = undefined;
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_SANDBOX: 'host',
      YUANTU_SESSION_TITLES: 'false',
      YUANTU_MODEL: '',
      YUANTU_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, '.yuantu', 'profile')}`,
      ],
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await waitForPage(
      page,
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.ready,
    );
    await page.locator('#open-settings').click();
    assert.equal(await page.locator('#workspace-maintenance-settings').isVisible(), false);
    // The entry is hidden; open the retained page programmatically to exercise its recovery flow.
    await page.locator('#workspace-maintenance-settings').evaluate((entry) => entry.click());
    const row = page.locator(`[data-binding-id="${binding.id}"]`);
    await row.waitFor();
    assert.equal(await row.locator('strong').textContent(), binding.executionRoot);
    assert.equal(await page.locator('.settings-content:visible').count(), 1);
    const preset = await page.evaluate(() =>
      window.yuantu.presets({ type: 'set', preset: 'unconfined', acknowledgeHost: true }),
    );
    assert.equal(preset.ok, true);
    await row.locator('[data-action="archive"]').click();
    await page.waitForSelector(`[data-binding-id="${binding.id}"][data-state="archived"]`);
    await row.locator('[data-action="remove"]').click();
    await access(binding.executionRoot); // The first click only asks for confirmation.
    await row.locator('[data-action="remove"]').click();
    await page.waitForSelector(`[data-binding-id="${binding.id}"][data-state="removed"]`);
    await assert.rejects(access(binding.executionRoot));
    await page.locator('#workspace-maintenance-refresh').click();
    await row.locator('[data-action="restore"]').waitFor();
    await row.locator('[data-action="restore"]').click();
    await page.waitForSelector(`[data-binding-id="${binding.id}"][data-state="ready"]`);
    assert.equal(
      await readFile(path.join(binding.executionRoot, 'edited.txt'), 'utf8'),
      'retained child work\n',
    );
    // A failed/interrupted recovery can leave a blocked binding and a missing directory.
    store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    store.setWorkspaceState({ bindingId: binding.id, expect: 'ready', to: 'blocked' });
    store.close();
    store = undefined;
    await rm(binding.executionRoot, { recursive: true, force: true });
    await page.locator('#workspace-maintenance-refresh').click();
    await page.waitForSelector(`[data-binding-id="${binding.id}"][data-state="blocked"]`);
    await row.locator('[data-action="restore"]').click();
    await page.waitForSelector(`[data-binding-id="${binding.id}"][data-state="ready"]`);
    assert.equal(
      await readFile(path.join(binding.executionRoot, 'edited.txt'), 'utf8'),
      'retained child work\n',
    );
    if (process.env.TEST_DESKTOP_SCREENSHOT_PATH)
      await page.screenshot({
        path: path.join(process.env.FOUNDRY_TEST_ARTIFACTS || root, 'workspace-maintenance.png'),
      });
    const rejected = await page.evaluate(() =>
      window.yuantu.workspaceMaintenance({ type: 'remove', bindingId: 'x', workspace: '/other' }),
    );
    assert.equal(rejected.ok, false);
  },
);
