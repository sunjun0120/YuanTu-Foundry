import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';
import { waitForPage } from './page-wait.mjs';
process.env.YUANTU_SESSION_TITLES = 'false';
import * as XLSX from 'xlsx';
import { docxFixture, pdfFixture } from './attachment-fixtures.ts';

// ---- merged from subagents.smoke.mjs ----

/** The last user turn of an Anthropic request body, which is what identifies a delegated child. */
function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content))
      return message.content
        .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
        .join('');
  }
  return '';
}
const report = (id, summary, statement, evidence, paths) => ({
  id,
  name: 'submit_report',
  input: {
    summary,
    findings: [{ statement, evidence, ...(paths ? { paths } : {}) }],
    unverified: ['运行时行为未验证'],
  },
});

/**
 * The desktop half of sub-agent delegation.
 *
 * A parent run can delegate several tasks, and each child then works with no visible trace in the
 * parent transcript. This covers what makes that work checkable: the live cards, the child's
 * structured findings, the transcript viewer, who asked for an approval and who changed a file, the
 * localisation, and the fact that reopening the session brings the cards back from the stored run.
 */
test('desktop shows, attributes and can open a sub-agent run', { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-subagents-ui-'));
  let parentCalls = 0;
  const childTurns = new Map();
  const url = await httpFixture(t, (body, res) => {
    // A child is told what it is in its own system prompt, which is how a fixture tells the two
    // apart without inspecting the wire format for a marker that is not guaranteed.
    if (systemText(body.system).includes('You are a sub-agent delegated by a parent agent')) {
      const writer = lastUserText(body).includes('写入说明文件');
      const turn = (childTurns.get(writer ? 'writer' : 'reader') ?? 0) + 1;
      childTurns.set(writer ? 'writer' : 'reader', turn);
      if (writer && turn === 1)
        return sendFrames(
          res,
          frames('写入说明文件。', [
            {
              id: 'write-1',
              name: 'write_file',
              input: { path: 'NOTES.md', content: '由子代理写入\n' },
            },
          ]),
        );
      return sendFrames(
        res,
        frames(
          '',
          writer
            ? [
                report('report-w', '已写入 NOTES.md。', 'NOTES.md 已创建', 'write_file 返回成功', [
                  'NOTES.md',
                ]),
              ]
            : [
                report(
                  'report-r',
                  '加载器位于 packages/core。',
                  '入口在 packages/core/agent.ts',
                  'read_file 返回 Agent 类',
                  ['packages/core/agent.ts'],
                ),
              ],
        ),
      );
    }
    if (parentCalls++ === 0)
      return sendFrames(
        res,
        frames('派发两个子代理。', [
          {
            id: 'delegate-1',
            name: 'delegate_task',
            input: {
              tasks: [
                { objective: '调查加载器结构', role: 'explore' },
                { objective: '写入说明文件', role: 'general' },
              ],
            },
          },
        ]),
      );
    return sendFrames(res, frames('两个子代理都已报告。'));
  });
  const env = {
    ...process.env,
    YUANTU_NODE_PATH: process.execPath,
    YUANTU_WORKSPACE: root,
    YUANTU_PROTOCOL: 'anthropic',
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_API_KEY: 'fixture',
    YUANTU_BASE_URL: url,
    YUANTU_PERMISSION_POLICY: '',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const launch = () =>
    electron.launch({
      executablePath: electronPath,
      args: [
        path.resolve('dist/desktop/main.cjs'),
        `--user-data-dir=${path.join(root, 'profile')}`,
      ],
      env,
    });
  t.after(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });
  app = await launch();
  let page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const idle = () => page.waitForFunction(() => !document.querySelector('#new-session').disabled);
  await idle();
  await page.locator('#new-session').click();
  await idle();
  // A session that has delegated nothing shows no catalog: the trigger is a count of children, and a
  // "0 个子代理" pill would be a control with nothing behind it.
  assert.equal(await page.locator('#open-subagents').isVisible(), false);

  await page.locator('#prompt').fill('调查加载器并写好说明');
  await page.locator('#send').click();
  await page.locator('#open-subagents').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.subagent-card').length === 2);
  assert.equal(await page.locator('#subagents-panel').isHidden(), true);

  // The write-capable child asks for permission, and the prompt says whose request it is.
  const approvals = page.locator('#approvals');
  await page.getByRole('button', { name: '允许一次' }).waitFor();
  assert.match(await approvals.locator('.subagent-badge').textContent(), /写入说明文件/);
  await page.locator('#open-subagents').click();
  await page.locator('#subagent-catalog .subagent-row').nth(1).click();
  await page.locator('#subagent-transcript .subagent-live-tool').waitFor();
  assert.match(await page.locator('#subagent-transcript').textContent(), /write_file/);
  assert.equal(await page.locator('#subagent-transcript details[open]').count(), 0);
  await page.locator('#chat-title').click();
  await page.locator('#subagent-transcript').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '允许一次' }).click();
  await idle();

  // One card per task, in request order, with the role the parent sent and the child's findings.
  const cards = page.locator('.subagent-card');
  const titles = [
    await cards.nth(0).locator('h3').textContent(),
    await cards.nth(1).locator('h3').textContent(),
  ];
  assert.match(titles[0], /^子代理 1\/2 · 只读调查$/);
  assert.match(titles[1], /^子代理 2\/2 · 可写入$/);
  assert.match(await cards.nth(0).locator('.subagent-objective').textContent(), /调查加载器结构/);
  assert.equal(await cards.nth(0).locator('.subagent-status').textContent(), '已完成');
  // A report is shown as findings with their evidence, not as prose.
  assert.match(
    await cards.nth(0).locator('.subagent-findings li').textContent(),
    /入口在 packages\/core\/agent\.ts/,
  );
  assert.match(
    await cards.nth(0).locator('.subagent-evidence').textContent(),
    /依据: read_file 返回 Agent 类/,
  );
  assert.match(
    await cards.nth(0).locator('.subagent-unverified').textContent(),
    /未核实: 运行时行为未验证/,
  );
  // Each card also reports what that child cost and how long it worked, so a session shows which child was
  // expensive and a reader can tell a cheap investigation from an expensive one.
  assert.match(
    await cards.nth(0).locator('.subagent-meta-counts').textContent(),
    /\d+ 轮 · \d+ 次工具调用/,
  );
  assert.match(
    await cards.nth(0).locator('.subagent-meta-tokens').textContent(),
    /^\s*· \d+(\.\d+)?[KM]? tok$/,
  );
  assert.match(await cards.nth(0).locator('.subagent-meta-duration').textContent(), /^\s*· \d+秒$/);

  // The header catalog: one row per direct child, with its state, what it spent and how long it worked.
  const catalogRows = page.locator('#subagent-catalog .subagent-row');
  assert.equal(await catalogRows.count(), 2);
  assert.equal(await page.locator('#subagents-label').textContent(), '2 个子代理');
  assert.match(
    await catalogRows.nth(0).locator('.subagent-row-label').textContent(),
    /调查加载器结构/,
  );
  assert.equal(
    await catalogRows.nth(0).locator('.subagent-row-meta').textContent(),
    '只读调查 · 已完成',
  );
  assert.match(
    await catalogRows.nth(0).locator('.subagent-row-tokens').textContent(),
    /^\d+(\.\d+)?[KM]? tok$/,
  );
  assert.match(await catalogRows.nth(0).locator('.subagent-row-duration').textContent(), /^\d+秒$/);
  assert.equal(
    await catalogRows.nth(0).locator('.subagent-row-dot').getAttribute('data-state'),
    'done',
  );
  // The catalog is the other way into a child: opening a row is the same navigation the card offers, and it
  // closes the menu behind itself.
  await page.locator('#open-subagents').click();
  assert.equal(await page.locator('#subagents-popover').isVisible(), true);
  await mkdir('artifacts/subagents', { recursive: true });
  await page.screenshot({ path: 'artifacts/subagents/catalog.png' });
  await catalogRows.nth(1).click();
  await page.locator('#subagent-transcript').waitFor();
  await page.locator('#subagents-popover').waitFor({ state: 'hidden' });
  // A child's record is a page, not a panel: the header turns into a breadcrumb naming the child, and the
  // conversation that delegated it — transcript, cards, composer — steps aside until the title brings it back.
  assert.equal(await page.locator('#subagent-transcript-title').innerText(), '写入说明文件');
  assert.match(
    await page.locator('#chat-title').getAttribute('class'),
    /chat-title-back/,
    'the session title becomes the way back',
  );
  assert.equal(await page.locator('#open-subagents').isVisible(), true);
  await page.screenshot({ path: 'artifacts/subagents/page.png' });
  await page.locator('#chat-title').click();
  await page.locator('#subagent-transcript').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#messages').isVisible(), true);

  // The file the child wrote is listed with its author, so the change list is not a lie by omission.
  const changes = page.locator('#changes-list');
  assert.match(await changes.locator('.subagent-badge').textContent(), /子代理：写入说明文件/);
  assert.match(await readFile(path.join(root, 'NOTES.md'), 'utf8'), /由子代理写入/);

  // The child's own transcript is readable, which is what makes the parent's report checkable. The card's
  // button opens the same page the catalog row does.
  await page.locator('#open-subagents').click();
  await catalogRows.nth(0).click();
  await page.locator('#subagent-transcript').waitFor();
  assert.match(await page.locator('#subagent-transcript-title').textContent(), /调查加载器结构/);
  await page.waitForFunction(() =>
    document
      .querySelector('#subagent-transcript-note')
      ?.textContent.includes('只读：这是该子代理自己会话里的完整记录。'),
  );
  assert.match(
    await page.locator('#subagent-transcript-note').textContent(),
    /只读：这是该子代理自己会话里的完整记录。/,
  );
  const transcript = await page
    .locator('#subagent-transcript .message, #subagent-transcript .tool-result')
    .allTextContents();
  assert.match(transcript[0], /Objective: 调查加载器结构/);
  assert.match(transcript.join('\n'), /submit_report/);
  assert.equal(await page.locator('#subagent-transcript details[open]').count(), 0);
  // The conversation the reader came from is off screen, and the composer with it: this is a record, not a
  // place to type. The jump-to-latest button goes too — there is no tail here to follow.
  assert.equal(await page.locator('#messages').isVisible(), false);
  assert.equal(await page.locator('.composer-area').isVisible(), false);
  assert.equal(await page.locator('#jump-to-latest').isVisible(), false);
  await page.locator('#chat-title').click();
  // Waiting for the state rather than sampling it: leaving is a round trip to the Host, and `isVisible()`
  // asks once, the instant the click returns.
  await page.locator('#subagent-transcript').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.composer-area').isVisible(), true);

  // The panel is localised like the rest of the surface. The objective and the report are model
  // output and stay in whatever language they were written in, so only the chrome is checked.
  await page.locator('#open-settings').click();
  await page.locator('.settings-sidebar nav button').first().click();
  await page.locator('#ui-language').selectOption('en-US');
  // Saving makes the language survive the restart below, so the restored cards can be checked for
  // the right locale rather than whichever language the app happens to start in.
  await page.locator('#general-settings-save').click();
  await page.waitForFunction(() => document.querySelector('#general-settings-save').disabled);
  await page.locator('#settings-back').click();
  await page.waitForFunction(() =>
    (document.querySelector('#subagents-panel')?.textContent ?? '').includes('Sub-agent 1/2'),
  );
  assert.equal(await page.locator('#subagents-panel h2').textContent(), 'Sub-agents');
  assert.equal(
    await cards.nth(0).locator('h3').textContent(),
    'Sub-agent 1/2 · read-only research',
  );
  assert.equal(await cards.nth(1).locator('h3').textContent(), 'Sub-agent 2/2 · write-capable');
  assert.equal(await cards.nth(0).locator('.subagent-status').textContent(), 'Completed');
  assert.equal(await cards.nth(0).locator('.subagent-view').textContent(), 'View transcript');
  assert.equal(await page.locator('#subagents-label').textContent(), '2 subagents');
  assert.equal(
    await catalogRows.nth(0).locator('.subagent-row-meta').textContent(),
    'read-only research · Completed',
  );
  // Read the English card text now so the restart below can be compared against it: the number itself is
  // the fixture's business, but losing it on reload is ours.
  const englishMeta = await cards.nth(0).locator('.subagent-meta').textContent();
  assert.match(englishMeta, /· \d+(\.\d+)?[KM]? tok · \d+s$/);
  await page.locator('#open-subagents').click();
  await catalogRows.nth(0).click();
  await page.waitForFunction(() =>
    (document.querySelector('#subagent-transcript-note')?.textContent ?? '').includes('Read-only'),
  );
  await page.locator('#chat-title').click();
  await page.locator('#subagent-transcript').waitFor({ state: 'hidden' });

  // A restart loses every event, so the cards have to come back from what the run stored.
  const sessionId = await page.evaluate(
    async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
  );
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  await page.locator('#open-subagents').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.subagent-card').length === 2);
  assert.equal(await page.locator('#subagents-panel').isHidden(), true);
  const restored = page.locator('.subagent-card');
  assert.match(
    await restored.nth(0).locator('.subagent-objective').textContent(),
    /调查加载器结构/,
  );
  assert.equal(await restored.nth(0).locator('.subagent-status').textContent(), 'Completed');
  // The findings survive the restart because the summary keeps the report, not just a status.
  assert.match(
    await restored.nth(0).locator('.subagent-findings li').textContent(),
    /入口在 packages\/core\/agent\.ts/,
  );
  // And the cost survives with them, so a reloaded session still shows which child was expensive.
  assert.equal(await restored.nth(0).locator('.subagent-meta').textContent(), englishMeta);
  // The catalog comes back from the same log: the child's work time is a fold of its own session's runs, so
  // a reopened window reads the same number the running one did rather than starting the clock again.
  const restoredRows = page.locator('#subagent-catalog .subagent-row');
  assert.equal(await restoredRows.count(), 2);
  assert.equal(await page.locator('#subagents-label').textContent(), '2 subagents');
  assert.match(
    await restoredRows.nth(0).locator('.subagent-row-duration').textContent(),
    /^\d+(\.\d+)?s$/,
  );
  assert.match(
    await restoredRows.nth(0).locator('.subagent-row-tokens').textContent(),
    /^\d+(\.\d+)?[KM]? tok$/,
  );
  // The reports themselves stay where they always were: in the transcript's tool results. They live
  // inside a collapsed `<details>`, so this reads textContent rather than innerText.
  assert.match(await page.locator('#messages').textContent(), /findings:/);
});

// ---- merged from statistics.smoke.mjs ----

test(
  'composer statistics show real usage, accessible popovers, themes and session isolation',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-statistics-ui-'));
    let requests = 0;
    const url = await httpFixture(t, (_body, res) => {
      const events = frames('Statistics verified.');
      events[0].message.usage.cache_read_input_tokens = 80;
      // The first answer streams with a pause before its end, so the panel has a decode span to report. The
      // second is cut off before its end, which is how a mid-stream failure reaches the run.
      if (requests++ === 0) return sendFrames(res, events, 60);
      return sendFrames(res, events.slice(0, -1));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'statistics-fixture',
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
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('Hello');
    await page.locator('#send').click();
    await page.waitForFunction(() =>
      document.querySelector('#statistics-tokens').textContent.includes('110 tok'),
    );
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await page.locator('#statistics-tokens').hover();
    assert.equal(await page.locator('#statistics-tokens-panel').isVisible(), true);
    assert.match(await page.locator('#statistics-tokens-panel').innerText(), /80%/);
    // The panel's rows are DSH's, in DSH's order, and the cache-write row a session never wrote is absent
    // rather than present as a zero.
    assert.deepEqual(await page.locator('#statistics-tokens-panel dt').allTextContents(), [
      '缓存命中',
      '未缓存输入',
      '缓存读取',
      '输出',
    ]);
    assert.deepEqual(await page.locator('#statistics-tokens-panel dd').allTextContents(), [
      '80%',
      '20 tok',
      '80 tok',
      '10 tok',
    ]);
    assert.deepEqual(
      await page.locator('#statistics-tokens-panel header strong').allTextContents(),
      ['Token 用量', '110 tok'],
    );
    assert.equal(
      (await page.locator('#statistics-tokens').innerText()).trim(),
      '110 tok · 缓存命中 80%',
    );
    await mkdir('artifacts/statistics', { recursive: true });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.screenshot({ path: 'artifacts/statistics/tokens-dark.png' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#statistics-tokens-panel').isVisible(), false);
    await page.locator('#statistics-session').click();
    assert.equal(await page.locator('#statistics-session-panel').isVisible(), true);
    // The counts are the session's own boundaries, and the figures are the ones the step measured: a session
    // that called no tool has no tool row to show.
    assert.deepEqual(await page.locator('#statistics-session-panel dt').allTextContents(), [
      '模型用时',
      '首 token 平均（TTFT）',
      '输出速度（TPS）',
    ]);
    const sessionRows = await page.locator('#statistics-session-panel dd').allTextContents();
    assert.equal(sessionRows.length, 3);
    assert.equal(sessionRows[2], '未知');
    assert.equal((await page.locator('#statistics-session').innerText()).trim(), '1 轮 1 步');
    await page.screenshot({ path: 'artifacts/statistics/session-dark.png' });
    await page.locator('#prompt').click({ position: { x: 8, y: 8 } });
    assert.equal(await page.locator('#statistics-session-panel').isVisible(), false);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.locator('#statistics-tokens').click();
    await page.screenshot({ path: 'artifacts/statistics/tokens-light.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(780, 720));
    await page.locator('#statistics-tokens').hover();
    const box = await page.locator('#statistics-tokens-panel').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
    assert.ok(box.y >= 0 && box.y + box.height <= viewport.height);
    await page.keyboard.press('Escape');
    await page.locator('#statistics-session').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'statistics-tokens');
    assert.equal(await page.locator('#statistics-tokens-panel').isVisible(), true);
    assert.equal(
      await page.locator('#statistics-tokens').evaluate((el) => getComputedStyle(el).outlineStyle),
      'solid',
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#statistics-tokens-panel').isVisible(), false);
    await page.locator('#prompt').fill('Interrupted stream');
    await page.locator('#send').click();
    // A run cut off mid-stream still closed its step, so the counts move and the usage does not: the provider
    // never finished the request, which means it never billed for it.
    await page.waitForFunction(() =>
      document.querySelector('#statistics-session').textContent.startsWith('2 轮 2 步'),
    );
    assert.match(await page.locator('#statistics-tokens').innerText(), /110 tok · 缓存命中 80%/);
    await page.locator('#statistics-tokens').click();
    assert.deepEqual(await page.locator('#statistics-tokens-panel dd').allTextContents(), [
      '80%',
      '20 tok',
      '80 tok',
      '10 tok',
    ]);
    await page.keyboard.press('Escape');
    await page.locator('#new-session').click();
    // A session nobody has run has no reading at all, so neither pill is on screen: an empty panel would be a
    // measurement of nothing.
    await page.waitForFunction(() => {
      const host = document.querySelector('#composer-statistics');
      return host && host.querySelectorAll('.statistics-item:not([hidden])').length === 0;
    });
    assert.equal(await page.locator('#statistics-tokens-panel').isVisible(), false);
    assert.deepEqual(errors, []);
  },
);

// ---- merged from attachments.smoke.mjs ----

test(
  'desktop sends image and extracted PDF, Word, Excel, text and code contents; restores attachments from history',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-attachments-'));
    const requests = [];
    const url = await httpFixture(t, (body, res) => {
      requests.push(body);
      sendFrames(res, frames('附件内容已收到。'));
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_SUPPORTS_VISION: 'true',
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
          '--user-data-dir=' + path.join(root, 'profile'),
        ],
        env,
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
      return page;
    };
    let page = await launch();
    assert.equal((await page.locator('#attach-image').innerText()).trim(), '+');
    await page.locator('#permission-trigger').click();
    // Three rungs, not the approval modes that used to live here: the chip writes where a run executes and how
    // much it may do without asking, as one choice.
    assert.equal(await page.locator('#permission-menu [role=menuitemradio]').count(), 3);
    assert.equal(
      await page.locator('#permission-menu [data-preset=guarded]').getAttribute('aria-checked'),
      'true',
    );
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/attachment-permission-menu.png' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'artifacts/attachment-permission-menu-dark.png' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');
    await page.locator('#image-input').setInputFiles({
      name: 'unsupported.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('not supported'),
    });
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').innerText(), /unsupported.exe/);
    assert.equal(await page.locator('#attachments .attachment').count(), 0);
    await page.locator('#image-input').setInputFiles({
      name: 'remove.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('remove me'),
    });
    await page.locator('.document-attachment').waitFor();
    await page.locator('.document-attachment').hover();
    await page.locator('.document-attachment .attachment-remove').click();
    assert.equal(await page.locator('#attachments .attachment').count(), 0);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Sheet secret', 682]]), 'Sheet1');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5u8AAAAASUVORK5CYII=',
      'base64',
    );
    await page.locator('#image-input').setInputFiles([
      { name: 'sample.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
      {
        name: 'sample.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: await docxFixture(),
      },
      ...['xlsx', 'xls'].map((bookType) => ({
        name: 'sample.' + bookType,
        mimeType: 'application/octet-stream',
        buffer: XLSX.write(book, { type: 'buffer', bookType }),
      })),
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('text secret 354') },
      { name: 'code.ts', mimeType: 'text/plain', buffer: Buffer.from('const codeSecret = 917;') },
      { name: 'pixel.png', mimeType: 'image/png', buffer: png },
    ]);
    await page.waitForFunction(
      () => document.querySelectorAll('#attachments .attachment').length === 7,
    );
    await page.screenshot({ path: 'artifacts/attachment-files-ready.png' });
    assert.equal(await page.locator('#send').isEnabled(), true);
    await page.locator('#send').click();
    await page.getByText('附件内容已收到。', { exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.equal(requests.length, 1);
    const content = requests[0].messages.at(-1).content;
    assert.ok(content.some((block) => block.type === 'image'));
    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    for (const marker of [
      'PDF document secret 529',
      'Word document secret 731',
      'Table cell 984',
      'Sheet secret',
      '682',
      'text secret 354',
      'codeSecret = 917',
    ])
      assert.ok(text.includes(marker), marker);
    assert.equal(await page.locator('.message-document').count(), 6);
    assert.equal(await page.locator('#attachments .attachment').count(), 0);
    await app.close();
    app = undefined;
    page = await launch();
    assert.equal(await page.locator('.message-document').count(), 6);
    await page.locator('.message-document').first().locator('summary').click();
    assert.match(
      await page.locator('.message-document').first().innerText(),
      /PDF document secret 529/,
    );
    await page.screenshot({ path: 'artifacts/attachment-history.png' });
    await app.close();
    app = undefined;
    env.YUANTU_SUPPORTS_VISION = 'false';
    page = await launch();
    await page.locator('#new-session').click();
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    assert.equal(await page.locator('#attach-image').isEnabled(), true);
    await page.locator('#image-input').setInputFiles({
      name: 'text-only.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('text works without vision 113'),
    });
    await page.locator('.document-attachment').waitFor();
    await page.locator('#send').click();
    await page.getByText('附件内容已收到。', { exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelector('#run-status').textContent === '本轮已结束',
    );
    assert.match(JSON.stringify(requests.at(-1)), /text works without vision 113/);
  },
);

// ---- merged from model-progress.smoke.mjs ----

test(
  'desktop previews reasoning and keeps incomplete tool arguments out of the transcript',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-model-progress-'));
    const hidden = 'private thought never shown';
    let requestBudget;
    const url = await httpFixture(t, async (body, res) => {
      requestBudget = body.max_completion_tokens;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (value) => res.write('data: ' + JSON.stringify(value) + '\n\n');
      send({
        choices: [
          { index: 0, delta: { reasoning_content: hidden, content: '' }, finish_reason: null },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"unfinished' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
      send({
        choices: [],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 100,
          completion_tokens_details: { reasoning_tokens: 80 },
        },
      });
      res.end('data: [DONE]\n\n');
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'progress-fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_PROTOCOL: 'openai',
      YUANTU_MAX_OUTPUT_TOKENS: '100',
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
    await page.locator('#prompt').fill('Inspect');
    await page.locator('#send').click();
    await page.locator('#run-status').getByText('正在推理…').waitFor();
    await page.locator('#messages > .process-group > summary').waitFor();
    assert.match(
      await page.locator('#messages > .process-group > summary').innerText(),
      /private thought never shown/,
    );
    await page.locator('#run-status').getByText('正在生成工具调用…').waitFor();
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    assert.equal(requestBudget, 100, 'the provider request retains the configured output budget');
    assert.match(await page.locator('#error').innerText(), /100\/100 output tokens/);
    assert.equal(await page.locator('#messages .tool-call').count(), 0);
    assert.doesNotMatch(
      await page.locator('#live .message-content').textContent(),
      /private thought never shown|unfinished/,
    );
  },
);

test(
  'desktop shows the model thinking while it works, and keeps it folded after a restart',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-reasoning-ui-'));
    const thought =
      'weighing whether the note file already exists\n' +
      'check the full reasoning\n'.repeat(1100) +
      'REASONING_END';
    const url = await httpFixture(t, async (_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (value) => res.write('data: ' + JSON.stringify(value) + '\n\n');
      send({
        choices: [
          { index: 0, delta: { reasoning_content: thought, content: '' }, finish_reason: null },
        ],
      });
      // The thinking has to stay on screen long enough to be looked at: an answered-in-50ms fixture proves
      // nothing about the live block, because the live bubble is gone by then.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      send({ choices: [{ index: 0, delta: { content: 'It is there.' }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 12 } });
      res.end('data: [DONE]\n\n');
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'reasoning-fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_PROTOCOL: 'openai',
      YUANTU_PERMISSION_POLICY: '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    const launch = () =>
      electron.launch({
        executablePath: electronPath,
        args: [
          path.resolve('dist/desktop/main.cjs'),
          `--user-data-dir=${path.join(root, 'profile')}`,
        ],
        env,
      });
    t.after(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    app = await launch();
    let page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('Check the note file');
    await page.locator('#send').click();

    // While the model is thinking, the thought is on screen — folded, beside the answer rather than in it.
    const live = page.locator('#live-reasoning');
    const processGroup = page.locator('#messages > .process-group');
    await processGroup.waitFor();
    assert.match(await processGroup.locator(':scope > summary').textContent(), /weighing whether/);
    assert.doesNotMatch(await processGroup.locator(':scope > summary').textContent(), /·\s*\d+/);
    await processGroup.locator(':scope > summary').click();
    await live.waitFor();
    assert.equal(await live.getAttribute('open'), null, 'thinking starts folded');
    assert.match(await live.locator('summary').textContent(), /思考过程/);
    assert.match(await live.locator('summary').textContent(), /weighing whether/);
    await live.locator('summary').click();
    assert.equal(await live.locator('.reasoning-content').textContent(), thought);

    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    const answered = page.locator('#messages .message.assistant .message-content');
    assert.match(await answered.textContent(), /It is there\./);
    assert.doesNotMatch(
      await answered.textContent(),
      new RegExp(thought),
      'the answer is the answer, never the reasoning',
    );

    // A restart loses every event, so the thought has to come back from the message the run stored.
    const sessionId = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state.session.sessionId,
    );
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.locator(`[data-session-id="${sessionId}"]`).click();
    const stored = page.locator('#messages .message-reasoning');
    await stored.waitFor({ state: 'attached' });
    assert.equal(await stored.getAttribute('open'), null, 'a reopened thought is folded too');
    assert.equal(await stored.locator('.reasoning-content').textContent(), thought);
    assert.match(
      await page.locator('#messages > .process-group > summary').textContent(),
      /weighing whether/,
    );
    assert.match(
      await page.locator('#messages .message.assistant .message-content').textContent(),
      /It is there\./,
    );
  },
);

test(
  'desktop keeps one latest operation per reply interval while steps arrive',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-process-interval-'));
    await writeFile(path.join(root, 'note.txt'), 'needle');
    await writeFile(
      path.join(root, 'wait.cjs'),
      "const fs = require('node:fs');setInterval(() => { if (fs.existsSync('release-command')) process.exit(0); }, 30);",
    );
    const releases = [];
    const gates = [0, 1].map(() => new Promise((resolve) => releases.push(resolve)));
    t.after(() => releases.forEach((release) => release()));
    let round = 0;
    const url = await httpFixture(t, async (_, res) => {
      const step = round++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta) =>
        res.write(
          'data: ' +
            JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) +
            '\n\n',
        );
      if (step < 2) {
        send({
          reasoning_content:
            step === 0 ? 'FIRST_THOUGHT: inspect the file' : 'SECOND_THOUGHT: search the content',
        });
        await gates[step];
        send({
          tool_calls: [
            {
              index: 0,
              id: `operation-${step}`,
              type: 'function',
              function: {
                name: step === 0 ? 'read_file' : 'search_files',
                arguments: JSON.stringify(step === 0 ? { path: 'note.txt' } : { query: 'needle' }),
              },
            },
            ...(step === 0
              ? [
                  {
                    index: 1,
                    id: 'operation-command',
                    type: 'function',
                    function: {
                      name: 'run_command',
                      arguments: JSON.stringify({ command: 'node wait.cjs' }),
                    },
                  },
                ]
              : []),
          ],
        });
      } else send({ content: 'FINAL_REPLY' });
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: step < 2 ? 'tool_calls' : 'stop' }],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 12 } }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_PROTOCOL: 'openai',
      YUANTU_SANDBOX: 'host',
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
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('Read and search the note');
    await page.locator('#send').click();
    const group = page.locator('#messages > .process-group');
    await group.waitFor();
    assert.match(await group.locator(':scope > summary').innerText(), /FIRST_THOUGHT/);
    assert.equal(await group.getAttribute('open'), null);
    await group.locator(':scope > summary').click();
    await page.locator('#live-reasoning > summary').click();
    releases[0]();
    await page.getByRole('button', { name: '允许一次', exact: true }).click();
    await waitForPage(page, async () =>
      (await window.yuantu.invoke({ type: 'snapshot' })).state.session.tools.some(
        (call) => call.name === 'run_command',
      ),
    );
    assert.match(await group.locator(':scope > summary').innerText(), /wait\.cjs/);
    await writeFile(path.join(root, 'release-command'), 'ready');
    try {
      await page.waitForFunction(() =>
        document
          .querySelector('#messages > .process-group > summary')
          ?.textContent.includes('SECOND_THOUGHT'),
      );
    } catch (error) {
      t.diagnostic(
        JSON.stringify(
          await page.evaluate(async () => {
            const snapshot = (await window.yuantu.invoke({ type: 'snapshot' })).state;
            return {
              error: snapshot.error,
              sessionError: snapshot.session.error,
              tools: snapshot.session.tools,
              live: snapshot.session.liveMessage,
              summaries: [...document.querySelectorAll('.process-group > summary')].map(
                (el) => el.textContent,
              ),
              messages: snapshot.session.messages.map((m) => ({
                role: m.role,
                content: m.content.slice(0, 150),
              })),
            };
          }),
        ),
      );
      throw error;
    }
    assert.equal(await group.count(), 1);
    assert.notEqual(await group.getAttribute('open'), null);
    assert.equal(await group.locator('.tool-call').count(), 2);
    assert.equal(await group.locator('.tool-result').count(), 2);
    await group.locator(':scope > summary').click();
    assert.match(await group.locator(':scope > summary').innerText(), /SECOND_THOUGHT/);
    assert.equal(await group.locator('.process-steps').isVisible(), false);
    releases[1]();
    await page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    assert.equal(await group.count(), 1);
    assert.match(await group.locator(':scope > summary').innerText(), /搜索[\s\S]*needle/);
    assert.equal(await group.getAttribute('open'), null);
    assert.equal(await group.locator('.tool-result').count(), 3);
    assert.match(
      await page.locator('#messages > .message.assistant .message-content').innerText(),
      /FINAL_REPLY/,
    );
    assert.equal(await page.locator('#tools').isVisible(), false);
    assert.equal(await page.locator('#live .message-content').textContent(), '');
    await group.locator(':scope > summary').click();
    const kinds = await group
      .locator('.process-steps .process-icon')
      .evaluateAll((icons) => [...new Set(icons.map((icon) => icon.dataset.kind))]);
    assert.ok(
      ['reasoning', 'read', 'search'].every((kind) => kinds.includes(kind)),
      kinds.join(','),
    );
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/compact-process-expanded.png' });
    await group.locator(':scope > summary').click();
    await page.screenshot({ path: 'artifacts/compact-process-collapsed.png' });
    assert.ok((await group.locator(':scope > summary').boundingBox()).height <= 32);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.screenshot({ path: 'artifacts/compact-process-dark-collapsed.png' });
    await group.locator(':scope > summary').click();
    await page.screenshot({ path: 'artifacts/compact-process-dark-expanded.png' });
  },
);

test(
  'desktop displays answers after more than 4 MB of streamed data',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-large-stream-ui-'));
    let requests = 0;
    const url = await httpFixture(t, (_body, res) => {
      const visible = requests++ > 0;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame =
        'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: visible
                ? { content: 'V'.repeat(50_400) }
                : { reasoning_content: 'hidden-thought'.repeat(3600) },
              finish_reason: null,
            },
          ],
        }) +
        '\n\n';
      for (let index = 0; index < 100; index++) res.write(frame);
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [
              { index: 0, delta: { content: visible ? '' : 'Ready' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 100_000 },
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    const env = {
      ...process.env,
      YUANTU_WORKSPACE: root,
      YUANTU_NODE_PATH: process.execPath,
      YUANTU_MODEL: 'large-stream-fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_API_KEY: 'fixture',
      YUANTU_BASE_URL: url,
      YUANTU_PROTOCOL: 'openai',
      YUANTU_MAX_OUTPUT_TOKENS: '256000',
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
    page.setDefaultTimeout(20000);
    try {
      await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    } catch (error) {
      const startup = await page
        .evaluate(() => ({
          title: document.title,
          stage: document.querySelector('#run-status')?.textContent,
          error: document.querySelector('#error')?.textContent,
          body: document.body?.innerText.slice(0, 500),
        }))
        .catch(() => ({ error: 'Renderer unavailable' }));
      throw new Error(`Desktop did not become ready: ${JSON.stringify(startup)}`, { cause: error });
    }
    await page.locator('#prompt').fill('Answer briefly');
    await page.locator('#send').click();
    await page.waitForFunction(
      () =>
        !document.querySelector('#new-session').disabled &&
        document.querySelector('.message.assistant .message-content')?.textContent === 'Ready',
    );
    assert.doesNotMatch(await page.locator('#error').innerText(), /4MB|4 MB/);
    assert.doesNotMatch(
      await page.locator('#messages > .message.assistant .message-content').innerText(),
      /hidden-thought/,
    );
    assert.equal(
      await page.locator('#messages .reasoning-content').evaluate((el) => el.textContent.length),
      5_040_000,
    );
    await page.locator('#prompt').fill('Give a long answer');
    await page.locator('#send').click();
    await page.waitForFunction(
      () =>
        !document.querySelector('#new-session').disabled &&
        [...document.querySelectorAll('.message.assistant .message-content')].some(
          (node) => node.textContent?.length === 5_040_000,
        ),
      undefined,
      { timeout: 30000 },
    );
    assert.equal(await page.locator('.message.assistant .plain-fallback').count(), 1);
    assert.doesNotMatch(await page.locator('#error').innerText(), /4MB|4 MB/);
  },
);
