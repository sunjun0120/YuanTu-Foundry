// @test-serial desktop-ui: Launches real Electron windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, chromium } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { waitFor } from './desktop-smoke-support.mjs';

async function desktop(t, endpoint) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-round3-'));
  const env = {
    ...process.env,
    YUANTU_WORKSPACE: root,
    YUANTU_NODE_PATH: process.execPath,
    YUANTU_STATE_DIR: path.join(root, 'state'),
    YUANTU_PROTOCOL: 'anthropic',
    YUANTU_BASE_URL: endpoint,
    YUANTU_API_KEY: 'fixture',
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_SESSION_TITLES: 'false',
    YUANTU_ALLOW_PRIVATE_NETWORK: '1',
    YUANTU_SANDBOX: 'host',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  t.after(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  app = await electron.launch({
    executablePath: electronPath,
    args: [
      path.resolve('dist/desktop/main.cjs'),
      `--user-data-dir=${path.join(root, 'profile')}`,
      '--no-sandbox',
    ],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
  return { page, root };
}

test(
  'desktop shows the task draft before model planning finishes',
  { timeout: 45_000 },
  async (t) => {
    let finishProposal;
    const endpoint = await httpFixture(t, (_body, res) => {
      finishProposal = () =>
        sendFrames(
          res,
          frames(
            JSON.stringify({
              title: 'Reviewed task',
              description: 'Review notes',
              steps: [{ description: 'Review notes' }],
              acceptance: [{ description: 'Human review', met: false }],
            }),
          ),
        );
    });
    const { page } = await desktop(t, endpoint);
    await page.locator('#prompt').fill('/task Review notes');
    await page.locator('#send').click();
    await waitFor(() => !!finishProposal);
    try {
      await page.locator('#tasks-panel').waitFor({ state: 'visible', timeout: 5000 });
      assert.match(await page.locator('#task-list').innerText(), /Review notes/);
      assert.doesNotMatch(await page.locator('#task-list').innerText(), /Goal:/);
    } finally {
      finishProposal();
    }
    await page.waitForFunction(() =>
      document.querySelector('#task-list').textContent.includes('Reviewed task'),
    );
  },
);

test(
  'desktop bundled Host opens Chromium and saves a screenshot',
  { timeout: 60_000 },
  async (t) => {
    try {
      const browser = await chromium.launch({ headless: true });
      await browser.close();
    } catch (error) {
      if (/Executable doesn't exist/.test(String(error)))
        return t.skip('Chromium is not installed');
      throw error;
    }
    let step = 0;
    let endpoint;
    endpoint = await httpFixture(t, (_body, res, _headers, requestPath) => {
      if (requestPath === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>Round3 browser</title><h1>Rendered in Chromium</h1>');
        return;
      }
      const calls = [
        { id: 'open', name: 'browser_open', input: { url: `${endpoint}/page` } },
        { id: 'shot', name: 'browser_screenshot', input: { path: 'browser.png' } },
        { id: 'close', name: 'browser_close', input: {} },
      ];
      const call = calls[step++];
      sendFrames(res, frames(call ? 'Browser step' : 'Browser complete', call ? [call] : []));
    });
    const { page, root } = await desktop(t, endpoint);
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    await page.locator('#full-access-enable').click();
    await page.waitForFunction(
      () => document.querySelector('#permission-mode').value === 'unconfined',
    );
    const response = await page.evaluate(async () =>
      window.yuantu.invoke({
        type: 'send',
        prompt: 'Open the page and save a screenshot',
      }),
    );
    assert.equal(response.ok, true, response.error);
    const snapshot = response.state;
    const tools = snapshot.session.messages.filter((message) => message.role === 'tool');
    assert.match(tools.map((message) => message.content).join('\n'), /Round3 browser/);
    assert.equal(
      tools.some((message) => message.isError),
      false,
      JSON.stringify(tools),
    );
    assert.equal(
      (await readFile(path.join(root, 'browser.png'))).subarray(0, 4).toString('hex'),
      '89504e47',
    );
  },
);
