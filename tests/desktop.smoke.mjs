// @test-serial desktop-ui: Launches real Electron windows.
// @test-serial windows-sandbox: Live permission switching uses initialized sandbox accounts on Windows CI.
// Turn cards, permission presets and the session sandbox, the core chat flow, and Markdown and diff review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import {
  artifactPath,
  verificationNudge,
  waitFor,
  choosePermissionPreset,
} from './desktop-smoke-support.mjs';
process.env.YUANTU_SESSION_TITLES = 'false';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { waitForPage } from './page-wait.mjs';

/**
 * The Host snapshot can report a verified completion before the renderer has repainted the previous notice.
 * Wait for the transcript DOM rather than sampling it immediately, so the assertion is about the rendered result
 * instead of about IPC-versus-render latency. A genuinely visible notice still fails after the wait timeout.
 */
async function waitForNoCompletionUi(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('.completion-notice, .completion-check').length === 0,
  );
}

test(
  'desktop automatic verification folds reasons and evidence into a plain status line',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-verification-fold-'));
    await mkdir(path.join(root, '.yuantu'));
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const cases = [
      ['verified', 'verified', '检查通过'],
      ['needs_review', 'environment-error', '未能验证（环境限制）'],
      ['unverified', 'missing-verification', '尚未验证'],
      ['limited', 'repair-limit', '达到修复限制'],
    ];
    const sessions = cases.map(([state, reason, label]) => {
      const session = store.create(root);
      const runId = store.beginRun(session.id);
      store.append(session.id, { role: 'assistant', content: reason, toolCalls: [] });
      const evidence = {
        passed: state === 'verified',
        durationMs: 1,
        checks:
          reason === 'missing-verification'
            ? []
            : [
                {
                  id: 'auto-1',
                  kind: 'command',
                  passed: state === 'verified',
                  durationMs: 1,
                  detail: reason === 'environment-error' ? 'spawn EPERM' : 'Check output',
                  ...(reason === 'environment-error'
                    ? { failureReason: 'environment-error' }
                    : {
                        command: {
                          exitCode: state === 'verified' ? 0 : 1,
                          signal: null,
                          timedOut: false,
                          stdout: 'RECORDED_CHECK_OUTPUT',
                          stderr: '',
                          outputTruncated: false,
                        },
                      }),
                },
              ],
      };
      store.recordEvent(session.id, 'completion.updated', {
        contractId: session.id,
        runId,
        source: 'automatic',
        definitionHash: 'fixture',
        definition: {
          version: 1,
          objective: 'Verify the game',
          constraints: [],
          steps: [],
          inputs: [],
          acceptance: [
            {
              description: 'Run the game check',
              met: false,
              check: { id: 'auto-1', kind: 'command', command: 'node', args: ['game-check.mjs'] },
            },
          ],
        },
        summary: {
          version: 1,
          definitionHash: 'fixture',
          state,
          reason,
          verificationRound: 1,
          repairRounds: state === 'limited' ? 3 : 0,
          repeatedFailures: 0,
          failedCheckIds:
            state === 'verified' || reason === 'missing-verification' ? [] : ['auto-1'],
          unfinishedStepIds: [],
        },
        policy: { maxRepairRounds: 3, maxRepeatedFailures: 2, repairTimeoutMs: 900000 },
        steps: [],
        affectedPaths: [],
        evidence,
      });
      store.finishRun({
        sessionId: session.id,
        runId,
        status: state === 'verified' ? 'completed' : 'needs_review',
        text: reason,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      assert.equal(store.completionCurrent(session.id)?.summary.state, state);
      return { id: session.id, label, evidence, state, reason };
    });
    store.close();
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_SANDBOX: 'host',
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
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    for (const fixture of sessions) {
      await page.locator(`[data-session-id="${fixture.id}"]`).first().click();
      await waitForPage(
        page,
        async (id) => {
          const session = (await window.yuantu.invoke({ type: 'snapshot' })).state.session;
          return session.sessionId === id && !session.loading;
        },
        fixture.id,
      );
      const completion = await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.completion,
      );
      assert.equal(completion.summary.state, fixture.state);
      assert.deepEqual(completion.evidence, fixture.evidence);
      if (fixture.state === 'verified') {
        assert.equal(await page.locator('.completion-notice').count(), 0);
        continue;
      }
      const notice = page.locator('details.completion-inline');
      await notice.waitFor();
      assert.equal(
        await notice.locator(':scope > summary').innerText(),
        `自动验证 · ${fixture.label}`,
      );
      assert.equal(await notice.getAttribute('open'), null);
      assert.equal(await notice.locator('.completion-details').isVisible(), false);
      for (const colorScheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme });
        assert.deepEqual(
          await notice.evaluate((el) => {
            const style = getComputedStyle(el);
            return [style.backgroundColor, style.borderLeftWidth, style.padding];
          }),
          ['rgba(0, 0, 0, 0)', '0px', '0px'],
        );
        assert.deepEqual(
          await notice.locator(':scope > summary').evaluate((el) => {
            const style = getComputedStyle(el);
            return [style.backgroundColor, style.borderTopWidth, style.padding];
          }),
          ['rgba(0, 0, 0, 0)', '0px', '0px'],
        );
      }
      await notice.locator(':scope > summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await notice.locator('.completion-details').isVisible(), true);
      if (fixture.reason === 'environment-error') {
        assert.match(await notice.innerText(), /未执行/);
        assert.match(await notice.innerText(), /spawn EPERM/);
        assert.doesNotMatch(await notice.innerText(), /不是代码失败|未通过的检查|未通过 ·/);
      } else if (fixture.evidence.checks.length) {
        assert.match(await notice.innerText(), /node game-check.mjs/);
        assert.match(await notice.innerText(), /RECORDED_CHECK_OUTPUT/);
      }
      await page.locator('#open-settings').click();
      await page.locator('#settings-back').click();
      assert.equal(await notice.getAttribute('open'), '');
      await notice.locator(':scope > summary').focus();
      await page.keyboard.press('Space');
      assert.equal(await notice.locator('.completion-details').isVisible(), false);
      await page.screenshot({ path: artifactPath(`verification-inline-${fixture.state}.png`) });
    }
  },
);

test(
  'desktop hides successful automatic verification and preserves evidence across reloads',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-auto-verification-ui-'));
    await writeFile(path.join(root, 'out.txt'), 'fixed');
    let requests = 0;
    const endpoint = await httpFixture(t, (_body, response) =>
      sendFrames(
        response,
        requests++ === 0
          ? frames('', [
              {
                id: 'verify',
                name: 'verify_work',
                input: {
                  commands: [
                    {
                      command: process.execPath,
                      args: [
                        '-e',
                        "if(require('node:fs').readFileSync('out.txt','utf8')!=='fixed')process.exit(1);console.log('OUTPUT_CHECK_PASSED')",
                      ],
                      description: 'Check the output file',
                    },
                  ],
                  inputs: ['out.txt'],
                },
              },
            ])
          : frames('Checked the output.'),
      ),
    );
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: endpoint,
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SANDBOX: 'host',
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
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    assert.equal(
      await page
        .locator('#composer-verification, #plan-verification, .verification-editor')
        .count(),
      0,
    );
    await page.locator('#prompt').fill('Verify the output file');
    await page.locator('#send').click();
    await waitForPage(
      page,
      async () =>
        (await window.yuantu.invoke({ type: 'snapshot' })).state.session.completion?.summary
          .state === 'verified',
    );
    await waitForNoCompletionUi(page);
    const completion = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.completion,
    );
    assert.equal(completion.summary.state, 'verified');
    assert.equal(completion.evidence.checks[0].command.exitCode, 0);
    assert.match(completion.evidence.checks[0].command.stdout, /OUTPUT_CHECK_PASSED/);
    await page.screenshot({ path: artifactPath('automatic-verification.png'), fullPage: true });
    await page.reload();
    await waitForPage(
      page,
      async () =>
        (await window.yuantu.invoke({ type: 'snapshot' })).state.session.completion?.summary
          .state === 'verified',
    );
    await waitForNoCompletionUi(page);
    const restored = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.completion,
    );
    assert.match(restored.evidence.checks[0].command.stdout, /OUTPUT_CHECK_PASSED/);
  },
);

test(
  'finished turns show separate file cards at their ends, with collapsed previews and live changes withheld',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-turn-cards-'));
    await mkdir(path.join(root, '.yuantu'));
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const session = store.create(root);
    const firstRun = store.beginRun(session.id);
    store.append(session.id, { role: 'user', content: 'FIRST_QUESTION' });
    for (let index = 0; index < 6; index++) {
      const name = `file-${index}.ts`;
      const text = `const value = ${index};\n`;
      await writeFile(path.join(root, name), text);
      const id = store.prepareFileChange(
        session.id,
        {
          path: name,
          kind: 'create',
          patch: `@@ -0,0 +1 @@\n+${text}`,
          added: 1,
          removed: 0,
          truncated: false,
        },
        null,
        Buffer.from(text),
      );
      store.markFileChange(id, 'applied');
    }
    store.append(session.id, { role: 'assistant', content: 'FIRST_FINAL', toolCalls: [] });
    store.finishRun({
      sessionId: session.id,
      runId: firstRun,
      status: 'completed',
      text: 'FIRST_FINAL',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const secondRun = store.beginRun(session.id);
    store.append(session.id, { role: 'user', content: 'SECOND_QUESTION' });
    await writeFile(path.join(root, 'second.ts'), 'second');
    const secondId = store.prepareFileChange(
      session.id,
      {
        path: 'second.ts',
        kind: 'create',
        patch: '@@ -0,0 +1 @@\n+second',
        added: 1,
        removed: 0,
        truncated: false,
      },
      null,
      Buffer.from('second'),
    );
    store.markFileChange(secondId, 'applied');
    store.append(session.id, { role: 'assistant', content: 'SECOND_FINAL', toolCalls: [] });
    store.finishRun({
      sessionId: session.id,
      runId: secondRun,
      status: 'completed',
      text: 'SECOND_FINAL',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    store.close();
    let requests = 0,
      pending;
    const endpoint = await httpFixture(t, (body, response) => {
      // The requested answer is settled by the test; the verification nudge after it is answered here so the
      // third turn can actually finish and its file card appear.
      if (verificationNudge(body)) sendFrames(response, frames('THIRD_FINAL'));
      else if (++requests === 1)
        sendFrames(
          response,
          frames('', [
            { id: 'live-write', name: 'write_file', input: { path: 'live.ts', content: 'live\n' } },
          ]),
        );
      else pending = response;
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: endpoint,
      YUANTU_API_KEY: 'fixture-turn-card',
      YUANTU_MODEL: 'fixture',
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
      pending?.destroy();
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
    await page.locator(`[data-session-id="${session.id}"]`).first().click();
    await page.waitForFunction(
      async () => !(await window.yuantu.invoke({ type: 'snapshot' })).state.session.loading,
    );
    await page.locator('.turn-changes').nth(1).waitFor();
    assert.equal(await page.locator('#changes').count(), 0);
    assert.deepEqual(await page.locator('.turn-changes-title').allTextContents(), [
      '已编辑 6 个文件',
      '已编辑 1 个文件',
    ]);
    const first = page.locator('.turn-changes').first();
    assert.equal(await first.locator('.turn-change-row').count(), 3);
    assert.equal(
      await first.evaluate((card) =>
        card.previousElementSibling.textContent.includes('FIRST_FINAL'),
      ),
      true,
    );
    assert.equal(
      await page
        .locator('.turn-changes')
        .nth(1)
        .evaluate((card) => card.previousElementSibling.textContent.includes('SECOND_FINAL')),
      true,
    );
    await first.getByRole('button', { name: '全部 6 个文件', exact: true }).click();
    assert.equal(await first.locator('.turn-change-row').count(), 6);
    await first.getByRole('button', { name: '收起文件列表', exact: true }).click();
    assert.equal(await first.locator('.turn-change-row').count(), 3);
    if (process.env.CODEX_TURN_CHANGES_SCREENSHOT_DIR) {
      const output = artifactPath('turn-changes');
      await mkdir(output, { recursive: true });
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await first.screenshot({ path: path.join(output, `${theme}.png`) });
      }
    }
    await first.locator('.turn-change-row').first().click();
    await page.locator('#workspace-preview-body .diff-added').waitFor();
    assert.match(await page.locator('#workspace-preview-body').textContent(), /const value = 0/);
    const diffNode = await page.locator('#workspace-preview-body .file-diff').elementHandle();
    await diffNode.evaluate((diff) => {
      diff.open = false;
    });
    await first.getByRole('button', { name: '全部 6 个文件', exact: true }).click();
    const firstCardNode = await first.elementHandle();
    await page.locator('#prompt').fill('THIRD_QUESTION');
    await page.locator('#send').click();
    await page.waitForFunction(
      async () =>
        (await window.yuantu.invoke({ type: 'snapshot' })).state.session.running &&
        (await window.yuantu.invoke({ type: 'snapshot' })).state.session.tools.length === 0,
    );
    await waitFor(() => Boolean(pending));
    assert.equal(await page.locator('.turn-changes').count(), 2);
    assert.equal(await firstCardNode.evaluate((card) => card.isConnected), true);
    assert.equal(await diffNode.evaluate((diff) => diff.isConnected && !diff.open), true);
    assert.equal(await first.locator('.turn-change-row').count(), 6);
    assert.equal(await page.locator('.turn-change-row').filter({ hasText: 'live.ts' }).count(), 0);
    sendFrames(pending, frames('THIRD_FINAL'));
    pending = undefined;
    await page.locator('.turn-changes').nth(2).waitFor();
    assert.match(await page.locator('.turn-changes').nth(2).textContent(), /live.ts/);
    assert.equal(await firstCardNode.evaluate((card) => card.isConnected), true);
    assert.equal(await diffNode.evaluate((diff) => diff.isConnected && !diff.open), true);
    // The completion verdict sits between the final answer and its file summary, so walk back to the answer
    // rather than assuming the summary's immediate previous sibling is the message.
    assert.equal(
      await page
        .locator('.turn-changes')
        .nth(2)
        .evaluate((card) => {
          for (let node = card.previousElementSibling; node; node = node.previousElementSibling)
            if (node.classList.contains('assistant'))
              return node.textContent.includes('THIRD_FINAL');
          return false;
        }),
      true,
    );
  },
);

// ---- merged from desktop.smoke.mjs ----

test(
  'desktop switches to full access while a background command waits for approval',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-live-permission-'));
    const profileRoot = await mkdtemp(path.join(tmpdir(), 'yuantu-live-permission-profile-'));
    const results = [];
    const url = await httpFixture(t, (body, response) => {
      // Answer the verification nudge with the final answer; treating it as a new instruction started a second
      // background command and left the run in an error-shaped review state.
      if (verificationNudge(body)) {
        sendFrames(response, frames('LIVE_PERMISSION_DONE'));
        return;
      }
      const last = body.messages.at(-1);
      const result = Array.isArray(last?.content)
        ? last.content.find((block) => block.type === 'tool_result')
        : undefined;
      if (result) {
        results.push(result);
        sendFrames(response, frames('LIVE_PERMISSION_DONE'));
      } else
        sendFrames(
          response,
          frames('', [
            {
              id: 'pending-background',
              name: 'start_command',
              input: { command: 'echo LIVE_PERMISSION_COMMAND' },
            },
          ]),
        );
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_SANDBOX: 'native',
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
      await rm(profileRoot, { recursive: true, force: true });
    });
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(profileRoot, 'profile')}`,
      ],
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await choosePermissionPreset(page, 'guarded');
    await page.locator('#prompt').fill('run the background fixture');
    await page.locator('#send').click();
    await page.getByRole('button', { name: '允许一次', exact: true }).waitFor();
    assert.match(await page.locator('#approvals').innerText(), /start_command/);
    await page.locator('#permission-trigger').click();
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
    await page.locator('#full-access-enable').click();
    await page.getByText('LIVE_PERMISSION_DONE', { exact: true }).waitFor();
    await waitForPage(page, async () => {
      const snapshot = (await window.yuantu.invoke({ type: 'snapshot' })).state;
      return snapshot.background.some(
        (job) => job.status === 'completed' && job.output.includes('LIVE_PERMISSION_COMMAND'),
      );
    });
    assert.notEqual(results[0]?.is_error, true, JSON.stringify(results[0]));
    assert.equal(await page.locator('#approvals').innerText(), '');
    assert.equal(await page.locator('#error').isVisible(), false);
    assert.equal(
      (await page.evaluate(() => window.yuantu.presets({ type: 'get' }))).view.current,
      'unconfined',
    );
  },
);

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
        await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
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
        await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
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
      await page.waitForFunction(() => document.querySelector('#permission-mode').value === 'auto');
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
      const texts =
        typeof last.content === 'string'
          ? [last.content]
          : last.content.filter((block) => block.type === 'text').map((block) => block.text);
      const prompt = texts.findLast((text) =>
        ['读取项目', '创建文件', '拒绝写入', '取消写入'].includes(text),
      );
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
        await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
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
    await choosePermissionPreset(page, 'guarded');
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
    // Switching presets also settles this pending write under the newly confirmed policy.
    await page.locator('#permission-trigger').click();
    /**
     * Full access is the rung that stops asking, so it is also the one behind the host confirmation — the test
     * acknowledges it here, which is the same thing an operator does. (It used to be possible to stop asking
     * about *writes* while staying confined; that rung is gone, and the chip says three things now.)
     */
    await page.locator('#permission-menu [data-preset="unconfined"]').click();
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
    if (process.env.YUANTU_QA_SCREENSHOT) await page.screenshot({ path: artifactPath('qa.png') });
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
    await choosePermissionPreset(page, 'guarded');
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
    await choosePermissionPreset(page, 'guarded');
    await page.locator('#prompt').fill('修改 count');
    await page.locator('#send').click();
    await page.locator('.approval .diff-added').waitFor();
    assert.match(await page.locator('.approval .file-diff').textContent(), /-const count = 1;/);
    assert.equal(await readFile(path.join(root, 'main.ts'), 'utf8'), 'const count = 1;\n');
    if (process.env.YUANTU_QA_SCREENSHOT)
      await page.screenshot({
        path: artifactPath('qa.png').replace(/\.png$/, '-diff.png'),
      });
    await page.getByRole('button', { name: '允许一次' }).click();
    await page.waitForFunction(() => !document.querySelector('#choose-workspace').disabled);
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
    await page.locator('#messages .turn-changes').waitFor();
    assert.match(await page.locator('.turn-changes-title').textContent(), /已编辑 1 个文件/);
    assert.equal(await page.locator('#changes').count(), 0);
    const id = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await page.locator(`[data-session-id="${id}"]`).click();
    await page.locator('#messages .turn-changes').waitFor();
    assert.match(await page.locator('.turn-change-row').textContent(), /main.ts/);
    if (process.env.YUANTU_QA_SCREENSHOT) {
      await page.locator('#messages .code-block').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: artifactPath('qa.png').replace(/\.png$/, '-markdown.png'),
        fullPage: true,
      });
    }
    await page.locator('.turn-change-row').click();
    await page.locator('#workspace-preview-body .file-diff').waitFor();
    await page.getByRole('button', { name: '撤销此修改', exact: true }).click();
    await page.getByRole('button', { name: '确认恢复修改前内容', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('#workspace-preview-body').textContent.includes('已撤销'),
    );
    assert.equal(await readFile(path.join(root, 'main.ts'), 'utf8'), 'const count = 1;\n');
    assert.match(await page.locator('#messages').textContent(), /\[Files restored by user\]/);
  },
);
