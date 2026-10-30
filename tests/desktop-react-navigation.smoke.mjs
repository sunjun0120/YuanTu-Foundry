// @test-serial desktop-ui: Product navigation, motion frames and preserved conversation state in real Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { artifactPath } from './desktop-smoke-support.mjs';
import { translate } from '../apps/desktop/i18n.ts';

for (const reduced of [false, true]) {
  test(
    `product navigation preserves the conversation and records ${reduced ? 'reduced' : 'normal'} motion`,
    { timeout: 60000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'react-navigation-'));
      await mkdir(path.join(root, '.yuantu'));
      const store = new SessionStore(path.join(root, '.yuantu/sessions.sqlite'));
      const session = store.create(root);
      for (let i = 0; i < 35; i++) {
        store.append(session.id, {
          role: 'user',
          content: 'NAVIGATION ' + i + ' ' + 'history '.repeat(24),
        });
        store.append(session.id, {
          role: 'assistant',
          content: 'reply ' + i + ' ' + 'context '.repeat(30),
          toolCalls: [],
        });
      }
      store.close();
      const attachment = path.join(root, 'draft-note.txt');
      await writeFile(attachment, 'Keep this attachment while navigating.');
      const endpoint = await httpFixture(t, (_body, res) => sendFrames(res, frames('done')));
      const env = {
        ...process.env,
        YUANTU_WORKSPACE: root,
        YUANTU_NODE_PATH: process.execPath,
        YUANTU_SANDBOX: 'host',
        YUANTU_PROTOCOL: 'anthropic',
        YUANTU_BASE_URL: endpoint,
        YUANTU_API_KEY: 'fixture',
        YUANTU_MODEL: 'navigation-fixture',
        YUANTU_SESSION_TITLES: 'false',
      };
      delete env.ELECTRON_RUN_AS_NODE;
      let app;
      t.after(async () => {
        await app?.close();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      });
      app = await electron.launch({
        executablePath: electronPath,
        args: [
          path.resolve('dist/desktop/main.cjs'),
          '--user-data-dir=' + path.join(root, 'profile'),
        ],
        env,
      });
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.waitForFunction(() => !document.querySelector('#prompt')?.disabled);
      assert.equal(await page.locator('#chat-page[data-page-pane]').count(), 1);
      const failures = [];
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') failures.push(message.text());
      });
      await page
        .getByRole('textbox', { name: translate('ui.taskDescription', 'zh-CN') })
        .fill('A draft survives page navigation');
      await page.locator('input[type=file]').setInputFiles(attachment);
      await page.getByText('draft-note.txt', { exact: true }).first().waitFor();
      const before = await page.evaluate(() => {
        window.__conversation = document.getElementById('conversation');
        window.__prompt = document.getElementById('prompt');
        window.__conversation.scrollTop = 300;
        return window.__conversation.scrollTop;
      });
      assert.ok(before > 0);
      const dir = artifactPath('react-navigation-' + (reduced ? 'reduced' : 'normal'));
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'start.png') });
      const cdp = await page.context().newCDPSession(page);
      const captured = [];
      cdp.on('Page.screencastFrame', (frame) => {
        captured.push(frame);
        void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      });
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await page.evaluate(() => {
        window.__navigationFrames = [];
        const sample = () => {
          window.__navigationFrames.push(
            ['chat-page', 'settings-page'].map((id) => {
              const element = document.getElementById(id);
              return {
                id,
                opacity: Number(
                  getComputedStyle(
                    id === 'settings-page' ? element.closest('.settings-dialog') : element,
                  ).opacity,
                ),
                hidden: element.getClientRects().length === 0,
                inert: element.inert,
                active: element.dataset.pageActive,
              };
            }),
          );
          if (window.__navigationFrames.length < 50) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page
        .getByRole('button', { name: translate('ui.settings', 'zh-CN'), exact: true })
        .click();
      await page.waitForFunction(
        () =>
          Number(getComputedStyle(document.getElementById('settings-page')).opacity) === 1 &&
          document.getElementById('chat-page').hidden,
      );
      await cdp.send('Page.stopScreencast');
      const timeline = await page.evaluate(() => window.__navigationFrames);
      if (!reduced)
        assert.ok(
          timeline.some((frame) => frame.some((p) => !p.hidden && p.opacity > 0 && p.opacity < 1)),
          'normal navigation must produce intermediate frames',
        );
      else
        assert.equal(
          timeline.some((frame) => frame.some((p) => !p.hidden && p.opacity > 0 && p.opacity < 1)),
          false,
        );
      for (const frame of timeline)
        assert.ok(
          frame.filter((p) => !p.hidden && !p.inert).length <= 1,
          'outgoing content cannot stay interactive',
        );
      await writeFile(path.join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2));
      for (const [index, frame] of captured.entries())
        await writeFile(
          path.join(dir, `frame-${String(index).padStart(3, '0')}.png`),
          Buffer.from(frame.data, 'base64'),
        );
      await page.screenshot({ path: path.join(dir, 'settings.png') });
      await page.getByRole('button', { name: translate('ui.backToChat', 'zh-CN') }).click();
      await page.locator('.settings-dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !document.getElementById('chat-page').inert);
      assert.equal(
        await page
          .getByRole('textbox', { name: translate('ui.taskDescription', 'zh-CN') })
          .inputValue(),
        'A draft survives page navigation',
      );
      assert.equal(
        await page.getByText('draft-note.txt', { exact: true }).first().isVisible(),
        true,
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          sameConversation: window.__conversation === document.getElementById('conversation'),
          samePrompt: window.__prompt === document.getElementById('prompt'),
          scroll: document.getElementById('conversation').scrollTop,
        })),
        { sameConversation: true, samePrompt: true, scroll: before },
      );
      // A fast reversal before exit completes must keep the last target and the same form elements.
      await page.evaluate(async () => {
        document.getElementById('open-settings').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.getElementById('settings-back').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.getElementById('open-settings').click();
      });
      await page.waitForFunction(
        () =>
          document.body.dataset.page === 'settings' &&
          document.getElementById('chat-page').hidden &&
          Number(getComputedStyle(document.getElementById('settings-page')).opacity) === 1,
      );
      assert.equal(await page.getByRole('main').count(), 1);
      assert.deepEqual(failures, []);
      await page.screenshot({ path: path.join(dir, 'end.png') });
    },
  );
}
