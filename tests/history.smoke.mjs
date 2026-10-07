import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { waitForPage } from './page-wait.mjs';

test(
  'desktop pages older history while preserving existing message nodes and the reading position',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-history-ui-'));
    await mkdir(path.join(root, '.yuantu'));
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const session = store.create(root);
    for (let i = 0; i < 250; i++)
      store.append(session.id, { role: 'user', content: `HISTORY_ENTRY_${i}` });
    store.close();
    let modelRequests = 0;
    const endpoint = await httpFixture(t, (body, res) => {
      modelRequests++;
      assert.match(
        JSON.stringify(body.messages),
        /HISTORY_ENTRY_0/,
        'display paging cannot truncate the model history',
      );
      sendFrames(res, frames('History reply'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'history-model',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: endpoint,
      YUANTU_API_KEY: 'synthetic-history-key',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_MAX_OUTPUT_TOKENS: '4096',
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await page.locator(`[data-session-id="${session.id}"]`).first().click();
    await page.getByText('HISTORY_ENTRY_249', { exact: true }).waitFor();
    assert.equal(await page.locator('#messages > .message').count(), 100);
    await page.evaluate(() => {
      window.savedHistoryNode = document.querySelector('#messages > .message');
      const area = document.querySelector('#conversation');
      area.scrollTop = 0;
      window.savedHistoryTop = window.savedHistoryNode.getBoundingClientRect().top;
    });
    await page.locator('#load-older-history').click();
    await page.getByText('HISTORY_ENTRY_50', { exact: true }).waitFor();
    assert.equal(await page.locator('#messages > .message').count(), 200);
    assert.equal(await page.evaluate(() => window.savedHistoryNode.isConnected), true);
    assert.ok(
      await page.evaluate(
        () =>
          Math.abs(window.savedHistoryNode.getBoundingClientRect().top - window.savedHistoryTop) <
          4,
      ),
      'the old first message stays at its reading position',
    );
    await page.locator('#prompt').fill('Reply');
    await page.locator('#send').click();
    await page.getByText('History reply', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    assert.equal(
      await page.evaluate(() => window.savedHistoryNode.isConnected),
      true,
      'appending a reply reuses the unchanged history',
    );
    assert.equal(modelRequests, 1);
  },
);

test(
  'loading an older process interval retains the open group and the visible internal step',
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-history-process-'));
    await mkdir(path.join(root, '.yuantu'));
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const session = store.create(root);
    for (let i = 0; i < 250; i++)
      store.append(session.id, {
        role: 'tool',
        toolCallId: `step-${i}`,
        content: `PROCESS_ENTRY_${i}`,
        isError: false,
      });
    store.close();
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'history-model',
      YUANTU_API_KEY: 'synthetic-process-key',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await page.locator(`[data-session-id="${session.id}"]`).first().click();
    await page.locator('#load-older-history').waitFor();
    await page.evaluate(() => {
      document.querySelector('#messages > .process-group').open = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await page.evaluate(() => {
      const group = document.querySelector('#messages > .process-group');
      group.open = true;
      const steps = group.querySelector('.process-steps');
      steps.scrollTop = 200;
      document.querySelector('#conversation').scrollTop = 0;
      const boundary = steps.getBoundingClientRect().top;
      window.savedProcessStep = [...steps.children].find(
        (step) => step.getBoundingClientRect().bottom > boundary,
      );
      window.savedProcessTop = window.savedProcessStep.getBoundingClientRect().top;
      window.savedProcessGroup = group;
    });
    await page.locator('#load-older-history').click();
    await waitForPage(
      page,
      () => document.querySelector('#messages .process-steps').children.length === 200,
    );
    const result = await page.evaluate(() => ({
      sameGroup: window.savedProcessGroup.isConnected,
      open: window.savedProcessGroup.open,
      delta: Math.abs(window.savedProcessStep.getBoundingClientRect().top - window.savedProcessTop),
      outerScroll: document.querySelector('#conversation').scrollTop,
      innerScroll: window.savedProcessGroup.querySelector('.process-steps').scrollTop,
    }));
    assert.equal(result.sameGroup, true);
    assert.equal(result.open, true);
    assert.ok(result.delta < 4, `visible internal step moved: ${JSON.stringify(result)}`);
    await page.locator('#open-settings').click();
    await page.locator('#general-settings').click();
    await page.locator('#ui-language').selectOption('en-US');
    await page.locator('#settings-back').click();
    assert.equal(
      await page.locator('#messages > .process-group').evaluate((group) => group.open),
      true,
    );
    assert.equal(
      await page.locator('#messages .process-steps').evaluate((steps) => steps.scrollTop),
      result.innerScroll,
      'language changes preserve the internal scroll position',
    );
  },
);
