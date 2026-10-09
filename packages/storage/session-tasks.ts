import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  Acceptance,
  Approval,
  Task,
  TaskAttempt,
  TaskAttemptKind,
  TaskStatus,
  TaskStep,
  TaskStepCheckpoint,
  TaskStepStatus,
  TaskTrigger,
  TaskTriggerSource,
} from '../protocol/index.ts';
import {
  TASK_APPROVAL_OUTCOME_UNKNOWN,
  TASK_ATTEMPT_SELECT,
  TASK_EFFECT_OUTCOME_UNKNOWN,
  TASK_SELECT,
  assertTaskTransition,
  completedStepIndexesFor,
  deadOwner,
  nextTaskTimestamp,
  resumeSteps,
  sameApprovalDescription,
  scheduledNextRunAt,
  stepStatusMap,
  taskAttemptFromRow,
  taskFromRow,
  taskStepStatuses,
  validateAcceptance,
  validateSteps,
  validateTaskText,
} from './session-schema.ts';
import { misfirePolicy, nextRunAt as nextRunAtValue, oneShot } from '../core/task-trigger.ts';
import type { SessionEventType } from './events.ts';

/**
 * The task execution journal: what a task's attempts, steps, effects and schedule admission are recorded as.
 *
 * Split out of `SessionStore` because it is a *journal* rather than storage plumbing: the session store owns the
 * connection, the log cache, the projections and the migrations, while everything here answers "what happened
 * when this task ran, and what may it do next". The two meet at one narrow port — the connection, the
 * transaction wrapper it borrows, `getTask`, `getTaskAttempt`, `hasPendingTaskEffects`, `settleAbandonedRun`
 * and `recordEvent` — which is exactly the set of members the moved code uses (measured, not assumed).
 *
 * Three rules in here are load-bearing and were carried over verbatim:
 *
 * - **An effect is recorded before it can happen.** `beginTaskEffect` writes the ledger row first, so a task whose
 *   process dies mid-operation is left reporting "outcome unknown" rather than being rearmed over work that may
 *   already have landed.
 * - **A schedule obligation is claimed with a compare-and-set.** `claimTaskSchedule` reserves the delivery in one
 *   write transaction across Host processes, and a receipt already in the log makes a second admission a no-op.
 * - **Recovery converges rather than guesses.** `recoverInterruptedTasks` and `reconcileChildRuns` only touch rows
 *   whose owning process is *gone*; a live owner means the work is still running.
 */
export interface TaskJournalPort {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  getTask(sessionId: string, id: string): Task;
  getTaskAttempt(sessionId: string, taskId: string, attemptId: string): TaskAttempt;
  hasPendingTaskEffects(sessionId: string, taskId: string, attemptId?: string): boolean;
  settleAbandonedRun(sessionId: string, runId: string, reason: string): void;
  recordEvent(
    id: string,
    type: SessionEventType,
    data: Record<string, unknown>,
    stored?: Record<string, unknown>,
  ): void;
}

/** Everything a task's own lifecycle needs from the journal; `SessionStore` forwards to this. */
export class TaskJournal {
  private readonly port: TaskJournalPort;

  constructor(port: TaskJournalPort) {
    this.port = port;
  }

  startTaskAttempt(
    sessionId: string,
    taskId: string,
    input: {
      kind: TaskAttemptKind;
      runId?: string;
      prompt?: string;
      baselines?: Record<string, unknown>;
      trigger?: TaskTriggerSource;
      resume?: boolean;
    },
  ): TaskAttempt {
    if (input.kind !== 'run' && input.kind !== 'verify' && input.kind !== 'review')
      throw new Error('Invalid task attempt kind');
    const source = input.trigger ?? 'manual';
    if (
      ![
        'manual',
        'interval',
        'daily',
        'event',
        'recovery',
        'at',
        'after',
        'weekly',
        'cron',
      ].includes(source)
    )
      throw new Error('Invalid task attempt trigger');
    return this.port.transaction(() => {
      const task = this.port.getTask(sessionId, taskId);
      assertTaskTransition(task.status, 'in_progress');
      const active = this.port.db
        .prepare("SELECT 1 FROM task_attempts WHERE task_id=? AND status='in_progress'")
        .get(taskId);
      if (active) throw new Error('Task already has an active attempt');
      const id = randomUUID();
      const ordinal = task.attemptCount + 1;
      const startedAt = new Date().toISOString();
      // A resume re-seeds the visible step list from the checkpoint journal so the model and the
      // UI both start from the last completed step instead of the original list. A fresh run
      // reseeds to pending for the same reason: the previous cycle's completion marks describe an
      // execution that has already ended.
      const seed = (map: Map<number, TaskStepStatus>): TaskStep[] => resumeSteps(task.steps, map);
      const steps =
        input.kind === 'run' && task.steps.length
          ? seed(input.resume === true ? stepStatusMap(this.port.db, taskId) : new Map())
          : null;
      this.port.db
        .prepare(
          "INSERT INTO task_attempts(id,task_id,session_id,ordinal,kind,run_id,status,prompt,baselines,trigger,resume,started_at) VALUES(?,?,?,?,?,?,'in_progress',?,?,?,?,?)",
        )
        .run(
          id,
          taskId,
          sessionId,
          ordinal,
          input.kind,
          input.runId ?? null,
          input.prompt ?? null,
          input.baselines ? JSON.stringify(input.baselines) : null,
          source,
          input.resume === true ? 1 : 0,
          startedAt,
        );
      this.port.db
        .prepare(
          "UPDATE tasks SET status='in_progress',steps=?,updated_at=? WHERE session_id=? AND id=?",
        )
        .run(JSON.stringify(steps ?? task.steps), startedAt, sessionId, taskId);
      return this.port.getTaskAttempt(sessionId, taskId, id);
    });
  }
  finishTaskAttempt(
    sessionId: string,
    taskId: string,
    attemptId: string,
    input: {
      status: Extract<TaskStatus, 'completed' | 'needs_review' | 'blocked' | 'cancelled'>;
      verification?: NonNullable<Task['verification']>;
      error?: string;
      acceptance?: Acceptance[];
      steps?: TaskStep[];
      /** Effects whose command results are persisted in this same transaction. */
      resolvedEffectIds?: string[];
    },
  ): Task {
    return this.port.transaction(() => {
      const task = this.port.getTask(sessionId, taskId);
      assertTaskTransition(task.status, input.status);
      const attempt = this.port.getTaskAttempt(sessionId, taskId, attemptId);
      if (attempt.status !== 'in_progress') throw new Error('Task attempt is already finished');
      const finishedAt = new Date().toISOString();
      for (const effectId of input.resolvedEffectIds ?? []) {
        const changed = this.port.db
          .prepare(
            "UPDATE task_effects SET status='completed',completed_at=? WHERE id=? AND session_id=? AND task_id=? AND attempt_id=? AND status='pending'",
          )
          .run(finishedAt, effectId, sessionId, taskId, attemptId);
        if (Number(changed.changes) !== 1)
          throw new Error('Task effect is not pending in this attempt');
      }
      const uncertainEffect = this.port.hasPendingTaskEffects(sessionId, taskId, attemptId);
      const finalStatus =
        input.status === 'completed' && uncertainEffect ? 'needs_review' : input.status;
      const finalError = uncertainEffect ? TASK_EFFECT_OUTCOME_UNKNOWN : (input.error ?? null);
      this.port.db
        .prepare(
          'UPDATE task_attempts SET status=?,verification=?,error=?,finished_at=? WHERE id=? AND task_id=? AND session_id=?',
        )
        .run(
          finalStatus,
          input.verification ? JSON.stringify(input.verification) : null,
          finalError,
          finishedAt,
          attemptId,
          taskId,
          sessionId,
        );
      // A failed verification must not erase work the model durably checkpointed as done; only the
      // steps that never completed fall back to the verifier's verdict.
      const checkpointed = stepStatusMap(this.port.db, taskId);
      const steps = input.steps
        ? input.steps.map((step, index) =>
            finalStatus !== 'completed' && checkpointed.get(index) === 'completed'
              ? { ...step, status: 'completed' as const }
              : step,
          )
        : task.steps;
      this.port.db
        .prepare(
          'UPDATE tasks SET status=?,acceptance=?,verification=?,steps=?,updated_at=? WHERE session_id=? AND id=?',
        )
        .run(
          finalStatus,
          JSON.stringify(validateAcceptance(input.acceptance ?? task.acceptance)),
          input.verification ? JSON.stringify(input.verification) : null,
          JSON.stringify(validateSteps(steps)),
          finishedAt,
          sessionId,
          taskId,
        );
      if (uncertainEffect)
        this.port.db
          .prepare('UPDATE tasks SET next_run_at=NULL WHERE session_id=? AND id=?')
          .run(sessionId, taskId);
      if (
        finalStatus === 'completed' &&
        attempt.trigger === 'manual' &&
        task.approvalOutcomeUnknown
      ) {
        // A deliberate manual retry is the recovery boundary for effects left unknown by an
        // earlier attempt. Keep the journal rows for audit, but never clear a current pending effect.
        this.port.db
          .prepare(
            "UPDATE task_effects SET status='reviewed',completed_at=? WHERE session_id=? AND task_id=? AND status='pending' AND attempt_id<>?",
          )
          .run(finishedAt, sessionId, taskId, attemptId);
        this.port.db
          .prepare(
            'UPDATE tasks SET next_run_at=?,last_trigger_error=NULL WHERE session_id=? AND id=?',
          )
          .run(scheduledNextRunAt(task.trigger, new Date(finishedAt)), sessionId, taskId);
      }
      if (!this.port.hasPendingTaskEffects(sessionId, taskId)) {
        this.port.db
          .prepare(
            'UPDATE tasks SET last_trigger_error=NULL WHERE session_id=? AND id=? AND last_trigger_error=?',
          )
          .run(sessionId, taskId, TASK_EFFECT_OUTCOME_UNKNOWN);
        if (finalStatus === 'completed')
          this.port.db
            .prepare(
              'UPDATE tasks SET last_trigger_error=NULL WHERE session_id=? AND id=? AND last_trigger_error=?',
            )
            .run(sessionId, taskId, TASK_APPROVAL_OUTCOME_UNKNOWN);
      }
      return this.port.getTask(sessionId, taskId);
    });
  }
  getTaskAttempt(sessionId: string, taskId: string, attemptId: string): TaskAttempt {
    this.port.getTask(sessionId, taskId);
    const row = this.port.db
      .prepare(`${TASK_ATTEMPT_SELECT} WHERE session_id=? AND task_id=? AND id=?`)
      .get(sessionId, taskId, attemptId);
    if (!row) throw new Error(`Task attempt not found: ${attemptId}`);
    return taskAttemptFromRow(row);
  }
  listTaskAttempts(sessionId: string, taskId: string): TaskAttempt[] {
    this.port.getTask(sessionId, taskId);
    return this.port.db
      .prepare(`${TASK_ATTEMPT_SELECT} WHERE session_id=? AND task_id=? ORDER BY ordinal`)
      .all(sessionId, taskId)
      .map((row) => taskAttemptFromRow(row));
  }
  /**
   * Latest checkpoint per step index. Later entries win, which is what makes the journal
   * append-only instead of a mutable row per step.
   */
  /**
   * Record one step transition. The journal is the durable progress record; `tasks.steps` is
   * updated in the same transaction so a reader never sees the two disagree.
   */
  checkpointTaskStep(
    sessionId: string,
    taskId: string,
    input: { attemptId: string; index: number; status: TaskStepStatus; note?: string },
  ): Task {
    return this.port.transaction(() => {
      const task = this.port.getTask(sessionId, taskId);
      const attempt = this.port.getTaskAttempt(sessionId, taskId, input.attemptId);
      if (attempt.status !== 'in_progress')
        throw new Error('Task attempt is not active; refusing to checkpoint a stale step');
      if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= task.steps.length)
        throw new Error('Invalid task step index');
      if (!taskStepStatuses.has(input.status)) throw new Error('Invalid task step status');
      const note =
        input.note === undefined ? undefined : validateTaskText(input.note, 'note', 500, true);
      const now = new Date().toISOString();
      this.port.db
        .prepare(
          'INSERT INTO task_step_checkpoints(id,task_id,session_id,attempt_id,step_index,status,note,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          taskId,
          sessionId,
          input.attemptId,
          input.index,
          input.status,
          note ?? null,
          now,
        );
      const steps = task.steps.map((step, index) =>
        index === input.index ? { ...step, status: input.status } : step,
      );
      this.port.db
        .prepare('UPDATE tasks SET steps=?,updated_at=? WHERE session_id=? AND id=?')
        .run(JSON.stringify(steps), now, sessionId, taskId);
      return this.port.getTask(sessionId, taskId);
    });
  }
  taskStepCheckpoints(sessionId: string, taskId: string): TaskStepCheckpoint[] {
    this.port.getTask(sessionId, taskId);
    return this.port.db
      .prepare(
        'SELECT id,task_id AS taskId,session_id AS sessionId,attempt_id AS attemptId,step_index AS stepIndex,status,note,created_at AS createdAt FROM task_step_checkpoints WHERE session_id=? AND task_id=? ORDER BY seq',
      )
      .all(sessionId, taskId)
      .map((row) => ({
        id: String(row.id),
        taskId: String(row.taskId),
        sessionId: String(row.sessionId),
        attemptId: String(row.attemptId),
        index: Number(row.stepIndex),
        status: String(row.status) as TaskStepStatus,
        ...(row.note === null || row.note === undefined ? {} : { note: String(row.note) }),
        createdAt: String(row.createdAt),
      }));
  }
  /** Indexes of steps a previous attempt durably completed, used to seed a resume. */
  completedStepIndexes(taskId: string): number[] {
    const map = stepStatusMap(this.port.db, taskId);
    return [...map.entries()]
      .filter(([, status]) => status === 'completed')
      .map(([index]) => index)
      .sort((left, right) => left - right);
  }
  /** Mark a permissioned task operation before it can affect the workspace or an external system. */
  beginTaskEffect(sessionId: string, taskId: string, attemptId: string, toolName: string): string {
    return this.port.transaction(() => {
      const attempt = this.port.getTaskAttempt(sessionId, taskId, attemptId);
      if (attempt.status !== 'in_progress' || !toolName.trim())
        throw new Error('Task effect requires an active attempt and a tool name');
      const id = randomUUID();
      const now = new Date().toISOString();
      this.port.db
        .prepare(
          "INSERT INTO task_effects(id,task_id,session_id,attempt_id,tool_name,status,started_at) VALUES(?,?,?,?,?,'pending',?)",
        )
        .run(id, taskId, sessionId, attemptId, toolName, now);
      this.port.db
        .prepare(
          'UPDATE tasks SET last_trigger_error=CASE WHEN last_trigger_error=? THEN last_trigger_error ELSE ? END,updated_at=? WHERE id=? AND session_id=?',
        )
        .run(TASK_APPROVAL_OUTCOME_UNKNOWN, TASK_EFFECT_OUTCOME_UNKNOWN, now, taskId, sessionId);
      return id;
    });
  }
  /** A successful tool result is durable only after the corresponding transcript entry is saved. */
  completeTaskEffect(sessionId: string, taskId: string, effectId: string): void {
    this.port.transaction(() => {
      const changed = this.port.db
        .prepare(
          "UPDATE task_effects SET status='completed',completed_at=? WHERE id=? AND task_id=? AND session_id=? AND status='pending'",
        )
        .run(new Date().toISOString(), effectId, taskId, sessionId);
      if (Number(changed.changes) !== 1) throw new Error('Task effect is not pending');
      if (!this.port.hasPendingTaskEffects(sessionId, taskId))
        this.port.db
          .prepare(
            'UPDATE tasks SET last_trigger_error=NULL WHERE id=? AND session_id=? AND last_trigger_error=?',
          )
          .run(taskId, sessionId, TASK_EFFECT_OUTCOME_UNKNOWN);
    });
  }
  hasPendingTaskEffects(sessionId: string, taskId: string, attemptId?: string): boolean {
    this.port.getTask(sessionId, taskId);
    return Boolean(
      this.port.db
        .prepare(
          "SELECT 1 FROM task_effects WHERE session_id=? AND task_id=? AND status='pending' AND (? IS NULL OR attempt_id=?) LIMIT 1",
        )
        .get(sessionId, taskId, attemptId ?? null, attemptId ?? null),
    );
  }
  /** Persist a scheduled run's exact approval request before stopping the unattended attempt. */
  deferTaskApproval(sessionId: string, taskId: string, approval: Approval): Task {
    return this.port.transaction(() => {
      const task = this.port.getTask(sessionId, taskId);
      if (!task.trigger?.enabled || task.status !== 'in_progress')
        throw new Error('Only an active scheduled task can defer approval');
      const serialized = JSON.stringify({ ...approval, requestId: randomUUID() });
      if (Buffer.byteLength(serialized) > 128_000) throw new Error('Task approval exceeds 128KB');
      const previous = this.port.db
        .prepare('SELECT created_at AS createdAt FROM task_approvals WHERE task_id=?')
        .get(taskId);
      const now = nextTaskTimestamp(previous ? String(previous.createdAt) : undefined);
      this.port.db
        .prepare(
          "INSERT INTO task_approvals(task_id,session_id,state,approval,created_at,reviewed_at) VALUES(?,?,'pending',?,?,NULL) ON CONFLICT(task_id) DO UPDATE SET state='pending',approval=excluded.approval,created_at=excluded.created_at,reviewed_at=NULL",
        )
        .run(taskId, sessionId, serialized, now);
      this.port.db
        .prepare('UPDATE tasks SET next_run_at=NULL,updated_at=? WHERE session_id=? AND id=?')
        .run(now, sessionId, taskId);
      return this.port.getTask(sessionId, taskId);
    });
  }
  /** Review a deferred request. Approval queues one recovery attempt; rejection keeps it paused. */
  resolveTaskApproval(
    sessionId: string,
    taskId: string,
    allow: boolean,
    expectedApprovalId: string,
  ): Task {
    return this.port.transaction(() => {
      const task = this.port.getTask(sessionId, taskId);
      if (task.pendingApproval?.state !== 'pending')
        throw new Error('Task approval is no longer pending');
      if (!expectedApprovalId || task.pendingApproval.id !== expectedApprovalId)
        throw new Error('Task approval changed; reload before reviewing');
      if (task.status === 'in_progress') throw new Error('Task is still running');
      if (allow && !task.trigger?.enabled) throw new Error('Task trigger is disabled');
      const now = new Date().toISOString();
      this.port.db
        .prepare(
          'UPDATE task_approvals SET state=?,reviewed_at=? WHERE session_id=? AND task_id=? AND state=?',
        )
        .run(allow ? 'approved' : 'rejected', now, sessionId, taskId, 'pending');
      this.port.db
        .prepare('UPDATE tasks SET next_run_at=?,updated_at=? WHERE session_id=? AND id=?')
        .run(allow ? now : null, now, sessionId, taskId);
      return this.port.getTask(sessionId, taskId);
    });
  }
  /** A grant applies to one matching tool operation only, never to the whole task. */
  consumeTaskApproval(sessionId: string, taskId: string, approval: Approval): boolean {
    return this.port.transaction(() => {
      this.port.getTask(sessionId, taskId);
      const row = this.port.db
        .prepare(
          "SELECT approval FROM task_approvals WHERE session_id=? AND task_id=? AND state='approved'",
        )
        .get(sessionId, taskId);
      if (!row) return false;
      const saved = JSON.parse(String(row.approval)) as Approval;
      if (
        saved.kind !== approval.kind ||
        !sameApprovalDescription(saved, approval) ||
        saved.toolCall.name !== approval.toolCall.name ||
        !isDeepStrictEqual(saved.toolCall.arguments, approval.toolCall.arguments) ||
        !isDeepStrictEqual(saved.change, approval.change)
      )
        return false;
      this.port.db
        .prepare("DELETE FROM task_approvals WHERE session_id=? AND task_id=? AND state='approved'")
        .run(sessionId, taskId);
      this.port.db
        .prepare(
          'UPDATE tasks SET next_run_at=NULL,last_trigger_error=? WHERE session_id=? AND id=?',
        )
        .run(TASK_APPROVAL_OUTCOME_UNKNOWN, sessionId, taskId);
      return true;
    });
  }
  /** An unused grant expires when its single recovery attempt finishes. */
  clearApprovedTaskApproval(sessionId: string, taskId: string, expectedRule?: string): void {
    this.port.transaction(() => {
      if (expectedRule !== undefined) {
        let task: Task;
        try {
          task = this.port.getTask(sessionId, taskId);
        } catch {
          return;
        }
        if ((task.triggerRevision ?? 'legacy') !== expectedRule) return;
      }
      this.port.db
        .prepare("DELETE FROM task_approvals WHERE session_id=? AND task_id=? AND state='approved'")
        .run(sessionId, taskId);
    });
  }
  /** Compare and reserve a clock obligation in one write transaction, across Host processes. */
  claimTaskSchedule(task: Task, source: TaskTriggerSource, scheduledAt?: string): boolean {
    return this.port.transaction(() => {
      let current: Task;
      try {
        current = this.port.getTask(task.sessionId, task.id);
      } catch {
        return false;
      }
      const rule = task.triggerRevision ?? 'legacy';
      if (
        !current.trigger?.enabled ||
        current.status === 'cancelled' ||
        current.status === 'in_progress' ||
        current.approvalOutcomeUnknown ||
        ['pending', 'rejected'].includes(current.pendingApproval?.state ?? '') ||
        (current.triggerRevision ?? 'legacy') !== rule ||
        current.nextRunAt !== task.nextRunAt ||
        !current.nextRunAt ||
        Date.parse(current.nextRunAt) > Date.now()
      )
        return false;
      const recovery =
        source === 'recovery' ||
        current.lastTriggerError?.startsWith('Host restarted mid-attempt') === true;
      // v26 had the receipt but no current-delivery column. Only an explicit known recovery may
      // adopt that rule's last receipt; ordinary ticks never resurrect an already admitted run.
      // The receipt is looked up in SQL rather than by reading the session's log: an admission decision must not
      // fail because some unrelated event's payload is damaged (see `tests/storage-audit-repairs.test.ts`).
      const previousId = recovery
        ? (this.port.db
            .prepare('SELECT current_delivery_id AS id FROM tasks WHERE id=?')
            .get(task.id)?.id ??
          (
            this.port.db
              .prepare(
                "SELECT json_extract(data,'$.deliveryId') AS id FROM session_events WHERE session_id=? AND type='task.admitted' AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.ruleRevision')=? ORDER BY seq DESC LIMIT 1",
              )
              .get(task.sessionId, task.id, rule) as { id?: unknown } | undefined
          )?.id)
        : undefined;
      const deliveryId = previousId
        ? String(previousId)
        : oneShot(current.trigger)
          ? `once:${task.id}:${rule}`
          : `clock:${task.id}:${rule}:${scheduledAt ?? task.nextRunAt}`;
      const known = Boolean(
        this.port.db
          .prepare(
            "SELECT 1 FROM session_events WHERE session_id=? AND type='task.admitted' AND json_extract(data,'$.deliveryId')=? LIMIT 1",
          )
          .get(task.sessionId, deliveryId),
      );
      if (known && !recovery) return false;
      this.port.db
        .prepare(
          'UPDATE tasks SET next_run_at=NULL,last_trigger_error=?,current_delivery_id=? WHERE session_id=? AND id=?',
        )
        .run(
          'Schedule admitted; completion has not yet been recorded.',
          deliveryId,
          task.sessionId,
          task.id,
        );
      if (!known)
        this.port.recordEvent(task.sessionId, 'task.admitted', {
          deliveryId,
          taskId: task.id,
          ruleRevision: rule,
          dueAt: task.nextRunAt,
          scheduledAt: scheduledAt ?? task.nextRunAt,
          source,
        });
      return true;
    });
  }
  /** A skip is a scheduling receipt, not an execution or an attempt. */
  skipTaskSchedule(task: Task, now: Date): boolean {
    return this.port.transaction(() => {
      let current: Task;
      try {
        current = this.port.getTask(task.sessionId, task.id);
      } catch {
        return false;
      }
      const rule = task.triggerRevision ?? 'legacy';
      if (
        !current.trigger?.enabled ||
        misfirePolicy(current.trigger) !== 'skip' ||
        current.approvalOutcomeUnknown ||
        current.pendingApproval ||
        current.status === 'in_progress' ||
        current.status === 'cancelled' ||
        (current.triggerRevision ?? 'legacy') !== rule ||
        current.nextRunAt !== task.nextRunAt ||
        !current.nextRunAt ||
        now.getTime() - Date.parse(current.nextRunAt) <= 60000 ||
        this.port.db.prepare('SELECT current_delivery_id AS id FROM tasks WHERE id=?').get(task.id)
          ?.id
      )
        return false;
      const next = nextRunAtValue(current.trigger, now);
      this.port.db
        .prepare('UPDATE tasks SET next_run_at=?,last_trigger_error=? WHERE id=?')
        .run(next ?? null, 'Missed schedule skipped by policy.', task.id);
      this.port.recordEvent(task.sessionId, 'task.skipped', {
        taskId: task.id,
        ruleRevision: rule,
        dueAt: task.nextRunAt,
        nextRunAt: next,
        reason: 'misfire',
        at: now.toISOString(),
      });
      return true;
    });
  }
  recordTaskRun(
    sessionId: string,
    taskId: string,
    input: {
      at: string;
      trigger?: TaskTrigger;
      error?: string;
      expectedRule?: string;
      finishedAt?: string;
    },
  ): Task {
    return this.port.transaction(() => {
      const task = this.port.getTask(sessionId, taskId);
      if (
        input.expectedRule !== undefined &&
        input.expectedRule !== (task.triggerRevision ?? 'legacy')
      )
        return task;
      const unknown = task.approvalOutcomeUnknown && task.status !== 'completed';
      const paused =
        unknown ||
        task.pendingApproval?.state === 'pending' ||
        task.pendingApproval?.state === 'rejected';
      const next =
        paused || oneShot(input.trigger)
          ? null
          : input.trigger?.enabled
            ? (nextRunAtValue(
                input.trigger,
                new Date(misfirePolicy(input.trigger) ? (input.finishedAt ?? input.at) : input.at),
              ) ?? null)
            : null;
      this.port.db
        .prepare(
          'UPDATE tasks SET last_run_at=?,next_run_at=?,last_trigger_error=?,current_delivery_id=CASE WHEN ? THEN current_delivery_id ELSE NULL END WHERE session_id=? AND id=?',
        )
        .run(
          input.at,
          next,
          unknown ? (task.lastTriggerError ?? TASK_EFFECT_OUTCOME_UNKNOWN) : (input.error ?? null),
          paused ? 1 : 0,
          sessionId,
          taskId,
        );
      return this.port.getTask(sessionId, taskId);
    });
  }
  /** Put a task back on the due queue immediately, e.g. to resume it after a Host restart. */
  scheduleImmediateRun(sessionId: string, taskId: string, error?: string): Task {
    this.port.getTask(sessionId, taskId);
    this.port.db
      .prepare(
        'UPDATE tasks SET next_run_at=?,last_trigger_error=? WHERE session_id=? AND id=? AND trigger IS NOT NULL',
      )
      .run(new Date().toISOString(), error ?? null, sessionId, taskId);
    return this.port.getTask(sessionId, taskId);
  }
  taskAttemptBaselines(
    sessionId: string,
    taskId: string,
    attemptId: string,
  ): Record<string, unknown> {
    this.port.getTaskAttempt(sessionId, taskId, attemptId);
    const row = this.port.db
      .prepare('SELECT baselines FROM task_attempts WHERE id=?')
      .get(attemptId);
    return row?.baselines ? (JSON.parse(String(row.baselines)) as Record<string, unknown>) : {};
  }
  latestRunAttemptBaselines(sessionId: string, taskId: string): Record<string, unknown> {
    this.port.getTask(sessionId, taskId);
    const row = this.port.db
      .prepare(
        "SELECT a.baselines FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.session_id=? AND a.task_id=? AND a.kind='run' AND a.ordinal>t.definition_attempt_floor ORDER BY a.ordinal DESC LIMIT 1",
      )
      .get(sessionId, taskId);
    return row?.baselines ? (JSON.parse(String(row.baselines)) as Record<string, unknown>) : {};
  }
  recoverInterruptedTasks(workspace?: string): number {
    return this.port.transaction(() => {
      const rows = this.port.db
        .prepare(
          "SELECT a.id,a.task_id AS taskId,a.session_id AS sessionId,a.run_id AS runId,r.owner_pid AS ownerPid FROM task_attempts a JOIN tasks t ON t.id=a.task_id JOIN sessions s ON s.id=a.session_id LEFT JOIN runs r ON r.id=a.run_id WHERE a.status='in_progress' AND t.status='in_progress' AND (? IS NULL OR s.workspace=?)",
        )
        .all(workspace ?? null, workspace ?? null);
      const interrupted = rows.filter((row) => deadOwner(row.ownerPid));
      const now = new Date().toISOString();
      const deadRunIds = new Set<string>();
      for (const row of interrupted) {
        if (row.runId) deadRunIds.add(String(row.runId));
        this.port.db
          .prepare(
            "UPDATE task_attempts SET status='needs_review',error=?,finished_at=? WHERE id=?",
          )
          .run(
            'Host stopped before this task attempt finished; inspect workspace state before retrying.',
            now,
            String(row.id),
          );
        this.port.db
          .prepare(
            "UPDATE tasks SET status='needs_review',updated_at=? WHERE id=? AND session_id=?",
          )
          .run(now, String(row.taskId), String(row.sessionId));
      }
      const legacy = this.port.db
        .prepare(
          "SELECT t.id,t.session_id AS sessionId,s.active_run AS activeRun,r.owner_pid AS ownerPid FROM tasks t JOIN sessions s ON s.id=t.session_id LEFT JOIN runs r ON r.id=s.active_run WHERE t.status='in_progress' AND NOT EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id=t.id AND a.status='in_progress') AND (? IS NULL OR s.workspace=?)",
        )
        .all(workspace ?? null, workspace ?? null)
        .filter((row) => !row.activeRun || deadOwner(row.ownerPid));
      for (const row of legacy) {
        if (row.activeRun) deadRunIds.add(String(row.activeRun));
        this.port.db
          .prepare(
            "UPDATE tasks SET status='needs_review',updated_at=? WHERE id=? AND session_id=?",
          )
          .run(now, String(row.id), String(row.sessionId));
      }
      this.port.db
        .prepare(
          "UPDATE tasks SET next_run_at=NULL WHERE id IN (SELECT task_id FROM task_effects WHERE status='pending') AND (? IS NULL OR session_id IN (SELECT id FROM sessions WHERE workspace=?))",
        )
        .run(workspace ?? null, workspace ?? null);
      // Release any run this recovery marked dead so it no longer blocks session mutation,
      // mirroring the interrupted-run handling in beginRun.
      for (const runId of deadRunIds) {
        this.port.db
          .prepare("UPDATE runs SET status='interrupted' WHERE id=? AND status='running'")
          .run(runId);
        this.port.db.prepare('UPDATE sessions SET active_run=NULL WHERE active_run=?').run(runId);
      }
      return interrupted.length + legacy.length;
    });
  }
  /**
   * Converge child runs left behind by a Host that died while sub-agents were working.
   *
   * Task recovery above joins `tasks`, and a child session never has one; child sessions are also
   * hidden from `list()`, so nothing else will ever look at them again — their run row would stay
   * `running` and their session would keep `active_run` forever. Ordinary sessions are converged by
   * `reconcileInterruptedRuns`, which is the same convergence without the parent's notification; the two are
   * split because only this one knows both the child and the parent that has to hear about it.
   */
  reconcileChildRuns(workspace?: string): number {
    return this.port.transaction(() => {
      const rows = this.port.db
        .prepare(
          "SELECT r.id AS runId, r.owner_pid AS ownerPid FROM runs r JOIN sessions s ON s.id=r.session_id WHERE s.parent_session_id IS NOT NULL AND s.fork_message_count IS NULL AND r.status='running' AND (? IS NULL OR s.workspace=?)",
        )
        .all(workspace ?? null, workspace ?? null)
        .filter((row) => deadOwner(row.ownerPid));
      for (const row of rows) {
        const childId = String(
          this.port.db.prepare('SELECT session_id FROM runs WHERE id=?').get(String(row.runId))
            ?.session_id,
        );
        this.port.settleAbandonedRun(
          childId,
          String(row.runId),
          'Previous child run was interrupted. Execution outcome is unknown; inspect current state before retrying.',
        );
        // The parent's view of this child is a durable fact too: a reader of the parent's log must be able
        // to see "this child was interrupted" without reaching into the child's own session. Recorded here
        // because this is the only place that knows both the parent and the outcome.
        const parent = this.port.db
          .prepare(
            'SELECT parent_session_id AS parentSessionId FROM sessions WHERE id=? AND parent_session_id IS NOT NULL',
          )
          .get(childId);
        if (parent)
          this.port.recordEvent(String(parent.parentSessionId), 'subagent.interrupted', {
            runId: String(row.runId),
            childSessionId: childId,
            reason: 'Interrupted; inspect the child transcript and current state before retrying.',
          });
      }
      return rows.length;
    });
  }
  /**
   * Put interrupted work back on the queue after a restart. Only tasks that opt in with an enabled
   * trigger are resumed automatically; everything else stays `needs_review` for a human to decide,
   * because resuming unattended work the operator never scheduled would be a surprise.
   *
   * Returns the tasks now due for a resume attempt.
   */
  resumableTasks(workspace?: string): Task[] {
    return this.port.transaction(() => {
      const candidates = this.port.db
        .prepare(
          `${TASK_SELECT} WHERE t.trigger IS NOT NULL AND t.status IN ('in_progress','needs_review','blocked') AND (? IS NULL OR t.session_id IN (SELECT id FROM sessions WHERE workspace=?)) AND NOT EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id=t.id AND a.status='in_progress') ORDER BY t.next_run_at IS NULL,t.next_run_at,t.id`,
        )
        .all(workspace ?? null, workspace ?? null)
        .map((row) => taskFromRow(row));
      const resumable = candidates.filter((task) => {
        const trigger = task.trigger;
        if (!trigger?.enabled || task.approvalOutcomeUnknown) return false;
        if (task.pendingApproval?.state === 'pending' || task.pendingApproval?.state === 'rejected')
          return false;
        if (trigger.kind === 'event' && task.pendingApproval?.state !== 'approved') return false;
        return (
          task.pendingApproval?.state === 'approved' ||
          completedStepIndexesFor(this.port.db, task.id).length > 0
        );
      });
      const now = new Date().toISOString();
      for (const task of resumable) {
        this.port.db
          .prepare(
            'UPDATE tasks SET next_run_at=?,last_trigger_error=? WHERE session_id=? AND id=?',
          )
          .run(
            now,
            'Host restarted mid-attempt; resuming from the last completed step.',
            task.sessionId,
            task.id,
          );
      }
      return resumable.map((task) => this.port.getTask(task.sessionId, task.id));
    });
  }
  transitionTask(sessionId: string, id: string, status: TaskStatus): Task {
    const current = this.port.getTask(sessionId, id);
    assertTaskTransition(current.status, status);
    this.port.db
      .prepare('UPDATE tasks SET status=?,updated_at=? WHERE session_id=? AND id=?')
      .run(status, new Date().toISOString(), sessionId, id);
    return this.port.getTask(sessionId, id);
  }
  deleteTask(sessionId: string, id: string): void {
    this.port.getTask(sessionId, id);
    this.port.db.prepare('DELETE FROM tasks WHERE session_id=? AND id=?').run(sessionId, id);
  }
}
