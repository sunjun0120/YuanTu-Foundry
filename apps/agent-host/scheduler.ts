import type { SessionStore } from '../../packages/storage/sqlite.ts';
import type { RunResult, Task, TaskTriggerSource } from '../../packages/protocol/index.ts';
import {
  dueTasks,
  matchesEvent,
  misfirePolicy,
  latestScheduledAt,
  type DueTask,
  type TaskEvent,
} from '../../packages/core/task-trigger.ts';
import { recordTaskDelivery, type TaskDelivery } from '../../packages/core/task-deliveries.ts';

export interface SchedulerRun {
  task: Task;
  source: TaskTriggerSource;
  resume: boolean;
  missed: boolean;
  scheduledAt?: string;
}

export interface TaskSchedulerOptions {
  store: SessionStore;
  /** Restricts the scheduler to one workspace; the Host owns exactly one. */
  workspace: string;
  /** False while the Host cannot accept another run, so due work waits instead of failing. */
  canRun: () => boolean;
  /** Starts one run and resolves when it settles. */
  run: (run: SchedulerRun) => Promise<void | Pick<RunResult, 'status' | 'error'>>;
  /**
   * The longest the scheduler waits before looking again, and the fallback when nothing is scheduled.
   *
   * It is no longer the *rate* at which due work is noticed: the clock aims at the earliest due moment and this is
   * the ceiling on that aim, so `YUANTU_WORKFLOW_INTERVAL_MS` now means "how stale a schedule may get if the timer
   * is wrong" rather than "how often to check".
   */
  intervalMs?: number;
  catchUp?: boolean;
}

/** Event chains are capped so a pair of tasks cannot trigger each other without bound. */
const MAX_EVENT_DEPTH = 3;
/**
 * The floor and the fallback for how long the scheduler waits.
 *
 * The floor keeps a clock that is due *now* from becoming a spin loop — a due task that cannot run because the
 * Host is busy is waiting for the Host, and asking again a millisecond later would not change that. The fallback is
 * what a scheduler with nothing scheduled waits: long enough not to matter, short enough that a task created
 * between two ticks is noticed without an explicit nudge.
 */
const MIN_TICK_MS = 1_000;
const DEFAULT_TICK_MS = 30_000;

/**
 * Fires durable tasks on their own schedule and on Host events.
 *
 * The scheduler owns no scheduling state of its own: `trigger` and `next_run_at` live on the task
 * row, so a Host restart resumes exactly where the previous process left off, and one missed
 * occurrence is replayed once rather than once per missed interval.
 *
 * Its clock is aimed rather than polled. A fixed interval meant a task due at 09:00:01 started at 09:00:30 at the
 * earliest — and that the process woke 2,880 times a day to find nothing to do. Each tick now schedules the next
 * look at the moment something is actually due (`nextDelayMs`), with the configured interval as the ceiling so a
 * task edited by another process is still noticed.
 */
export class TaskScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private pendingCatchUp: boolean;
  private eventDepth = 0;
  /** Tasks already started by the current event cascade, which stops A->B->A ping-pong. */
  private chain = new Set<string>();
  private stopped = false;
  private readonly options: TaskSchedulerOptions;

  constructor(options: TaskSchedulerOptions) {
    this.options = options;
    this.pendingCatchUp = options.catchUp !== false;
  }
  get running(): boolean {
    return this.timer !== undefined;
  }
  start(): void {
    if (this.stopped || this.timer) return;
    this.arm();
    void this.tick();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  /**
   * How long until the next look.
   *
   * Three answers, in the order they are asked: something is *already* due, which means it is waiting for the Host
   * rather than for the clock, so the ordinary interval is the right re-check; something is due later, in which
   * case that is the moment to wake at; nothing is scheduled, in which case the interval is what a new task has to
   * wait to be noticed.
   */
  nextDelayMs(now = new Date()): number {
    const interval = Math.max(MIN_TICK_MS, this.options.intervalMs ?? DEFAULT_TICK_MS);
    const tasks = this.options.store.listScheduledTasks(this.options.workspace);
    if (dueTasks(tasks, now, { catchUp: false }).length) return interval;
    const upcoming: number[] = [];
    for (const task of tasks) {
      const trigger = task.trigger;
      if (!trigger?.enabled || task.status === 'cancelled' || task.status === 'in_progress')
        continue;
      const at = task.nextRunAt ? Date.parse(task.nextRunAt) : Number.NaN;
      if (Number.isFinite(at)) upcoming.push(at);
    }
    if (!upcoming.length) return interval;
    return Math.min(interval, Math.max(MIN_TICK_MS, Math.min(...upcoming) - now.getTime()));
  }
  /** (Re)schedule the next look. Called by `start` and after every tick, so there is never more than one timer. */
  arm(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.nextDelayMs());
    // A pending timer must never be the reason the Host process stays alive.
    this.timer.unref?.();
  }
  /**
   * Run every task whose scheduled moment has arrived, one at a time. Returns the tasks actually
   * started so callers and tests can assert on scheduling without re-reading the database.
   */
  async tick(): Promise<SchedulerRun[]> {
    if (this.stopped || this.ticking) return [];
    this.ticking = true;
    const catchUp = this.pendingCatchUp;
    this.pendingCatchUp = false;
    try {
      const candidates = dueTasks(
        this.options.store.listScheduledTasks(this.options.workspace),
        new Date(),
        { catchUp },
      );
      const started: SchedulerRun[] = [];
      for (const due of candidates) {
        if (this.stopped) break;
        if (this.skipMissed(due.task, due.source)) continue;
        if (!this.options.canRun()) {
          // The rest of the queue waits for the Host, and that wait is written down rather than left to be
          // inferred from a late `last_run_at` (`packages/core/task-deliveries.ts`). Recorded here, once per
          // session and look, so the next tick of a busy Host adds nothing.
          this.recordWaiting(candidates.slice(candidates.indexOf(due)));
          break;
        }
        const run = await this.execute(due.task, due.source, due.missed);
        if (run) started.push(run);
      }
      return started;
    } finally {
      this.ticking = false;
      // The next look is aimed at whatever is due next, which the tick that just ran has moved on.
      this.arm();
    }
  }
  /**
   * Write down the due work this Host is not free to start, merged per session.
   *
   * The merge is the snapshot's §4.5: everything one session was owed when the scheduler looked is one delivery
   * rather than one record per task, and the moment it was due is the oldest of them. `closed` is the honest
   * reason while the Host is shutting down — those deliveries are picked up by the next process, which is what
   * the row's own lateness is for.
   */
  private recordWaiting(due: readonly DueTask[]): void {
    const groups = new Map<string, TaskDelivery>();
    for (const entry of due) {
      const dueAt = entry.task.nextRunAt;
      if (!dueAt) continue;
      const group = groups.get(entry.task.sessionId) ?? {
        // `due` is oldest first, so the first entry of a session is its oldest obligation.
        dueAt,
        reason: this.stopped ? 'closed' : 'busy',
        tasks: [],
        recordedAt: new Date().toISOString(),
      };
      group.tasks.push({
        id: entry.task.id,
        title: entry.task.title,
        ruleRevision: entry.task.triggerRevision ?? 'legacy',
        scheduledAt: entry.task.nextRunAt,
      });
      groups.set(entry.task.sessionId, group);
    }
    for (const [sessionId, group] of groups) {
      try {
        recordTaskDelivery(this.options.store, sessionId, group);
      } catch {
        /* A task deleted mid-tick must not take the scheduler down; the row is what the delivery is about. */
      }
    }
  }
  /**
   * React to a Host event. Event-triggered runs start immediately rather than waiting for the next
   * tick, so a chain of dependent tasks makes progress within one session.
   */
  async notify(event: TaskEvent): Promise<SchedulerRun[]> {
    if (this.stopped || this.eventDepth >= MAX_EVENT_DEPTH) return [];
    const matching = this.options.store
      .listScheduledTasks(this.options.workspace)
      .filter((task) => task.trigger && matchesEvent(task.trigger, event))
      .filter((task) => task.status !== 'in_progress' && task.status !== 'cancelled')
      .filter((task) => !task.pendingApproval && !task.approvalOutcomeUnknown);
    const started: SchedulerRun[] = [];
    this.eventDepth++;
    try {
      for (const task of matching) {
        // A run emits `run.finished` while the cascade that started it is still on the stack; the
        // chain keeps a task from being restarted by the very event it just produced.
        if (this.stopped || this.chain.has(task.id) || !this.options.canRun()) break;
        this.chain.add(task.id);
        const run = await this.execute(task, 'event', false);
        if (run) started.push(run);
      }
    } finally {
      this.eventDepth--;
      if (this.eventDepth === 0) this.chain.clear();
    }
    return started;
  }
  private skipMissed(task: Task, source: TaskTriggerSource): boolean {
    if (source === 'recovery' || task.lastTriggerError?.startsWith('Host restarted mid-attempt'))
      return false;
    return task.trigger &&
      misfirePolicy(task.trigger) === 'skip' &&
      task.nextRunAt &&
      Date.now() - Date.parse(task.nextRunAt) > 60000
      ? this.options.store.skipTaskSchedule(task, new Date())
      : false;
  }
  private async execute(
    task: Task,
    source: TaskTriggerSource,
    missed: boolean,
  ): Promise<SchedulerRun | undefined> {
    const trigger = task.trigger;
    if (!trigger) return undefined;
    if (this.skipMissed(task, source)) return undefined;
    const recovery =
      source === 'recovery' || task.lastTriggerError?.startsWith('Host restarted mid-attempt');
    const late = !recovery && task.nextRunAt && Date.now() - Date.parse(task.nextRunAt) > 60000;
    const scheduledAt =
      late && misfirePolicy(trigger) === 'latest'
        ? latestScheduledAt(trigger, task.nextRunAt!, new Date())
        : task.nextRunAt;
    if (source !== 'event' && !this.options.store.claimTaskSchedule(task, source, scheduledAt))
      return undefined;
    if (source === 'event') {
      let current: Task;
      try {
        current = this.options.store.getTask(task.sessionId, task.id);
      } catch {
        return undefined;
      }
      if (
        !current.trigger?.enabled ||
        current.status === 'cancelled' ||
        current.status === 'in_progress' ||
        (current.triggerRevision ?? 'legacy') !== (task.triggerRevision ?? 'legacy')
      )
        return undefined;
    }
    // A task that already banked completed steps continues from them; a task that never got that
    // far starts clean, and a completed task restarts from the beginning.
    const resume =
      task.status !== 'pending' &&
      task.status !== 'completed' &&
      (task.pendingApproval?.state === 'approved' ||
        this.options.store.completedStepIndexes(task.id).length > 0);
    const run: SchedulerRun = {
      task,
      source,
      resume,
      missed: missed || Boolean(late),
      ...(scheduledAt ? { scheduledAt } : {}),
    };
    const startedAt = new Date().toISOString();
    let error: string | undefined;
    try {
      const result = await this.options.run(run);
      if (result && result.status !== 'completed') error = result.error ?? `Run ${result.status}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      // A review grant is valid for this recovery attempt only. A new deferred request remains.
      this.options.store.clearApprovedTaskApproval(
        task.sessionId,
        task.id,
        task.triggerRevision ?? 'legacy',
      );
      // Re-arm the clock even when the run failed, otherwise one broken task would be retried on
      // every tick forever.
      try {
        this.options.store.recordTaskRun(task.sessionId, task.id, {
          at: startedAt,
          finishedAt: new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString(),
          trigger,
          expectedRule: task.triggerRevision ?? 'legacy',
          ...(error ? { error: error.slice(0, 500) } : {}),
        });
      } catch {
        /* A task deleted mid-run must not take the scheduler down. */
      }
    }
    return run;
  }
}
