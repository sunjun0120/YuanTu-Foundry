import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { normalizeTaskTrigger, nextRunAt } from '../packages/core/task-trigger.ts';
import { TaskScheduler } from '../apps/agent-host/scheduler.ts';
import { recordTaskDelivery, pendingTaskDeliveries } from '../packages/core/task-deliveries.ts';
import { parseCarrierCommand } from '../packages/carrier/contract.ts';

test('Carrier validates delays without manufacturing a new save anchor', () => {
  const command = parseCarrierCommand({
    type: 'taskTrigger',
    taskId: 'task',
    trigger: { kind: 'after', enabled: true, afterMinutes: 120 },
  });
  assert.deepEqual(command, {
    type: 'taskTrigger',
    taskId: 'task',
    trigger: { kind: 'after', enabled: true, afterMinutes: 120 },
  });
});

test('calendar trigger validation preserves legacy daily while accepting explicit daily and weekly zones', () => {
  assert.deepEqual(normalizeTaskTrigger({ kind: 'daily', enabled: true, atMinutes: 540 }), {
    kind: 'daily',
    enabled: true,
    atMinutes: 540,
  });
  const weekly = normalizeTaskTrigger({
    kind: 'weekly',
    enabled: true,
    atMinutes: 540,
    weekdays: [5, 1, 1],
    timeZone: 'America/New_York',
  })!;
  assert.equal(nextRunAt(weekly, new Date('2026-10-05T01:00:00Z')), '2026-10-05T13:00:00.000Z');
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'at', enabled: true, at: '2026-02-30T12:00:00Z' }),
    /date|timestamp/i,
  );
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'at', enabled: true, at: '2026-10-07T12:00:00' }),
    /offset|timestamp/i,
  );
  assert.throws(
    () =>
      normalizeTaskTrigger({
        kind: 'weekly',
        enabled: true,
        atMinutes: 540,
        weekdays: [],
        timeZone: 'UTC',
      }),
    /weekday/i,
  );
});

test('after arms once at save and unchanged settings do not refill a consumed one-shot rule', async () => {
  const store = new SessionStore(':memory:');
  try {
    const session = store.create(process.cwd()).id;
    const task = store.createTask(session, {
      title: 'Once',
      trigger: { kind: 'after', enabled: true, afterMinutes: 1 },
    } as never);
    const first = task.nextRunAt;
    assert.ok(first);
    assert.equal(
      store.updateTask(session, task.id, {
        trigger: { kind: 'after', enabled: true, afterMinutes: 1 },
      } as never).nextRunAt,
      first,
    );
    store.scheduleImmediateRun(session, task.id);
    let runs = 0;
    const scheduler = new TaskScheduler({
      store,
      workspace: process.cwd(),
      canRun: () => true,
      run: async () => {
        runs++;
      },
    });
    await scheduler.tick();
    await scheduler.tick();
    scheduler.stop();
    assert.equal(runs, 1);
    assert.equal(store.getTask(session, task.id).nextRunAt, undefined);
    assert.equal(
      store.updateTask(session, task.id, {
        trigger: { kind: 'after', enabled: true, afterMinutes: 1 },
      } as never).nextRunAt,
      undefined,
    );
    store.updateTask(session, task.id, {
      trigger: { kind: 'after', enabled: false, afterMinutes: 1 },
    } as never);
    assert.ok(
      store.updateTask(session, task.id, {
        trigger: { kind: 'after', enabled: true, afterMinutes: 1 },
      } as never).nextRunAt,
    );
  } finally {
    store.close();
  }
});

test('editing a waiting rule retires its delivery and old completion cannot overwrite the new calendar', async () => {
  const store = new SessionStore(':memory:');
  try {
    const session = store.create(process.cwd()).id;
    const original = store.createTask(session, {
      title: 'Edit',
      trigger: { kind: 'interval', enabled: true, everyMinutes: 10 },
    });
    store.scheduleImmediateRun(session, original.id);
    const due = store.getTask(session, original.id);
    recordTaskDelivery(store, session, {
      dueAt: due.nextRunAt!,
      reason: 'busy',
      tasks: [{ id: due.id, title: due.title }],
      recordedAt: new Date().toISOString(),
    });
    let next: string | undefined;
    const scheduler = new TaskScheduler({
      store,
      workspace: process.cwd(),
      canRun: () => true,
      run: async () => {
        const updated = store.updateTask(session, due.id, {
          trigger: {
            kind: 'weekly',
            enabled: true,
            atMinutes: 540,
            weekdays: [1],
            timeZone: 'UTC',
          },
        } as never);
        next = updated.nextRunAt;
      },
    });
    await scheduler.tick();
    scheduler.stop();
    assert.equal(store.getTask(session, due.id).nextRunAt, next);
    assert.deepEqual(pendingTaskDeliveries(store, session), []);
  } finally {
    store.close();
  }
});

test('two schedulers cannot concurrently admit the same one-shot clock obligation', async () => {
  const store = new SessionStore(':memory:');
  try {
    const session = store.create(process.cwd()).id;
    const task = store.createTask(session, {
      title: 'Once',
      trigger: { kind: 'at', enabled: true, at: '2020-01-01T00:00:00Z' },
    } as never);
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    let runs = 0;
    const options = {
      store,
      workspace: process.cwd(),
      canRun: () => true,
      run: async () => {
        runs++;
        await wait;
      },
    };
    const first = new TaskScheduler(options),
      second = new TaskScheduler(options);
    const running = first.tick();
    await second.tick();
    release();
    await running;
    first.stop();
    second.stop();
    assert.equal(runs, 1);
    assert.equal(store.getTask(session, task.id).nextRunAt, undefined);
  } finally {
    store.close();
  }
});

test('editing or deleting the second due task during the first run rejects the captured stale candidate', async () => {
  const store = new SessionStore(':memory:');
  try {
    const session = store.create(process.cwd()).id;
    const first = store.createTask(session, {
      title: 'First',
      trigger: { kind: 'at', enabled: true, at: '2020-01-01T00:00:00Z' },
    } as never);
    const second = store.createTask(session, {
      title: 'Second',
      trigger: { kind: 'at', enabled: true, at: '2020-01-02T00:00:00Z' },
    } as never);
    const ids: string[] = [];
    const scheduler = new TaskScheduler({
      store,
      workspace: process.cwd(),
      canRun: () => true,
      run: async (run) => {
        ids.push(run.task.id);
        if (run.task.id === first.id) store.updateTask(session, second.id, { trigger: null });
      },
    });
    await scheduler.tick();
    scheduler.stop();
    assert.deepEqual(ids, [first.id]);
  } finally {
    store.close();
  }
});

test('cold stores preserve delay anchors and atomic admission prevents another connection claiming the same result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-calendar-'));
  const file = path.join(root, 'sessions.sqlite');
  let store = new SessionStore(file),
    other: SessionStore | undefined;
  try {
    const session = store.create(root).id;
    const task = store.createTask(session, {
      title: 'Persist',
      trigger: { kind: 'after', enabled: true, afterMinutes: 60 },
    });
    store.close();
    store = new SessionStore(file);
    assert.equal(store.getTask(session, task.id).nextRunAt, task.nextRunAt);
    assert.deepEqual(store.getTask(session, task.id).trigger, task.trigger);
    store.scheduleImmediateRun(session, task.id);
    other = new SessionStore(file);
    const first = store.getTask(session, task.id),
      second = other.getTask(session, task.id);
    assert.equal(store.claimTaskSchedule(first, 'after'), true);
    assert.equal(other.claimTaskSchedule(second, 'after'), false);
    other.close();
    other = undefined;
    store.close();
    store = new SessionStore(file);
    assert.equal(store.getTask(session, task.id).nextRunAt, undefined);
    assert.match(store.getTask(session, task.id).lastTriggerError!, /completion has not yet/);
  } finally {
    other?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
