import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { TaskScheduler, type SchedulerRun } from '../apps/agent-host/scheduler.ts';
import { recordTaskDelivery, pendingTaskDeliveries } from '../packages/core/task-deliveries.ts';
import { latestScheduledAt, normalizeTaskTrigger } from '../packages/core/task-trigger.ts';

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cron-'));
  const file = path.join(root, 'sessions.sqlite'),
    store = new SessionStore(file),
    session = store.create(root).id;
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const due = (id: string, at: string) => {
    const db = new DatabaseSync(file);
    try {
      db.prepare('UPDATE tasks SET next_run_at=? WHERE id=?').run(at, id);
    } finally {
      db.close();
    }
  };
  return { root, file, store, session, due };
}
test('cron skip retires persisted busy debt without a model call or fake task attempt', async (t) => {
  const { root, store, session, due } = await setup(t);
  const task = store.createTask(session, {
    title: 'Skip',
    trigger: {
      kind: 'cron',
      enabled: true,
      expression: '* * * * *',
      timeZone: 'UTC',
      misfire: 'skip',
    },
  });
  due(task.id, '2000-01-01T00:00:00.000Z');
  const stale = store.getTask(session, task.id);
  recordTaskDelivery(store, session, {
    dueAt: stale.nextRunAt!,
    recordedAt: new Date().toISOString(),
    reason: 'busy',
    tasks: [{ id: task.id, title: task.title }],
  });
  let calls = 0;
  const scheduler = new TaskScheduler({
    store,
    workspace: root,
    canRun: () => false,
    run: async () => {
      calls++;
    },
  });
  t.after(() => scheduler.stop());
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(calls, 0);
  assert.equal(store.getTask(session, task.id).attemptCount, 0);
  assert.equal(store.getTask(session, task.id).lastRunAt, undefined);
  assert.ok(Date.parse(store.getTask(session, task.id).nextRunAt!) > Date.now() - 1000);
  assert.equal(store.events(session).filter((e) => e.type === 'task.skipped').length, 1);
  assert.deepEqual(pendingTaskDeliveries(store, session), []);
});
test('decades of cron debt merge to the latest minute once after busy ticks and rearm after finish', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2046-10-06T12:34:56Z') });
  const { root, store, session, due } = await setup(t);
  const task = store.createTask(session, {
    title: 'Latest',
    trigger: { kind: 'cron', enabled: true, expression: '* * * * *', timeZone: 'UTC' },
  });
  due(task.id, '2000-01-01T00:00:00.000Z');
  let idle = false;
  const runs: SchedulerRun[] = [];
  const scheduler = new TaskScheduler({
    store,
    workspace: root,
    canRun: () => idle,
    run: async (run) => {
      runs.push(run);
      t.mock.timers.setTime(new Date('2046-10-06T12:40:56Z').getTime());
    },
  });
  t.after(() => scheduler.stop());
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(store.events(session).filter((e) => e.type === 'task.due').length, 1);
  idle = true;
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.scheduledAt, '2046-10-06T12:34:00.000Z');
  assert.equal(store.getTask(session, task.id).nextRunAt, '2046-10-06T12:41:00.000Z');
  const receipts = store.events(session).filter((e) => e.type === 'task.admitted');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.data.dueAt, '2000-01-01T00:00:00.000Z');
  assert.equal(receipts[0]!.data.scheduledAt, '2046-10-06T12:34:00.000Z');
  assert.deepEqual(pendingTaskDeliveries(store, session), []);
});
test('explicit misfire applies to interval and calendars while legacy fields remain absent', () => {
  assert.deepEqual(normalizeTaskTrigger({ kind: 'interval', enabled: true, everyMinutes: 60 }), {
    kind: 'interval',
    enabled: true,
    everyMinutes: 60,
  });
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'daily', enabled: true, atMinutes: 0, misfire: 'replay' }),
    /misfire/i,
  );
  const interval = normalizeTaskTrigger({
    kind: 'interval',
    enabled: true,
    everyMinutes: 60,
    misfire: 'latest',
  })!;
  assert.equal(
    latestScheduledAt(interval, '2000-01-01T00:00:00.000Z', new Date('2046-10-06T12:34:56Z')),
    '2046-10-06T12:00:00.000Z',
  );
  const weekly = normalizeTaskTrigger({
    kind: 'weekly',
    enabled: true,
    atMinutes: 540,
    weekdays: [1],
    timeZone: 'Asia/Shanghai',
    misfire: 'latest',
  })!;
  assert.equal(
    latestScheduledAt(weekly, '2000-01-01T00:00:00.000Z', new Date('2026-10-06T12:00Z')),
    '2026-10-05T01:00:00.000Z',
  );
});
test('latest admission is atomic across cold connections and never resurrects a claimed run', async (t) => {
  const { root, file, store, session, due } = await setup(t);
  const task = store.createTask(session, {
    title: 'Cold',
    trigger: { kind: 'cron', enabled: true, expression: '* * * * *', timeZone: 'UTC' },
  });
  due(task.id, '2000-01-01T00:00:00.000Z');
  const stale = store.getTask(session, task.id);
  const second = new SessionStore(file);
  try {
    const instant = latestScheduledAt(stale.trigger!, stale.nextRunAt!, new Date());
    assert.equal(store.claimTaskSchedule(stale, 'cron', instant), true);
    assert.equal(second.claimTaskSchedule(stale, 'cron', instant), false);
  } finally {
    second.close();
  }
  const cold = new SessionStore(file);
  try {
    let calls = 0;
    const scheduler = new TaskScheduler({
      store: cold,
      workspace: root,
      canRun: () => true,
      run: async () => {
        calls++;
      },
    });
    await scheduler.tick();
    scheduler.stop();
    assert.equal(calls, 0);
    assert.match(cold.getTask(session, task.id).lastTriggerError!, /admitted/i);
    // A known checkpoint recovery belongs to the original delivery, not to the synthetic queue timestamp.
    cold.scheduleImmediateRun(
      session,
      task.id,
      'Host restarted mid-attempt; resuming from the last completed step.',
    );
    assert.equal(cold.claimTaskSchedule(cold.getTask(session, task.id), 'recovery'), true);
    assert.equal(cold.events(session).filter((e) => e.type === 'task.admitted').length, 1);
  } finally {
    cold.close();
  }
});
test('cron edits and deletion during an awaited earlier run reject captured obsolete candidates', async (t) => {
  const { root, store, session, due } = await setup(t);
  const tasks = [0, 1, 2].map((i) =>
    store.createTask(session, {
      title: `Cron ${i}`,
      trigger: { kind: 'cron', enabled: true, expression: '* * * * *', timeZone: 'UTC' },
    }),
  );
  tasks.forEach((task, i) => due(task.id, `2000-01-0${i + 1}T00:00:00.000Z`));
  const ids: string[] = [];
  const scheduler = new TaskScheduler({
    store,
    workspace: root,
    canRun: () => true,
    run: async (run) => {
      ids.push(run.task.id);
      store.updateTask(session, tasks[1]!.id, {
        trigger: { kind: 'cron', enabled: true, expression: '0 9 * * 1', timeZone: 'UTC' },
      });
      store.deleteTask(session, tasks[2]!.id);
    },
  });
  t.after(() => scheduler.stop());
  await scheduler.tick();
  assert.deepEqual(ids, [tasks[0]!.id]);
});

test('v26 checkpoint recovery retains the original periodic admission after migration', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cron-migrate-')),
    file = path.join(root, 'sessions.sqlite');
  let store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root).id;
  const task = store.createTask(session, {
    title: 'Legacy interval',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  store.scheduleImmediateRun(session, task.id);
  assert.equal(store.claimTaskSchedule(store.getTask(session, task.id), 'interval'), true);
  store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec('ALTER TABLE tasks DROP COLUMN current_delivery_id');
    db.exec('PRAGMA user_version=26');
  } finally {
    db.close();
  }
  store = new SessionStore(file);
  store.scheduleImmediateRun(
    session,
    task.id,
    'Host restarted mid-attempt; resuming from the last completed step.',
  );
  assert.equal(store.claimTaskSchedule(store.getTask(session, task.id), 'recovery'), true);
  assert.equal(store.events(session).filter((e) => e.type === 'task.admitted').length, 1);
});
