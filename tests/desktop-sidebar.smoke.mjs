// @test-serial desktop-ui: Real Electron project collapse, global search and workspace tabs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { artifactPath } from './desktop-smoke-support.mjs';

test(
  'project names collapse, global search opens an unopened project and new-tab controls stay compact',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-sidebar-'));
    const a = path.join(root, 'Alpha');
    const b = path.join(root, 'Beta');
    let wanted;
    for (const folder of [a, b]) {
      await mkdir(path.join(folder, '.yuantu'), { recursive: true });
      const store = new SessionStore(path.join(folder, '.yuantu', 'sessions.sqlite'));
      const session = store.create(folder);
      store.rename(session.id, folder === b ? 'Background conversation' : 'Active conversation');
      store.append(session.id, { role: 'user', content: 'GLOBAL_NEEDLE' });
      if (folder === b) wanted = session.id;
      if (folder === a)
        for (let index = 0; index < 6; index++) {
          const extra = store.create(folder);
          store.rename(extra.id, `Alpha conversation ${index}`);
        }
      store.close();
    }
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: a,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#prompt')?.disabled);
    await page.evaluate(async () => {
      const reply = await window.yuantu.uiSettings({ type: 'get' });
      await window.yuantu.uiSettings({
        type: 'save',
        settings: { ...reply.settings, appearance: 'dark' },
      });
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    assert.equal(await page.getByRole('button', { name: '更换目录', exact: true }).count(), 0);
    assert.equal(await page.locator('#recent-sessions-label').count(), 0);
    const current = page.locator('.project-row.selected');
    await current.locator('.project-name').click();
    assert.equal(
      await current.locator('.project-disclosure svg').getAttribute('data-icon'),
      'folder-closed',
    );
    assert.equal(await current.locator('.project-name').getAttribute('aria-expanded'), 'false');
    assert.equal(await current.locator('.session-sidebar-root').isHidden(), true);
    await current.locator('.project-name').press('Enter');
    await current.locator('.session-item').first().waitFor();
    assert.equal(
      await current.locator('.project-disclosure svg').getAttribute('data-icon'),
      'folder-open',
    );
    assert.equal(await current.locator('.session-item').count(), 3);
    await current.locator('.session-toggle').click();
    assert.equal(await current.locator('.session-item').count(), 7);
    await current.locator('.session-toggle').click();
    const headerBounds = await current.locator('.project-row-header').boundingBox();
    const selectedBounds = await current.locator('.session-item.selected').boundingBox();
    assert.equal(headerBounds.height, selectedBounds.height);
    assert.equal(
      await page.locator('.project-group-toggle svg').getAttribute('data-icon'),
      'chevron-down',
    );
    await page.locator('#open-workspace').click();
    await page.locator('#workspace-new-tab-page').waitFor();
    assert.equal(await page.locator('#workspace-tree-tab').isHidden(), true);
    assert.equal(await page.locator('#workspace-location').isHidden(), true);
    const tab = await page.locator('#workspace-new-tab').locator('xpath=..').boundingBox();
    const plus = await page.locator('#workspace-new-tab-plus').boundingBox();
    assert.ok(plus.x >= tab.x + tab.width && plus.x - tab.x - tab.width < 12);
    assert.equal(await page.locator('#workspace-tabs #workspace-new-tab-plus').count(), 1);
    await page.locator('#workspace-new-files').click();
    assert.equal(await page.locator('#workspace-tree-tab').isVisible(), true);
    await page.locator('#workspace-new-tab-plus').click();
    await page.locator('#workspace-new-tab-page').waitFor();
    await page.locator('#workspace-close').click();
    const added = await page.evaluate(
      (folder) => window.yuantu.projects({ type: 'add', path: folder }),
      b,
    );
    const bId = added.addedId;
    const before = await page.evaluate(() => window.yuantu.projects({ type: 'list' }));
    assert.equal(before.runtime[bId], undefined, 'Beta must not have a Host before search');
    const search = page.locator('#open-session-search');
    assert.equal(
      await search.evaluate((element) => element.closest('.project-group-header').className),
      'project-group-header',
    );
    await search.click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'search opens inside the sidebar');
    assert.equal(await page.locator('.project-group-toggle').isVisible(), false);
    const inputBounds = await page.locator('.project-search-field').boundingBox();
    const sidebarBounds = await page.locator('.project-sidebar').boundingBox();
    assert.ok(inputBounds.width >= sidebarBounds.width - 24, 'search spans the heading row');
    await page.locator('#session-search').fill('GLOBAL_NEEDLE');
    await page.waitForFunction(
      () => document.querySelectorAll('.project-search-result').length === 2,
    );
    const after = await page.evaluate(() => window.yuantu.projects({ type: 'list' }));
    assert.deepEqual(
      (await page.locator('.project-search-project-name').allTextContents()).sort(),
      ['Alpha', 'Beta'],
    );
    assert.equal(after.registry.activeWorkspaceId, before.registry.activeWorkspaceId);
    assert.equal(after.runtime[bId], undefined, 'search must not start a Host');
    const concurrent = await page.evaluate(async () =>
      Promise.all([
        ...Array.from({ length: 5 }, () =>
          window.yuantu.projects({ type: 'search', query: 'no-such-message' }),
        ),
        window.yuantu.projects({ type: 'search', query: 'GLOBAL_NEEDLE' }),
      ]),
    );
    assert.equal(
      concurrent.at(-1).ok,
      true,
      'the latest query must survive cancellation of obsolete queries',
    );
    assert.equal(concurrent.at(-1).search.hits.length, 2);
    assert.equal(
      concurrent.slice(0, -1).some((reply) => !reply.ok),
      true,
    );
    await page.screenshot({ path: artifactPath('sidebar-global-search.png') });
    await page
      .locator('.project-search-result')
      .filter({ hasText: 'Background conversation' })
      .click();
    await page.waitForFunction(
      (id) => document.querySelector('#sessions .selected')?.getAttribute('data-session-id') === id,
      wanted,
    );
    await page.locator('#session-search').waitFor({ state: 'hidden' });
    await search.click();
    await page.locator('#session-search').fill('no-such-message');
    await page.locator('#session-search-empty').waitFor();
    await page.locator('#clear-session-search').focus();
    await page.keyboard.press('Escape');
    await page.locator('#session-search').waitFor({ state: 'hidden' });
    assert.equal(await search.evaluate((element) => element === document.activeElement), true);
    await search.click();
    await page.locator('#session-search').fill('GLOBAL_NEEDLE');
    await page.locator('#clear-session-search').click();
    assert.equal(await page.locator('#session-search').isVisible(), false);
    await search.click();
    await page.locator('#session-search').fill('no-such-message');
    await page.locator('#prompt').click();
    assert.equal(
      await page.locator('#session-search').isVisible(),
      false,
      'clicking outside closes search',
    );
    await page.locator('#open-workspace').click();
    await page.screenshot({ path: artifactPath('sidebar-workspace-layout.png') });
    assert.deepEqual(errors, []);
  },
);
