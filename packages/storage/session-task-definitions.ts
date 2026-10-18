import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { normalizeTaskDraft } from '../protocol/task-spec.ts';
import { normalizeTaskTrigger, oneShot } from '../protocol/task-trigger.ts';
import type { Task, TaskStatus } from '../protocol/index.ts';
import type { Session, TaskCreate, TaskUpdate } from './session-schema.ts';
import {
  assertTaskTransition,
  nextTaskTimestamp,
  scheduledNextRunAt,
  TASK_SELECT,
  taskFromRow,
  taskStatuses,
  validateAcceptance,
  validateSteps,
  validateTaskText,
} from './session-schema.ts';

/** Task definitions and schedule revisions. Execution attempts remain in TaskJournal. */
export interface SessionTaskDefinitionsPort {
  db: DatabaseSync;
  get(id: string): Session;
  transaction<T>(fn: () => T): T;
}

export class SessionTaskDefinitions {
  private readonly port: SessionTaskDefinitionsPort;

  constructor(port: SessionTaskDefinitionsPort) {
    this.port = port;
  }

  createTask(sessionId: string, input: TaskCreate): Task {
    this.port.get(sessionId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = validateTaskText(input.title, 'title', 200);
    const description = validateTaskText(input.description ?? '', 'description', 20_000, true);
    const acceptance = validateAcceptance(input.acceptance ?? []).map((item) => ({
      ...item,
      met: false,
    }));
    const steps = validateSteps(input.steps ?? []).map((item) => ({
      ...item,
      status: 'pending' as const,
    }));
    const trigger = normalizeTaskTrigger(input.trigger);
    this.port.db
      .prepare(
        "INSERT INTO tasks(id,session_id,title,description,status,acceptance,steps,trigger,trigger_revision,next_run_at,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?,?,?,?,?)",
      )
      .run(
        id,
        sessionId,
        title,
        description,
        JSON.stringify(acceptance),
        JSON.stringify(steps),
        trigger ? JSON.stringify(trigger) : null,
        trigger ? randomUUID() : null,
        scheduledNextRunAt(trigger, new Date()),
        now,
        now,
      );
    return this.getTask(sessionId, id);
  }

  getTask(sessionId: string, id: string): Task {
    this.port.get(sessionId);
    const row = this.port.db
      .prepare(`${TASK_SELECT} WHERE t.session_id=? AND t.id=?`)
      .get(sessionId, id);
    if (!row) throw new Error(`Task not found: ${id}`);
    return taskFromRow(row);
  }

  listTasks(sessionId: string, status?: TaskStatus): Task[] {
    this.port.get(sessionId);
    if (status !== undefined && !taskStatuses.has(status)) throw new Error('Invalid task status');
    return this.port.db
      .prepare(
        `${TASK_SELECT} WHERE t.session_id=? AND (? IS NULL OR t.status=?) ORDER BY t.created_at,t.id`,
      )
      .all(sessionId, status ?? null, status ?? null)
      .map((row) => taskFromRow(row));
  }

  /**
   * Every task that carries a trigger, across all sessions in one workspace. The scheduler needs
   * one query rather than a per-session fan-out because a trigger belongs to the task, not to
   * whichever session happens to be open.
   */
  listScheduledTasks(workspace?: string): Task[] {
    return this.port.db
      .prepare(
        `${TASK_SELECT} WHERE t.trigger IS NOT NULL AND (? IS NULL OR t.session_id IN (SELECT id FROM sessions WHERE workspace=?)) ORDER BY t.next_run_at IS NULL,t.next_run_at,t.id`,
      )
      .all(workspace ?? null, workspace ?? null)
      .map((row) => taskFromRow(row));
  }

  updateTask(sessionId: string, id: string, update: TaskUpdate): Task {
    return this.port.transaction(() => {
      const current = this.getTask(sessionId, id);
      const keys = Object.keys(update);
      if (
        !keys.length ||
        keys.some(
          (key) =>
            !['title', 'description', 'status', 'acceptance', 'steps', 'trigger'].includes(key),
        )
      )
        throw new Error('Invalid task update');
      const title =
        update.title === undefined ? current.title : validateTaskText(update.title, 'title', 200);
      const description =
        update.description === undefined
          ? current.description
          : validateTaskText(update.description, 'description', 20_000, true);
      const status = update.status ?? current.status;
      if (!taskStatuses.has(status)) throw new Error('Invalid task status');
      if (update.status !== undefined) assertTaskTransition(current.status, status);
      const acceptance =
        update.acceptance === undefined
          ? current.acceptance
          : validateAcceptance(update.acceptance);
      const steps = update.steps === undefined ? current.steps : validateSteps(update.steps);
      // Re-arm the clock whenever the trigger changes: a new interval must not inherit the old
      // schedule, and clearing a trigger must clear its pending obligation.
      let rawTrigger: unknown = update.trigger;
      if (current.trigger?.kind === 'after' && rawTrigger && typeof rawTrigger === 'object') {
        const candidate = rawTrigger as Record<string, unknown>;
        if (
          candidate.kind === 'after' &&
          candidate.afterMinutes === current.trigger.afterMinutes &&
          candidate.enabled === current.trigger.enabled &&
          candidate.anchorAt === undefined
        )
          rawTrigger = { ...candidate, anchorAt: current.trigger.anchorAt };
      }
      const trigger =
        update.trigger === undefined ? current.trigger : normalizeTaskTrigger(rawTrigger);
      const changed =
        update.trigger !== undefined &&
        (!oneShot(current.trigger) || !isDeepStrictEqual(trigger, current.trigger));
      const nextAt = !changed
        ? (current.nextRunAt ?? null)
        : scheduledNextRunAt(trigger, new Date());
      this.port.db
        .prepare(
          'UPDATE tasks SET title=?,description=?,status=?,acceptance=?,steps=?,trigger=?,trigger_revision=?,next_run_at=?,last_trigger_error=?,updated_at=? WHERE session_id=? AND id=?',
        )
        .run(
          title,
          description,
          status,
          JSON.stringify(acceptance),
          JSON.stringify(steps),
          trigger ? JSON.stringify(trigger) : null,
          changed ? randomUUID() : (current.triggerRevision ?? null),
          nextAt,
          !changed ? (current.lastTriggerError ?? null) : null,
          new Date().toISOString(),
          sessionId,
          id,
        );
      if (changed) {
        this.port.db.prepare('DELETE FROM task_approvals WHERE task_id=?').run(id);
        this.port.db.prepare('UPDATE tasks SET current_delivery_id=NULL WHERE id=?').run(id);
      }
      return this.getTask(sessionId, id);
    });
  }

  replaceTaskDefinition(
    sessionId: string,
    id: string,
    input: unknown,
    expectedUpdatedAt?: string,
  ): Task {
    return this.port.transaction(() => {
      const task = this.getTask(sessionId, id);
      if (task.status === 'in_progress') throw new Error('Task is running');
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== task.updatedAt)
        throw new Error('Task changed; reload before saving');
      const draft = normalizeTaskDraft(input);
      const now = nextTaskTimestamp(task.updatedAt);
      this.port.db
        .prepare(
          "UPDATE tasks SET title=?,description=?,status='pending',acceptance=?,steps=?,verification=NULL,definition_attempt_floor=(SELECT COALESCE(MAX(ordinal),0) FROM task_attempts WHERE task_id=tasks.id),updated_at=? WHERE session_id=? AND id=?",
        )
        .run(
          draft.title,
          draft.description,
          JSON.stringify(draft.acceptance),
          JSON.stringify(draft.steps),
          now,
          sessionId,
          id,
        );
      // Step indexes only mean something relative to the definition they were recorded against,
      // so an edited task starts its checkpoint history over rather than inheriting stale progress.
      this.port.db.prepare('DELETE FROM task_step_checkpoints WHERE task_id=?').run(id);
      this.port.db.prepare('DELETE FROM task_approvals WHERE task_id=?').run(id);
      return this.getTask(sessionId, id);
    });
  }
}
