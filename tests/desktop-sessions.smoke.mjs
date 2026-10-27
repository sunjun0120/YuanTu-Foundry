// @test-serial desktop-ui: Launches real Electron windows.
// Sidebar session menus, the question panel, Host recovery, and tool images and result cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { artifactPath } from './desktop-smoke-support.mjs';
process.env.YUANTU_SESSION_TITLES = 'false';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { waitForPage } from './page-wait.mjs';

// ---- merged from session-management.smoke.mjs ----

test(
  'sidebar hover menus rename and delete the targeted session without switching or losing drafts',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-session-ui-'));
    const db = path.join(root, '.yuantu', 'sessions.sqlite');
    const seed = new SessionStore(db);
    const source = seed.create(root),
      other = seed.create(root);
    seed.append(source.id, { role: 'user', content: '检查 cookie 边界' });
    seed.append(source.id, { role: 'assistant', content: '已检查', toolCalls: [] });
    seed.rename(other.id, '其他会话');
    seed.close();
    await writeFile(path.join(root, 'keep.txt'), 'current file state');
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
    const launch = async () => {
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
      page.setDefaultTimeout(8000);
      await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
      return page;
    };
    let page = await launch();
    assert.equal(await page.locator('#session-short').count(), 0);
    assert.doesNotMatch(
      await page.locator('.composer-area').innerText(),
      /(?:Session|会话) [0-9a-f]{8}/,
    );
    const row = (id) => page.locator(`[data-session-id="${id}"]`);
    const more = (id) => page.locator(`[data-menu-session-id="${id}"]`);
    const idle = () =>
      page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    const open = async (id, name) => {
      await idle();
      await more(id).hover();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };
    const confirm = async () => {
      await page.locator('#session-dialog-confirm').click();
      await page.locator('#session-dialog').waitFor({ state: 'hidden' });
      await idle();
    };
    await row(source.id).click();
    await idle();
    assert.equal(
      await page
        .locator('#fork-session, #history-session, .session-toolbar, #session-history')
        .count(),
      0,
    );
    assert.equal(await more(other.id).isVisible(), true);
    assert.equal(await page.getByRole('menu').isVisible(), false);
    await page.locator('#prompt').fill('未发送的草稿');
    await more(other.id).hover();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).waitFor();
    if (process.env.YUANTU_QA_DIR)
      await page.screenshot({ path: artifactPath('session-menu.png') });
    await page.locator('#prompt').hover();
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    await more(other.id).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(
      await page
        .getByRole('menuitem', { name: '重命名', exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').isVisible(), false);
    await open(other.id, '重命名');
    await page.locator('#session-title-input').fill('已重命名的其他会话');
    await confirm();
    assert.match(await row(other.id).innerText(), /已重命名的其他会话/);
    assert.equal(
      await page.locator('#sessions .selected').getAttribute('data-session-id'),
      source.id,
    );
    assert.equal(await page.locator('#prompt').inputValue(), '未发送的草稿');
    assert.equal(await page.locator('#session-search').isVisible(), false);
    await page.locator('#open-session-search').click();
    assert.equal(await page.locator('#recent-sessions-label').isVisible(), false);
    assert.equal(await page.locator('#session-search').isVisible(), true);
    assert.equal(await page.locator('#session-search').inputValue(), '');
    assert.equal(
      await page.locator('#session-search').evaluate((el) => el === document.activeElement),
      true,
    );
    await page.locator('#session-search').fill('cookie');
    await page.locator('#session-search').evaluate((input) => {
      window.searchBlurCount = 0;
      input.addEventListener('blur', () => window.searchBlurCount++);
    });
    await page.waitForFunction(
      () => document.querySelectorAll('#sessions .session-item').length === 1,
    );
    await idle();
    assert.equal(
      await page.locator('#session-search').evaluate((el) => el === document.activeElement),
      true,
    );
    await page.locator('#session-search').fill('不存在的词');
    await page.locator('#session-search-empty').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.searchBlurCount), 0);
    assert.equal(await page.locator('#session-search-empty').innerText(), '无匹配会话');
    assert.equal(await page.locator('#session-search-note').isVisible(), false);
    await idle();
    assert.equal(
      await page.locator('#session-search').evaluate((el) => el === document.activeElement),
      true,
    );
    await page.locator('#clear-session-search').click();
    assert.equal(await page.locator('#session-search').inputValue(), '');
    assert.equal(await page.locator('#clear-session-search').isVisible(), false);
    assert.equal(await page.locator('#session-search-empty').isVisible(), false);
    assert.equal(await page.locator('#open-session-search').isVisible(), true);
    assert.equal(await page.locator('#close-session-search').count(), 0);
    assert.equal(await page.locator('#session-search').isVisible(), false);
    await page.waitForFunction(
      () => document.querySelectorAll('#sessions .session-item').length === 2,
    );
    await page.locator('#open-session-search').click();
    assert.equal(await page.locator('#session-search').inputValue(), '');
    assert.equal(
      await page.locator('#session-search').evaluate((el) => el === document.activeElement),
      true,
    );
    await page.locator('#prompt').click();
    await open(other.id, '删除');
    await page.locator('#session-dialog-cancel').click();
    assert.equal(await row(other.id).count(), 1);
    await open(other.id, '删除');
    await confirm();
    assert.equal(await row(other.id).count(), 0);
    assert.equal(
      await page.locator('#sessions .selected').getAttribute('data-session-id'),
      source.id,
    );
    assert.equal(await page.locator('#prompt').inputValue(), '未发送的草稿');
    await open(source.id, '重命名');
    await page.locator('#session-title-input').fill('登录流程');
    await confirm();
    await app.close();
    app = undefined;
    page = await launch();
    assert.match(await row(source.id).innerText(), /登录流程/);
    assert.equal(await page.locator('#messages .message').count(), 2);
    await open(source.id, '删除');
    await confirm();
    assert.equal(await row(source.id).count(), 0);
    assert.equal(await page.locator('#sessions .session-item').count(), 1);
    assert.equal(await page.locator('#messages .message').count(), 0);
    assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'current file state');
    const check = new SessionStore(db);
    try {
      assert.throws(() => check.get(source.id), /not found/);
      assert.throws(() => check.get(other.id), /not found/);
    } finally {
      check.close();
    }
  },
);

test(
  'desktop question panel answers a run that is waiting on a choice',
  { timeout: 90_000 },
  async (t) => {
    const entry = path.resolve('dist/desktop/main.cjs');
    await access(entry);
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-question-'));
    let turns = 0;
    const url = await httpFixture(t, (body, res) => {
      if (turns++ === 0) {
        sendFrames(
          res,
          frames('需要你先确认主题颜色。', [
            {
              id: 'ask-1',
              name: 'ask_user_question',
              input: {
                questions: [
                  {
                    id: 'color',
                    header: '主题',
                    question: '主题用哪种颜色？',
                    options: [
                      { label: '红色', description: '默认配色', recommended: true },
                      { label: '蓝色' },
                    ],
                  },
                ],
              },
            },
          ]),
        );
        return;
      }
      // The answer has to reach the model, which is the only reason the panel is worth waiting on.
      assert.match(JSON.stringify(body.messages), /蓝色/);
      sendFrames(res, frames('已按蓝色继续。'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'fixture-secret',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: url,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    app = await electron.launch({
      executablePath: electronPath,
      args: [entry, `--user-data-dir=${path.join(root, 'profile')}`],
      env,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('选择主题颜色');
    await page.locator('#send').click();
    const questions = page.locator('#questions');
    await questions.locator('.question-card').waitFor();
    assert.match(await questions.innerText(), /主题用哪种颜色/);
    // The header is the eyebrow, the question is the title, and a recommendation is a badge rather than part of
    // the label — the label is what the model reads back, so the interface does not edit it to draw one.
    assert.equal(await questions.locator('.question-eyebrow').innerText(), '主题');
    assert.equal(await questions.locator('.question-recommended').innerText(), '推荐');
    await mkdir(artifactPath(''), { recursive: true });
    await page.screenshot({ path: artifactPath('question-panel.png') });
    await questions.locator('.question-option', { hasText: '红色' }).click();
    await questions.locator('.question-option', { hasText: '蓝色' }).click();
    // One question, one answer: picking the second option has to release the first.
    const chosen = questions.locator('.question-option.selected');
    assert.equal(await chosen.count(), 1);
    assert.match(await chosen.innerText(), /蓝色/);
    await questions.getByRole('button', { name: '提交' }).click();
    await page.getByText('已按蓝色继续。', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    // The panel has to go with the answer, or it invites a second one nobody will read.
    assert.equal((await questions.innerText()).trim(), '');
  },
);

test(
  'desktop brings itself back when the Host process dies, and says so',
  { timeout: 90_000 },
  async (t) => {
    const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const entry = path.join(project, 'dist/desktop/main.cjs');
    await access(entry);
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-recover-'));
    // The first request is held open so the Host dies with a run in flight: a crash during a reply is the case
    // where a user is waiting for something that will never arrive.
    let release = null;
    let calls = 0;
    let started = false;
    const url = await httpFixture(t, (_body, res) => {
      calls++;
      if (calls === 1) {
        started = true;
        release = () => sendFrames(res, frames('不应到达的回答。'));
        return;
      }
      sendFrames(res, frames('重启后的回答。'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'fixture-secret',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: url,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      release?.();
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    app = await electron.launch({
      executablePath: electronPath,
      args: [entry, `--user-data-dir=${path.join(root, 'profile')}`],
      env,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('杀死宿主进程');
    await page.locator('#send').click();
    // Kill the Host the way a crash does: from outside, with no chance to shut anything down.
    await page.waitForFunction(() => document.querySelector('#run-status')?.textContent !== '');
    while (!started) await new Promise((resolve) => setTimeout(resolve, 25));
    const hostPid = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.hostPid,
    );
    assert.ok(hostPid, 'the window must be able to name the Host process it is talking to');
    process.kill(hostPid, 'SIGKILL');
    // The window comes back by itself: no restart, no dialog, and the notice explains what happened.
    const notice = page.locator('#notice');
    await notice.waitFor();
    assert.match(
      await notice.innerText(),
      new RegExp(`进程 ${hostPid}.*已自动重启并从会话日志重建`),
    );
    // The error the crash caused is gone with it: the notice explains the same event, and a stale banner about
    // a request that died with the Host would contradict a window that is working again.
    assert.equal(await page.locator('#error').isHidden(), true);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    // The interrupted run remains in the durable record without a panel in the conversation.
    await waitForPage(page, async () =>
      (await window.yuantu.invoke({ type: 'snapshot' })).state.audit.some(
        (event) => event.type === 'run.interrupted',
      ),
    );
    // And the session is usable, not merely readable.
    await page.locator('#prompt').fill('重启之后再说一次');
    await page.locator('#send').click();
    await page.getByText('重启后的回答。', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    // The notice goes away once the user has acted on it.
    await page.waitForFunction(() => document.querySelector('#notice')?.hidden === true);
  },
);

test(
  'desktop shows the picture a tool looked at, and the model receives it as an image',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-image-ui-'));
    // A real 1×1 PNG. The point of the test is the whole path — file, tool, log, request, window — so nothing
    // here may be faked at the boundary: a path-only screenshot used to be exactly the dead end.
    await writeFile(
      path.join(root, 'shot.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    let turns = 0;
    const url = await httpFixture(t, (body, res) => {
      if (turns++ === 0) {
        sendFrames(
          res,
          frames('我先看一眼这张图。', [
            { id: 'shot', name: 'read_image', input: { path: 'shot.png' } },
          ]),
        );
        return;
      }
      // The endpoint is Anthropic here, which is the protocol that can put the picture inside the tool result
      // itself. What must not arrive is the path — that is what the model could not see before.
      const result = body.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .find((block) => block.type === 'tool_result');
      assert.ok(result, 'the tool result reached the endpoint');
      assert.ok(
        result.content.some((block) => block.type === 'image' && block.source?.data),
        `no image block in ${JSON.stringify(result.content)}`,
      );
      sendFrames(res, frames('图里是一个红色像素。'));
    });
    let app;
    t.after(async () => {
      if (app) await app.close();
      await rm(root, { recursive: true, force: true });
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
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('看一下截图');
    await page.locator('#send').click();
    // The person reading along has to see the same picture the model was shown: an answer about a layout is
    // unverifiable if the only trace of the screenshot is a file name.
    await page.waitForFunction(() => {
      const image = document.querySelector('#messages .tool-result img');
      return Boolean(image?.getAttribute('src')?.startsWith('data:image/png;base64,'));
    });
    assert.equal(await page.locator('#messages .tool-result img').count(), 1);
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.match(await page.locator('#messages').textContent(), /图里是一个红色像素/);
  },
);

// ---- structured tool results ----

test(
  'a stored tool result is drawn as its card, with its own text one fold below',
  { timeout: 60_000 },
  async (t) => {
    // Seeded through the store rather than driven by a model, so what is under test is exactly the last link of
    // the chain: a payload that reached the session log is a payload the window can draw. Nothing here re-checks
    // the tool that produced it (tests/tool-cards.test.ts does that) — this is about a real Electron renderer
    // turning a real stored message into a card, which no DOM-less test can claim.
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-tool-cards-ui-'));
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const session = store.create(root);
    store.append(session.id, { role: 'user', content: '跑一下测试' });
    store.append(session.id, {
      role: 'assistant',
      content: '跑。',
      toolCalls: [
        { id: 'call-command', name: 'run_command', arguments: { command: 'node fail.cjs' } },
        { id: 'call-read', name: 'read_file', arguments: { path: 'src/app.ts' } },
      ],
    });
    store.append(session.id, {
      role: 'tool',
      toolCallId: 'call-command',
      content: 'exit code 3\nout\nerr',
      output: {
        render: 'command-output',
        value: {
          command: 'node fail.cjs',
          exitCode: 3,
          signal: null,
          timedOut: false,
          durationMs: 42,
          stdout: 'out\n',
          stderr: 'err\n',
          truncated: false,
        },
      },
    });
    store.append(session.id, {
      role: 'tool',
      toolCallId: 'call-read',
      content: '1: one\n2: two',
      output: {
        render: 'file-read',
        value: {
          path: 'src/app.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 2,
          totalLines: 9,
          text: 'one\ntwo',
          truncated: false,
        },
      },
    });
    for (let i = 0; i < 24; i++)
      store.append(session.id, {
        role: 'assistant',
        content: `Transcript line ${i}: ${'more text '.repeat(18)}`,
        toolCalls: [],
      });
    store.close();
    const env = {
      ...process.env,
      YUANTU_SANDBOX: 'host',
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
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
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator(`[data-session-id="${session.id}"]`).click();
    await page.locator('#messages .tool-result').first().waitFor({ state: 'attached' });
    const processGroup = page.locator('#messages > .process-group');
    assert.equal(await processGroup.count(), 1);
    assert.equal(await processGroup.getAttribute('open'), null);
    assert.match(
      await processGroup.locator(':scope > summary').innerText(),
      /读取[\s\S]*src\/app\.ts/,
    );
    assert.equal(await processGroup.locator('.process-steps > details').count(), 4);
    await processGroup.locator(':scope > summary').click();
    assert.ok(
      await processGroup
        .locator('.process-steps')
        .evaluate((el) => parseFloat(getComputedStyle(el).maxHeight) <= 360),
    );
    await page.locator('#conversation').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.locator('#jump-to-latest').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#jump-to-latest svg').count(), 1);
    const arrowOffset = await page.locator('#jump-to-latest').evaluate((button) => {
      const outer = button.getBoundingClientRect();
      const icon = button.querySelector('svg').getBoundingClientRect();
      return Math.max(
        Math.abs((outer.left + outer.right - icon.left - icon.right) / 2),
        Math.abs((outer.top + outer.bottom - icon.top - icon.bottom) / 2),
      );
    });
    assert.ok(arrowOffset <= 1, `jump arrow is offset by ${arrowOffset}px`);
    await page.locator('#jump-to-latest').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('#conversation');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    });
    await page.locator('#jump-to-latest').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#messages .tool-call').first().getAttribute('open'), null);
    assert.equal(await page.locator('#messages .message-label').count(), 0);
    assert.equal(await page.locator('#live .message-label').count(), 0);
    assert.equal(await page.locator('#audit-panel').count(), 0);
    const processGap = await page.locator('#messages').evaluate((root) => {
      const rows = [...root.querySelectorAll('.tool-call > summary, .tool-result > summary')];
      return rows[2].getBoundingClientRect().top - rows[1].getBoundingClientRect().bottom;
    });
    assert.ok(processGap <= 16, `adjacent process rows are ${processGap}px apart`);
    assert.match(
      await page.locator('#messages .tool-call > summary').nth(1).innerText(),
      /读取[\s\S]*src\/app\.ts/,
    );
    assert.equal(
      await page
        .locator('#messages .tool-call > summary')
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopWidth),
      '0px',
    );
    assert.equal(
      await page
        .locator('#messages .tool-result > summary')
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopWidth),
      '0px',
    );
    // A tool result is folded in this window (`<details class="tool-result">`), so the card is drawn inside a
    // closed fold until somebody opens it — clicking the summary is what a reader does.
    await page.locator('#messages .tool-result > summary').first().click();
    // Each tool result is its own fold, so the second one has to be opened too before it can be read.
    await page.evaluate(() =>
      document
        .querySelectorAll('#messages .tool-result')
        .forEach((result) => result.setAttribute('open', '')),
    );
    await page.locator('#messages .tool-card-command').first().waitFor();
    // The exit code, the two streams and the command itself: the four things a failing command is read for.
    const command = page.locator('#messages .tool-card-command').first();
    assert.match(await command.locator('.tool-card-command-line').innerText(), /node fail\.cjs/);
    assert.equal(await command.locator('.tool-card-badge').first().innerText(), '退出码 3');
    assert.match(await command.locator('.tool-card-stdout').innerText(), /out/);
    assert.match(await command.locator('.tool-card-stderr').innerText(), /err/);
    // The file card says which lines it is, and draws the raw lines rather than the numbered text form.
    const file = page.locator('#messages .tool-card-file').first();
    assert.match(await file.locator('.tool-card-path').innerText(), /src\/app\.ts/);
    assert.match(await file.locator('.tool-card-meta').first().innerText(), /typescript/);
    assert.match(await file.locator('.tool-card-meta').nth(1).innerText(), /第 1–2 行 \/ 共 9 行/);
    assert.equal((await file.locator('.tool-card-text').innerText()).trim(), 'one\ntwo');
    // The text form the model read is still there, one fold down: a card is a view of the result, not a
    // replacement for it, so a person must be able to check the two against each other.
    const raw = page.locator('#messages .tool-result-raw').first();
    assert.equal(await raw.locator('pre').isVisible(), false);
    // `textContent`, not `innerText`: the fold is closed, so the text is in the DOM and not on screen — which is
    // the point being asserted, and asking for rendered text would answer ''.
    assert.match(await raw.locator('pre').textContent(), /exit code 3/);
    await raw.locator('summary').click();
    assert.equal(await raw.locator('pre').isVisible(), true);
  },
);

// ---- the read-only workspace panel ----

test('the workspace panel reads files without writing them', { timeout: 60_000 }, async (t) => {
  // What this pins that no DOM-less test can: the panel is painted from Host answers (the renderer never
  // touches the filesystem), the ignore list holds at the UI level, and each of the three preview kinds is
  // drawn as itself.
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-workspace-ui-'));
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await mkdir(path.join(root, 'empty'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'notes.txt'), '第一行\nsecond line\n');
  const sampleSource = [
    'const answer: number = 42;',
    '// explain the answer',
    'const label = "hi";',
    '',
  ].join('\n');
  await writeFile(path.join(root, 'sample.ts'), sampleSource);
  await writeFile(
    path.join(root, 'evil.ts'),
    'const html = "<img src=x onerror=window.workspaceCodeExecuted=true>";\n',
  );
  await writeFile(path.join(root, 'big.ts'), 'const value = 1;\n'.repeat(6000));
  const guide = [
    '---',
    'description: hidden preview metadata',
    '---',
    '# 工作区阅读',
    '',
    '| 能力 | 状态 |',
    '| --- | --- |',
    '| Markdown | 可阅读 |',
    '',
    '```js',
    'const readable = true;',
    '```',
    '',
    '<script>window.workspacePreviewExecuted = true</script>',
    '',
    ...Array.from({ length: 50 }, (_, i) => `## 第 ${i + 1} 节\n\n文档占据可用阅读空间。\n`),
  ].join('\n');
  await writeFile(path.join(root, 'guide.md'), guide);
  await writeFile(path.join(root, 'long.log'), 'long file line\n'.repeat(150));
  const extraFiles = Array.from({ length: 8 }, (_, i) => `additional-document-${i}.txt`);
  for (const name of extraFiles) await writeFile(path.join(root, name), name);
  await writeFile(path.join(root, 'sub', 'nested.txt'), 'nested\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  await writeFile(path.join(root, '.git', 'config'), 'ignored\n');
  // Real bytes rather than a name: a 1×1 PNG, and a file whose extension says nothing about its content.
  await writeFile(
    path.join(root, 'logo.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  await writeFile(path.join(root, 'blob.txt'), Buffer.from([0x41, 0x00, 0x42]));
  const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: '看看工作区' });
  store.close();
  const env = {
    ...process.env,
    YUANTU_SANDBOX: 'host',
    YUANTU_NODE_PATH: process.execPath,
    YUANTU_WORKSPACE: root,
    YUANTU_PROTOCOL: 'anthropic',
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_API_KEY: 'fixture',
    YUANTU_BASE_URL: 'http://127.0.0.1:1',
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
    args: [path.resolve('dist/desktop/main.cjs'), '--user-data-dir=' + path.join(root, 'profile')],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled);

  const contentSize = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1100, 760);
    return window.getContentSize();
  });
  await page.waitForFunction(
    ([width, height]) => innerWidth === width && innerHeight === height,
    contentSize,
  );
  await page.locator('#open-workspace').click();
  await page.waitForFunction(() => document.body.dataset.workspaceView === 'open');
  assert.equal(await page.locator('#workspace-panel').isVisible(), true);
  assert.equal(await page.locator('#workspace-new-tab-page').isVisible(), true);
  assert.equal(await page.locator('#workspace-new-tab').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#workspace-new-browser').isDisabled(), true);
  await page.locator('#workspace-new-tab-plus').click();
  assert.equal(await page.locator('#workspace-new-tab-page').isVisible(), true);
  await page.locator('#workspace-new-files').click();
  assert.equal(await page.locator('#workspace-tree-tab').getAttribute('aria-selected'), 'true');
  const row = (name) => page.locator(`#workspace-tree .workspace-entry-button[title="${name}"]`);
  await row('notes.txt').waitFor();
  const resizeHandle = page.locator('#workspace-resize');
  await resizeHandle.waitFor({ state: 'visible' });
  // Start at the supported minimum so a narrow window still has room to grow.
  await resizeHandle.focus();
  await page.keyboard.press('Home');
  const initialWidth = (await page.locator('#workspace-panel').boundingBox()).width;
  const handleBounds = await resizeHandle.boundingBox();
  const handleY = handleBounds.y + handleBounds.height / 2;
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleY);
  await page.mouse.down();
  assert.equal(
    await page.evaluate(() => document.body.classList.contains('workspace-resizing')),
    true,
    'dragging shows the resize cursor and suppresses selection',
  );
  await page.mouse.move(handleBounds.x - 100, handleY, { steps: 8 });
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => document.body.classList.contains('workspace-resizing')),
    false,
    'releasing the pointer clears the resize state',
  );
  const draggedWidth = (await page.locator('#workspace-panel').boundingBox()).width;
  assert.ok(draggedWidth > initialWidth + 80, 'dragging left widens the sidebar');
  await resizeHandle.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await page.locator('#workspace-panel').boundingBox()).width, draggedWidth - 24);
  await page.keyboard.press('ArrowLeft');
  assert.equal((await page.locator('#workspace-panel').boundingBox()).width, draggedWidth);
  assert.equal(await page.locator('#workspace-expand').count(), 0);
  const opener = page.locator('#open-workspace');
  assert.equal(await opener.locator('svg').getAttribute('data-icon'), 'expand');
  assert.ok((await opener.boundingBox()).width <= 32, 'sidebar opener is a compact icon');
  for (const id of ['workspace-fullscreen', 'workspace-refresh', 'workspace-close']) {
    const control = page.locator(`#${id}`);
    assert.equal(await control.locator('svg').count(), 1);
    assert.equal((await control.innerText()).trim(), '', 'toolbar controls use icons');
    assert.ok(await control.getAttribute('aria-label'));
  }
  await page.locator('#workspace-refresh').hover();
  await page.locator('#workspace-tooltip').waitFor({ state: 'visible' });
  assert.ok(await page.locator('#workspace-tooltip').innerText());
  await page.mouse.move(10, 300);
  // The ignore list is the file tools' own, applied on the Host side: what the model cannot read, the tree
  // does not offer — and the store's own directory is the sharpest case of that.
  for (const hidden of ['.env', '.git', '.yuantu'])
    assert.equal(await row(hidden).count(), 0, `${hidden} must not be listed`);
  assert.equal(await row('empty').getAttribute('aria-expanded'), 'false');
  assert.equal(await row('empty').locator('svg').getAttribute('data-icon'), 'folder');
  await row('sub').click();
  await row('sub/nested.txt').waitFor();
  assert.equal(await row('sub').getAttribute('aria-expanded'), 'true');
  assert.equal(await row('sub').locator('svg').getAttribute('data-icon'), 'folder-open');
  assert.equal(await row('guide.md').locator('svg').getAttribute('data-icon'), 'markdown');
  // An empty directory is an answer, not an absence: "no files here" and "not read yet" are different.
  await row('empty').click();
  await page.locator('#workspace-tree .workspace-note').first().waitFor();
  if (process.env.YUANTU_QA_SCREENSHOT) {
    await mkdir(artifactPath(''), { recursive: true });
    await page.screenshot({
      path: artifactPath('qa.png').replace(/\.png$/, '-tree.png'),
    });
  }
  // Text preview: the bytes the Host decoded, byte for byte.
  await row('notes.txt').click();
  await page.locator('.workspace-preview-text').waitFor();
  assert.equal(
    await page.locator('#workspace-tabs [role="tab"][aria-selected="true"] span').innerText(),
    'notes.txt',
  );
  // `textContent` for the bytes themselves: `innerText` is the *rendered* text, and this assertion is about
  // what the Host decoded rather than about how a `<pre>` lays it out.
  assert.equal(
    await page.locator('.workspace-preview-text').textContent(),
    '第一行\nsecond line\n',
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const plainStyle = await page.locator('.workspace-preview-text').evaluate((pre) => {
    const style = getComputedStyle(pre);
    return { background: style.backgroundColor, maxHeight: style.maxHeight };
  });
  assert.equal(
    plainStyle.maxHeight,
    'none',
    'file content must not inherit the 280px tool-output cap',
  );
  assert.equal(
    plainStyle.background,
    'rgba(0, 0, 0, 0)',
    'plain file preview uses the themed reading surface',
  );
  assert.equal(await row('notes.txt').getAttribute('aria-current'), 'true');
  await page.locator('#workspace-tree-tab').click();
  assert.equal(await page.locator('#workspace-tree').isVisible(), true);

  await page.locator('#workspace-tree-tab').click();
  await row('sample.ts').click();
  const code = page.locator('.workspace-preview-code');
  await code.waitFor();
  assert.equal(await code.textContent(), sampleSource);
  const tokenColors = () =>
    code.evaluate((pre) => ({
      classes: [...pre.querySelectorAll('span')].map((span) => span.className),
      colors: [
        ...new Set([...pre.querySelectorAll('span')].map((span) => getComputedStyle(span).color)),
      ],
    }));
  const darkTokens = await tokenColors();
  for (const token of ['hljs-keyword', 'hljs-string', 'hljs-comment', 'hljs-number'])
    assert.ok(
      darkTokens.classes.some((name) => name.split(/\s+/u).includes(token)),
      `sample.ts is missing ${token}`,
    );
  assert.ok(darkTokens.colors.length >= 3, 'dark theme keeps token colours distinct');
  await page.evaluate(async () => {
    document.documentElement.dataset.theme = 'light';
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  });
  const lightTokens = await tokenColors();
  assert.ok(lightTokens.colors.length >= 3, 'light theme keeps token colours distinct');
  assert.notDeepEqual(lightTokens.colors, darkTokens.colors);
  await page.evaluate(async () => {
    document.documentElement.dataset.theme = 'dark';
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  });

  await page.locator('#workspace-tree-tab').click();
  await row('evil.ts').click();
  await page.locator('.workspace-preview-code').waitFor();
  assert.match(await page.locator('.workspace-preview-code').textContent(), /<img src=x/);
  assert.equal(await page.evaluate(() => window.workspaceCodeExecuted), undefined);

  await page.locator('#workspace-tree-tab').click();
  await row('big.ts').click();
  await page.locator('.workspace-preview-text').waitFor();
  assert.equal(await page.locator('.workspace-preview-code').count(), 0);
  await page.locator('#workspace-tree-tab').click();

  await row('guide.md').click();
  await page.locator('#workspace-preview-body .markdown h1').waitFor();

  const tab = (name) => page.locator(`#workspace-tabs .workspace-file-tab[data-path="${name}"]`);
  assert.equal(await tab('notes.txt').count(), 1);
  assert.equal(await tab('guide.md').count(), 1);
  for (const name of ['guide.md', 'notes.txt']) {
    const label = tab(name).locator('[role="tab"]');
    const appearance = () =>
      label.evaluate((button) => {
        const style = getComputedStyle(button);
        return { color: style.color, background: style.backgroundColor };
      });
    await page.mouse.move(10, 300);
    const before = await appearance();
    await label.hover();
    assert.deepEqual(
      await appearance(),
      before,
      'filename hover preserves active and inactive colors',
    );
  }
  if (process.env.YUANTU_QA_SCREENSHOT)
    await page.screenshot({
      path: artifactPath('qa.png').replace(/\.png$/, '-tabs.png'),
    });
  await page.locator('#workspace-preview-body').evaluate((body) => {
    body.scrollTop = 160;
  });
  await tab('notes.txt').locator('[role="tab"]').click();
  assert.equal(
    await page.locator('#workspace-tabs [role="tab"][aria-selected="true"] span').innerText(),
    'notes.txt',
  );
  await tab('guide.md').locator('[role="tab"]').click();
  assert.equal(
    await page.locator('#workspace-preview-body').evaluate((body) => body.scrollTop),
    160,
  );
  await page.locator('#workspace-tree-tab').click();
  await row('guide.md').click();
  assert.equal(await tab('guide.md').count(), 1, 'opening again reuses the existing tab');
  await tab('notes.txt').locator('.workspace-tab-close').click();
  assert.equal(await tab('notes.txt').count(), 0);
  assert.equal(
    await page.locator('#workspace-tabs [role="tab"][aria-selected="true"] span').innerText(),
    'guide.md',
  );
  assert.equal(
    await page.locator('#workspace-preview-body .markdown h1').textContent(),
    '工作区阅读',
  );
  assert.equal(await page.locator('#workspace-preview-body table').count(), 1);
  assert.equal(await page.locator('#workspace-preview-body script').count(), 0);
  assert.equal(await page.evaluate(() => window.workspacePreviewExecuted), undefined);
  assert.equal(
    (await page.locator('#workspace-preview-body').innerText()).includes('hidden preview metadata'),
    false,
  );
  assert.equal(
    await page.locator('#workspace-tree').isVisible(),
    false,
    'the file is a single reading pane',
  );
  const fillsPanel = () =>
    page.locator('#workspace-preview-body').evaluate((body) => {
      const panel = document.querySelector('#workspace-panel').getBoundingClientRect();
      return Math.abs(body.getBoundingClientRect().bottom - panel.bottom) <= 2;
    });
  assert.equal(await fillsPanel(), true, 'reading area fills the panel height');
  for (const removed of [
    '#workspace-preview-name',
    '#workspace-preview-source',
    '#workspace-preview-back',
    '#workspace-preview-meta',
  ])
    assert.equal(
      await page.locator(removed).count(),
      0,
      'duplicate document toolbar and size rows are removed',
    );
  const locationBounds = await page.locator('#workspace-location').boundingBox();
  const contentBounds = await page.locator('#workspace-preview-body').boundingBox();
  assert.ok(
    Math.abs(contentBounds.y - locationBounds.y - locationBounds.height) <= 1,
    'content begins directly below the path',
  );
  const contrast = () =>
    page.locator('#workspace-preview-body').evaluate((body) => {
      const rgb = (color) =>
        color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number);
      const luminance = (color) =>
        rgb(color)
          .map((v) => {
            v /= 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const text = luminance(getComputedStyle(body.querySelector('.markdown p')).color);
      const background = luminance(getComputedStyle(body).backgroundColor);
      return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
    });
  assert.ok((await contrast()) >= 4.5, 'dark document text meets readable contrast');
  await page.locator('#workspace-preview-body .markdown h1').waitFor();

  await page.locator('#workspace-fullscreen').click();
  await page.waitForFunction(() => document.body.dataset.workspaceView === 'fullscreen');
  assert.equal(await page.locator('#chat-page').isVisible(), false);
  const fullBounds = await page.locator('#workspace-panel').boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.equal(fullBounds.width, viewport.width);
  assert.equal(fullBounds.height, viewport.height);
  assert.equal(await fillsPanel(), true);
  if (process.env.YUANTU_QA_SCREENSHOT) {
    await mkdir(artifactPath(''), { recursive: true });
    await page.screenshot({ path: artifactPath('qa.png') });
  }
  await page.locator('#workspace-preview-body').evaluate((body) => {
    body.scrollTop = 180;
  });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.body.dataset.workspaceView), 'open');
  assert.equal(
    await page.locator('#workspace-preview').isVisible(),
    true,
    'Escape exits fullscreen before leaving the file',
  );
  assert.equal(await page.locator('#chat-page').isVisible(), true);
  assert.equal(
    await page.locator('#workspace-preview-body').evaluate((body) => body.scrollTop),
    180,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  assert.ok((await contrast()) >= 4.5, 'light document text meets readable contrast');
  if (process.env.YUANTU_QA_SCREENSHOT) {
    await page.locator('#workspace-fullscreen').click();
    await page.screenshot({
      path: artifactPath('qa.png').replace(/\.png$/, '-light.png'),
    });
    await page.locator('#workspace-fullscreen').click();
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'system';
  });
  assert.ok((await contrast()) >= 4.5, 'system dark theme applies to the document');
  await page.setViewportSize({ width: 860, height: 720 });
  await page.locator('#workspace-fullscreen').click();
  const narrowBounds = await page.locator('#workspace-panel').boundingBox();
  assert.equal(narrowBounds.width, 860, 'fullscreen also fills a narrow window');
  assert.equal(narrowBounds.height, 720);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#workspace-preview').isVisible(), true);
  assert.ok((await page.locator('#workspace-panel').boundingBox()).width <= 836);
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.locator('#workspace-tree-tab').click();
  assert.equal(
    await row('sub').getAttribute('aria-expanded'),
    'true',
    'returning keeps expanded folders',
  );
  await row('long.log').click();
  const scrollsOnce = await page.locator('.workspace-preview-text').evaluate((pre) => {
    const body = pre.parentElement;
    return (
      pre.clientHeight > 280 &&
      body.scrollHeight > body.clientHeight &&
      pre.scrollHeight === pre.clientHeight
    );
  });
  assert.equal(
    scrollsOnce,
    true,
    'long files scroll in the reading pane instead of a nested capped pre',
  );
  await page.locator('#workspace-preview-body').evaluate((body) => {
    body.scrollTop = 100;
  });
  await tab('guide.md').locator('[role="tab"]').click();
  await tab('long.log').locator('[role="tab"]').click();
  assert.equal(
    await page.locator('#workspace-preview-body').evaluate((body) => body.scrollTop),
    100,
  );
  const refreshedLog = 'refreshed file line\n'.repeat(150);
  await writeFile(path.join(root, 'long.log'), refreshedLog);
  await page.locator('#workspace-refresh').click();
  await page.waitForFunction(
    (text) => document.querySelector('.workspace-preview-text')?.textContent === text,
    refreshedLog,
  );
  assert.equal(
    await page.locator('#workspace-preview-body').evaluate((body) => body.scrollTop),
    100,
  );
  await tab('long.log').locator('.workspace-tab-close').click();
  assert.equal(
    await page.locator('#workspace-tabs [role="tab"][aria-selected="true"] span').innerText(),
    'guide.md',
    'closing the active tab selects a neighbor',
  );
  await page.locator('#workspace-tree-tab').click();
  assert.equal(await row('sub').getAttribute('aria-expanded'), 'true');
  await row('long.log').click();
  assert.equal(
    await page.locator('#workspace-preview-body').evaluate((body) => body.scrollTop),
    0,
    'a closed tab is reopened as a fresh reader',
  );
  await page.locator('#workspace-fullscreen').click();
  await page.locator('#workspace-close').click();
  assert.equal(await page.locator('#chat-page').isVisible(), true);
  await page.locator('#open-workspace').click();
  assert.equal(
    await page.evaluate(() => document.body.dataset.workspaceView),
    'open',
    'reopening does not retain fullscreen',
  );
  assert.equal(await page.locator('#workspace-new-tab-page').isVisible(), true);
  await page.locator('#workspace-tree-tab').click();
  // A file whose extension promises an image is not one: the kind comes from the bytes.
  await row('logo.png').click();
  await page.locator('img.workspace-preview-image').waitFor();
  assert.match(
    await page.locator('img.workspace-preview-image').getAttribute('src'),
    /^data:image\/png;base64,/,
  );
  assert.equal(
    await page.locator('img.workspace-preview-image').evaluate((image) => image.naturalWidth),
    1,
    'the data URL really decodes as the PNG it came from',
  );
  // And a text file that is really binary is refused with a reason instead of rendered as replacement
  // characters, which would look like content.
  await page.locator('#workspace-tree-tab').click();
  await row('blob.txt').click();
  await page.locator('.workspace-preview-unsupported').waitFor();
  assert.match(await page.locator('.workspace-preview-unsupported').innerText(), /二进制|binary/);
  await page.locator('#workspace-fullscreen').click();
  for (const name of [
    'guide.md',
    'long.log',
    'logo.png',
    'blob.txt',
    'sample.ts',
    'evil.ts',
    'big.ts',
  ])
    await tab(name).locator('.workspace-tab-close').click();
  assert.equal(await page.locator('#workspace-tabs .workspace-file-tab').count(), 0);
  assert.equal(
    await page.locator('#workspace-tree').isVisible(),
    true,
    'closing the last document returns to files',
  );
  assert.equal(await page.evaluate(() => document.body.dataset.workspaceView), 'fullscreen');
  for (const name of extraFiles) {
    await row(name).click();
    await page.locator('.workspace-preview-text').waitFor();
    const activeBounds = await tab(name).boundingBox();
    assert.ok(activeBounds.width <= 180, 'file tabs use compact widths with ellipsis');
    const stripBounds = await page.locator('#workspace-tabs').boundingBox();
    assert.ok(
      activeBounds.x + activeBounds.width <= stripBounds.x + stripBounds.width + 1,
      'newly opened tab scrolls into view',
    );
    assert.ok(activeBounds.x >= stripBounds.x - 1, 'active tab stays inside the strip');
    await page.locator('#workspace-tree-tab').click();
  }
  await page.locator('#workspace-tree-tab').focus();
  await page.keyboard.press('End');
  assert.equal(
    await page.locator('#workspace-tabs [role="tab"][aria-selected="true"] span').innerText(),
    extraFiles.at(-1),
  );
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#workspace-new-tab-page').isVisible(), true);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#workspace-tree').isVisible(), true);
  for (const name of extraFiles) await tab(name).locator('.workspace-tab-close').click();
  await page.locator('#workspace-close').click();
  await page.waitForFunction(() => document.body.dataset.workspaceView === 'closed');
  assert.equal(await page.locator('#workspace-panel').isVisible(), false);
  assert.equal(
    await readFile(path.join(root, 'guide.md'), 'utf8'),
    guide,
    'preview leaves source unchanged',
  );
});
