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
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(15000);
    await page.waitForFunction(
      () => document.querySelector('#prompt') && !document.querySelector('#prompt').disabled,
    );
    await page.emulateMedia({ colorScheme: 'light' });
    const toggle = page.locator('#toggle-sidebar');
    assert.equal(await toggle.count(), 1, 'the logo row must offer a sidebar toggle');
    await page.locator('#prompt').fill('Keep this draft while folding the sidebar');
    const originalSession = await page.evaluate(async () => {
      window.__sidebarPrompt = document.getElementById('prompt');
      window.__sidebarProjects = document.querySelector('.project-sidebar');
      return (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId;
    });
    await toggle.hover();
    const tip = page.getByRole('tooltip', { name: '收起侧边栏' });
    await tip.waitFor();
    assert.deepEqual(
      await tip.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          background: style.backgroundColor,
          color: style.color,
          radius: style.borderRadius,
        };
      }),
      { background: 'rgb(26, 26, 26)', color: 'rgb(255, 255, 255)', radius: '10px' },
    );
    await mkdir(artifactPath(''), { recursive: true });
    await page.screenshot({ path: artifactPath('sidebar-toggle-tooltip.png') });
    await toggle.click();
    await page.waitForFunction(
      () =>
        Math.abs(document.getElementById('chat-sidebar').getBoundingClientRect().width - 56) < 1,
    );
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.project-sidebar-expanded').isVisible(), false);
    const spaces = page.locator('#collapsed-spaces-trigger');
    assert.equal(await spaces.isVisible(), true);
    await spaces.click();
    const spacesCard = page.locator('#collapsed-spaces-card');
    await spacesCard.waitFor();
    assert.equal(
      await spacesCard.getByRole('heading', { name: '空间', exact: true }).isVisible(),
      true,
    );
    assert.equal(await spacesCard.getByText('Alpha', { exact: true }).isVisible(), true);
    assert.ok(
      (await spacesCard.locator('.collapsed-space-session').count()) > 0,
      'the active space immediately shows its conversations',
    );
    const cardBounds = await spacesCard.boundingBox();
    assert.ok(
      cardBounds.x >= 56 && cardBounds.width >= 260,
      'spaces open beside the collapsed rail',
    );
    await page.screenshot({ path: artifactPath('sidebar-collapsed-spaces.png') });
    await page.locator('#prompt').click();
    await spacesCard.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#new-session').isVisible(), true);
    assert.equal(await page.locator('#open-settings').isVisible(), true);
    assert.equal(
      await page.locator('#prompt').inputValue(),
      'Keep this draft while folding the sidebar',
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        prompt: window.__sidebarPrompt === document.getElementById('prompt'),
        projects: window.__sidebarProjects === document.querySelector('.project-sidebar'),
        overflow: document.documentElement.scrollWidth > innerWidth,
      })),
      { prompt: true, projects: true, overflow: false },
    );
    await page.locator('#prompt').focus();
    await page.locator('#prompt').hover();
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    await page.screenshot({ path: artifactPath('sidebar-collapsed.png') });
    await page.locator('#open-settings').click();
    await page.locator('#settings-page').waitFor();
    await page.locator('#settings-back').click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    await page.waitForFunction(
      () =>
        Math.abs(document.getElementById('chat-sidebar').getBoundingClientRect().width - 272) < 1,
    );
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.project-sidebar').isVisible(), true);
    assert.equal((await page.locator('.project-group-toggle').innerText()).trim(), '空间');
    await page.locator('#open-session-search').hover();
    const searchTip = page.getByRole('tooltip', { name: '全局搜索' });
    await searchTip.waitFor();
    assert.equal(
      await searchTip.evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgb(26, 26, 26)',
    );
    assert.equal(await page.locator('#open-session-search').getAttribute('title'), null);
    await page.screenshot({ path: artifactPath('sidebar-space-tooltip.png') });
    assert.deepEqual(
      await page.evaluate(() => ({
        sidebar: getComputedStyle(document.getElementById('chat-sidebar')).backgroundColor,
        chat: getComputedStyle(document.getElementById('chat-page')).backgroundColor,
        composer: getComputedStyle(document.getElementById('composer')).backgroundColor,
        border: getComputedStyle(document.getElementById('composer')).borderRadius,
        attachRadius: getComputedStyle(document.getElementById('attach-image')).borderRadius,
        sendRadius: getComputedStyle(document.getElementById('send')).borderRadius,
        permissionRadius: getComputedStyle(document.getElementById('permission-trigger'))
          .borderRadius,
      })),
      {
        sidebar: 'rgb(240, 240, 240)',
        chat: 'rgb(248, 248, 247)',
        composer: 'rgb(255, 255, 255)',
        border: '14px',
        attachRadius: '50%',
        sendRadius: '50%',
        permissionRadius: '20px',
      },
    );
    assert.equal((await page.locator('#new-session').innerText()).trim(), '新建任务');
    assert.equal(
      await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
      ),
      originalSession,
    );
    await page.locator('#prompt').fill('');
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
    await page.waitForFunction(
      () =>
        document
          .querySelector('.project-row.selected .project-name')
          ?.getAttribute('aria-expanded') === 'false',
    );
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
    assert.equal(
      await page.locator('.workspace-panel').evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgb(255, 255, 255)',
    );
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
    await page.waitForFunction(
      () =>
        document.getElementById('chat-page').getBoundingClientRect().right <=
        document.querySelector('.workspace-panel').getBoundingClientRect().left + 1,
    );
    const inputBoundsWithWorkspace = await page.evaluate(() => ({
      input: document.getElementById('composer').getBoundingClientRect().right,
      send: document.getElementById('send').getBoundingClientRect().right,
      chat: document.getElementById('chat-page').getBoundingClientRect().right,
    }));
    assert.ok(
      inputBoundsWithWorkspace.send <= inputBoundsWithWorkspace.input &&
        inputBoundsWithWorkspace.input <= inputBoundsWithWorkspace.chat,
      'the composer stays within the center column while files are open',
    );
    await page.screenshot({ path: artifactPath('sidebar-workspace-layout.png') });
    const previousSession = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await toggle.click();
    await page.locator('#new-session').click();
    await page.waitForFunction(
      async (id) =>
        (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId !== id,
      previousSession,
    );
    assert.equal(
      await toggle.getAttribute('aria-expanded'),
      'false',
      'creating a task from the rail keeps the sidebar collapsed',
    );
    assert.deepEqual(errors, []);
  },
);
