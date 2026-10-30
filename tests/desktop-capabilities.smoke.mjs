// @test-serial desktop-ui: Launches real Electron windows.
// Attachments, skills and approvals, MCP access labels, and the model's checklist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';
import { choosePermissionPreset, chooseSelectOption, waitFor } from './desktop-smoke-support.mjs';
import { translate } from '../apps/desktop/i18n.ts';
process.env.YUANTU_SESSION_TITLES = 'false';

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
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let calls = 0;
    let continueSteer;
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
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    assert.equal(await page.locator('#skill-select').count(), 0);
    await page.locator('#prompt').fill('/');
    // By name, not by text: the built-in office skill's description mentions office_preview, which contains "review".
    await page.getByRole('option', { name: /^review\b/ }).waitFor();
    await page.locator('#image-input').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await page.locator('#prompt').fill('/');
    await page.getByRole('option', { name: /^review\b/ }).click();
    await choosePermissionPreset(page, 'guarded');
    await page.locator('#prompt').fill('/skill:review 看图并修改');
    await page.locator('#send').click();
    // Hold the write at its real approval boundary before steering the live run.
    await page
      .getByRole('button', { name: translate('approval.allow', 'zh-CN'), exact: true })
      .waitFor();
    assert.match(await page.locator('#approvals').innerText(), /write_file/);
    assert.match(await page.locator('#approvals').innerText(), /no\.txt/);
    /**
     * The desktop has no steer control any more: the select that chose between steering and queueing is gone, and
     * a message typed while the run is live is queued for after the turn. The *runtime* still takes a steer, so
     * the test drives the command the removed control used to send — the path stays covered without the suite
     * pretending the interface offers it.
     */
    const steered = await page.evaluate(() =>
      window.yuantu.invoke({ type: 'enqueue', mode: 'steer', prompt: '不要写入，只解释' }),
    );
    assert.equal(steered.ok, true, JSON.stringify(steered));
    await waitFor(() => continueSteer !== undefined, 10_000);
    await page.locator('#prompt').fill('最后列出检查清单');
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('#queue').textContent.includes('最后列出检查清单'),
    );
    continueSteer();
    await page.waitForFunction(
      (text) => document.querySelector('#run-status').textContent === text,
      translate('ui.runStatus.completed', 'zh-CN'),
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
    await chooseSelectOption(page, 'settings-protocol', 'OpenAI Chat Completions');
    assert.equal(
      await page.locator('#settings-protocol').inputValue(),
      translate('settings.protocolOpenai', 'en-US'),
    );
  },
);

test(
  'desktop labels and approves external MCP access without a shell permission shortcut',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-ui-'));
    await mkdir(path.join(root, '.yuantu'));
    await writeFile(path.join(root, 'note.txt'), 'LOCAL_TOOL_OK');
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
            { id: 'local-ui', name: 'read_file', input: { path: 'note.txt' } },
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
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.locator('#prompt').fill('Use the external echo tool');
    await page.locator('#send').click();
    await page
      .getByRole('heading', { name: translate('approval.title.external', 'zh-CN') })
      .waitFor();
    const mcpRow = page.locator('.mcp-call[data-call-id="mcp-ui"]');
    const executionGroup = page.locator('.execution-process');
    const card = page.locator('.mcp-group');
    assert.equal(
      await executionGroup.count(),
      1,
      'the MCP execution has one outer process disclosure',
    );
    assert.equal(
      await executionGroup.evaluate((node) => node.open),
      false,
      'the whole process starts collapsed',
    );
    assert.equal(await card.evaluate((node) => node.open), false, 'MCP cards start collapsed too');
    assert.equal(
      await mcpRow.evaluate((node) => node.open),
      false,
      'individual calls start collapsed',
    );
    await executionGroup.locator(':scope > summary').click();
    await card.waitFor();
    assert.equal(
      await card.evaluate((node) => node.open),
      false,
      'opening the process does not expand its cards',
    );
    await card.locator(':scope > summary').click();
    await mcpRow.waitFor();
    assert.equal(await mcpRow.getAttribute('data-status'), 'running');
    assert.equal(await mcpRow.locator('.mcp-call-name').innerText(), 'echo');
    assert.match(await card.locator(':scope > summary').innerText(), /0\/1/);
    assert.equal(await page.locator('.process-group .tool-call[data-call-id="mcp-ui"]').count(), 0);
    assert.equal(
      await page.locator('.process-group .tool-call[data-call-id="local-ui"]').count(),
      1,
    );
    await mcpRow.locator(':scope > summary').click();
    assert.equal(await mcpRow.evaluate((node) => node.open), true, 'row opens before approval');
    await page.evaluate(() => {
      window.__mcpRow = document.querySelector('.mcp-call[data-call-id="mcp-ui"]');
    });
    await assert.rejects(readFile(path.join(root, 'mcp-pid.txt')), { code: 'ENOENT' });
    await page
      .getByRole('button', { name: translate('approval.allow', 'zh-CN'), exact: true })
      .click();
    await page.waitForFunction(
      (text) => document.querySelector('#run-status').textContent === text,
      translate('ui.runStatus.completed', 'zh-CN'),
    );
    assert.match(await page.locator('#messages').textContent(), /MCP_UI_OK/);
    assert.equal(await mcpRow.getAttribute('data-status'), 'succeeded');
    assert.equal(
      await executionGroup.evaluate((node) => node.open),
      true,
      'a result keeps the process open',
    );
    assert.equal(await card.evaluate((node) => node.open), true, 'a result keeps its card open');
    assert.match(await card.locator(':scope > summary').innerText(), /1\/1/);
    assert.equal(
      await mcpRow.evaluate((node) => node === window.__mcpRow),
      true,
      'result arrival retains the row node',
    );
    assert.equal(
      await mcpRow.evaluate((node) => node.open),
      true,
      'result arrival retains the open row',
    );
    assert.match(await mcpRow.locator('.mcp-call-result').innerText(), /MCP_UI_OK/);
    assert.equal(
      await page.locator('.process-group .tool-result').count(),
      1,
      'only the local result remains in the ordinary process fold',
    );
    await mcpRow.locator(':scope > summary').click();
    assert.equal(await mcpRow.evaluate((node) => node.open), false);
    await mcpRow.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(
      await mcpRow.evaluate((node) => node.open),
      true,
      'the MCP disclosure supports keyboard activation',
    );
    const pid = Number(await readFile(path.join(root, 'mcp-pid.txt'), 'utf8'));
    // MCP connections are session-scoped now (`packages/catalog/resource-pool.ts`): the stdio server stays
    // alive for the next turn instead of dying with the run. Closing the window closes the Host that pooled it.
    assert.doesNotThrow(() => process.kill(pid, 0));
    await app.close();
    app = undefined;
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
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
    await page.waitForLoadState('domcontentloaded');
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
      translate('ui.todosSummary', 'zh-CN', { completed: 0, inProgress: 1, pending: 2 }),
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
      (text) => document.querySelector('#run-status').textContent === text,
      translate('ui.runStatus.completed', 'zh-CN'),
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
      translate('ui.todosSummary', 'zh-CN', { completed: 2, inProgress: 1, pending: 0 }),
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
      (text) => document.querySelector('#run-status').textContent === text,
      translate('ui.runStatus.completed', 'zh-CN'),
    );
    assert.equal(await page.locator('#todos-panel').isVisible(), true);
    // A turn that writes no list leaves the latest saved list available.
    await page.locator('#prompt').fill('Carry on without a plan');
    await page.locator('#send').click();
    await releaseRun();
    await page.getByText('No new plan', { exact: true }).waitFor();
    await page.waitForFunction(
      (text) => document.querySelector('#run-status').textContent === text,
      translate('ui.runStatus.completed', 'zh-CN'),
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
      (text) => document.querySelector('#todos-summary')?.textContent === text,
      translate('ui.todosSummary', 'zh-CN', { completed: 1, inProgress: 0, pending: 1 }),
    );
    assert.equal(
      await page.locator('#todos-summary').innerText(),
      translate('ui.todosSummary', 'zh-CN', { completed: 1, inProgress: 0, pending: 1 }),
    );
    assert.deepEqual(await page.locator('#todos .todo-content').allInnerTexts(), [
      'Read the loader',
      'Ship the fix',
    ]);
    // The last saved version stays visible when the run finishes.
    await releaseRun();
    await page.waitForFunction(
      (text) => document.querySelector('#run-status').textContent === text,
      translate('ui.runStatus.completed', 'zh-CN'),
    );
    assert.equal(await page.locator('#todos-panel').isVisible(), true);
  },
);
