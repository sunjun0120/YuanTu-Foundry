import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';
process.env.YUANTU_SESSION_TITLES = 'false';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { waitForPage } from './page-wait.mjs';

// ---- merged from desktop.smoke.mjs ----

for (const transition of ['Host recovery', 'model replacement']) {
  test(
    `desktop preserves read-only permissions after ${transition}`,
    { timeout: 60_000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-permission-recovery-'));
      const requests = [];
      const url = await httpFixture(t, (body, res) => {
        requests.push(body);
        sendFrames(res, frames(`PERMISSION_REPLY_${requests.length}`));
      });
      const env = {
        ...process.env,
        YUANTU_WORKSPACE: root,
        YUANTU_NODE_PATH: process.execPath,
        YUANTU_SANDBOX: 'host',
        YUANTU_PROTOCOL: 'anthropic',
        YUANTU_BASE_URL: url,
        YUANTU_MODEL: 'fixture',
        YUANTU_API_KEY: 'fixture',
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
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
      page.setDefaultTimeout(15_000);
      await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
      const applied = await page.evaluate(() =>
        window.yuantu.presets({ type: 'set', preset: 'observe' }),
      );
      assert.equal(applied.ok, true, applied.error);
      const checkReadOnly = async () => {
        const index = requests.length + 1;
        await page.locator('#prompt').fill(`Check permissions ${index}`);
        await page.locator('#send').click();
        await page.getByText(`PERMISSION_REPLY_${index}`, { exact: true }).waitFor();
        await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
        assert.equal(
          requests.at(-1).tools.some((tool) => tool.name === 'write_file'),
          false,
        );
        assert.equal(
          requests.at(-1).tools.some((tool) => tool.name === 'run_command'),
          false,
        );
        assert.equal(
          (await page.evaluate(() => window.yuantu.presets({ type: 'get' }))).view.current,
          'observe',
        );
      };
      await checkReadOnly();
      const before = await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
      );
      if (transition === 'Host recovery') {
        process.kill(before.hostPid, 'SIGKILL');
        await page.locator('#notice').waitFor();
        await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
      } else {
        const saved = await page.evaluate(
          (url) =>
            window.yuantu.settings({
              type: 'save',
              values: {
                connectionId: '',
                protocol: 'anthropic',
                baseUrl: url,
                apiKey: 'fixture',
                model: 'fixture2',
                maxContextTokens: 128000,
              },
            }),
          url,
        );
        assert.equal(saved.ok, true, saved.error);
      }
      const after = await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
      );
      assert.notEqual(after.hostPid, before.hostPid);
      assert.equal(after.session.sessionId, before.session.sessionId);
      await checkReadOnly();
    },
  );
}

test(
  'desktop applies the session sandbox only after startup is ready',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-startup-sandbox-'));
    const profile = path.join(root, 'profile');
    const entry = path.resolve('dist/desktop/main.cjs');
    const driver = path.join(root, 'desktop-driver.cjs');
    const errors = path.join(root, 'desktop-errors.log');
    // Capture errors before the desktop entry runs, including those emitted before Playwright connects.
    await writeFile(
      driver,
      `const { appendFileSync } = require('node:fs');
const originalError = console.error;
console.error = (...args) => {
  appendFileSync(${JSON.stringify(errors)}, args.map(String).join(' ') + '\\n');
  originalError(...args);
};
require(${JSON.stringify(entry)});
`,
    );
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_API_KEY: 'startup-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: 'http://127.0.0.1:1',
      YUANTU_PROTOCOL: 'anthropic',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.YUANTU_SANDBOX;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    let initialSession;
    for (const startup of ['new session', 'persisted session']) {
      await writeFile(errors, '');
      app = await electron.launch({
        executablePath: electronPath,
        args: [driver, `--user-data-dir=${profile}`],
        env,
        timeout: 15_000,
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(15_000);
      await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
      await assert.rejects(
        waitForPage(page, async () => false, undefined, { timeout: 500 }),
        /Timed out|Timeout/,
        'an asynchronous false condition must keep waiting until the deadline',
      );
      await page.waitForFunction(
        () => document.querySelector('#permission-mode').value === 'guarded',
      );
      assert.doesNotMatch(
        await readFile(errors, 'utf8'),
        /could not apply the session sandbox|Agent Host is not ready/,
        `${startup} must wait for the carrier before applying its sandbox`,
      );
      const sessionId = await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
      );
      assert.ok(sessionId, `${startup} must have an active session`);
      if (initialSession) assert.equal(sessionId, initialSession, 'restart restores the session');
      else initialSession = sessionId;
      await app.close();
      app = undefined;
    }
  },
);

test(
  'desktop window completes chat, file approvals, cancel and history after restart',
  { timeout: 90_000 },
  async (t) => {
    const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const entry = path.join(project, 'dist/desktop/main.cjs');
    await access(entry);
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-ui-'));
    await writeFile(path.join(root, 'readme.txt'), '桌面测试项目');
    let calls = 0;
    const url = await httpFixture(t, (body, res) => {
      calls++;
      const last = body.messages.at(-1);
      const prompt =
        typeof last.content === 'string'
          ? last.content
          : last.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('');
      if (prompt === '读取项目') {
        sendFrames(
          res,
          frames('正在读取项目说明。', [
            { id: 'read', name: 'read_file', input: { path: 'readme.txt' } },
          ]),
        );
      } else if (prompt === '创建文件' || prompt === '拒绝写入' || prompt === '取消写入') {
        const filename =
          prompt === '创建文件'
            ? 'approved.txt'
            : prompt === '拒绝写入'
              ? 'denied.txt'
              : 'cancelled.txt';
        sendFrames(
          res,
          frames('需要你确认以下文件操作。', [
            {
              id: `w${calls}`,
              name: 'write_file',
              input: {
                path: filename,
                content: '<script>window.injected = true</script>\n来自桌面审批',
              },
            },
          ]),
        );
      } else {
        sendFrames(res, frames('处理完成。项目内容已核对。'));
      }
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_BASE_URL: url,
      YUANTU_API_KEY: 'ui-fixture-secret',
      YUANTU_MODEL: 'fixture-model',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
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
        args: [entry, `--user-data-dir=${path.join(root, 'profile')}`],
        env,
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(15_000);
      await page.getByRole('button', { name: '发送', exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
      return page;
    };
    let page = await launch();
    // Replace only the native picker; exercise the real IPC and Host switch below.
    await page.getByRole('textbox', { name: '任务描述' }).fill('保留这段尚未发送的任务');
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole('button', { name: '更换目录' }).click();
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    assert.equal(
      await page.getByRole('textbox', { name: '任务描述' }).inputValue(),
      '保留这段尚未发送的任务',
    );
    const badRoot = path.join(root, 'unavailable-workspace');
    await mkdir(badRoot);
    await writeFile(path.join(badRoot, '.yuantu'), 'Not a directory');
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, badRoot);
    await page.getByRole('button', { name: '更换目录' }).click();
    await page.locator('#error').waitFor();
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    assert.equal(
      await page.getByRole('textbox', { name: '任务描述' }).inputValue(),
      '保留这段尚未发送的任务',
    );
    assert.equal(
      await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.workspace,
      ),
      root,
    );
    const send = async (prompt) => {
      await page.getByRole('textbox', { name: '任务描述' }).fill(prompt);
      await page.getByRole('button', { name: '发送', exact: true }).click();
    };
    // The composer stays editable during runs for Steer/Follow-up. Session controls
    // become available only after the run and history reconciliation have finished.
    const idle = async () => {
      try {
        await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
      } catch (error) {
        t.diagnostic(
          JSON.stringify(
            await page.evaluate(async () => {
              const snapshot = (await window.yuantu.invoke({ type: 'snapshot' })).state;
              return {
                error: snapshot.error,
                running: snapshot.session.running,
                status: snapshot.session.status,
                sessionError: snapshot.session.error,
                approvals: snapshot.session.approvals.map((a) => ({
                  id: a.id,
                  name: a.approval.toolCall.name,
                })),
                banner: document.querySelector('#error').textContent,
                mode: document.querySelector('#permission-mode').textContent,
              };
            }),
          ),
        );
        throw error;
      }
    };
    const audit = async () =>
      page.evaluate(async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.audit);
    await send('读取项目');
    await page.getByText('处理完成。项目内容已核对。', { exact: true }).waitFor();
    await idle();
    await send('创建文件');
    await page.getByRole('button', { name: '允许一次' }).waitFor();
    await assert.rejects(readFile(path.join(root, 'approved.txt')), { code: 'ENOENT' });
    assert.match(await page.locator('#approvals').innerText(), /approved.txt/);
    await page.locator('.approval-raw > summary').click();
    assert.match(await page.locator('#approvals').innerText(), /<script>window.injected/);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('#permission-mode').isDisabled(), false);
    // The execution policy is fixed during a run; settle this approval before switching presets.
    await page.getByRole('button', { name: '允许一次', exact: true }).click();
    await idle();
    await page.locator('#permission-trigger').click();
    /**
     * Full access is the rung that stops asking, so it is also the one behind the host confirmation — the test
     * acknowledges it here, which is the same thing an operator does. (It used to be possible to stop asking
     * about *writes* while staying confined; that rung is gone, and the chip says three things now.)
     */
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    await page.locator('#full-access-acknowledge').check();
    await page.locator('#full-access-enable').click();
    await idle();
    assert.match(await readFile(path.join(root, 'approved.txt'), 'utf8'), /来自桌面审批/);
    assert.equal(await page.locator('#approvals').innerText(), '');
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="guarded"]').click();
    await send('拒绝写入');
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await idle();
    await assert.rejects(readFile(path.join(root, 'denied.txt')), { code: 'ENOENT' });
    await waitForPage(page, async () => {
      const events = (await window.yuantu.invoke({ type: 'snapshot' })).state.audit;
      return (
        events.some(
          (event) =>
            event.type === 'approval.required' &&
            event.data.approval?.change?.path === 'denied.txt',
        ) &&
        events.some(
          (event) =>
            event.type === 'approval.decided' &&
            event.data.allow === false &&
            event.data.reason === 'user',
        )
      );
    });
    await send('取消写入');
    await page.getByRole('button', { name: '允许一次' }).waitFor();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await idle();
    await page.getByText('已停止', { exact: true }).waitFor();
    await assert.rejects(readFile(path.join(root, 'cancelled.txt')), { code: 'ENOENT' });
    await waitForPage(page, async () =>
      (await window.yuantu.invoke({ type: 'snapshot' })).state.audit.some(
        (event) =>
          event.type === 'approval.required' &&
          event.data.approval?.change?.path === 'cancelled.txt',
      ),
    );
    const auditBeforeRestart = await audit();
    assert.deepEqual(
      auditBeforeRestart
        .filter((event) => event.type === 'approval.required')
        .map((event) => event.data.approval?.change?.path),
      ['approved.txt', 'denied.txt', 'cancelled.txt'],
    );
    assert.ok(
      auditBeforeRestart.some(
        (event) => event.type === 'approval.decided' && event.data.allow === true,
      ),
    );
    assert.ok(
      auditBeforeRestart.some(
        (event) =>
          event.type === 'approval.decided' &&
          event.data.allow === false &&
          event.data.reason === 'user',
      ),
    );
    assert.ok(
      auditBeforeRestart.some(
        (event) => event.type === 'approval.decided' && event.data.reason === 'cancelled',
      ),
    );
    assert.equal(await page.locator('#audit-panel').count(), 0);
    const original = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await page.getByRole('heading', { name: '从一个任务开始。' }).waitFor();
    await app.close();
    app = undefined;
    page = await launch();
    await page.locator(`[data-session-id="${original}"]`).click();
    await page.locator('#messages').getByText('读取项目', { exact: true }).waitFor();
    await page.locator('#messages').getByText('取消写入', { exact: true }).waitFor();
    // The record survives a restart even though the process panel is no longer shown in the conversation.
    await waitForPage(page, async () =>
      (await window.yuantu.invoke({ type: 'snapshot' })).state.audit.some(
        (event) => event.type === 'approval.decided' && event.data.allow === true,
      ),
    );
    assert.deepEqual(await audit(), auditBeforeRestart);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const invalid = await page.evaluate(() =>
      window.yuantu.invoke({ type: 'exec', command: 'anything' }),
    );
    assert.equal(invalid.ok, false);
    assert.doesNotMatch(await page.locator('body').innerText(), /ui-fixture-secret/);
    if (process.env.YUANTU_QA_SCREENSHOT)
      await page.screenshot({ path: process.env.YUANTU_QA_SCREENSHOT });
    const otherRoot = path.join(root, 'other-project');
    await mkdir(otherRoot);
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, otherRoot);
    await page.getByRole('button', { name: '更换目录' }).click();
    await page.waitForFunction(
      (target) =>
        document.querySelector('#workspace').textContent === target &&
        !document.querySelector('#prompt').disabled,
      otherRoot,
    );
    await page.getByRole('heading', { name: '从一个任务开始。' }).waitFor();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, root);
    await page.getByRole('button', { name: '更换目录' }).click();
    await page.waitForFunction(
      (target) =>
        document.querySelector('#workspace').textContent === target &&
        !document.querySelector('#prompt').disabled,
      root,
    );
    await page.locator(`[data-session-id="${original}"]`).click();
    await page.locator('#messages').getByText('读取项目', { exact: true }).waitFor();
    await send('取消写入');
    await page.getByRole('button', { name: '允许一次' }).waitFor();
    await app.close();
    app = undefined;
    await assert.rejects(readFile(path.join(root, 'cancelled.txt')), { code: 'ENOENT' });
    app = await electron.launch({
      executablePath: electronPath,
      args: [entry, `--user-data-dir=${path.join(root, 'profile')}`],
      env: { ...env, YUANTU_API_KEY: '', ANTHROPIC_API_KEY: '' },
    });
    page = await app.firstWindow();
    await page.locator('#configuration').waitFor();
    assert.equal(await page.getByRole('textbox', { name: '任务描述' }).isDisabled(), true);
    await page.locator(`[data-session-id="${original}"]`).click();
    await page.locator('#messages').getByText('读取项目', { exact: true }).waitFor();
    const history = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session,
    );
    assert.equal(history.running, false);
    assert.equal(history.approvals.length, 0);
  },
);

// ---- merged from desktop-review.smoke.mjs ----

test(
  'desktop renders safe Markdown, copies highlighted code and reviews persisted diffs',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-review-ui-'));
    await writeFile(path.join(root, 'main.ts'), 'const count = 1;\n');
    let calls = 0;
    const markdown = [
      '## 修改完成',
      '',
      '**结果** 与 `count` &amp; 说明',
      '',
      '| 检查 | 结果 |',
      '| --- | --- |',
      '| 测试 | 通过 |',
      '',
      '```typescript',
      'const count = 2;',
      '```',
      '',
      '[文档](https://example.com/guide)',
      '[危险](javascript:alert(1))',
      '![远程图片](https://example.com/tracker.png)',
      '',
      '<img src=x onerror="window.injected=true"><script>window.injected=true</script>',
    ].join('\n');
    const url = await httpFixture(t, (_body, res) => {
      // Read, then edit: a change to a file this run has not read is refused before any approval, and this
      // scenario is built around approving the diff.
      const turn = calls++;
      sendFrames(
        res,
        turn === 0
          ? frames('检查完成，建议修改。', [
              { id: 'read', name: 'read_file', input: { path: 'main.ts' } },
            ])
          : turn === 1
            ? frames('检查完成，建议修改。', [
                {
                  id: 'change',
                  name: 'edit_file',
                  input: { path: 'main.ts', old_text: '1', new_text: '2' },
                },
              ])
            : frames(markdown),
      );
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
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('修改 count');
    await page.locator('#send').click();
    await page.locator('.approval .diff-added').waitFor();
    assert.match(await page.locator('.approval .file-diff').textContent(), /-const count = 1;/);
    assert.equal(await readFile(path.join(root, 'main.ts'), 'utf8'), 'const count = 1;\n');
    if (process.env.YUANTU_QA_SCREENSHOT)
      await page.screenshot({
        path: process.env.YUANTU_QA_SCREENSHOT.replace(/\.png$/, '-diff.png'),
      });
    await page.getByRole('button', { name: '允许一次' }).click();
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    assert.equal(await readFile(path.join(root, 'main.ts'), 'utf8'), 'const count = 2;\n');
    assert.equal(await page.locator('#messages .markdown h2').textContent(), '修改完成');
    assert.equal(await page.locator('#messages .markdown table').count(), 1);
    assert.match(await page.locator('#messages .markdown').last().textContent(), /count & 说明/);
    assert.ok((await page.locator('#messages .hljs-keyword').count()) > 0);
    assert.equal(await page.locator('#messages img,#messages script').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('#messages a').count(), 1);
    assert.equal(
      await page.locator('#messages a').getAttribute('href'),
      'https://example.com/guide',
    );
    await app.evaluate(({ shell }) => {
      globalThis.openedLinks = [];
      shell.openExternal = async (url) => {
        globalThis.openedLinks.push(url);
      };
    });
    await page.locator('#messages a').click();
    assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), [
      'https://example.com/guide',
    ]);
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'const count = 2;');
    assert.match(await page.locator('#changes-count').textContent(), /1 次文件操作/);
    const id = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await page.locator(`[data-session-id="${id}"]`).click();
    await page.locator('#changes').waitFor();
    assert.match(await page.locator('#changes-list').textContent(), /main.ts/);
    if (process.env.YUANTU_QA_SCREENSHOT) {
      await page.locator('#messages .code-block').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: process.env.YUANTU_QA_SCREENSHOT.replace(/\.png$/, '-markdown.png'),
        fullPage: true,
      });
    }
    await page.locator('#changes > summary').click();
    await page.locator('#changes-list .file-diff > summary').click();
    await page.getByRole('button', { name: '撤销此修改', exact: true }).click();
    await page.getByRole('button', { name: '确认恢复修改前内容', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('#changes-list').textContent.includes('已撤销'),
    );
    assert.equal(await readFile(path.join(root, 'main.ts'), 'utf8'), 'const count = 1;\n');
    assert.match(await page.locator('#messages').textContent(), /\[Files restored by user\]/);
  },
);

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
      '◈ Models',
    );
    assert.equal(
      (await page.locator('#mcp-settings').innerText()).replace(/\s+/g, ' '),
      '◇ MCP Services',
    );
    assert.equal(await page.locator('#permission-settings').count(), 0);
    await page.locator('#settings-back').click();
    await page.waitForFunction(() => !document.querySelector('#permission-mode').disabled);
    assert.equal(await page.locator('#permission-mode').inputValue(), 'guarded');
    await page.locator('#permission-trigger').click();
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
    assert.equal(await page.locator('#permission-mode').inputValue(), 'guarded');
    await page.locator('#full-access-close').click();
    assert.equal(await page.locator('#full-access-dialog').isVisible(), false);
    assert.equal(await page.locator('#permission-mode').inputValue(), 'guarded');
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    assert.equal(await page.locator('#full-access-dialog').isVisible(), true);
    await page.locator('#full-access-cancel').click();
    assert.equal(await page.locator('#permission-mode').inputValue(), 'guarded');
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
    for (const tab of ['general-settings', 'model-settings', 'mcp-settings']) {
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
      await mkdir('artifacts', { recursive: true });
      await page.screenshot({ path: 'artifacts/settings-general-' + value + '.png' });

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
    await mkdir('artifacts', { recursive: true });
    await page.locator('#prompt').fill('');
    await page.screenshot({ path: 'artifacts/desktop-layout-dark.png' });
    await page.locator('#prompt').fill('保留这段草稿');
    await theme('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await logo('light');
    await page.locator('#prompt').fill('');
    await page.screenshot({ path: 'artifacts/desktop-layout-light.png' });
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
    await page.locator('#mcp-settings').click();
    assert.equal(await page.locator('#mcp-panel').isVisible(), true);
    for (const [tab, panel] of [
      ['mcp-settings', '#mcp-panel'],
      ['general-settings', '#general-settings-content'],
      ['model-settings', '[aria-labelledby="settings-title"]'],
      ['mcp-settings', '#mcp-panel'],
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
    await page.screenshot({ path: 'artifacts/settings-mcp-layout.png' });

    await page.locator('#settings-back').click();
    await fits();
  },
);

// ---- merged from header-background.smoke.mjs ----

test('background tasks live in a conditional header popover without workspace context', async () => {
  const [html, renderer, css] = await Promise.all([
    readFile('apps/desktop/index.html', 'utf8'),
    readFile('apps/desktop/renderer.ts', 'utf8'),
    readFile('apps/desktop/layout.css', 'utf8'),
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
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/background-hover.png' });
    await row.evaluate((element) => {
      window.__backgroundRow = element;
    });
    await row.locator('.background-command').click();
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.__backgroundRow?.isConnected), true);
    assert.equal(await row.getAttribute('open'), null);
    assert.equal(await row.locator('summary, .background-meta, .background-log').count(), 0);
    assert.equal(
      await page.locator('#background-popover').evaluate((panel) => panel.hidden),
      false,
    );
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
    assert.equal(await page.locator('#open-background').isVisible(), true);
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
    assert.equal(await reopened.locator('#open-background').isVisible(), true);
  },
);

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
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);

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
    await page.locator('#prompt').fill('/switch');
    assert.ok(((await page.locator('#command-menu').textContent()) ?? '').includes('/model'));

    const report = [...after].map(
      ([text, where]) => `  ${text}   (${[...new Set(where)].join(', ')})`,
    );
    assert.deepEqual(
      report,
      [],
      `en-US still shows Chinese (zh-CN baseline: ${before.size} strings):\n${report.join('\n')}`,
    );
  },
);

// ---- header interactions and first-run naming ----

test(
  'a new chat shows the model-generated title before its first reply finishes',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-title-before-reply-ui-'));
    let requests = 0;
    let releaseReply;
    const url = await httpFixture(t, async (_body, res) => {
      requests++;
      if (requests === 1) return sendFrames(res, frames('修复登录跳转'));
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
    await page.getByText('修复登录跳转', { exact: true }).first().waitFor();
    assert.equal(requests, 2, 'title request must precede the still-pending reply request');
    assert.equal(await page.getByText('首轮回复完成', { exact: true }).count(), 0);
    releaseReply?.();
    await page.getByText('首轮回复完成', { exact: true }).waitFor();
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
    await page.waitForFunction(() => document.querySelector('#new-session').disabled);
    await page.locator('#open-subagents').hover();
    await page.locator('#subagents-popover').waitFor({ state: 'visible' });
    const subagentPopoverBounds = await page.locator('#subagents-popover').boundingBox();
    assert.ok(subagentPopoverBounds && subagentPopoverBounds.width <= 340);
    await page.locator('#subagent-catalog .subagent-row').click();
    await page.waitForFunction(() => document.body.dataset.subagentPage === 'open');
    await page.getByText('子代理实时记录', { exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
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
  await page.waitForFunction(() =>
    document
      .querySelector('#subagent-transcript-messages')
      ?.textContent?.includes('实时查看子代理'),
  );
  await page.locator('#subagent-transcript .subagent-live').getByText('子代理实时片段').waitFor();
  assert.equal(requests >= 2, true);
  assert.equal(await page.locator('#subagent-transcript .subagent-live').isVisible(), true);
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
        !document.querySelector('#new-session').disabled,
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
    await mkdir('artifacts/user-message', { recursive: true });
    await page.screenshot({ path: 'artifacts/user-message/dark.png' });
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
        !document.querySelector('#new-session').disabled,
    );
    const last = page.locator('.message.user').last();
    assert.equal(await last.locator('.message-content').textContent(), long);
    assert.ok((await last.locator('.user-bubble').boundingBox()).width <= 561);
    await last.locator('.copy-user-message').click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), long);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.screenshot({ path: 'artifacts/user-message/light.png' });
  },
);

// ---- merged from capabilities.smoke.mjs ----

test(
  'desktop attaches images, discovers skills, steers approvals and follows up',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-capabilities-'));
    const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    await mkdir(path.join(root, '.yuantu/skills/review'), { recursive: true });
    await writeFile(
      path.join(root, '.yuantu/skills/review/SKILL.md'),
      '---\nname: review\ndescription: Review code\n---\nCheck regressions.',
    );
    await writeFile(path.join(root, 'AGENTS.md'), 'Use concise Chinese.');
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5u8AAAAASUVORK5CYII=';
    let calls = 0;
    let continueSteer;
    let steerReady;
    const steering = new Promise((resolve) => {
      steerReady = resolve;
    });
    const url = await httpFixture(t, (body, res) => {
      const call = calls++;
      if (call === 0) {
        assert.ok(body.messages[0].content.some((p) => p.type === 'image'));
        assert.match(systemText(body.system), /concise Chinese/);
        assert.match(JSON.stringify(body.messages[0]), /Check regressions/);
        sendFrames(
          res,
          frames('Waiting', [
            { id: 'write', name: 'write_file', input: { path: 'no.txt', content: 'no' } },
          ]),
        );
      } else if (call === 1) {
        assert.match(JSON.stringify(body.messages), /不要写入，只解释/);
        continueSteer = () => sendFrames(res, frames('已解释'));
        steerReady();
      } else {
        assert.match(JSON.stringify(body.messages.at(-1)), /最后列出检查清单/);
        sendFrames(res, frames('任务已按追加指令完成'));
      }
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'test',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    t.after(async () => {
      if (app) {
        const timer = setTimeout(() => app.process().kill(), 5000);
        try {
          await app.close();
        } finally {
          clearTimeout(timer);
        }
      }
      await rm(root, { recursive: true, force: true });
    });
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.join(project, 'dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    assert.equal(await page.locator('#skill-select').count(), 0);
    await page.locator('#prompt').fill('/');
    await page.getByRole('option').filter({ hasText: 'review' }).waitFor();
    await page.locator('#image-input').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await page.locator('#prompt').fill('/');
    await page.getByRole('option').filter({ hasText: 'review' }).click();
    await page.locator('#prompt').fill('/skill:review 看图并修改');
    await page.locator('#send').click();
    /**
     * The desktop has no steer control any more: the select that chose between steering and queueing is gone, and
     * a message typed while the run is live is queued for after the turn. The *runtime* still takes a steer, so
     * the test drives the command the removed control used to send — the path stays covered without the suite
     * pretending the interface offers it.
     */
    await page.evaluate(() =>
      window.yuantu.invoke({ type: 'enqueue', mode: 'steer', prompt: '不要写入，只解释' }),
    );
    await steering;
    await page.locator('#prompt').fill('最后列出检查清单');
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('#queue').textContent.includes('最后列出检查清单'),
    );
    continueSteer();
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.match(await page.locator('#messages').textContent(), /不要写入，只解释/);
    assert.match(await page.locator('#messages').textContent(), /最后列出检查清单/);
    assert.match(await page.locator('#messages').textContent(), /\/skill:review 看图并修改/);
    assert.doesNotMatch(await page.locator('#messages').textContent(), /Check regressions/);
    assert.equal(calls, 3);
    await assert.rejects(readFile(path.join(root, 'no.txt')), { code: 'ENOENT' });
    assert.equal(await page.locator('#messages img').count(), 1);
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();
    await page.locator('#settings-protocol').selectOption('openai');
    assert.equal(await page.locator('#settings-protocol').inputValue(), 'openai');
  },
);

test(
  'desktop labels and approves external MCP access without a shell permission shortcut',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-ui-'));
    await mkdir(path.join(root, '.yuantu'));
    await writeFile(
      path.join(root, '.yuantu/mcp.json'),
      JSON.stringify({
        servers: {
          local: {
            transport: 'stdio',
            command: process.execPath,
            args: [path.resolve('tests/mcp-fixture.ts'), 'mcp-pid.txt'],
          },
        },
      }),
    );
    let turns = 0;
    const url = await httpFixture(t, (body, res) => {
      if (turns++ === 0)
        sendFrames(
          res,
          frames('', [
            {
              id: 'mcp-ui',
              name: 'mcp_local_call_tool',
              input: { name: 'echo', arguments: { text: 'MCP_UI_OK' } },
            },
          ]),
        );
      else {
        assert.match(JSON.stringify(body.messages), /MCP_UI_OK/);
        sendFrames(res, frames('MCP_UI_OK'));
      }
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
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('Use the external echo tool');
    await page.locator('#send').click();
    await page.getByRole('heading', { name: '访问外部服务' }).waitFor();
    await assert.rejects(readFile(path.join(root, 'mcp-pid.txt')), { code: 'ENOENT' });
    await page.getByRole('button', { name: '允许一次', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.match(await page.locator('#messages').textContent(), /MCP_UI_OK/);
    const pid = Number(await readFile(path.join(root, 'mcp-pid.txt'), 'utf8'));
    assert.throws(() => process.kill(pid, 0));
  },
);

test(
  'desktop shows the checklist the model writes and keeps it current across writes',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-todo-ui-'));
    const todo = (id, content, status) => ({ id, content, status });
    /**
     * One held-open turn per planning answer.
     *
     * The panel lives exactly as long as the turn that wrote its list, so a test that inspects the panel has
     * to keep that turn running: the fixture answers the request that follows the `todo_write` only when the
     * test releases it. Without the gate the run finishes in milliseconds and the panel is gone before the
     * first assertion can read it — which is the behaviour under test, not an obstacle to it.
     */
    let release;
    const releaseRun = async () => {
      for (let waited = 0; waited < 200 && !release; waited++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      release?.();
      release = undefined;
    };
    const messagesOf = (body) => (Array.isArray(body?.messages) ? body.messages : []);
    const lastUserText = (body) => {
      for (const message of [...messagesOf(body)].reverse()) {
        if (message.role !== 'user') continue;
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content))
          return message.content
            .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
            .join('');
      }
      return '';
    };
    const writeTodos = (res, id, text, todos) =>
      sendFrames(res, frames(text, [{ id, name: 'todo_write', input: { todos } }]));
    /**
     * Whether this request is the follow-up inside a turn that already called a tool.
     *
     * Two shapes have to be recognised because a tool result is not one thing on the wire: OpenAI-style
     * adapters send a message whose role is `tool`, while Anthropic sends a *user* message carrying a
     * `tool_result` block. Reading only the first shape would make this fixture answer the follow-up as if it
     * were a fresh user turn, and the model would ask for the same tool forever.
     */
    const isFollowUp = (body) => {
      const last = messagesOf(body).at(-1);
      if (!last) return false;
      if (last.role === 'tool') return true;
      return (
        last.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.some((block) => block?.type === 'tool_result')
      );
    };
    const url = await httpFixture(t, async (body, res) => {
      const asked = lastUserText(body);
      if (isFollowUp(body)) {
        // The tool result is the only place the model reads its own list back.
        assert.match(JSON.stringify(body.messages), /Fix the retry/);
        await new Promise((resolve) => (release = resolve));
        sendFrames(res, frames('Done'));
        return;
      }
      if (asked.includes('without a plan')) {
        // A turn that writes no list at all: the panel must not come back for it.
        await new Promise((resolve) => (release = resolve));
        sendFrames(res, frames('No new plan'));
        return;
      }
      if (asked.includes('Plan it again'))
        return writeTodos(res, 'todo-3', 'Re-planning', [
          todo('a', 'Read the loader', 'completed'),
          todo('d', 'Ship the fix', 'pending'),
        ]);
      if (asked.includes('Carry on'))
        return writeTodos(res, 'todo-2', 'Finishing', [
          todo('a', 'Read the loader', 'completed'),
          todo('b', 'Fix the retry', 'completed'),
          todo('c', 'Run the tests', 'in_progress'),
        ]);
      return writeTodos(res, 'todo-1', 'Planning', [
        todo('a', 'Read the loader', 'in_progress'),
        todo('b', 'Fix the retry', 'pending'),
        todo('c', 'Run the tests', 'pending'),
      ]);
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
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    // Absent, not empty: no plan yet is a different statement from an empty plan.
    assert.equal(await page.locator('#todos-panel').isVisible(), false);
    await page.locator('#prompt').fill('Plan the fix');
    await page.locator('#send').click();
    await page.locator('#todos-panel').waitFor();
    assert.equal(
      await page.locator('#todos-panel').evaluate((el) => el.closest('.composer-area') !== null),
      true,
    );
    assert.equal(await page.locator('#todos-panel').getAttribute('open'), null);
    assert.match(
      await page.locator('#todos-panel > summary').innerText(),
      /任务[\s\S]*0 已完成 · 1 进行中 · 2 待处理/,
    );
    const panelColor = async (theme) =>
      page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        return getComputedStyle(document.querySelector('#todos-panel')).backgroundColor;
      }, theme);
    assert.notEqual(await panelColor('dark'), await panelColor('light'));
    await panelColor('system');
    await page.locator('#todos-panel > summary').click();
    assert.equal(await page.locator('#todos .todo').count(), 3);
    assert.equal(
      await page.locator('#todos .todo-in-progress .todo-content').innerText(),
      'Read the loader',
    );
    assert.equal(await page.locator('#todos .todo-completed').count(), 0);
    assert.equal(
      await page.locator('#todos-summary').innerText(),
      '0 已完成 · 1 进行中 · 2 待处理',
    );
    // The panel answers "what is the plan now"; it does not report what the last write changed about it.
    assert.equal(await page.locator('#todos-change').count(), 0);
    assert.deepEqual(await page.locator('#todos .todo-content').allInnerTexts(), [
      'Read the loader',
      'Fix the retry',
      'Run the tests',
    ]);
    // A written list remains available above the composer after the turn finishes.
    assert.equal(await page.locator('#todos-panel').isVisible(), true);
    await releaseRun();
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.equal(await page.locator('#todos-panel').isVisible(), true);
    // The second turn updates the same visible list.
    await page.locator('#prompt').fill('Carry on');
    await page.locator('#send').click();
    await page.waitForFunction(
      () => document.querySelectorAll('#todos .todo-completed').length === 2,
    );
    assert.equal(await page.locator('#todos-panel').getAttribute('open'), '');
    assert.match(
      await page.locator('#todos-panel > summary').innerText(),
      /2 已完成 · 1 进行中 · 0 待处理/,
    );
    assert.equal(
      await page.locator('#todos .todo-in-progress .todo-content').innerText(),
      'Run the tests',
    );
    assert.equal(
      await page.locator('#todos-summary').innerText(),
      '2 已完成 · 1 进行中 · 0 待处理',
    );
    /**
     * What the second write changed about the first is not drawn: the list below *is* the answer, and it is the
     * one that stays true. The same three items moved to another state, which is what this reads off the rows.
     */
    assert.deepEqual(
      await page
        .locator('#todos .todo')
        .evaluateAll((items) => items.map((item) => item.className.replace('todo todo-', ''))),
      ['completed', 'completed', 'in-progress'],
    );
    assert.equal(await page.locator('#todos .todo-completed .todo-content').count(), 2);
    await releaseRun();
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.equal(await page.locator('#todos-panel').isVisible(), true);
    // A turn that writes no list leaves the latest saved list available.
    await page.locator('#prompt').fill('Carry on without a plan');
    await page.locator('#send').click();
    await releaseRun();
    await page.getByText('No new plan', { exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.equal(
      await page.locator('#todos-panel').isVisible(),
      false,
      'a question the model answered without writing a plan does not keep the previous one on screen',
    );
    // A new write replaces the list already on screen.
    await page.locator('#prompt').fill('Plan it again');
    await page.locator('#send').click();
    await page.waitForFunction(
      () =>
        document.querySelector('#todos-summary')?.textContent === '1 已完成 · 0 进行中 · 1 待处理',
    );
    assert.equal(
      await page.locator('#todos-summary').innerText(),
      '1 已完成 · 0 进行中 · 1 待处理',
    );
    assert.deepEqual(await page.locator('#todos .todo-content').allInnerTexts(), [
      'Read the loader',
      'Ship the fix',
    ]);
    // The last saved version stays visible when the run finishes.
    await releaseRun();
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.equal(await page.locator('#todos-panel').isVisible(), true);
  },
);

// ---- merged from launcher.smoke.mjs ----
const exec = promisify(execFile);
function launch(args, env) {
  const child = spawn(process.execPath, [path.resolve('scripts/start-desktop.mjs'), ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  return { child, closed, output: () => output };
}
async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Launcher did not reach expected state');
}
async function windowProbe(parentPid, action = 'inspect') {
  assert.ok(Number.isSafeInteger(parentPid));
  const source = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LauncherProbe {
 public delegate bool Callback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int max);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static string Inspect(uint target,string action) {
  string result="missing";
  EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);
   if(pid==target) {var title=new StringBuilder(256);GetWindowText(h,title,256);
    if(title.ToString()=="YuanTu Agent") {
     result="visible="+IsWindowVisible(h)+" minimized="+IsIconic(h);
     if(action=="minimize")ShowWindowAsync(h,6);
     if(action=="close")PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);
    }
   }return true;
  },IntPtr.Zero);return result;
 }
}
'@
$process = Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Where-Object {$_.Name -eq 'electron.exe'} | Select-Object -First 1
if(!$process) { throw 'Launcher child missing' }
[LauncherProbe]::Inspect($process.ProcessId,'${action}')
`;
  const { stdout } = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(source, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 10000 },
  );
  return stdout.trim();
}
test(
  'actual Windows launcher shows its window and duplicate launch restores the existing instance',
  { skip: process.platform !== 'win32', timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-launch-'));
    const profile = path.join(root, 'profile');
    const args = ['--workspace', root, '--user-data-dir', profile];
    const env = {
      ...process.env,
      YUANTU_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      YUANTU_MODEL: '',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
    };
    const first = launch(args, env);
    let exited = false;
    void first.closed.then(() => {
      exited = true;
    });
    t.after(async () => {
      if (!exited) {
        await windowProbe(first.child.pid, 'close').catch(() => {});
        await Promise.race([first.closed, new Promise((r) => setTimeout(r, 5000))]);
      }
      if (!exited) {
        await exec('taskkill.exe', ['/PID', String(first.child.pid), '/T', '/F'], {
          windowsHide: true,
        }).catch(() => {});
        await first.closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    await waitFor(() => first.output().includes('[desktop] host.ready'));
    assert.equal(await windowProbe(first.child.pid), 'visible=True minimized=False');
    await windowProbe(first.child.pid, 'minimize');
    assert.match(await windowProbe(first.child.pid), /minimized=True/);
    const second = launch(args, env);
    const secondCode = await Promise.race([
      second.closed,
      new Promise((_, reject) => {
        setTimeout(() => {
          second.child.kill();
          reject(new Error('Duplicate launch failed to exit'));
        }, 10000).unref();
      }),
    ]);
    assert.equal(secondCode, 0);
    assert.match(second.output(), /Existing window activated/);
    assert.equal(await windowProbe(first.child.pid), 'visible=True minimized=False');
  },
);

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
      page.setDefaultTimeout(8000);
      await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
      return page;
    };
    let page = await launch();
    const row = (id) => page.locator(`[data-session-id="${id}"]`);
    const more = (id) => page.locator(`[data-menu-session-id="${id}"]`);
    const idle = () => page.waitForFunction(() => !document.querySelector('#new-session').disabled);
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
      await page.screenshot({ path: path.join(process.env.YUANTU_QA_DIR, 'session-menu.png') });
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
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/question-panel.png' });
    await questions.locator('.question-option', { hasText: '红色' }).click();
    await questions.locator('.question-option', { hasText: '蓝色' }).click();
    // One question, one answer: picking the second option has to release the first.
    const chosen = questions.locator('.question-option.selected');
    assert.equal(await chosen.count(), 1);
    assert.match(await chosen.innerText(), /蓝色/);
    await questions.getByRole('button', { name: '提交' }).click();
    await page.getByText('已按蓝色继续。', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
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
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
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
    assert.equal(await page.locator('#jump-to-latest').isVisible(), false);
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
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled);

  await page.locator('#open-workspace').click();
  await page.waitForFunction(() => document.body.dataset.workspaceView === 'open');
  assert.equal(await page.locator('#workspace-panel').isVisible(), true);
  const row = (name) => page.locator(`#workspace-tree .workspace-entry-button[title="${name}"]`);
  await row('notes.txt').waitFor();
  const resizeHandle = page.locator('#workspace-resize');
  await resizeHandle.waitFor({ state: 'visible' });
  const initialWidth = (await page.locator('#workspace-panel').boundingBox()).width;
  const handleBounds = await resizeHandle.boundingBox();
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x - 100, 300, { steps: 8 });
  await page.mouse.up();
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
    await mkdir(path.dirname(process.env.YUANTU_QA_SCREENSHOT), { recursive: true });
    await page.screenshot({
      path: process.env.YUANTU_QA_SCREENSHOT.replace(/\.png$/, '-tree.png'),
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
      path: process.env.YUANTU_QA_SCREENSHOT.replace(/\.png$/, '-tabs.png'),
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
    await mkdir(path.dirname(process.env.YUANTU_QA_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.YUANTU_QA_SCREENSHOT });
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
      path: process.env.YUANTU_QA_SCREENSHOT.replace(/\.png$/, '-light.png'),
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
  for (const name of ['guide.md', 'long.log', 'logo.png', 'blob.txt'])
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
