// @test-serial desktop-ui: Launches a real Electron window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { artifactPath, setWindowContentSize } from './desktop-smoke-support.mjs';

test(
  'both side regions animate open and closed without losing the chat draft',
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-side-region-motion-'));
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'fixture',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
      YUANTU_SESSION_TITLES: 'false',
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
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace')?.disabled);
    await setWindowContentSize(app, page, 1220, 800);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#prompt').fill('Keep this draft through both side transitions');
    await page.evaluate(() => {
      window.originalPrompt = document.querySelector('#prompt');
    });

    const trace = async (button, region, targetWidth) => {
      await page.evaluate((region) => {
        window.sideFrames = [];
        window.sampleSide = true;
        const sample = () => {
          const node = document.querySelector(region);
          const box = node.getBoundingClientRect();
          const sidebar = document.querySelector('#chat-sidebar').getBoundingClientRect();
          const main = getComputedStyle(document.querySelector('.desktop-shell-main'));
          window.sideFrames.push({
            width: box.width,
            left: box.left,
            sidebarRight: sidebar.right,
            workspaceLeft: document.querySelector('.desktop-shell-aside').getBoundingClientRect()
              .left,
            paddingLeft: parseFloat(main.paddingLeft),
            paddingRight: parseFloat(main.paddingRight),
            visible:
              getComputedStyle(node).visibility !== 'hidden' &&
              getComputedStyle(node).display !== 'none',
          });
          if (window.sampleSide) requestAnimationFrame(sample);
        };
        sample();
      }, region);
      await page.locator(button).click();
      await page.waitForFunction(
        ({ region, targetWidth }) =>
          Math.abs(document.querySelector(region).getBoundingClientRect().width - targetWidth) < 1,
        { region, targetWidth },
      );
      return page.evaluate(() => {
        window.sampleSide = false;
        return window.sideFrames;
      });
    };
    for (const [target, button] of [
      [56, '#toggle-sidebar'],
      [272, '#toggle-sidebar'],
    ]) {
      const frames = await trace(button, '#chat-sidebar', target);
      assert.ok(
        frames.some((frame) => frame.width > 58 && frame.width < 270),
        'the session sidebar paints intermediate widths in both directions',
      );
      assert.ok(
        frames.every((frame) => Math.abs(frame.paddingLeft - frame.width) < 2),
        'the conversation offset follows the painted sidebar width',
      );
    }
    await page.locator('#open-workspace').click();
    await page.waitForFunction(() => document.body.dataset.workspaceView === 'open');
    await page.waitForFunction(() =>
      document
        .querySelector('.desktop-shell')
        .getAnimations()
        .every((a) => a.playState !== 'running'),
    );
    const width = await page
      .locator('.desktop-shell-aside')
      .evaluate((el) => el.getBoundingClientRect().width);
    const closing = await trace('#workspace-close', '.desktop-shell-aside', 0);
    assert.ok(
      closing.some((frame) => frame.width > 2 && frame.width < width - 2 && frame.visible),
      'workspace content stays painted while its region closes',
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('.desktop-shell-aside')).visibility === 'hidden',
    );
    const opening = await trace('#open-workspace', '.desktop-shell-aside', width);
    assert.ok(
      opening.some((frame) => frame.width > 2 && frame.width < width - 2 && frame.visible),
      'workspace opening paints intermediate widths',
    );
    for (const frames of [closing, opening]) {
      assert.ok(
        frames.every((frame) => Math.abs(frame.paddingRight - frame.width) < 2),
        'the conversation offset follows the painted workspace width',
      );
      assert.ok(frames.every((frame) => frame.left >= frame.sidebarRight - 1));
    }
    await page.locator('#workspace-fullscreen').click();
    await page.waitForFunction(() =>
      document
        .querySelector('.desktop-shell')
        .getAnimations()
        .every((a) => a.playState !== 'running'),
    );
    for (const target of [56, 272]) {
      const frames = await trace('#toggle-sidebar', '#chat-sidebar', target);
      assert.ok(
        frames.every((frame) => frame.workspaceLeft >= frame.sidebarRight - 1),
        'an enlarged workspace never covers the moving session sidebar',
      );
      await page.waitForFunction(() =>
        document
          .querySelector('.desktop-shell')
          .getAnimations()
          .every((a) => a.playState !== 'running'),
      );
    }
    await page.locator('#workspace-fullscreen').click();
    await page.waitForFunction(() =>
      document
        .querySelector('.desktop-shell')
        .getAnimations()
        .every((a) => a.playState !== 'running'),
    );
    await page.locator('#workspace-close').evaluate((button) => button.click());
    await page.waitForFunction(
      () => document.querySelector('.desktop-shell-aside').getBoundingClientRect().width < 300,
    );
    await page.locator('#open-workspace').evaluate((button) => button.click());
    await page.waitForFunction(
      (width) =>
        Math.abs(
          document.querySelector('.desktop-shell-aside').getBoundingClientRect().width - width,
        ) < 1,
      width,
    );
    await page.locator('#workspace-close').click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(
      () => document.querySelector('.desktop-shell-aside').getBoundingClientRect().width < 1,
    );
    await page.locator('#toggle-sidebar').click();
    assert.equal(
      await page
        .locator('#chat-sidebar')
        .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
      56,
    );
    await page.locator('#open-workspace').click();
    await page.waitForFunction(() => document.body.dataset.workspaceView === 'open');
    assert.equal(
      await page
        .locator('.desktop-shell')
        .evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length),
      0,
    );
    assert.equal(
      await page.locator('#prompt').inputValue(),
      'Keep this draft through both side transitions',
    );
    assert.equal(
      await page.evaluate(() => window.originalPrompt === document.querySelector('#prompt')),
      true,
    );
  },
);

test(
  'workspace expands smoothly beside the usable session sidebar',
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-workspace-expand-'));
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_MODEL: '',
      YUANTU_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      YUANTU_SESSION_TITLES: 'false',
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
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace')?.disabled);
    await setWindowContentSize(app, page, 1220, 800);
    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
    await page.locator('#open-workspace').click();

    const geometry = () =>
      page.evaluate(() => {
        const panel = document.querySelector('#workspace-panel');
        const sidebar = document.querySelector('#chat-sidebar');
        const box = panel.getBoundingClientRect();
        const nav = sidebar.getBoundingClientRect();
        return {
          width: box.width,
          left: box.left,
          sidebarRight: nav.right,
          sidebarVisible: getComputedStyle(sidebar).display !== 'none' && nav.width > 0,
          sidebarInert: sidebar.inert,
        };
      });
    const settled = (expanded) =>
      page.waitForFunction((expanded) => {
        const aside = document.querySelector('.desktop-shell');
        return (
          document.body.dataset.workspaceView === (expanded ? 'fullscreen' : 'open') &&
          aside.getAnimations().every((animation) => animation.playState !== 'running')
        );
      }, expanded);
    const traceToggle = async (expanded) => {
      await page.evaluate(() => {
        window.workspaceFrames = [];
        window.traceWorkspace = true;
        const sample = () => {
          const panel = document.querySelector('#workspace-panel').getBoundingClientRect();
          const sidebar = document.querySelector('#chat-sidebar');
          window.workspaceFrames.push({
            width: panel.width,
            left: panel.left,
            sidebarRight: sidebar.getBoundingClientRect().right,
            sidebarVisible: getComputedStyle(sidebar).display !== 'none',
            sidebarInert: sidebar.inert,
          });
          if (window.traceWorkspace) requestAnimationFrame(sample);
        };
        sample();
      });
      await page.locator('#workspace-fullscreen').click();
      await settled(expanded);
      return page.evaluate(() => {
        window.traceWorkspace = false;
        return window.workspaceFrames;
      });
    };

    for (const collapsed of [false, true]) {
      if (collapsed) {
        await page.locator('#toggle-sidebar').click();
        await page.waitForFunction(
          () => document.querySelector('#chat-sidebar').offsetWidth === 56,
        );
      }
      await settled(false);
      const docked = await geometry();
      const expansion = await traceToggle(true);
      const expanded = await geometry();
      assert.ok(
        expansion.every((frame) => frame.sidebarVisible && !frame.sidebarInert),
        'the session sidebar stays visible and interactive throughout expansion',
      );
      assert.ok(
        Math.abs(expanded.left - docked.sidebarRight) <= 1,
        'the enlarged workspace stops at the session sidebar',
      );
      assert.ok(
        expansion.some(
          (frame) => frame.width > docked.width + 2 && frame.width < expanded.width - 2,
        ),
        'expansion paints intermediate widths instead of flashing to its final bounds',
      );
      assert.ok(expansion.every((frame) => frame.left >= frame.sidebarRight - 1));
      assert.equal(
        await page.locator('#workspace-fullscreen').getAttribute('data-tooltip'),
        '还原窗口',
      );
      assert.equal(await page.locator('#workspace-panel').getAttribute('aria-modal'), null);
      if (process.env.YUANTU_QA_SCREENSHOT) {
        await mkdir(artifactPath(''), { recursive: true });
        await page.screenshot({
          path: artifactPath(
            collapsed ? 'workspace-expanded-collapsed-sidebar.png' : 'workspace-expanded.png',
          ),
        });
      }
      const restoration = await traceToggle(false);
      assert.ok(
        restoration.some(
          (frame) => frame.width > docked.width + 2 && frame.width < expanded.width - 2,
        ),
        'restoration also paints intermediate widths',
      );
      assert.ok(Math.abs((await geometry()).width - docked.width) <= 1);
      assert.equal(
        await page.locator('#workspace-fullscreen').getAttribute('data-tooltip'),
        '放大窗口',
      );
    }

    // A second click during the resize must continue from the painted width without a jump.
    await page.locator('#workspace-fullscreen').click();
    await page.waitForFunction(() =>
      document
        .querySelector('.desktop-shell')
        .getAnimations()
        .some((a) => a.playState === 'running'),
    );
    await page.locator('#workspace-fullscreen').evaluate((button) => button.click());
    await settled(false);
    assert.ok((await geometry()).sidebarVisible);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setWindowContentSize(app, page, 860, 720);
    await page.locator('#workspace-fullscreen').click();
    await settled(true);
    const compact = await geometry();
    assert.ok(Math.abs(compact.left - compact.sidebarRight) <= 1);
    assert.ok(Math.abs(compact.width - (860 - compact.sidebarRight)) <= 1);
    assert.equal(
      await page.locator('.desktop-shell-aside').evaluate((el) => el.getAnimations().length),
      0,
    );
    await page.locator('#workspace-fullscreen').focus();
    await page.keyboard.press('Escape');
    await settled(false);
    await page.locator('#workspace-fullscreen').click();
    await page.locator('#open-settings').click();
    await page.locator('.settings-dialog').waitFor();
    assert.equal(
      await page.evaluate(() => document.body.dataset.workspaceView),
      'open',
      'the sidebar settings action remains usable from an enlarged workspace',
    );
  },
);
