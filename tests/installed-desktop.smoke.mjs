import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';

async function retainedFiles(roots) {
  const files = {};
  async function visit(root, relative = '') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(root, name);
      else if (entry.isFile())
        files[path.join(root, name)] = createHash('sha256')
          .update(await readFile(path.join(root, name)))
          .digest('hex');
      else throw new Error(`Unexpected retained symlink: ${name}`);
    }
  }
  for (const root of roots) await visit(root);
  return files;
}

test(
  'packaged desktop starts with its bundled runtime, survives Chinese paths and restores its session without development PATH',
  { timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-installed-'));
    const installed = process.env.PACKAGED_TEST_DIRECTORY || path.join(root, '中文 安装目录');
    const profile = process.env.PACKAGED_TEST_PROFILE || path.join(root, '隔离 用户数据');
    const workspace = process.env.PACKAGED_TEST_WORKSPACE || path.join(root, '用户 工作区');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, '用户文件.txt'), 'INSTALLER_MUST_PRESERVE_THIS_FILE');
    if (!process.env.PACKAGED_TEST_DIRECTORY)
      await cp(path.resolve('dist/release/win-unpacked'), installed, { recursive: true });
    const node = path.join(installed, 'resources/runtime/node.exe');
    let parentStage = 0;
    let ptyPrinted = false;
    const url = await httpFixture(t, (body, response) => {
      if (systemText(body.system).includes('You are a sub-agent delegated by a parent agent'))
        return sendFrames(
          response,
          frames('', [
            {
              id: 'child-report',
              name: 'submit_report',
              input: {
                summary: 'PACKAGED_CHILD_DONE',
                findings: [
                  {
                    statement: 'Installed child connected',
                    evidence: 'The local fixture received the delegated request',
                  },
                ],
                unverified: [],
              },
            },
          ]),
        );
      const stage = parentStage++;
      if (stage === 0)
        return sendFrames(
          response,
          frames('Starting installed capabilities', [
            {
              id: 'background',
              name: 'start_command',
              input: { command: `"${node}" -e "console.log('PACKAGED_BACKGROUND_DONE')"` },
            },
            {
              id: 'pty',
              name: 'terminal_open',
              input: { command: node, args: ['-e', "console.log('PACKAGED_PTY_DONE')"] },
            },
            {
              id: 'child',
              name: 'delegate_task',
              input: { tasks: [{ objective: 'verify packaged child', role: 'explore' }] },
            },
          ]),
        );
      const resultText =
        body.messages
          .filter((message) => message.role === 'user')
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter(
            (block) =>
              block.type === 'tool_result' && block.tool_use_id?.startsWith('terminal-read-'),
          )
          .map((block) =>
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          )
          .at(-1) || '';
      if (resultText.includes('PACKAGED_PTY_DONE')) ptyPrinted = true;
      if (stage > 0 && stage < 16 && !(ptyPrinted && /exit 0/.test(resultText))) {
        const id = /Terminal ([a-f0-9-]+) started/.exec(JSON.stringify(body.messages))?.[1];
        assert.ok(id, 'Opening the installed PTY must return its identifier');
        return sendFrames(
          response,
          frames('Checking installed terminal', [
            {
              id: `terminal-read-${stage}`,
              name: 'terminal_read',
              input: {
                id,
                cursor: Number(/cursor (\d+)/.exec(resultText)?.[1] || 0),
                wait_ms: 2000,
              },
            },
          ]),
        );
      }
      sendFrames(response, frames('INSTALLED_HOST_REPLY'));
    });
    const env = {
      ...process.env,
      PATH: [
        path.join(process.env.SystemRoot || 'C:/Windows', 'System32'),
        path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0'),
      ].join(path.delimiter),
      YUANTU_WORKSPACE: workspace,
      YUANTU_SANDBOX: 'host',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.YUANTU_NODE_PATH;
    delete env.NODE_OPTIONS;
    let app;
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const launch = () =>
      electron.launch({
        executablePath: path.join(installed, 'YuanTu Agent.exe'),
        args: [`--user-data-dir=${profile}`],
        cwd: installed,
        env,
      });
    const install = (uninstall = false) =>
      promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-File',
          path.resolve('scripts/verify-windows-install.ps1'),
          '-Installer',
          process.env.PACKAGED_TEST_INSTALLER,
          '-InstallDirectory',
          installed,
          ...(uninstall ? ['-Uninstall'] : []),
        ],
        { timeout: 120000 },
      );
    app = await launch();
    let errors = '';
    app.process().stderr?.on('data', (chunk) => {
      errors += String(chunk);
      process.stderr.write(`[installed] ${chunk}`);
    });
    // Native error dialogs block automation; capture them and fail on their actual message.
    await app.evaluate(({ dialog }) => {
      dialog.showErrorBox = (title, message) =>
        console.error(`VERIFY_NATIVE_ERROR: ${title}: ${message}`);
    });
    let page = await app.firstWindow();
    try {
      await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    } catch (error) {
      console.error(
        'Installed startup snapshot:',
        JSON.stringify(await page.evaluate(() => window.yuantu.invoke({ type: 'snapshot' }))),
      );
      throw error;
    }
    const created = await page.evaluate(() => window.yuantu.invoke({ type: 'create' }));
    assert.equal(created.ok, true, created.error);
    const saved = await page.evaluate(
      (url) =>
        window.yuantu.settings({
          type: 'save',
          values: {
            name: 'Installed retention model',
            baseUrl: url,
            model: 'fixture',
            protocol: 'anthropic',
            apiKey: 'packaged-fixture-key',
            maxContextTokens: 128000,
          },
        }),
      url,
    );
    assert.equal(saved.ok, true, saved.error);
    const permissions = await page.evaluate(() =>
      window.yuantu.presets({ type: 'set', preset: 'unconfined', acknowledgeHost: true }),
    );
    assert.equal(permissions.ok, true, permissions.error);
    await page.locator('#prompt').fill('prove installed host connection');
    await page.locator('#send').click();
    await page.getByText('INSTALLED_HOST_REPLY', { exact: true }).waitFor();
    console.error('[verify] installed tools completed');
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    const first = await page.evaluate(() => window.yuantu.invoke({ type: 'snapshot' }));
    assert.equal(first.ok, true, first.error);
    const transcript = JSON.stringify(first.state.session.messages);
    assert.match(transcript, /PACKAGED_CHILD_DONE/);
    assert.match(transcript, /Terminal .* started/);
    assert.match(transcript, /PACKAGED_PTY_DONE/);
    const terminals = first.state.session.messages.filter(
      (message) => message.role === 'tool' && message.toolCallId?.startsWith('terminal-read-'),
    );
    assert.match(
      terminals.map((message) => String(message.content)).join('\n'),
      /PACKAGED_PTY_DONE/,
    );
    assert.match(String(terminals.at(-1)?.content), /exit[: ]+0|exitCode.*0|exited.*0/);
    assert.doesNotMatch(transcript, /node-pty is not available/);
    const child = first.state.session.subagents.find((child) => child.childSessionId);
    assert.ok(child, 'Installed child must be navigable');
    const viewed = await page.evaluate(
      (child) =>
        window.yuantu.invoke({
          type: 'subagentTranscript',
          subagentId: child.id,
          childSessionId: child.childSessionId,
        }),
      child,
    );
    assert.equal(viewed.ok, true, viewed.error);
    assert.match(JSON.stringify(viewed.state.subagentTranscript.messages), /PACKAGED_CHILD_DONE/);
    await page.evaluate(() => window.yuantu.invoke({ type: 'closeSubagentTranscript' }));
    await page.waitForFunction(async () => {
      const state = await window.yuantu.invoke({ type: 'refreshBackground' });
      return (
        state.ok &&
        state.state.background.some(
          (job) =>
            job.status === 'completed' &&
            job.exitCode === 0 &&
            (job.output || '').includes('PACKAGED_BACKGROUND_DONE'),
        )
      );
    });
    console.error('[verify] installed background completed');
    const ui = await page.evaluate(() =>
      window.yuantu.uiSettings({
        type: 'save',
        settings: { language: 'zh-CN', appearance: 'dark', fontSize: 'large' },
      }),
    );
    assert.equal(ui.ok, true, ui.error);
    await app.close();
    app = undefined;
    assert.doesNotMatch(errors, /VERIFY_NATIVE_ERROR/, errors);
    if (process.env.PACKAGED_TEST_INSTALLER) {
      const before = await retainedFiles([profile, workspace]);
      await install();
      assert.deepEqual(
        await retainedFiles([profile, workspace]),
        before,
        'Reinstallation must preserve every profile and workspace file',
      );
    }
    console.error('[verify] first desktop closed');
    app = await launch();
    console.error('[verify] desktop relaunched');
    page = await app.firstWindow();
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.getByText('INSTALLED_HOST_REPLY', { exact: true }).waitFor();
    const loaded = await page.evaluate(() => window.yuantu.invoke({ type: 'snapshot' }));
    assert.equal(loaded.ok, true, loaded.error);
    const retained = await page.evaluate(() => window.yuantu.settings({ type: 'get' }));
    assert.equal(retained.ok, true, retained.error);
    assert.equal(retained.settings.hasKey, true);
    const retainedUi = await page.evaluate(() => window.yuantu.uiSettings({ type: 'get' }));
    assert.equal(retainedUi.settings.appearance, 'dark');
    assert.equal(retainedUi.settings.fontSize, 'large');
    await app.close();
    app = undefined;
    if (process.env.PACKAGED_TEST_INSTALLER) {
      const before = await retainedFiles([profile, workspace]);
      await install(true);
      assert.deepEqual(
        await retainedFiles([profile, workspace]),
        before,
        'Uninstallation must preserve every profile and workspace file',
      );
      await assert.rejects(access(path.join(installed, 'YuanTu Agent.exe')), /ENOENT/);
    }
  },
);
