/**
 * The record of a scheduled moment that arrived while the Host could not start the run.
 *
 * A due task waits for the Host, not for the clock: `canRun` is false while another run is in flight, and the
 * task stays due — late rather than lost. What these tests hold is the part that used to be silent: the wait is
 * written down when the schedule named it, one line per session and due moment (several tasks firing together are
 * one delivery, not one each), and it stops being owed when the tasks have actually run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { pendingTaskDeliveries, recordTaskDelivery } from '../packages/core/task-deliveries.ts';
import { TaskScheduler } from '../apps/agent-host/scheduler.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-delivery-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}
/** A task that is due now: the interval trigger arms it in the future, so the moment is pulled forward. */
function dueNow(store: SessionStore, root: string, title: string, sessionId?: string) {
  const session = sessionId ?? store.create(root).id;
  const task = store.createTask(session, {
    title,
    steps: [{ description: 'work', status: 'pending' }],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 30 },
  });
  store.scheduleImmediateRun(session, task.id);
  return { sessionId: session, task: store.getTask(session, task.id) };
}
const recorded = (store: SessionStore, sessionId: string) =>
  store.events(sessionId).filter((event) => event.type === 'task.due');

test('a delivery is owed until every task in it has run', async (t) => {
  const { root, store } = await fixture(t);
  const { sessionId, task } = dueNow(store, root, 'Nightly');
  const dueAt = task.nextRunAt!;
  assert.equal(
    recordTaskDelivery(store, sessionId, {
      dueAt,
      reason: 'busy',
      tasks: [{ id: task.id, title: task.title }],
      recordedAt: new Date().toISOString(),
    }),
    true,
  );
  assert.deepEqual(
    pendingTaskDeliveries(store, sessionId).map((delivery) => delivery.dueAt),
    [dueAt],
  );
  // The run that eventually happened settles it by moving the row's own `lastRunAt` past the moment — nothing
  // has to remember to clear a record.
  store.recordTaskRun(sessionId, task.id, {
    at: new Date(Date.parse(dueAt) + 1_000).toISOString(),
  });
  assert.deepEqual(pendingTaskDeliveries(store, sessionId), []);
});

test('a busy Host writes one line per session and look, and only one', async (t) => {
  const { root, store } = await fixture(t);
  const sessionId = store.create(root).id;
  const first = store.createTask(sessionId, {
    title: 'Build',
    steps: [{ description: 'one', status: 'pending' }],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 30 },
  });
  const second = store.createTask(sessionId, {
    title: 'Report',
    steps: [{ description: 'two', status: 'pending' }],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 30 },
  });
  store.scheduleImmediateRun(sessionId, first.id);
  store.scheduleImmediateRun(sessionId, second.id);
  /**
   * Which of the two is the older obligation depends on two clock reads a fraction of a millisecond apart, so it
   * is computed here rather than assumed — and nothing below asserts an order *between* the tasks either. What
   * this test is about is the merge; the queue's own discipline (oldest first, stable by id) belongs to `dueTasks`
   * and is pinned by its own test. A loaded full-suite run is exactly where an assumed order would break.
   */
  const oldest = [first.id, second.id]
    .map((id) => store.getTask(sessionId, id).nextRunAt!)
    .sort()[0]!;

  const scheduler = new TaskScheduler({
    store,
    workspace: root,
    // The Host is busy: nothing can start, and the wait is what has to be recorded.
    canRun: () => false,
    run: async () => undefined,
  });
  t.after(() => scheduler.stop());
  assert.deepEqual(await scheduler.tick(), []);
  const lines = recorded(store, sessionId);
  assert.equal(lines.length, 1, `one line for the pair: ${JSON.stringify(lines)}`);
  const delivery = pendingTaskDeliveries(store, sessionId);
  assert.equal(delivery.length, 1);
  assert.deepEqual(delivery[0]!.tasks.map((entry) => entry.title).sort(), ['Build', 'Report']);
  assert.equal(delivery[0]!.reason, 'busy');
  assert.equal(delivery[0]!.dueAt, oldest, 'the oldest obligation is the moment it names');

  // Another tick of a still-busy Host adds nothing: one delivery per look, not one per look *and* task.
  assert.deepEqual(await scheduler.tick(), []);
  assert.equal(recorded(store, sessionId).length, 1);

  // A third task joining the queue is a *different* delivery, because the set of owed work changed.
  const late = store.createTask(sessionId, {
    title: 'Joined later',
    steps: [{ description: 'three', status: 'pending' }],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 30 },
  });
  store.scheduleImmediateRun(sessionId, late.id);
  await scheduler.tick();
  assert.equal(recorded(store, sessionId).length, 2);
});

test('two sessions firing together are two deliveries, and a free Host owes nothing', async (t) => {
  const { root, store } = await fixture(t);
  const left = dueNow(store, root, 'Left');
  const right = dueNow(store, root, 'Right');
  assert.notEqual(left.sessionId, right.sessionId);

  let free = false;
  const scheduler = new TaskScheduler({
    store,
    workspace: root,
    canRun: () => free,
    run: async (run) => {
      // The run happened: record it exactly as the scheduler's own `finally` does.
      store.recordTaskRun(run.task.sessionId, run.task.id, { at: new Date().toISOString() });
      return { status: 'completed' as const };
    },
  });
  t.after(() => scheduler.stop());

  await scheduler.tick();
  assert.equal(recorded(store, left.sessionId).length, 1);
  assert.equal(recorded(store, right.sessionId).length, 1);
  assert.equal(pendingTaskDeliveries(store, left.sessionId).length, 1);

  // Once the Host is free the same due work runs, and the delivery is settled by the run itself.
  free = true;
  const started = await scheduler.tick();
  assert.deepEqual(started.map((run) => run.task.title).sort(), ['Left', 'Right']);
  assert.deepEqual(pendingTaskDeliveries(store, left.sessionId), []);
  assert.deepEqual(pendingTaskDeliveries(store, right.sessionId), []);
});
