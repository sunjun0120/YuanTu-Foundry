import type { SessionStore } from '../storage/sqlite.ts';

/**
 * The moments a schedule named while the Host could not start the run.
 *
 * A due task waits for the Host rather than for the clock: `canRun` says whether another run is in flight, and a
 * busy Host leaves the task due, which is late rather than lost. What was missing is the *record* of that wait —
 * the row keeps saying "due", the clock re-arms, and the only trace of the delay is a `last_run_at` later than the
 * schedule named, which cannot tell "the Host was busy" apart from "the process was down" or "somebody edited the
 * task". That is what `task.due` is for, and why it is written at the moment the schedule named rather than when
 * the run finally starts.
 *
 * One record per *session and look*: every task that session was owed when the scheduler looked is one delivery
 * rather than one per task, which is the merge the snapshot's §4.5 asks for. Keying on the exact scheduled instant
 * instead would almost never merge anything — two interval tasks armed minutes apart rarely name the same
 * millisecond — while the situation the merge is for ("this session had work due and the Host was busy") is
 * exactly what a look sees. Two sessions owed at the same moment are still two records, because a delivery is per
 * session.
 *
 * The projection below is what "still waiting" means, and it is deliberately computed against the task rows
 * rather than against a second event: a delivery is owed until every task it names has actually run since the
 * moment it was due. Nothing has to remember to settle it.
 */
export interface TaskDelivery {
  /** The oldest scheduled moment this delivery covers; with the task set, its identity within a session. */
  dueAt: string;
  /** Why the Host could not start it then, in the words the scheduler decided it in. */
  reason: string;
  /** The tasks that were owed, oldest obligation first. */
  tasks: { id: string; title: string; ruleRevision?: string; scheduledAt?: string }[];
  /** When the scheduler noticed and wrote it — at or after `dueAt`, and usually the same tick. */
  recordedAt: string;
}

/** Delivery reasons, closed so a reader can decide on them rather than pattern-match prose. */
export const TASK_DELIVERY_REASONS = ['busy', 'closed'] as const;
export type TaskDeliveryReason = (typeof TASK_DELIVERY_REASONS)[number];

/**
 * Record a delivery, unless the same one is already recorded, and say whether anything was written.
 *
 * Deduplication is by due moment and by the set of tasks in it: a busy Host ticks again and again, and one line
 * per tick would turn "this was late" into noise that buries it. The set matters as well as the moment — a task
 * added to the same instant afterwards is a different delivery, and it is recorded as one.
 */
export function recordTaskDelivery(
  store: SessionStore,
  sessionId: string,
  delivery: TaskDelivery,
): boolean {
  const savedTasks = delivery.tasks.map((task) => {
    const current = store.getTask(sessionId, task.id);
    return {
      ...task,
      ruleRevision: task.ruleRevision ?? current.triggerRevision ?? 'legacy',
      scheduledAt: task.scheduledAt ?? current.nextRunAt ?? delivery.dueAt,
    };
  });
  const identity = (task: TaskDelivery['tasks'][number]) =>
    `${task.id}:${task.ruleRevision ?? 'legacy'}:${task.scheduledAt ?? delivery.dueAt}`;
  const tasks = [...new Set(savedTasks.map(identity))].sort();
  // Defensive about the shape rather than trusting the caller: an undefined moment would otherwise throw inside a
  // scheduler tick, and "record nothing" is the right answer for a delivery that is not describable.
  if (
    !tasks.length ||
    typeof delivery.dueAt !== 'string' ||
    !delivery.dueAt.trim() ||
    typeof delivery.reason !== 'string' ||
    !delivery.reason.trim()
  )
    return false;
  const already = store
    .events(sessionId)
    .filter((event) => event.type === 'task.due')
    .some((event) => {
      const recorded = deliveryFrom(event.data);
      if (!recorded || recorded.dueAt !== delivery.dueAt) return false;
      const ids = [...new Set(recorded.tasks.map(identity))].sort();
      return ids.length === tasks.length && ids.every((id, index) => id === tasks[index]);
    });
  if (already) return false;
  store.recordEvent(sessionId, 'task.due', {
    dueAt: delivery.dueAt,
    reason: delivery.reason,
    tasks: savedTasks,
    recordedAt: delivery.recordedAt,
  });
  return true;
}

/**
 * The deliveries this session is still waiting for, oldest first.
 *
 * A delivery is owed while at least one task it names has not run since the moment it was due — the row's own
 * `lastRunAt` answers that, so a run that happened (whenever it happened) settles the delivery without anything
 * having to write a second record. A task that was cancelled, or deleted, stops owing: there is nothing left to
 * deliver, and keeping it in the list would make the queue grow forever on a session that changed its mind.
 */
export function pendingTaskDeliveries(store: SessionStore, sessionId: string): TaskDelivery[] {
  const tasks = new Map(store.listTasks(sessionId).map((task) => [task.id, task]));
  const pending: TaskDelivery[] = [];
  const events = store.events(sessionId);
  const admitted = new Set(
    events
      .filter((e) => e.type === 'task.admitted' || e.type === 'task.skipped')
      .map((e) => `${e.data.taskId}:${e.data.ruleRevision}:${e.data.dueAt}`),
  );
  for (const event of events) {
    if (event.type !== 'task.due') continue;
    const delivery = deliveryFrom(event.data);
    if (!delivery) continue;
    const owed = delivery.tasks.some((named) => {
      const task = tasks.get(named.id);
      if (!task || task.status === 'cancelled') return false;
      if (
        !task.trigger?.enabled ||
        (named.ruleRevision ?? 'legacy') !== (task.triggerRevision ?? 'legacy') ||
        admitted.has(
          `${named.id}:${named.ruleRevision ?? 'legacy'}:${named.scheduledAt ?? delivery.dueAt}`,
        )
      )
        return false;
      if (!task.lastRunAt) return true;
      return Date.parse(task.lastRunAt) < Date.parse(delivery.dueAt);
    });
    if (owed) pending.push(delivery);
  }
  return pending.sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
}

/** One recorded delivery, or `undefined` when the record is not one this module can read. */
function deliveryFrom(data: Record<string, unknown>): TaskDelivery | undefined {
  const dueAt = typeof data.dueAt === 'string' ? data.dueAt : '';
  const reason = typeof data.reason === 'string' ? data.reason : '';
  const recordedAt = typeof data.recordedAt === 'string' ? data.recordedAt : '';
  if (!dueAt || !reason || !recordedAt || !Array.isArray(data.tasks)) return undefined;
  const tasks: TaskDelivery['tasks'] = [];
  for (const entry of data.tasks) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String((entry as { id?: unknown }).id ?? '');
    if (!id) continue;
    const named = entry as Record<string, unknown>;
    tasks.push({
      id,
      title: String(named.title ?? ''),
      ...(typeof named.ruleRevision === 'string' ? { ruleRevision: named.ruleRevision } : {}),
      ...(typeof named.scheduledAt === 'string' ? { scheduledAt: named.scheduledAt } : {}),
    });
  }
  return tasks.length ? { dueAt, reason, tasks, recordedAt } : undefined;
}
