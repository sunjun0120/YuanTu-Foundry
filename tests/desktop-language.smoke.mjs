// @test-serial desktop-ui: Launches real Electron windows.
// Language switching, sidebar titles, the sub-agent catalog and child pages, and user-message bubbles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';
import { artifactPath } from './desktop-smoke-support.mjs';
process.env.YUANTU_SESSION_TITLES = 'false';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { waitForPage } from './page-wait.mjs';

// ---- merged from language.smoke.mjs ----

/**
 * Collect every piece of Chinese text a user can still see. This is the only
 * trustworthy measure of translation coverage: index.html holds Chinese
 * placeholders that renderers overwrite at runtime, so reading the source
 * over-reports the gap.
 */
const SCAN = () => {
  const han = /[\u4e00-\u9fff]/;
  const found = new Set();
  const reachable = (element) =>
    !element.closest('[hidden]') &&
    !element.closest('dialog:not([open])') &&
    !element.closest('script,style,pre,.message-content');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const element = node.parentElement;
    if (!element || !reachable(element)) continue;
    // The language picker names each language in its own script on purpose.
    if (element.closest('#ui-language')) continue;
    const text = (node.textContent ?? '').trim();
    if (text && han.test(text)) found.add(text);
  }
  for (const element of document.body.querySelectorAll('[placeholder],[aria-label],[title]')) {
    if (!reachable(element)) continue;
    for (const attribute of ['placeholder', 'aria-label', 'title']) {
      const value = element.getAttribute(attribute);
      if (value && han.test(value)) found.add(`${attribute}="${value}"`);
    }
  }
  return [...found].sort();
};

test(
  'switching to en-US leaves no Chinese in the visible interface',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-language-'));
    const url = await httpFixture(t, async (_body, res) => {
      sendFrames(res, frames('done'));
    });
    const env = {
      ...process.env,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_WORKSPACE: root,
      YUANTU_API_KEY: 'test',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: url,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
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
    page.setDefaultTimeout(8000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);

    const record = async (into, surface) => {
      await page.waitForTimeout(120);
      for (const text of await page.evaluate(SCAN)) {
        if (!into.has(text)) into.set(text, []);
        into.get(text).push(surface);
      }
    };
    const toChat = async () => {
      if (await page.locator('#settings-page').isVisible())
        await page.locator('#settings-back').click();
    };

    /** Walk every reachable surface, scanning as it goes. */
    const collect = async () => {
      const found = new Map();
      await toChat();
      await record(found, 'chat');

      await page.locator('#prompt').fill('/');
      await page.locator('#command-menu').waitFor({ state: 'visible' });
      assert.deepEqual(
        (await page.locator('#command-menu button strong').allTextContents()).filter((name) =>
          name.startsWith('/'),
        ),
        ['/compact', '/goal', '/plan'],
      );
      await record(found, 'slash-menu');
      await page.locator('#prompt').fill('');

      // Permission menu, then the host-execution confirmation the unconfined preset opens.
      await page.locator('#permission-trigger').click();
      await record(found, 'permission-menu');
      await page.locator('#permission-menu [data-preset="unconfined"]').click();
      await record(found, 'full-access-dialog');
      await page.locator('#full-access-cancel').click();

      // Every settings section, enumerated so a new one is covered for free.
      await page.locator('#open-settings').click();
      const sections = await page.locator('.settings-sidebar nav button').count();
      for (let index = 0; index < sections; index++) {
        const button = page.locator('.settings-sidebar nav button').nth(index);
        const label = ((await button.textContent()) ?? '').trim();
        await button.click();
        await record(found, `settings:${label}`);
      }
      return found;
    };

    const before = await collect();
    // The language picker lives in the first section; the walk left another one open.
    await page.locator('.settings-sidebar nav button').first().click();
    await page.locator('#ui-language').selectOption('en-US');
    await page.waitForFunction(() => document.documentElement.lang === 'en-US');
    const after = await collect();
    await toChat();
    await page.locator('#prompt').fill('/comp');
    assert.ok(((await page.locator('#command-menu').textContent()) ?? '').includes('/compact'));

    const report = [...after].map(
      ([text, where]) => `  ${text}   (${[...new Set(where)].join(', ')})`,
    );
    assert.deepEqual(
      report,
      [],
      `en-US still shows Chinese (zh-CN baseline: ${before.size} strings):\n${report.join('\n')}`,
    );

    // The English selection saved itself on change, so the main-process reply uses it too.
    await waitForPage(page, async () => {
      const reply = await window.yuantu.uiSettings({ type: 'get' });
      return reply.ok && reply.kind === 'settings' && reply.settings.language === 'en-US';
    });
    await toChat();

    // A real carrier rejection travels through both the command reply and the pushed snapshot.
    const failure = await page.evaluate(() =>
      window.yuantu.invoke({
        type: 'subagentTranscript',
        subagentId: 'missing-agent',
        childSessionId: 'missing-session',
      }),
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.errorDetail.code, 'subagentNotInSession');
    assert.doesNotMatch(failure.error, /\p{Script=Han}/u);
    await waitForPage(page, () =>
      document.querySelector('#error').textContent.includes('does not belong'),
    );
    assert.doesNotMatch(await page.locator('#error').textContent(), /\p{Script=Han}/u);

    // The same retained error is translated again when the user changes language.
    await page.locator('#open-settings').click();
    await page.locator('.settings-sidebar nav button').first().click();
    await page.locator('#ui-language').selectOption('zh-CN');
    await waitForPage(page, () => document.documentElement.lang === 'zh-CN');
    await toChat();
    assert.match(await page.locator('#error').textContent(), /不属于当前会话/);
    await page.locator('#open-settings').click();
    await page.locator('.settings-sidebar nav button').first().click();
    await page.locator('#ui-language').selectOption('en-US');
    await waitForPage(page, () => document.documentElement.lang === 'en-US');
    await toChat();
    assert.match(await page.locator('#error').textContent(), /does not belong/);
  },
);

// ---- header interactions and first-run naming ----

test(
  'a stalled title allows the reply and later updates the sidebar',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-title-before-reply-ui-'));
    let requests = 0;
    let releaseReply;
    let releaseTitle;
    let requestsReady;
    const bothRequests = new Promise((resolve) => (requestsReady = resolve));
    const url = await httpFixture(t, async (body, res) => {
      requests++;
      if (requests === 2) requestsReady();
      if (systemText(body.system).includes('为这段会话生成')) {
        await new Promise((resolve) => (releaseTitle = resolve));
        return sendFrames(res, frames('修复登录跳转'));
      }
      await new Promise((resolve) => (releaseReply = resolve));
      sendFrames(res, frames('首轮回复完成'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_MAX_RETRIES: '0',
      YUANTU_SESSION_TITLES: 'true',
      YUANTU_API_KEY: 'fixture',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      releaseTitle?.();
      releaseReply?.();
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
    await page.locator('#prompt').fill('登录后跳回首页，请修复');
    await page.locator('#send').click();
    await page.locator('#run-status').getByText('正在等待模型响应…', { exact: true }).waitFor();
    await bothRequests;
    assert.equal(requests, 2, 'the reply starts even with a pending title');
    assert.equal(await page.getByText('修复登录跳转', { exact: true }).count(), 0);
    assert.equal(await page.getByText('首轮回复完成', { exact: true }).count(), 0);
    releaseReply?.();
    await page.getByText('首轮回复完成', { exact: true }).waitFor();
    releaseTitle?.();
    await page.locator('#chat-title').getByText('修复登录跳转', { exact: true }).waitFor();
  },
);

test(
  'hovering subagents opens the list and a running parent can open a child page',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-subagent-hover-'));
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const parent = store.create(root);
    const child = store.create(root, parent.id);
    store.recordEvent(parent.id, 'subagent.assigned', {
      id: 'child-hover-1',
      role: 'explore',
      objective: '检查登录流程',
      childSessionId: child.id,
      runId: 'previous-run',
    });
    store.recordEvent(parent.id, 'run.finished', { runId: 'previous-run' });
    store.append(child.id, { role: 'user', content: '检查登录流程' });
    store.append(child.id, { role: 'assistant', content: '子代理实时记录' });
    store.close();
    let releaseReply;
    const url = await httpFixture(t, async (_body, res) => {
      await new Promise((resolve) => (releaseReply = resolve));
      sendFrames(res, frames('主代理完成'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      releaseReply?.();
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
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator(`[data-session-id="${parent.id}"]`).click();
    await page.locator('#open-subagents').waitFor({ state: 'visible' });
    await page.locator('#prompt').fill('继续检查');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#choose-workspace').disabled);
    await page.locator('#open-subagents').hover();
    await page.locator('#subagents-popover').waitFor({ state: 'visible' });
    const subagentPopoverBounds = await page.locator('#subagents-popover').boundingBox();
    assert.ok(subagentPopoverBounds && subagentPopoverBounds.width <= 340);
    await page.locator('#subagent-catalog .subagent-row').click();
    await page.waitForFunction(() => document.body.dataset.subagentPage === 'open');
    assert.equal(await page.locator('#subagent-transcript-process').getAttribute('open'), null);
    await page.locator('#subagent-transcript-process > summary').click();
    await page.getByText('子代理实时记录', { exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
  },
);

test(
  'a long child record opens with its process collapsed and its complete final reply visible',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-subagent-result-'));
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const parent = store.create(root);
    const child = store.create(root, parent.id);
    store.recordEvent(parent.id, 'subagent.assigned', {
      id: 'long-child',
      role: 'explore',
      objective: '检查长子代理记录',
      childSessionId: child.id,
      runId: 'previous-run',
    });
    store.append(child.id, { role: 'user', content: '检查长子代理记录' });
    for (let index = 0; index < 300; index++)
      store.append(child.id, { role: 'assistant', content: `过程记录 ${index}` });
    const finalText =
      '# 子代理最终结论\n\n' + '完整结果正文。\n'.repeat(3000) + '\nFINAL_RESULT_END';
    store.append(child.id, {
      role: 'assistant',
      content: finalText,
      reasoning: '最终回答前的完整分析',
    });
    store.recordEvent(parent.id, 'subagent.finished', {
      id: 'long-child',
      status: 'completed',
      rounds: 1,
      toolCalls: 0,
    });
    store.recordEvent(parent.id, 'run.finished', { runId: 'previous-run' });
    store.close();
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
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
    page.setDefaultTimeout(15_000);
    await waitForPage(page, () => !document.querySelector('#prompt').disabled);
    await page.locator(`[data-session-id="${parent.id}"]`).click();
    await page.locator('#open-subagents').hover();
    await page.locator('#subagent-catalog .subagent-row').click();
    await page.locator('#subagent-transcript').waitFor();
    const result = page.locator('#subagent-transcript-result');
    await result.getByText('子代理最终结论', { exact: true }).waitFor();
    assert.equal(await page.locator('#subagent-transcript-process').getAttribute('open'), null);
    assert.equal(await page.locator('#subagent-transcript-messages').isVisible(), false);
    const answer = await result.locator('.message-content').innerText();
    assert.ok(
      answer.includes('FINAL_RESULT_END'),
      'the final reply is loaded from the end of the record',
    );
    assert.equal(
      answer.match(/完整结果正文。/g)?.length,
      3000,
      'the entire final reply is retained',
    );
    await page.locator('#subagent-transcript-process > summary').click();
    await page
      .locator('#subagent-transcript-messages')
      .getByText('过程记录 299', { exact: true })
      .waitFor();
    const reasoning = page.locator('#subagent-transcript-messages .message-reasoning');
    await reasoning.locator('summary').click();
    await reasoning.locator('.reasoning-content').waitFor();
    assert.equal(
      await reasoning.locator('.reasoning-content').textContent(),
      '最终回答前的完整分析',
    );
    assert.equal(await result.locator('.message-reasoning').count(), 0);
    assert.equal(
      await page
        .locator('#subagent-transcript-result')
        .getByText('过程记录 299', { exact: true })
        .count(),
      0,
    );
    // Polling must preserve the reader's expansion state.
    await page.waitForTimeout(900);
    assert.notEqual(await page.locator('#subagent-transcript-process').getAttribute('open'), null);
    await page.locator('#chat-title').click();
    await page.locator('#subagent-transcript').waitFor({ state: 'hidden' });
    await page.locator('#open-subagents').hover();
    await page.locator('#subagent-catalog .subagent-row').click();
    await result.getByText('子代理最终结论', { exact: true }).waitFor();
    assert.equal(await page.locator('#subagent-transcript-process').getAttribute('open'), null);
  },
);

test('a child page opens while that child is still running', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-live-child-page-'));
  let requests = 0;
  let releaseChild;
  const url = await httpFixture(t, async (_body, res) => {
    requests++;
    if (requests === 1)
      return sendFrames(
        res,
        frames('正在委派', [
          {
            id: 'delegate-live',
            name: 'delegate_task',
            input: { tasks: [{ objective: '实时查看子代理', role: 'explore' }] },
          },
        ]),
      );
    const events = frames('子代理实时片段');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const write = (event) =>
      res.write(`event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
    for (const event of events.slice(0, -2)) write(event);
    await new Promise((resolve) => (releaseChild = resolve));
    for (const event of events.slice(-2)) write(event);
    res.end();
  });
  const env = {
    ...process.env,
    YUANTU_WORKSPACE: root,
    YUANTU_NODE_PATH: process.execPath,
    YUANTU_PROTOCOL: 'anthropic',
    YUANTU_BASE_URL: url,
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_API_KEY: 'fixture',
    YUANTU_SESSION_TITLES: 'false',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  t.after(async () => {
    releaseChild?.();
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });
  app = await electron.launch({
    executablePath: electronPath,
    args: [path.resolve('dist/desktop/main.cjs'), '--user-data-dir=' + path.join(root, 'profile')],
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
  await page.locator('#prompt').fill('请委派一个子代理');
  await page.locator('#send').click();
  await page.locator('#open-subagents').waitFor({ state: 'visible' });
  await page.locator('#open-subagents').hover();
  await page.locator('#subagent-catalog .subagent-row').click();
  await page.waitForFunction(() => document.body.dataset.subagentPage === 'open');
  assert.equal(await page.locator('#subagent-transcript-process').getAttribute('open'), null);
  await page.locator('#subagent-transcript-process > summary').click();
  await page.waitForFunction(() =>
    document
      .querySelector('#subagent-transcript-messages')
      ?.textContent?.includes('实时查看子代理'),
  );
  await page.locator('#subagent-transcript .subagent-live').getByText('子代理实时片段').waitFor();
  assert.equal(requests >= 2, true);
  assert.equal(await page.locator('#subagent-transcript .subagent-live').isVisible(), true);
  releaseChild?.();
  await waitForPage(
    page,
    () => document.querySelector('#subagent-transcript-result-title')?.textContent === '最终结果',
  );
  await page
    .locator('#subagent-transcript-result')
    .getByText('子代理实时片段', { exact: true })
    .waitFor();
  assert.notEqual(await page.locator('#subagent-transcript-process').getAttribute('open'), null);
});

// ---- merged from user-message.smoke.mjs ----

test(
  'user bubbles contain only the question, shrink to fit, and retain time and copy',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-user-message-'));
    const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('收到。')));
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'bubble-fixture',
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
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    const question = '你不能读写文件吗';
    await page.locator('#prompt').fill(question);
    await page.locator('#send').click();
    await page.waitForFunction(
      () =>
        document.querySelector('.message.assistant') &&
        !document.querySelector('#choose-workspace').disabled,
    );
    const user = page.locator('.message.user').first();
    assert.equal(await user.locator('.message-label, .message-model').count(), 0);
    assert.equal(await user.locator('.user-bubble').innerText(), question);
    const time = await user.locator('time').getAttribute('datetime');
    assert.ok(Number.isFinite(Date.parse(time)));
    assert.match(await user.locator('time').innerText(), /^\d{2}:\d{2}$/);
    const bubble = await user.locator('.user-bubble').boundingBox();
    const area = await page.locator('#messages').boundingBox();
    assert.ok(bubble.width < area.width / 2);
    assert.ok(bubble.height < 65);
    const actions = await user.locator('.user-message-meta').boundingBox();
    assert.ok(actions.y >= bubble.y + bubble.height);
    await user.locator('.copy-user-message').click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), question);
    assert.equal(await user.locator('[role=status]').innerText(), '已复制');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await mkdir(artifactPath('user-message'), { recursive: true });
    await page.screenshot({ path: artifactPath('user-message/dark.png') });
    await page.locator('#new-session').click();
    await page.waitForFunction(() => !document.querySelector('.message.user'));
    await page.locator('.session-item').filter({ hasText: question }).click();
    await page.waitForFunction(() => Boolean(document.querySelector('.message.user time')));
    assert.equal(await page.locator('.message.user time').getAttribute('datetime'), time);
    const long = '请只修改当前项目，并保留已有配置。'.repeat(25) + '\n第二行继续说明。';
    await page.locator('#prompt').fill(long);
    await page.locator('#send').click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.message.user').length === 2 &&
        !document.querySelector('#choose-workspace').disabled,
    );
    const last = page.locator('.message.user').last();
    assert.equal(await last.locator('.message-content').textContent(), long);
    assert.ok((await last.locator('.user-bubble').boundingBox()).width <= 561);
    await last.locator('.copy-user-message').click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), long);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.screenshot({ path: artifactPath('user-message/light.png') });
  },
);
