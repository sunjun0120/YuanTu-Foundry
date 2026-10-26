import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../packages/protocol/index.ts';
import {
  acceptanceRows,
  clockReading,
  evidenceReading,
  stepJournalReading,
  taskEventReading,
  taskActions,
  taskApprovalView,
  taskAttemptsReading,
  taskCanConfirm,
  taskScheduleReading,
  taskStatusReading,
  triggerSummaryReading,
} from '../apps/desktop/ui/panels/task-view.ts';

/**
 * The task panel's words: a status, a schedule sentence, the evidence a verification left and the step journal.
 * The trigger sentence is the one a person reads to know when a task will run again, so each kind keeps its legacy
 * shape — including the pause/misfire suffix and the time zone only where the schedule carries one.
 */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    sessionId: 's1',
    title: 'Build',
    description: '',
    status: 'pending',
    acceptance: [],
    steps: [],
    attemptCount: 0,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...overrides,
  } as Task;
}

test('statuses are translated and an unknown status is shown as it arrived', () => {
  assert.equal(taskStatusReading('pending', 'zh-CN'), '待确认草稿');
  assert.equal(taskStatusReading('in_progress', 'en-US'), 'In progress');
  assert.equal(taskStatusReading('needs_review', 'zh-CN'), '待验收');
  assert.equal(taskStatusReading('future-status', 'zh-CN'), 'future-status');
  assert.equal(clockReading(65), '01:05');
  assert.equal(clockReading(7), '00:07');
});

test('event triggers are named', () => {
  assert.equal(taskEventReading('run.finished', 'zh-CN'), '任一任务执行结束');
  assert.equal(taskEventReading('task.completed', 'en-US'), 'A task passes verification');
});

test('the trigger sentence keeps the cadence, pause and misfire in that order', () => {
  assert.equal(triggerSummaryReading(task(), 'zh-CN'), '无自动触发');
  assert.equal(
    triggerSummaryReading(
      task({ trigger: { kind: 'interval', everyMinutes: 15, enabled: true } as never }),
      'zh-CN',
    ),
    '每 15 分钟',
  );
  assert.equal(
    triggerSummaryReading(
      task({ trigger: { kind: 'interval', everyMinutes: 15, enabled: false } as never }),
      'zh-CN',
    ),
    '每 15 分钟 · 已暂停',
  );
  assert.equal(
    triggerSummaryReading(
      task({ trigger: { kind: 'daily', atMinutes: 545, enabled: true } as never }),
      'zh-CN',
    ),
    '每天 09:05 (本机时区)',
  );
  assert.equal(
    triggerSummaryReading(
      task({
        trigger: {
          kind: 'daily',
          atMinutes: 545,
          timeZone: 'UTC',
          enabled: true,
          misfire: 'skip',
        } as never,
      }),
      'zh-CN',
    ),
    '每天 09:05 (UTC) · 漏跑跳过',
  );
  assert.equal(
    triggerSummaryReading(
      task({
        trigger: {
          kind: 'weekly',
          weekdays: [1, 3],
          atMinutes: 480,
          timeZone: 'UTC',
          enabled: true,
        } as never,
      }),
      'en-US',
    ),
    'Weekly 1,3 at 08:00 (UTC)',
  );
  assert.equal(
    triggerSummaryReading(
      task({
        trigger: {
          kind: 'cron',
          expression: '*/5 * * * *',
          timeZone: 'UTC',
          enabled: true,
        } as never,
      }),
      'zh-CN',
    ),
    'Cron */5 * * * * (UTC)',
  );
  assert.equal(
    triggerSummaryReading(
      task({ trigger: { kind: 'at', at: '2026-11-01T00:00:00.000Z', enabled: true } as never }),
      'zh-CN',
    ),
    '仅一次：2026-11-01T00:00:00.000Z',
  );
  assert.equal(
    triggerSummaryReading(
      task({ trigger: { kind: 'after', afterMinutes: 30, enabled: true } as never }),
      'zh-CN',
    ),
    '保存后 30 分钟，仅一次',
  );
  assert.equal(
    triggerSummaryReading(
      task({ trigger: { kind: 'event', on: 'run.finished', enabled: false } as never }),
      'zh-CN',
    ),
    '任一任务执行结束 · 已暂停',
  );
});

test('verification evidence is a summary plus one block per check', () => {
  const reading = evidenceReading(
    {
      passed: false,
      checks: [
        { id: 'c1', kind: 'file-exact', passed: true, detail: 'match' },
        {
          id: 'c2',
          kind: 'command',
          passed: false,
          detail: 'exit 1',
          command: {
            command: 'npm test',
            exitCode: 1,
            timedOut: false,
            stdout: 'out',
            stderr: 'err',
          },
        },
      ],
    } as never,
    'zh-CN',
  );
  assert.equal(reading?.summary, '验收证据 · 未通过');
  assert.deepEqual(
    reading?.checks.map((check) => [check.mark, check.id, check.kind]),
    [
      ['✓', 'c1', 'file-exact'],
      ['×', 'c2', 'command'],
    ],
  );
  assert.equal(reading?.checks[1]?.command, 'exit: 1 · timeout: false\nout\nerr');
  assert.equal(evidenceReading(undefined, 'zh-CN'), null);
});

test('the step journal keeps one line per checkpoint', () => {
  const reading = stepJournalReading(
    [
      { index: 1, status: 'completed', createdAt: '2026-10-26T00:00:00.000Z', note: 'done' },
      { index: 2, status: 'in_progress', createdAt: '2026-10-26T00:01:00.000Z' },
    ] as never,
    'zh-CN',
  );
  assert.equal(reading?.summary, '步骤检查点 (2)');
  assert.deepEqual(reading?.entries, [
    '1 · completed · 2026-10-26T00:00:00.000Z · done',
    '2 · in_progress · 2026-10-26T00:01:00.000Z',
  ]);
  assert.equal(stepJournalReading([], 'zh-CN'), null);
});

test('acceptance rows carry the live selection and what cannot be confirmed again', () => {
  const rows = acceptanceRows(
    task({
      acceptance: [
        { description: 'first', met: false },
        { description: 'second', met: true },
      ] as never,
    }),
    new Set([0, 1]),
  );
  assert.deepEqual(
    rows.map((row) => [row.index, row.description, row.met, row.selected, row.confirmable]),
    [
      [0, 'first', false, true, true],
      [1, 'second', true, true, false],
    ],
  );
});

test('the timeline adds the next and last moments to the trigger sentence', () => {
  const reading = taskScheduleReading(
    task({
      trigger: { kind: 'interval', everyMinutes: 5, enabled: true } as never,
      nextRunAt: '2026-10-26T01:05:00.000Z',
      lastRunAt: '2026-10-26T01:00:00.000Z',
    }),
    'zh-CN',
  );
  assert.match(reading, /^每 5 分钟 · 下次 /);
  assert.match(reading, / · 上次 /);
  assert.doesNotMatch(taskScheduleReading(task(), 'zh-CN'), /下次|上次/);
});

test('an approval reads its state and only a pending one can be answered', () => {
  const pending = taskApprovalView(
    task({
      pendingApproval: {
        id: 'a1',
        state: 'pending',
        kind: 'command',
        tool: 'run_command',
        description: 'rm -rf build',
      } as never,
    }),
    'zh-CN',
  );
  assert.equal(pending.label, '等待操作审批');
  assert.equal(pending.detail, 'command · run_command');
  assert.equal(pending.canRespond, true);
  const rejected = taskApprovalView(
    task({
      pendingApproval: {
        id: 'a1',
        state: 'rejected',
        kind: 'command',
        tool: 'run_command',
        description: 'x',
      } as never,
    }),
    'zh-CN',
  );
  assert.equal(rejected.label, '已拒绝，自动触发已暂停');
  assert.equal(rejected.canRespond, false);
  assert.equal(taskApprovalView(task(), 'zh-CN').visible, false);
});

test('confirmation needs a run, evidence, and a task that is past pending', () => {
  const base = task({
    status: 'needs_review',
    latestRunId: 'run',
    verification: { passed: true, checks: [] } as never,
    acceptance: [{ description: 'manual', met: false }] as never,
  });
  assert.equal(taskCanConfirm(base), true);
  assert.equal(taskCanConfirm({ ...base, status: 'in_progress' }), false);
  assert.equal(taskCanConfirm({ ...base, latestRunId: undefined }), false);
});

test('actions choose start or retry, gate verification, and offer confirm only when it applies', () => {
  const fresh = task({ acceptance: [{ description: 'manual', met: false }] as never });
  assert.deepEqual(
    taskActions(fresh, new Set(), 'zh-CN')
      .filter((action) => ['start', 'retry', 'verify', 'confirm'].includes(action.kind))
      .map((action) => [action.kind, action.unavailable]),
    [
      ['start', false],
      ['verify', true],
    ],
  );
  const verified = task({
    status: 'needs_review',
    latestRunId: 'run',
    verification: { passed: true, checks: [] } as never,
    acceptance: [{ description: 'manual', met: false }] as never,
  });
  assert.deepEqual(
    taskActions(verified, new Set(), 'zh-CN')
      .filter((action) => ['start', 'retry', 'confirm'].includes(action.kind))
      .map((action) => [action.kind, action.unavailable]),
    [
      ['retry', false],
      ['confirm', true],
    ],
  );
  const chosen = taskActions(verified, new Set([0]), 'zh-CN').find(
    (action) => action.kind === 'confirm',
  );
  assert.equal(chosen?.unavailable, false);
});

test('attempt history keeps the trigger, resume and error on one line', () => {
  const reading = taskAttemptsReading(
    [
      { kind: 'automatic', status: 'completed', startedAt: 't1', trigger: 'cron', resume: true },
      { kind: 'manual', status: 'failed', startedAt: 't2', error: 'boom' },
    ],
    'zh-CN',
  );
  assert.equal(reading.title, '历史尝试 (2)');
  assert.equal(reading.rows[0]?.text, 'automatic · completed · t1 · cron · 续跑');
  assert.equal(reading.rows[1]?.text, 'manual · failed · t2 · boom');
  assert.equal(taskAttemptsReading([], 'zh-CN').visible, false);
});
