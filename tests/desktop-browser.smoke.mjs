// @test-serial desktop-ui: Launches a real Electron window with a WebContentsView guest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture } from './http-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';

test(
  'the panel browser navigates a local page, keeps history and closes its view',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-browser-ui-'));
    await mkdir(path.join(root, '.yuantu'), { recursive: true });
    new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite')).close();
    const site = await httpFixture(t, (_body, res, _headers, url) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const page = url === '/two' ? 'Two' : 'One';
      res.end(`<title>${page}</title><h1>${page}</h1>`);
    });
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
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
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);

    await page.locator('#open-workspace').click();
    await page.locator('#workspace-new-browser').click();
    await page.locator('[data-browser-start]').waitFor();
    const tab = page.locator('[data-browser-tab]').first();
    await tab.waitFor();
    const address = page.locator('.browser-address');
    await address.fill(`${site}/one`);
    await address.press('Enter');

    const guest = async (needle) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const found = app.windows().find((candidate) => candidate.url().includes(needle));
        if (found) return found;
        await page.waitForTimeout(50);
      }
      throw new Error(`guest page ${needle} did not appear`);
    };

    const one = await guest('/one');
    await one.locator('h1').waitFor();
    assert.equal(await one.locator('h1').innerText(), 'One');
    assert.equal(await one.evaluate(() => typeof require), 'undefined');
    assert.equal(await one.evaluate(() => typeof window.yuantu), 'undefined');
    await page.waitForFunction(
      () =>
        document.querySelector('.workspace-browser-tab .workspace-tab span')?.textContent === 'One',
    );

    await address.fill(`${site}/two`);
    await address.press('Enter');
    const two = await guest('/two');
    await two.locator('h1').waitFor();
    await page.locator('.browser-toolbar button').first().click();
    await page.waitForFunction(() =>
      document.querySelector('.browser-address')?.value.includes('/one'),
    );
    await page.locator('.browser-toolbar button').nth(1).click();
    await page.waitForFunction(() =>
      document.querySelector('.browser-address')?.value.includes('/two'),
    );

    // A POST popup is refused with a notice rather than degraded to GET; then a GET popup becomes a panel tab.
    await two.evaluate(() => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/posted';
      form.target = '_blank';
      document.body.append(form);
      form.submit();
    });
    await page.locator('.browser-notice').waitFor();
    assert.match(await page.locator('.browser-notice').innerText(), /表单|form/i);
    await two.evaluate(() => window.open('/popup'));
    await page.waitForFunction(() => document.querySelectorAll('[data-browser-tab]').length === 2);
    const popup = await guest('/popup');
    await popup.locator('h1').waitFor();

    await address.fill('http://127.0.0.1:1/');
    await address.press('Enter');
    await page.locator('[data-browser-error]').waitFor();

    while (await page.locator('.workspace-browser-tab').count())
      await page.locator('.workspace-browser-tab .workspace-tab-close').first().click();
    await page.locator('[data-browser-tab]').waitFor({ state: 'detached' });
    await page.waitForFunction(() => !document.querySelector('.workspace-browser-tab'));
  },
);
