import { commandRecords } from '../../packages/core/command-jobs.ts';
import { pendingTaskDeliveries } from '../../packages/core/task-deliveries.ts';
import type { BackgroundJobSnapshot } from '../../packages/protocol/rpc.ts';
import type { Task } from '../../packages/protocol/index.ts';
import type { SessionStore } from '../../packages/storage/sqlite.ts';
import type { TaskEvent } from '../../packages/core/task-trigger.ts';
import { resolveWorkspace, safeError } from '../shared/runtime.ts';
import type { TaskScheduler } from './scheduler.ts';

/**
 * The request-shape and session-ownership rules every handler shares.
 *
 * These are the parts of the protocol that are about the *request* rather than about the method it names: a
 * parameter that must be a nonempty string, a session that must belong to the workspace this Host owns, and the
 * durable background records a polling client reads. They live together because each of them is a rule the
 * dispatcher would otherwise have to restate in fifty places, and a rule restated per case is a rule that drifts
 * per case.
 */

/** A required string parameter, refused when absent or blank rather than coerced to something plausible. */
export const required = (params: Record<string, unknown>, key: string): string => {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${key}`);
  return value;
};

/**
 * The session with this id, refused unless it belongs to this Host's workspace.
 *
 * One Host serves one workspace, so a session resolved from *any* other root is a request the caller has no
 * authority over; both a missing root and a different one are the same refusal, because the caller learns nothing
 * useful from being told which of the two it was.
 */
export const ownedSession = (store: SessionStore, workspace: string, sessionId: string) => {
  const session = store.get(sessionId);
  let owner: string;
  try {
    owner = resolveWorkspace(session.workspace);
  } catch {
    throw new Error('Session belongs to a different workspace');
  }
  if (owner !== workspace) throw new Error('Session belongs to a different workspace');
  return session;
};

/**
 * The background jobs a client can still read, including the ones whose producer this process never owned.
 *
 * A crash takes the in-memory job with it, but not the records of what it produced, so a reconnecting client is
 * answered from the durable log instead of being told its job does not exist. `background.hidden` is how a client
 * says "I have read these" without deleting the evidence behind them.
 */
export const durableBackground = (
  store: SessionStore,
  sessionId: string,
  id?: string,
  cursor = 0,
): BackgroundJobSnapshot[] => {
  const hidden = new Set(
    store
      .events(sessionId)
      .filter((e) => e.type === 'background.hidden')
      .flatMap((e) => (e.data.ids as string[]) ?? []),
  );
  return [...commandRecords(store, sessionId).values()]
    .filter((r) => r.status && (id ? r.id === id : !hidden.has(r.id)))
    .map((r) => {
      if (cursor > r.outputChars) throw Error('Invalid output cursor');
      const offset = Math.max(0, r.outputChars - r.output.length),
        start = Math.max(cursor, offset);
      return {
        id: r.id,
        sessionId,
        command: r.command,
        cwd: r.cwd,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        status: r.status!,
        exitCode: r.exitCode ?? null,
        output: r.output.slice(start - offset),
        nextCursor: r.outputChars,
        truncated: cursor < offset,
      };
    });
};

/**
 * The tasks as a client reads them, with the schedule's unhappy half filled in.
 *
 * `waiting` is not on the row: the record is a `task.due` event written when the Host was too busy to start the
 * moment the schedule named (`packages/core/task-deliveries.ts`), and it stops being owed the moment that task
 * runs. Decorating here rather than storing it keeps one answer to "is this late?" — the row's own `lastRunAt`
 * is what settles it, and a copy on the task would be a second truth about the same fact.
 */
export const withWaiting = (store: SessionStore, sessionId: string, tasks: Task[]): Task[] => {
  const pending = pendingTaskDeliveries(store, sessionId);
  if (!pending.length) return tasks;
  return tasks.map((task) => {
    const owed = pending.find((delivery) => delivery.tasks.some((named) => named.id === task.id));
    return owed ? { ...task, waiting: { since: owed.dueAt, reason: owed.reason } } : task;
  });
};

/**
 * Scheduling observes runs; it must never control or crash them. `notify` can reject before its
 * own guards run — for example when listing scheduled tasks throws on a busy database — and a
 * bare `void scheduler.notify(...)` turns that into an unhandled rejection, which terminates the
 * Host process and reaches the user as an unexplained crash.
 */
export const createSchedulerNotifier =
  (scheduler: TaskScheduler) =>
  (event: TaskEvent): void => {
    void scheduler.notify(event).catch((error) => {
      process.stderr.write(`scheduler notify failed: ${safeError(error)}\n`);
    });
  };
