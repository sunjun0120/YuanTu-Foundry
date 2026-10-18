// @test-serial desktop-ui: Launches real Electron windows.
// Layout and theme at different window sizes, and the background-task entry in the header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { artifactPath, waitFor } from './desktop-smoke-support.mjs';
process.env.YUANTU_SESSION_TITLES = 'false';

// ---- merged from layout.smoke.mjs ----

test(
  'desktop layout follows theme, preserves composer and fits compact windows',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-layout-'));
    const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('布局验证完成。')));
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'layout-fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_PERMISSION_POLICY: '',
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
        '--user-data-dir=' + path.join(root, 'profile'),
      ],
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'system');
    const logo = async (theme) => {
      assert.equal(
        await page.locator('#chat-page').evaluate((el) => getComputedStyle(el).backgroundColor),
        theme === 'dark' ? 'rgb(20, 20, 22)' : 'rgb(255, 255, 255)',
      );
      assert.equal(await page.locator('.logo-' + theme).isVisible(), true);
      assert.equal(
        await page.locator('.logo-' + (theme === 'dark' ? 'light' : 'dark')).isVisible(),
        false,
      );
      assert.equal(
        await page.locator('.logo-' + theme).evaluate((el) => el.complete && el.naturalWidth > 0),
        true,
      );
    };
    await page.emulateMedia({ colorScheme: 'dark' });
    await logo('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await logo('light');
    await page.locator('#prompt').fill('保留这段草稿');
    await page.locator('#open-settings').click();
    await page.locator('#general-settings').click();
    await page.locator('#ui-language').selectOption('en-US');
    await page.locator('#general-settings-save').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en-US');
    assert.equal(await page.locator('#general-settings-title').innerText(), 'General');
    assert.equal(
      (await page.locator('#settings-back').innerText()).replace(/\s+/g, ' '),
      '← Back to chat',
    );
    assert.equal(
      (await page.locator('#model-settings').innerText()).replace(/\s+/g, ' '),
      'Models',
    );
    assert.equal(await page.locator('#mcp-settings,#mcp-panel').count(), 0);
    // Paused like backups: the bridge has no `mcp` member and the channel is not registered.
    assert.equal(await page.evaluate(() => Object.hasOwn(window.yuantu, 'mcp')), false);
    assert.equal(await page.locator('#permission-settings').count(), 0);
    await page.locator('#settings-back').click();
    await page.waitForFunction(() => !document.querySelector('#permission-mode').disabled);
    /**
     * The harness launches this suite with `YUANTU_SANDBOX=host` (25 real windows must not each pay for a native
     * backend initialization), and a `host` + `ask` pair is deliberately not one of the three presets. The honest
     * reading is therefore "custom": the value is shown and explained, but it cannot be selected. The default
     * `guarded` reading is asserted by `tests/agent.smoke.mjs`, which launches with the product default.
     */
    assert.equal(await page.locator('#permission-mode').inputValue(), 'custom');
    // Whatever the launch environment started this session in, cancelling a dialog must leave it exactly there.
    const initialPreset = await page.locator('#permission-mode').inputValue();
    await page.locator('#permission-trigger').click();
    // The "custom" reading lives in the open menu: the chip shows the name, the menu explains where it came from.
    assert.equal(await page.locator('#permission-custom').isVisible(), true);
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    assert.equal(await page.locator('#full-access-dialog').isVisible(), true);
    // The dialog says what changes and asks for one acknowledgement; the × and 取消 are the same way out.
    assert.equal(
      await page.locator('#full-access-acknowledge-label').innerText(),
      'I understand the risks and want to continue',
    );
    assert.equal(
      await page.getByText('I understand the risks and want to continue', { exact: true }).count(),
      1,
    );
    assert.match(
      await page.locator('#full-access-description').innerText(),
      /Use it only when you trust the current task\./,
    );
    assert.equal(await page.locator('#full-access-enable').isDisabled(), true);
    assert.equal(await page.locator('#permission-mode').inputValue(), initialPreset);
    await page.locator('#full-access-close').click();
    assert.equal(await page.locator('#full-access-dialog').isVisible(), false);
    assert.equal(await page.locator('#permission-mode').inputValue(), initialPreset);
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    assert.equal(await page.locator('#full-access-dialog').isVisible(), true);
    await page.locator('#full-access-cancel').click();
    assert.equal(await page.locator('#permission-mode').inputValue(), initialPreset);
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    await page.locator('#full-access-acknowledge').check();
    assert.equal(await page.locator('#full-access-enable').isEnabled(), true);
    await page.locator('#full-access-enable').click();
    /**
     * The wait is on the renderer's own value, not on a `presets.get` poll: the store's pair flips in memory
     * before the policy file lands, so an IPC read can answer "unconfined" while the page still draws `guarded`.
     */
    await page.waitForFunction(
      () =>
        document.querySelector('#permission-mode').value === 'unconfined' &&
        !document.querySelector('#permission-mode').disabled,
    );
    assert.equal(await page.locator('#permission-mode').inputValue(), 'unconfined');
    /**
     * The hidden select is the machine-readable value the menu draws, and driving it exercises the same path a
     * click does. `observe` moves the sandbox back off the host, so this is also the restart-on-preset case.
     */
    await page.locator('#permission-mode').evaluate((el) => {
      el.value = 'observe';
      el.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(
      () =>
        document.querySelector('#permission-mode').value === 'observe' &&
        !document.querySelector('#permission-mode').disabled,
    );
    const visibleHan = async () =>
      page.evaluate(() => {
        const visible = (element) => {
          const style = getComputedStyle(element);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.getClientRects().length > 0
          );
        };
        const values = [];
        for (const element of document.querySelectorAll('body *')) {
          if (!visible(element) || element.closest('#messages,.message-content,pre')) continue;
          for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && /[\u3400-\u9fff]/u.test(node.textContent || ''))
              values.push((node.textContent || '').trim());
          }
          for (const attribute of ['placeholder', 'aria-label', 'title']) {
            const value = element.getAttribute(attribute);
            if (value && /[\u3400-\u9fff]/u.test(value)) values.push(value);
          }
        }
        return [...new Set(values.filter(Boolean))];
      });
    await page.locator('#open-settings').click();
    for (const tab of ['general-settings', 'model-settings']) {
      await page.locator('#' + tab).click();
      assert.deepEqual(
        await visibleHan(),
        [],
        tab + ' must not contain visible Chinese in English mode',
      );
    }
    await page.locator('#settings-back').click();
    assert.equal(await page.locator('#new-session').innerText(), '＋ New session');
    assert.equal(
      await page.locator('#prompt').getAttribute('placeholder'),
      'Send a message or describe a task...',
    );
    assert.deepEqual(
      await visibleHan(),
      [],
      'chat must not contain visible Chinese in English mode',
    );
    assert.equal(await page.locator('#permission-mode option:checked').innerText(), 'Read only');
    await page.locator('#open-settings').click();
    await page.locator('#general-settings').click();
    await page.locator('#ui-language').selectOption('zh-CN');
    await page.locator('#general-settings-save').click();
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await page.locator('#settings-back').click();
    const theme = async (value) => {
      await page.locator('#open-settings').click();
      await page.locator('#general-settings').click();
      await page.locator('#ui-appearance').selectOption(value);
      const colors = await page.evaluate(() => ({
        settings: getComputedStyle(document.querySelector('#general-settings-content'))
          .backgroundColor,
        chat: getComputedStyle(document.querySelector('#chat-page')).backgroundColor,
        sidebar: getComputedStyle(document.querySelector('.settings-sidebar')).backgroundColor,
        chatSidebar: getComputedStyle(document.querySelector('#chat-sidebar')).backgroundColor,
      }));
      assert.equal(colors.settings, colors.chat);
      assert.equal(colors.sidebar, colors.chatSidebar);
      const field = page.locator('#ui-language');
      const label = await field.locator('..').boundingBox();
      const box = await field.boundingBox();
      assert.ok(box.y >= label.y + 24, 'select must be separated from its label');
      await field.click();
      await page.keyboard.press('Escape');
      // Neither pointer nor keyboard focus should add an outer ring.
      await field.click();
      assert.equal(await field.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      assert.equal(
        await page.locator('#ui-appearance').evaluate((el) => getComputedStyle(el).outlineStyle),
        'none',
      );
      await page.locator('#general-settings-title').click();
      await mkdir(artifactPath(''), { recursive: true });
      await page.screenshot({ path: artifactPath('settings-general-') + value + '.png' });

      await page.locator('#settings-back').click();
      await logo(value);
      assert.equal(await page.locator('#prompt').inputValue(), '保留这段草稿');
    };
    await theme('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await logo('dark');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1232, 720),
    );
    const fits = async () => {
      const rects = await page.evaluate(() => {
        const rect = (id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        };
        return {
          composer: rect('composer'),
          model: rect('model'),
          send: rect('send'),
          sidebar: rect('chat-sidebar'),
          width: innerWidth,
          height: innerHeight,
          overflow: document.body.scrollWidth > innerWidth,
        };
      });
      assert.equal(rects.overflow, false);
      assert.ok(rects.composer.x >= rects.sidebar.right);
      assert.ok(rects.model.y >= rects.composer.y && rects.model.bottom <= rects.composer.bottom);
      assert.ok(rects.send.right <= rects.width && rects.composer.bottom <= rects.height);
    };
    await fits();
    await mkdir(artifactPath(''), { recursive: true });
    await page.locator('#prompt').fill('');
    await page.screenshot({ path: artifactPath('desktop-layout-dark.png') });
    await page.locator('#prompt').fill('保留这段草稿');
    await theme('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await logo('light');
    await page.locator('#prompt').fill('');
    await page.screenshot({ path: artifactPath('desktop-layout-light.png') });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 620),
    );
    await fits();
    await page
      .locator('#prompt')
      .fill(
        '检查桌面布局：这是一条刻意写得很长的会话标题，用来验证头部不会把它整段铺开，' +
          '而是截断到固定的宽度，完整内容留在悬停提示里',
      );
    await page.locator('#send').click();
    await page.waitForFunction(() =>
      document.querySelector('#messages').textContent.includes('布局验证完成'),
    );
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    assert.match(await page.locator('#chat-title').innerText(), /检查桌面布局/);
    // A title is a label, not a paragraph: past the cap it is cut with an ellipsis, and the whole name is
    // still reachable as the tooltip rather than being lost.
    const titleOverflows = await page.locator('#chat-title').evaluate((el) => ({
      clipped: el.scrollWidth > el.clientWidth,
      full: el.getAttribute('title') ?? '',
    }));
    assert.equal(
      titleOverflows.clipped,
      true,
      'a long title must be cut rather than laid out in full',
    );
    assert.match(titleOverflows.full, /检查桌面布局/);
    // The tooltip is the whole name, not the clipped rendering: the cap takes the pixels, not the answer.
    assert.equal(
      titleOverflows.full,
      (await page.locator('#chat-title').innerText()).trim(),
      'the tooltip carries the whole title',
    );
    await page.locator('#open-settings').click();
    // MCP management is paused; general/model navigation still has layout coverage.
    assert.equal(await page.locator('#mcp-settings,#mcp-panel').count(), 0);
    for (const [tab, panel] of [
      ['general-settings', '#general-settings-content'],
      ['model-settings', '[aria-labelledby="settings-title"]'],
      ['general-settings', '#general-settings-content'],
    ]) {
      await page.locator('#' + tab).click();
      assert.equal(
        await page.locator('#settings-page > .settings-content:visible').count(),
        1,
        tab + ' must display exactly one settings panel',
      );
      assert.equal(await page.locator(panel).isVisible(), true);
      const sidebar = await page.locator('.settings-sidebar').boundingBox();
      const content = await page.locator(panel).boundingBox();
      assert.ok(content.x >= sidebar.x + sidebar.width - 1, tab + ' must occupy the right column');
      assert.ok(Math.abs(content.y - sidebar.y) < 1, tab + ' must remain in the first grid row');
    }
    await page.screenshot({ path: artifactPath('settings-layout.png') });

    await page.locator('#settings-back').click();
    await fits();
  },
);

// ---- merged from header-background.smoke.mjs ----

test('background tasks live in a conditional header popover without workspace context', async () => {
  const [html, renderer, css] = await Promise.all([
    readFile('apps/desktop/index.html', 'utf8'),
    readFile('apps/desktop/renderer-background.ts', 'utf8'),
    readFile('apps/desktop/layout-surfaces.css', 'utf8'),
  ]);
  const header = html.match(/<main id="chat-page">[\s\S]*?<header>([\s\S]*?)<\/header>/)?.[1] ?? '';
  assert.match(header, /id="open-background"/);
  assert.match(header, /id="background-popover"/);
  assert.ok(header.indexOf('id="open-background"') > header.indexOf('id="open-subagents"'));
  assert.doesNotMatch(header, /id="project-name"|header-context/);
  assert.doesNotMatch(html, /id="background-page"/);
  assert.doesNotMatch(header, /id="background-policy"|id="background-popover-footer"/);
  assert.match(renderer, /backgroundPopover\.contains\(event\.target as Node\)/);
  assert.match(css, /\.background-popover\s*\{/);
  assert.match(css, /position:\s*absolute/);
});

test(
  'background entry stays hidden without jobs and popover closes on outside click',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-header-background-'));
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      YUANTU_MODEL: '',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        '--user-data-dir=' + path.join(root, 'profile'),
      ],
      env,
    });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    assert.equal(await page.locator('#open-background').isHidden(), true);
    assert.equal(await page.locator('#project-name').count(), 0);
    await page.locator('#open-background').evaluate((button) => {
      button.hidden = false;
    });
    await page.locator('#open-subagents').evaluate((button) => {
      button.hidden = false;
    });
    const headerPositions = await page.evaluate(() => {
      const subagent = document.querySelector('#open-subagents').getBoundingClientRect();
      const background = document.querySelector('#open-background').getBoundingClientRect();
      const heading = document.querySelector('.chat-heading');
      return {
        insideHeading: heading.contains(document.querySelector('#open-background')),
        gap: background.left - subagent.right,
      };
    });
    assert.equal(headerPositions.insideHeading, true);
    assert.ok(headerPositions.gap >= 0 && headerPositions.gap <= 20);
    const states = await page.evaluate(() => {
      const button = document.querySelector('#open-background');
      const popover = document.querySelector('#background-popover');
      button.click();
      const opened = !popover.hidden && button.getAttribute('aria-expanded') === 'true';
      document
        .querySelector('#chat-title')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return { opened, closed: popover.hidden && button.getAttribute('aria-expanded') === 'false' };
    });
    assert.deepEqual(states, { opened: true, closed: true });
  },
);

test(
  'background jobs appear beside subagents with live status and a compact list',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-background-header-ui-'));
    await writeFile(
      path.join(root, 'wait.cjs'),
      'console.log("BACKGROUND_READY");setInterval(()=>{},1000);',
    );
    await writeFile(path.join(root, 'quick.cjs'), 'console.log("BACKGROUND_DONE");');
    let turns = 0;
    const url = await httpFixture(t, (_body, res) => {
      const turn = turns++;
      sendFrames(
        res,
        turn === 0 || turn === 2
          ? frames('Starting background work.', [
              {
                id: `background-ui-${turn}`,
                name: 'start_command',
                input: { command: turn === 0 ? 'node wait.cjs' : 'node quick.cjs' },
              },
            ])
          : frames('The background command is running.'),
      );
    });
    const env = {
      ...process.env,
      YUANTU_SANDBOX: 'host',
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'test',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
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
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('Start a background command');
    await page.locator('#send').click();
    await page.waitForFunction(
      () =>
        !document.querySelector('#open-background').hidden ||
        document.querySelector('#approvals button') !== null,
    );
    if (await page.getByRole('button', { name: '允许一次', exact: true }).isVisible())
      await page.getByRole('button', { name: '允许一次', exact: true }).click();
    await page.locator('#open-background').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#background-policy, #background-popover-footer').count(), 0);
    assert.equal(await page.locator('#open-background').innerText(), '1 个后台任务运行中');
    assert.equal(
      await page
        .locator('#open-background')
        .evaluate((button) => button.closest('.chat-heading') !== null),
      true,
    );
    await page.evaluate(() => {
      const trace = (window.__backgroundPopoverTrace = []);
      const record = (entry) => {
        trace.push({ ...entry, at: Math.round(performance.now()) });
        if (trace.length > 100) trace.shift();
      };
      for (const selector of ['.background-anchor', '#background-popover']) {
        const target = document.querySelector(selector);
        for (const type of ['pointerenter', 'pointerleave', 'pointerdown', 'click'])
          target.addEventListener(type, (event) =>
            record({
              type,
              selector,
              x: event.clientX,
              y: event.clientY,
              related: event.relatedTarget?.className,
              hidden: document.querySelector('#background-popover').hidden,
            }),
          );
      }
      for (const type of ['blur', 'focus']) window.addEventListener(type, () => record({ type }));
      new MutationObserver(() =>
        record({ type: 'hidden', hidden: document.querySelector('#background-popover').hidden }),
      ).observe(document.querySelector('#background-popover'), {
        attributes: true,
        attributeFilter: ['hidden'],
      });
    });
    await page.locator('#open-background').hover();
    await page.locator('#background-popover').waitFor({ state: 'visible' });
    const triggerBounds = await page.locator('#open-background').boundingBox();
    const popoverBounds = await page.locator('#background-popover').boundingBox();
    assert.ok(triggerBounds && popoverBounds);
    assert.ok(popoverBounds.width <= 340, `background list is too wide: ${popoverBounds.width}`);
    assert.ok(
      Math.abs(popoverBounds.x - triggerBounds.x) <= 2,
      `background list should open below its header button (${popoverBounds.x} vs ${triggerBounds.x})`,
    );
    const row = page.locator('#background-list .background-card').first();
    await row.waitFor();
    assert.match(await row.locator('.background-command').innerText(), /node wait\.cjs/);
    /**
     * The row appears while the job is still `启动中` — it is listed from the moment it is accepted, which is the
     * point of listing it — so reading the status once right after `waitFor` is a race the suite lost once. The
     * assertion is the same one; it just waits for the state it is about instead of for the row.
     */
    await page.waitForFunction(() =>
      /运行中/.test(
        document.querySelector('#background-list .background-card .background-status')
          ?.textContent ?? '',
      ),
    );
    assert.match(await row.locator('.background-status').innerText(), /运行中/);
    assert.match(await row.locator('.background-duration').innerText(), /\d+秒/);
    assert.equal(await row.evaluate((element) => element.tagName), 'DIV');
    assert.equal(await row.locator('summary, .background-meta, .background-log').count(), 0);
    // The stop control belongs to the running row and is revealed by the row itself. Opacity is what has to
    // be read here: Playwright's own visibility ignores it, and a control that is merely transparent must not
    // be one a pointer can hit by accident.
    const stopButton = row.locator('.background-stop');
    assert.equal(await row.locator('.background-stop').count(), 1);
    assert.equal(await stopButton.evaluate((el) => getComputedStyle(el).opacity), '0');
    await row.hover();
    await page.waitForFunction(
      () =>
        getComputedStyle(
          document.querySelector('#background-list .background-card .background-stop'),
        ).opacity === '1',
    );
    assert.match(await stopButton.innerText(), /停止任务/);
    await mkdir(artifactPath(''), { recursive: true });
    await page.screenshot({ path: artifactPath('background-hover.png') });
    await row.evaluate((element) => {
      window.__backgroundRow = element;
    });
    await row.locator('.background-command').click();
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.__backgroundRow?.isConnected), true);
    assert.equal(await row.getAttribute('open'), null);
    assert.equal(await row.locator('summary, .background-meta, .background-log').count(), 0);
    const unexpectedlyHidden = await page
      .locator('#background-popover')
      .evaluate((panel) => panel.hidden);
    if (unexpectedlyHidden)
      t.diagnostic(
        'background popover events: ' +
          JSON.stringify(await page.evaluate(() => window.__backgroundPopoverTrace)),
      );
    assert.equal(unexpectedlyHidden, false);
    await row.getByRole('button', { name: '停止任务' }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('#background-list .background-card')
          ?.querySelector('.background-status')?.textContent === '已取消',
    );
    assert.notEqual(await row.locator('.background-duration').innerText(), '—');
    assert.equal(await page.locator('#open-background').innerText(), '1 个后台任务');
    await page.locator('#chat-title').hover();
    await page.locator('#background-popover').waitFor({ state: 'hidden' });
    await page.locator('#prompt').fill('Run a quick background command');
    await page.locator('#send').click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('#background-list .background-card').length === 2 ||
        document.querySelector('#approvals button') !== null,
    );
    if (await page.getByRole('button', { name: '允许一次', exact: true }).isVisible())
      await page.getByRole('button', { name: '允许一次', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('#background-list .background-card').length === 2 &&
        document.querySelectorAll('#background-list .background-status')[1]?.textContent ===
          '退出码：0',
    );
    assert.equal(await page.locator('#open-background').innerText(), '2 个后台任务');
    await page.waitForTimeout(2200);
    assert.equal(await page.locator('#open-background').isVisible(), true);
    assert.equal(await page.locator('#background-list .background-card').count(), 2);
    await page.locator('#open-background').hover();
    await page.locator('#background-popover').waitFor({ state: 'visible' });
    const finished = page.locator('#background-list .background-card').nth(1);
    assert.equal(await finished.locator('.background-dot.completed').count(), 1);
    assert.notEqual(await finished.locator('.background-duration').innerText(), '—');
    // A finished job has nothing to stop, so it carries no stop control at all — not an empty one.
    assert.equal(await finished.locator('.background-stop').count(), 0);
    await page.evaluate(() => window.yuantu.invoke({ type: 'clearBackground' }));
    await page.waitForFunction(
      () => document.querySelectorAll('#background-list .background-card').length === 0,
    );
    // The trigger belongs to the list it opens: once every job is cleared there is nothing to open, which is the
    // same state this suite asserts before any job exists. The popover goes with it.
    assert.equal(await page.locator('#open-background').isHidden(), true);
    assert.equal(
      await page.locator('#background-popover button, #background-popover input').count(),
      0,
    );
    await app.close();
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        '--user-data-dir=' + path.join(root, 'profile'),
      ],
      env,
    });
    const reopened = await app.firstWindow();
    await reopened.waitForFunction(() => !document.querySelector('#prompt').disabled);
    // Clearing removed the jobs from the session record too, so the reopened window lists none — and the trigger
    // that exists only to open that list stays hidden.
    assert.equal(await reopened.locator('#open-background').isHidden(), true);
  },
);
