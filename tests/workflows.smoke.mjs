import { waitForPage } from './page-wait.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
process.env.YUANTU_SESSION_TITLES = 'false';
import { SessionStore } from '../packages/storage/sqlite.ts';

// ---- merged from task-editor.smoke.mjs ----

test(
  'task draft is editable and executes only after explicit start, then requires manual confirmation',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-editor-'));
    await writeFile(path.join(root, 'result.txt'), 'expected output');
    let requests = 0;
    const url = await httpFixture(t, (_body, res) => {
      requests++;
      sendFrames(
        res,
        frames(
          JSON.stringify({
            title: 'Review output',
            description: 'Review the existing output',
            steps: [{ description: 'Inspect result.txt', status: 'pending' }],
            acceptance: [{ description: 'Human review', met: false }],
          }),
        ),
      );
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
    page.setDefaultTimeout(15000);
    const idle = () => page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await idle();
    await page.locator('#prompt').fill('/goal Review the existing output');
    await page.locator('#send').click();
    await page.locator('.task-card').waitFor();
    await idle();
    const card = page.locator('.task-card').first();
    assert.equal(
      await card.getByRole('button', { name: '开始执行', exact: true }).isVisible(),
      true,
    );
    let state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.equal(state.tasks[0].latestRunId, undefined);
    assert.equal(state.tasks[0].attemptCount, 0);
    assert.equal(state.session.messages.filter((m) => m.role === 'tool').length, 0);
    const proposalRequests = requests;
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    await card.getByLabel('标题', { exact: true }).fill('Edited output review');
    // Snapshot refresh must preserve the active editor and its draft input.
    await page.locator('#refresh-tasks').click();
    await idle();
    assert.equal(
      await card.getByLabel('标题', { exact: true }).inputValue(),
      'Edited output review',
    );
    await card.getByRole('button', { name: '添加验收标准', exact: true }).click();
    const criterion = card.locator('.task-criterion').last();
    await criterion.getByLabel('标准描述', { exact: true }).fill('File content matches');
    await criterion.getByLabel('检查方式', { exact: true }).selectOption('file-exact');
    await criterion.getByLabel('相对工作区路径', { exact: true }).fill('result.txt');
    await criterion.getByLabel('期望文本', { exact: true }).fill('expected output');
    await card.getByRole('button', { name: '保存草稿', exact: true }).click();
    await card.locator('.task-editor').waitFor({ state: 'hidden' });
    await idle();
    assert.equal(requests, proposalRequests);
    await card.getByRole('button', { name: '开始执行', exact: true }).click();
    await idle();
    await waitForPage(page, async () => {
      const reply = await window.yuantu.invoke({ type: 'snapshot' });
      return !reply.state.session.running && !!reply.state.tasks[0].latestRunId;
    });
    await page.locator('#refresh-tasks').click();
    await idle();
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.ok(requests > proposalRequests);
    assert.equal(state.tasks[0].acceptance.find((a) => !a.check).met, false);
    await card.locator('input[type=checkbox]').check();
    await card.getByRole('button', { name: '确认勾选的人工结果', exact: true }).click();
    await idle();
    await card.getByRole('button', { name: '验收', exact: true }).click();
    await idle();
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.equal(state.tasks[0].acceptance.find((a) => !a.check).met, true);
    assert.equal(
      state.tasks[0].verification.checks.find((c) => c.kind === 'file-exact').passed,
      true,
    );
    assert.equal((await card.locator('.task-evidence').count()) > 0, true);
  },
);

// ---- merged from task-trigger.smoke.mjs ----

test(
  'task triggers are editable from the desktop and step checkpoints are visible',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-trigger-'));
    let requests = 0;
    const url = await httpFixture(t, (_body, res) => {
      requests++;
      // 1: the plan proposal. 2: the execution round, which checkpoints a step durably.
      if (requests === 1)
        sendFrames(
          res,
          frames(
            JSON.stringify({
              title: 'Scheduled review',
              description: 'Review the scheduled output',
              steps: [
                { description: 'Gather inputs', status: 'pending' },
                { description: 'Produce output', status: 'pending' },
              ],
              acceptance: [{ description: 'Human review', met: false }],
            }),
          ),
        );
      else if (requests === 2)
        sendFrames(
          res,
          frames('', [
            {
              id: 'checkpoint-1',
              name: 'task_step',
              input: { index: 0, status: 'completed', note: 'inputs gathered' },
            },
          ]),
        );
      else sendFrames(res, frames('Done'));
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
    page.setDefaultTimeout(15000);
    const idle = () => page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await idle();
    await page.locator('#prompt').fill('/goal Review the scheduled output');
    await page.locator('#send').click();
    await page.locator('.task-card').waitFor();
    await idle();
    const card = page.locator('.task-card').first();
    assert.equal(await card.locator('.task-schedule-summary').textContent(), '无自动触发');
    // No trigger has ever run, so there is nothing to show yet.
    assert.equal(await card.locator('.task-step-journal').count(), 0);

    await card.getByRole('button', { name: '触发设置', exact: true }).click();
    const form = card.locator('.task-schedule');
    await form.waitFor();
    await form.getByLabel('触发方式', { exact: true }).selectOption('interval');
    await form.getByLabel('间隔（分钟，1–10080）', { exact: true }).fill('15');
    await form.getByLabel('启用', { exact: true }).check();
    await form.getByRole('button', { name: '保存触发设置', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await idle();

    let state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.deepEqual(state.tasks[0].trigger, {
      kind: 'interval',
      enabled: true,
      everyMinutes: 15,
    });
    // The schedule is durable, so the Host computed the next occurrence for the UI to show.
    assert.ok(state.tasks[0].nextRunAt, 'the Host did not schedule the next run');
    assert.match(await card.locator('.task-schedule-summary').textContent(), /每 15 分钟/);
    assert.match(await card.locator('.task-schedule-summary').textContent(), /下次/);

    // Calendar settings travel through the renderer, Carrier and Host without losing their zone or anchor.
    await card.getByRole('button', { name: '触发设置', exact: true }).click();
    assert.equal(
      await form.getByLabel('间隔（分钟，1–10080）', { exact: true }).inputValue(),
      '15',
    );
    await form.getByLabel('触发方式', { exact: true }).selectOption('weekly');
    await form
      .getByLabel('IANA 时区（每天留空沿用本机）', { exact: true })
      .fill('America/New_York');
    await form.getByLabel('日历时间', { exact: true }).fill('09:00');
    await form.getByRole('button', { name: '保存触发设置', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await idle();
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.equal(state.tasks[0].trigger.timeZone, 'America/New_York');
    assert.deepEqual(state.tasks[0].trigger.weekdays, [1]);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(state.tasks[0].nextRunAt));
    assert.match(local, /Mon/);
    assert.match(local, /09:00/);
    await card.getByRole('button', { name: '触发设置', exact: true }).click();
    await form.getByLabel('触发方式', { exact: true }).selectOption('after');
    await form.getByLabel('延迟分钟（1～525600）', { exact: true }).fill('120');
    await form.getByRole('button', { name: '保存触发设置', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await idle();
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    const anchored = state.tasks[0].nextRunAt;
    assert.equal(Date.parse(anchored) - Date.parse(state.tasks[0].trigger.anchorAt), 120 * 60000);
    await card.getByRole('button', { name: '触发设置', exact: true }).click();
    assert.match(
      await form.locator('.task-schedule-preview').textContent(),
      new RegExp(anchored.replaceAll('.', '\\.')),
    );
    await form.getByRole('button', { name: '保存触发设置', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await idle();
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.equal(state.tasks[0].nextRunAt, anchored);
    await card.getByRole('button', { name: '触发设置', exact: true }).click();
    await form.getByLabel('触发方式', { exact: true }).selectOption('at');
    await form
      .getByLabel('绝对时刻（必须包含 UTC 偏移）', { exact: true })
      .fill('2030-01-01T09:00:00+08:00');
    assert.match(
      await form.locator('.task-schedule-preview').textContent(),
      /2030-01-01T01:00:00.000Z/,
    );
    await form.getByRole('button', { name: '保存触发设置', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await idle();
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.equal(state.tasks[0].nextRunAt, '2030-01-01T01:00:00.000Z');

    // Reopening the editor must show the stored schedule, not a blank form.
    await card.getByRole('button', { name: '触发设置', exact: true }).click();
    assert.equal(
      await form.getByLabel('绝对时刻（必须包含 UTC 偏移）', { exact: true }).inputValue(),
      '2030-01-01T01:00:00.000Z',
    );
    await form.getByLabel('触发方式', { exact: true }).selectOption('cron');
    await form.getByLabel('Cron 表达式（五字段）', { exact: true }).fill('0 0 30 2 *');
    await form.getByRole('button', { name: '保存触发设置', exact: true }).click();
    assert.equal(await form.isVisible(), true);
    assert.match(await form.locator('.task-edit-warning').textContent(), /reachable|occurrence/);
    await form.getByLabel('Cron 表达式（五字段）', { exact: true }).fill('0 9 * * 1-5');
    await form
      .getByLabel('IANA 时区（每天留空沿用本机）', { exact: true })
      .fill('America/New_York');
    await form.getByLabel('错过触发', { exact: true }).selectOption('skip');
    assert.match(await form.locator('.task-schedule-preview').textContent(), /Next|预计下次/);
    await form.getByRole('button', { name: '保存触发设置', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await idle();
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.equal(state.tasks[0].trigger.expression, '0 9 * * 1-5');
    assert.equal(state.tasks[0].trigger.timeZone, 'America/New_York');
    assert.equal(state.tasks[0].trigger.misfire, 'skip');
    const cronClock = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    }).format(new Date(state.tasks[0].nextRunAt));
    assert.match(cronClock, /09:00/);
    assert.doesNotMatch(cronClock, /Sat|Sun/);
    await card.getByRole('button', { name: '触发设置', exact: true }).click();
    assert.equal(
      await form.getByLabel('Cron 表达式（五字段）', { exact: true }).inputValue(),
      '0 9 * * 1-5',
    );
    assert.equal(await form.getByLabel('错过触发', { exact: true }).inputValue(), 'skip');
    await form.getByLabel('触发方式', { exact: true }).selectOption('event');
    assert.equal(await form.getByLabel('监听事件', { exact: true }).isDisabled(), false);
    assert.equal(
      await form.getByLabel('来源任务（仅“任务通过验收”）', { exact: true }).isDisabled(),
      false,
    );
    await form.getByLabel('触发方式', { exact: true }).selectOption('none');
    await form.getByRole('button', { name: '保存触发设置', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await idle();
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.equal(state.tasks[0].trigger, undefined);
    assert.equal(state.tasks[0].nextRunAt, undefined);
    assert.equal(await card.locator('.task-schedule-summary').textContent(), '无自动触发');

    // Running the task checkpoints a step; the journal must survive to the UI even though the
    // attempt ends awaiting human review.
    await card.getByRole('button', { name: '开始执行', exact: true }).click();
    await idle();
    await waitForPage(page, async () => {
      const reply = await window.yuantu.invoke({ type: 'snapshot' });
      return !reply.state.session.running && !!reply.state.tasks[0].latestRunId;
    });
    await page.locator('#refresh-tasks').click();
    await idle();
    const journal = card.locator('.task-step-journal');
    await journal.waitFor();
    assert.equal(await journal.locator('summary').textContent(), '步骤检查点 (1)');
    assert.match(await journal.locator('p').first().textContent(), /^0 · completed · /);
    assert.match(await journal.locator('p').first().textContent(), /inputs gathered/);
    state = await page.evaluate(
      async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
    );
    assert.equal(state.taskSteps[state.tasks[0].id].length, 1);
    // The completed checkpoint is preserved even though acceptance still needs a human.
    assert.equal(state.tasks[0].steps[0].status, 'completed');
    // The attempt records that a human started it, not a trigger.
    assert.equal(state.taskAttempts[state.tasks[0].id][0].trigger, 'manual');
    assert.equal(state.taskAttempts[state.tasks[0].id][0].resume, false);
  },
);

// ---- merged from task-approval.smoke.mjs ----

test(
  'desktop reviews a deferred scheduled write and resumes it once',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-approval-ui-'));
    const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
    const session = store.create(root);
    const task = store.createTask(session.id, {
      title: 'Approval review',
      description: 'create approved.txt',
      trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
    });
    store.scheduleImmediateRun(session.id, task.id);
    store.close();
    let requests = 0;
    const url = await httpFixture(t, (_body, res) => {
      requests++;
      if (requests <= 2)
        sendFrames(
          res,
          frames('', [
            {
              id: 'write-' + requests,
              name: 'write_file',
              input: { path: 'approved.txt', content: 'approved' },
            },
          ]),
        );
      else sendFrames(res, frames('Done'));
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
      YUANTU_WORKFLOW_INTERVAL_MS: '1000',
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
    const card = page.locator('.task-card').first();
    await card.waitFor();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !(await card.locator('.task-approval').count())) {
      await page.locator('#refresh-tasks').click();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await card.locator('.task-approval').waitFor();
    assert.match(await card.locator('.task-approval').textContent(), /write_file/);
    await card.getByRole('button', { name: '批准并续跑', exact: true }).click();
    let observed;
    const resumedDeadline = Date.now() + 20000;
    while (Date.now() < resumedDeadline) {
      observed = await page.evaluate(
        async () => (await window.yuantu.invoke({ type: 'snapshot' })).state,
      );
      if (observed.tasks[0]?.status === 'completed' && !observed.tasks[0]?.pendingApproval) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const bytes = await readFile(path.join(root, 'approved.txt'), 'utf8').catch(() => null);
    assert.equal(
      bytes,
      'approved',
      JSON.stringify({
        requests,
        task: observed.tasks[0],
        attempts: observed.taskAttempts[task.id],
        messages: observed.session.messages,
      }),
    );
    assert.equal(requests, 3);
  },
);

// ---- merged from plan-mode.smoke.mjs ----

/**
 * The desktop half of plan mode: `/plan` must produce a reviewable plan whose execution is gated on
 * an explicit approval, and the panel must be localised in both supported languages.
 */
test(
  'desktop /plan produces a read-only plan that needs approval before execution',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-plan-ui-'));
    let calls = 0;
    const url = await httpFixture(t, (_body, res) => {
      calls++;
      // First call is the planning run; it must answer with submit_plan.
      if (calls === 1)
        return sendFrames(
          res,
          frames('Let me look around first.', [
            {
              id: 'plan',
              name: 'submit_plan',
              input: {
                title: 'Refactor the loader',
                summary: 'Split the loader and cover it with tests.',
                steps: ['Read the loader', 'Split the module', 'Add tests'],
              },
            },
          ]),
        );
      return sendFrames(res, frames('Executed the approved plan.'));
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
    page.setDefaultTimeout(20000);
    const idle = () => page.waitForFunction(() => !document.querySelector('#new-session').disabled);
    await idle();
    await page.locator('#new-session').click();
    await idle();

    await page.locator('#prompt').fill('/plan Refactor the loader');
    await page.locator('#send').click();
    const panel = page.locator('#plan-panel');
    await panel.waitFor();
    await idle();

    // The planning run proposed a plan and nothing has executed: execution needs the human.
    assert.match(await page.locator('#plan-title').textContent(), /Refactor the loader/);
    assert.equal(await page.locator('#plan-steps li').count(), 3);
    assert.equal(
      await page.getByRole('button', { name: '批准计划', exact: true }).isVisible(),
      true,
      'a proposed plan offers approval',
    );
    assert.equal(
      await page.locator('.plan-execute').count(),
      0,
      'execution must not be offered before approval',
    );
    // The plan panel is localised: no Chinese left once the UI is switched to en-US.
    const openLanguage = async (locale) => {
      await page.locator('#open-settings').click();
      await page.locator('.settings-sidebar nav button').first().click();
      await page.locator('#ui-language').selectOption(locale);
      await page.locator('#settings-back').click();
    };
    await openLanguage('en-US');
    await page.waitForFunction(() =>
      (document.querySelector('#plan-actions')?.textContent ?? '').includes('Approve plan'),
    );
    assert.doesNotMatch(await page.locator('#plan-actions').textContent(), /[\u4e00-\u9fff]/);
    await openLanguage('zh-CN');
    await page.waitForFunction(() =>
      (document.querySelector('#plan-actions')?.textContent ?? '').includes('批准计划'),
    );

    // Approving reveals execution; the plan itself is then run by the Host, which re-checks the hash.
    await page.getByRole('button', { name: '批准计划', exact: true }).click();
    await page.getByRole('button', { name: '按计划执行', exact: true }).waitFor();
    await idle();
    assert.equal(
      await page.locator('#plan-status').textContent(),
      '已批准',
      'the panel reflects the approved status',
    );
    await page.getByRole('button', { name: '按计划执行', exact: true }).click();
    await page.waitForFunction(() =>
      (document.querySelector('#messages')?.textContent ?? '').includes(
        'Executed the approved plan',
      ),
    );
  },
);
