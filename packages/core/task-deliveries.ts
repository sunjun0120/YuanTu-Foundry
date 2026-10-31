import type { SessionStore } from '../storage/sqlite.ts';

/**
 * The moments a schedule named while the Host could not start the run. A busy Host leaves the task
 * due; the `task.due` record, written at the scheduled moment, is what tells "the Host was busy"
 * apart from downtime or edits.
 *
 * One record per session per scheduler look, covering every task owed then. A delivery stays owed
 * until every task it names has run since it was due, computed from the task rows, so nothing has
 * to settle it.
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
 * Record a delivery unless the same moment and task set is already recorded; returns whether
 * anything was written.
 */
export function recordTaskDelivery(
  store: SessionStore,
  sessionId: string,
  delivery: TaskDelivery,
): boolean {
  /**
   * Look tasks up from the list, so a task deleted since the tick does not lose the whole group's
   * record.
   */
  const known = new Map(store.listTasks(sessionId).map((task) => [task.id, task]));
  const savedTasks = delivery.tasks.map((task) => {
    const current = known.get(task.id);
    return {
      ...task,
      ruleRevision: task.ruleRevision ?? current?.triggerRevision ?? 'legacy',
      scheduledAt: task.scheduledAt ?? current?.nextRunAt ?? delivery.dueAt,
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
 * Deliveries this session still owes, oldest first: owed while any named task has not run since the
 * due moment. Cancelled or deleted tasks stop owing.
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
