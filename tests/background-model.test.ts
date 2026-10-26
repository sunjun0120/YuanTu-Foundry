import test from 'node:test';
import assert from 'node:assert/strict';
import type { CarrierSnapshot } from '../packages/carrier/contract.ts';
import type { BackgroundJobSnapshot as BackgroundJob } from '../packages/protocol/rpc.ts';
import {
  backgroundElapsed,
  backgroundOverall,
  backgroundStatusKey,
  backgroundView,
  shellOf,
} from '../apps/desktop/ui/panels/background-model.ts';

/**
 * The background card list: which jobs are the current session's, what the header says while they run, and how a
 * finished one reads. The popover itself is a shell; these are the readings that shell prints.
 */
function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1',
    sessionId: 's1',
    command: 'node build.js',
    cwd: '/w',
    createdAt: '2026-10-26T00:00:00.000Z',
    status: 'running',
    exitCode: null,
    output: '',
    nextCursor: 0,
    truncated: false,
    ...overrides,
  } as BackgroundJob;
}

function snapshot(jobs: BackgroundJob[], sessionId = 's1'): CarrierSnapshot {
  return {
    session: { sessionId },
    background: jobs,
  } as unknown as CarrierSnapshot;
}

test('only the current session’s jobs are offered', () => {
  const view = backgroundView(snapshot([job(), job({ id: 'job-2', sessionId: 's2' })]), 'zh-CN');
  assert.equal(view.visible, true);
  assert.deepEqual(
    view.rows.map((row) => row.id),
    ['job-1'],
  );
  assert.equal(backgroundView(null, 'zh-CN').visible, false);
});

test('the header label counts running jobs first, otherwise all of them', () => {
  const running = backgroundView(
    snapshot([job(), job({ id: 'job-2', status: 'completed', exitCode: 0 })]),
    'zh-CN',
  );
  assert.equal(running.overall, 'running');
  assert.equal(running.label, '1 个后台任务运行中');
  assert.equal(running.ariaLabel, '1 个后台任务运行中 · 运行中');

  const done = backgroundView(
    snapshot([job({ status: 'completed', exitCode: 0 }), job({ id: 'job-2', status: 'failed' })]),
    'zh-CN',
  );
  assert.equal(done.overall, 'failed');
  assert.equal(done.label, '2 个后台任务');
  assert.equal(done.rows[0]?.exitLabel, '退出码：0');
  assert.equal(done.rows[1]?.exitLabel, null, 'a failed job without an exit code names its status');

  const empty = backgroundView(snapshot([]), 'zh-CN');
  assert.equal(empty.visible, false);
  assert.equal(empty.label, '后台任务');
  assert.equal(empty.overall, 'idle');
});

test('the overall status prefers running, then failed, then cancelled, then completed', () => {
  assert.equal(backgroundOverall([]), 'idle');
  assert.equal(backgroundOverall([job({ status: 'completed' })]), 'completed');
  assert.equal(
    backgroundOverall([job({ status: 'completed' }), job({ id: 'b', status: 'cancelled' })]),
    'cancelled',
  );
  assert.equal(
    backgroundOverall([job({ status: 'cancelled' }), job({ id: 'b', status: 'failed' })]),
    'failed',
  );
  assert.equal(
    backgroundOverall([job({ status: 'failed' }), job({ id: 'b', status: 'starting' })]),
    'running',
  );
});

test('a cancelled job shows its status rather than an exit code', () => {
  const cancelled = backgroundView(
    snapshot([job({ status: 'cancelled', exitCode: 143, finishedAt: '2026-10-26T00:00:10.000Z' })]),
    'zh-CN',
  );
  assert.equal(cancelled.rows[0]?.exitLabel, null);
  assert.equal(cancelled.rows[0]?.stoppable, false);
  assert.equal(cancelled.rows[0]?.indicator, 'idle');
  assert.equal(cancelled.rows[0]?.statusLabelKey, 'background.cancelled');
});

test('elapsed time is compact and language-shaped', () => {
  const now = Date.parse('2026-10-26T01:02:03.000Z');
  assert.equal(
    backgroundElapsed('2026-10-26T00:00:00.000Z', undefined, now, 'zh-CN'),
    '1小时2分3秒',
  );
  assert.equal(backgroundElapsed('2026-10-26T00:00:00.000Z', undefined, now, 'en-US'), '1h 2m 3s');
  assert.equal(backgroundElapsed('2026-10-26T00:58:00.000Z', undefined, now, 'zh-CN'), '4分3秒');
  assert.equal(backgroundElapsed('2026-10-26T01:02:00.000Z', undefined, now, 'zh-CN'), '3秒');
  assert.equal(backgroundElapsed('not-a-date', undefined, now, 'zh-CN'), '—');
});

test('a finished job with a finish time shows the fixed duration, not "—"', () => {
  const view = backgroundView(
    snapshot([
      job({
        status: 'completed',
        exitCode: 0,
        finishedAt: '2026-10-26T00:00:05.000Z',
      }),
    ]),
    'zh-CN',
    Date.parse('2026-10-27T00:00:00.000Z'),
  );
  assert.equal(view.rows[0]?.duration, '5秒');
});

test('the shell is named when the command starts with one', () => {
  assert.equal(shellOf('pwsh -File build.ps1'), 'pwsh');
  assert.equal(
    shellOf('C:\\Windows\\System32\\cmd.exe /c dir'),
    null,
    'a path is not a bare shell',
  );
  assert.equal(shellOf('bash script.sh'), 'bash');
  assert.equal(shellOf('node server.js'), null);
  assert.equal(backgroundStatusKey('idle'), 'background.title');
  assert.equal(backgroundStatusKey('running'), 'background.running');
});
