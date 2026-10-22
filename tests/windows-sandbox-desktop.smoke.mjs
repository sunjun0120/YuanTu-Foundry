// @test-serial windows-sandbox: Exercises real Windows sandbox ACLs and trusted control state.
// @test-serial desktop-ui: Launches real Electron windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { waitForPage } from './page-wait.mjs';
import { verificationNudge } from './desktop-smoke-support.mjs';
import { quoteWindowsArgument } from '../packages/tools/sandbox-windows.ts';

const execute = promisify(execFile);
const packagedApp = process.env.WINDOWS_SANDBOX_PACKAGED_APP;
const acl = async (root) =>
  (await execute('icacls.exe', [root])).stdout.split(/\r?\n\s*\r?\n/, 1)[0].trim();
const eventually = async (read, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw Error('Desktop Windows acceptance evidence timed out');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};

test(
  'Windows desktop enforces the selected basic sandbox, joins cancellation and exit, and reopens its session',
  { skip: process.platform !== 'win32' && 'needs Windows', timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-desktop-windows-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'yuantu-desktop-outside-'));
    // Match a normal desktop install: Chromium's mutable profile is not a guest workspace.
    const profile = await mkdtemp(path.join(os.tmpdir(), 'yuantu-desktop-profile-'));
    const exitErrors = path.join(profile, 'exit-errors.jsonl');
    await mkdir(path.join(root, '.codex'));
    await writeFile(path.join(outside, 'canary'), 'unchanged');
    const originalAcl = await acl(root);
    const probe = path.join(root, 'probe.cjs');
    const wait = path.join(root, 'wait.cjs');
    await writeFile(
      probe,
      `const fs=require('node:fs');const result={token:process.argv[2],executable:process.execPath,secret:process.env.YUANTU_API_KEY??null};
fs.writeFileSync('allowed.txt',result.token);
for(const [key,file] of [['outside',${JSON.stringify(path.join(outside, 'forbidden'))}],['metadata','.codex/forbidden']]){try{fs.writeFileSync(file,'bad');result[key]='allowed'}catch(e){result[key]=e.code}}
fs.writeFileSync('desktop-proof.json',JSON.stringify(result));console.log('DESKTOP_NATIVE_OK');`,
    );
    await writeFile(
      wait,
      `const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',"require('node:fs').writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});child.on('error',e=>{throw e});setInterval(()=>{},1000);`,
    );
    const commands = {
      'verify basic': `${quoteWindowsArgument(process.execPath)} ${quoteWindowsArgument(probe)}`,
      'wait for cancel': `${quoteWindowsArgument(process.execPath)} ${quoteWindowsArgument(wait)}`,
      'wait for exit': `${quoteWindowsArgument(process.execPath)} ${quoteWindowsArgument(wait)}`,
    };
    let callId = 0;
    const receipts = new Map();
    const requests = [];
    const url = await httpFixture(t, (body, response, _headers, requestPath) => {
      if (requestPath.endsWith('/models')) {
        response.end('{"data":[]}');
        return;
      }
      if (verificationNudge(body)) {
        sendFrames(response, frames('desktop command settled'));
        return;
      }
      const last = body.messages.at(-1);
      for (const block of Array.isArray(last?.content) ? last.content : []) {
        if (block.type === 'tool_result') receipts.set(block.tool_use_id, block);
      }
      requests.push({
        role: last?.role,
        types: Array.isArray(last?.content) ? last.content.map((b) => b.type) : 'text',
      });
      // Skill/runtime context can accompany the user's command in a separate text block.
      const texts =
        typeof last?.content === 'string'
          ? [last.content]
          : (last?.content?.filter((b) => b.type === 'text').map((b) => b.text) ?? []);
      const prompt = texts.findLast((text) => Object.hasOwn(commands, text));
      // A restored cancelled call may be bundled with the new user's text.
      if (
        !commands[prompt] &&
        Array.isArray(last?.content) &&
        last.content.some((block) => block.type === 'tool_result')
      ) {
        sendFrames(response, frames('desktop command settled'));
        return;
      }
      assert.ok(commands[prompt], `Unexpected model prompt: ${texts.join('\n')}`);
      sendFrames(
        response,
        frames('', [
          {
            id: `desktop-command-${++callId}`,
            name: 'run_command',
            input: { command: commands[prompt], timeout_ms: 60000 },
          },
        ]),
      );
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_BASE_URL: url,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'desktop-fixture-secret',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: 'false',
      YUANTU_WORKFLOWS: 'false',
    };
    for (const key of [
      'ELECTRON_RUN_AS_NODE',
      'NODE_OPTIONS',
      'YUANTU_SANDBOX',
      'YUANTU_SANDBOX_FILES',
      'YUANTU_SANDBOX_NETWORK',
    ])
      delete env[key];
    // This suite exercises the basic restricted-token backend; native now always means the account backend.
    env.YUANTU_SANDBOX = 'windows';
    if (packagedApp) delete env.YUANTU_NODE_PATH;
    let app;
    const assertRestored = async () => {
      assert.equal(
        await acl(root),
        originalAcl,
        'Retain a failed fixture until its ACL restoration is verified',
      );
      const errors = await readFile(exitErrors, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      assert.equal(errors, '', 'Desktop shutdown reported an error');
    };
    t.after(async () => {
      await app?.close();
      await assertRestored();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const launch = async () => {
      app = await electron.launch({
        executablePath: packagedApp || electronPath,
        args: [
          ...(packagedApp ? [] : [path.resolve('dist/desktop/main.cjs')]),
          `--user-data-dir=${profile}`,
        ],
        env,
        timeout: 20000,
      });
      const page = await app.firstWindow();
      if (packagedApp) {
        const installed = await app.evaluate(({ app }) => ({
          packaged: app.isPackaged,
          resources: process.resourcesPath,
        }));
        assert.equal(installed.packaged, true);
        assert.equal(
          path.resolve(installed.resources, 'runtime/node.exe').toLowerCase(),
          process.execPath.toLowerCase(),
        );
      }
      await app.evaluate(({ dialog }, filename) => {
        dialog.showErrorBox = (title, message) =>
          require('node:fs').appendFileSync(filename, JSON.stringify({ title, message }) + '\n');
      }, exitErrors);
      page.setDefaultTimeout(30000);
      await page.waitForFunction(
        () =>
          !document.querySelector('#prompt').disabled &&
          !document.querySelector('#permission-mode').disabled,
      );
      return page;
    };
    const snapshot = (page) =>
      page.evaluate(async () => (await window.yuantu.invoke({ type: 'snapshot' })).state);
    const idle = (page) =>
      waitForPage(
        page,
        async () =>
          (await window.yuantu.invoke({ type: 'snapshot' })).state.session.running === false,
        undefined,
        { timeout: 30000 },
      );
    const send = async (page, prompt) => {
      await page.locator('#prompt').fill(prompt);
      await page.locator('#send').click();
      try {
        await page.getByRole('button', { name: '允许一次', exact: true }).click();
      } catch (error) {
        const state = await snapshot(page);
        console.error(
          'Desktop acceptance approval missing',
          JSON.stringify({
            prompt,
            requests,
            session: {
              running: state.session.running,
              error: state.session.error,
              approvals: state.session.approvals,
            },
            error: state.error,
            visible: await page.locator('#error').allTextContents(),
          }),
        );
        throw error;
      }
      return `desktop-command-${callId}`;
    };
    const verify = async (page) => {
      const token = randomUUID();
      await rm(path.join(root, 'desktop-proof.json'), { force: true });
      await rm(path.join(root, 'allowed.txt'), { force: true });
      commands['verify basic'] =
        `${quoteWindowsArgument(process.execPath)} ${quoteWindowsArgument(probe)} ${quoteWindowsArgument(token)}`;
      const toolId = await send(page, 'verify basic');
      const receipt = await eventually(() => receipts.get(toolId));
      assert.notEqual(receipt.is_error, true, JSON.stringify(receipt));
      const text =
        typeof receipt.content === 'string'
          ? receipt.content
          : receipt.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('');
      assert.equal(JSON.parse(text).exitCode, 0, text);
      await idle(page);
      const evidence = JSON.parse(await readFile(path.join(root, 'desktop-proof.json'), 'utf8'));
      assert.equal(evidence.token, token);
      assert.ok(['EACCES', 'EPERM'].includes(evidence.outside));
      assert.ok(['EACCES', 'EPERM'].includes(evidence.metadata));
      assert.equal(evidence.secret, null);
      assert.equal(evidence.executable.toLowerCase(), process.execPath.toLowerCase());
      assert.equal(await readFile(path.join(root, 'allowed.txt'), 'utf8'), token);
      assert.equal(await readFile(path.join(outside, 'canary'), 'utf8'), 'unchanged');
      await assert.rejects(readFile(path.join(outside, 'forbidden')), { code: 'ENOENT' });
    };
    const choosePreset = async (page, preset) => {
      await page.locator('#permission-trigger').click();
      await page.locator(`#permission-menu [data-preset="${preset}"]`).click();
      await page.waitForFunction(
        (value) =>
          document.querySelector('#permission-mode').value === value &&
          !document.querySelector('#permission-mode').disabled,
        preset,
      );
    };
    let page = await launch();
    for (const preset of ['observe', 'guarded']) await choosePreset(page, preset);
    const choice = await page.evaluate(() => window.yuantu.presets({ type: 'get' }));
    assert.equal(choice.ok, true);
    assert.equal(choice.view.current, 'guarded');
    assert.equal(choice.view.sandbox.mode, 'windows');
    assert.equal(choice.view.sandbox.availability, null);
    const sessionId = (await snapshot(page)).session.sessionId;
    await verify(page);
    await send(page, 'wait for cancel');
    const readPid = () =>
      eventually(async () => {
        const text = await readFile(path.join(root, 'descendant.pid'), 'utf8').catch(
          () => undefined,
        );
        return text?.trim() ? Number(text) : undefined;
      });
    const cancelledPid = await readPid();
    assert.doesNotThrow(() => process.kill(cancelledPid, 0));
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await idle(page);
    assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' });
    await app.close();
    app = undefined;
    await assertRestored();
    page = await launch();
    assert.equal((await snapshot(page)).session.sessionId, sessionId);
    // Session choices last for this window's lifetime; restarting restores the session at the auto default.
    assert.equal(await page.locator('#permission-mode').inputValue(), 'auto');
    await choosePreset(page, 'guarded');
    await rm(path.join(root, 'descendant.pid'));
    await send(page, 'wait for exit');
    const exitedPid = await readPid();
    assert.doesNotThrow(() => process.kill(exitedPid, 0));
    await app.close();
    app = undefined;
    assert.throws(() => process.kill(exitedPid, 0), { code: 'ESRCH' });
    await assertRestored();
    page = await launch();
    assert.equal((await snapshot(page)).session.sessionId, sessionId);
    assert.equal(await page.locator('#permission-mode').inputValue(), 'auto');
    await choosePreset(page, 'guarded');
    await verify(page);
    await app.close();
    app = undefined;
    await assertRestored();
  },
);
