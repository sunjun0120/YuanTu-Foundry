import { SessionCheckpoints } from './session-checkpoints.ts';
import { SessionSearch } from './session-search.ts';
import { SessionFileChanges } from './session-file-changes.ts';
import { SessionMigrations } from './session-migrations.ts';
import { SqlitePlanStore } from './plans.ts';
import type { PlanBody, PlanRepository } from '../protocol/plans.ts';
import type { SessionLease } from '../protocol/session-lease.ts';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, registerDatabase, type BackupPolicy } from './database-maintenance.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  Approval,
  FileChange,
  FileSnapshot,
  Message,
  Plan,
  RunResult,
  SubAgentSummary,
  Task,
  TaskStatus,
  TodoItem,
  TaskTriggerSource,
  Usage,
  Acceptance,
  TaskAttemptKind,
  TaskStep,
  TaskStepStatus,
  TaskTrigger,
} from '../protocol/index.ts';
import { normalizeTaskDraft } from '../core/task-spec.ts';
import { normalizeTaskTrigger, oneShot } from '../core/task-trigger.ts';
import { contextBoundaries, surfaceOf } from '../protocol/context.ts';
import type { Surface, SurfaceOp } from '../protocol/context.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { TodoChange } from '../protocol/todos.ts';
import { foldSteps, inFlightStep as openStepOf } from '../protocol/steps.ts';
import type { StepRecord } from '../protocol/steps.ts';
import { redactSecrets } from '../core/errors.ts';
import { isImageReference } from '../protocol/images.ts';
import {
  appendFoldedMessages,
  assertKnownEvents,
  AUDIT_SESSION_EVENTS,
  foldMessages,
  foldPendingInputs,
  messageEventType,
  type PendingSessionInput,
  type SessionEvent,
  type SessionEventType,
} from './events.ts';
import {
  BUILT_IN_SESSION_PROJECTIONS,
  SessionProjectionRegistry,
  subAgentCards,
} from './projections.ts';
import type { StatisticsState, SubAgentCardsState, TurnTiming } from './projections.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import type { Goal } from '../protocol/goals.ts';
import {
  APPEND_BATCH_LIMIT,
  LOG_CACHE_ENTRIES,
  RUN_INTERRUPTED_REASON,
  TASK_SELECT,
  ageSuffix,
  assertTaskTransition,
  deadOwner,
  frozen,
  leaseEvidence,
  messageSearchText,
  nextTaskTimestamp,
  scheduledNextRunAt,
  taskStatuses,
  validateAcceptance,
  validateSteps,
  validateTaskText,
} from './session-schema.ts';
import { taskFromRow } from './session-schema.ts';
import { TaskJournal } from './session-tasks.ts';
import { StreamCheckpoints } from './session-streams.ts';
import { SessionLifecycle } from './session-lifecycle.ts';
import { sessionTitle, storedMessage, type QueuedBlob } from './session-blobs.ts';
import type {
  Session,
  SessionSearchPage,
  StoredFileChange,
  TaskCreate,
  TaskUpdate,
} from './session-schema.ts';
export { normalizePlanBody, planHash } from '../protocol/plans.ts';
export type { PlanBody } from '../protocol/plans.ts';
export { LEASE_RENEW_INTERVAL_MS } from '../protocol/session-lease.ts';
export type { SessionLease } from '../protocol/session-lease.ts';
export { hashesIn, imageHash, sessionTitle, storedMessage } from './session-blobs.ts';
export type { QueuedBlob } from './session-blobs.ts';
/**
 * The store's public vocabulary is re-exported here because this module is the storage layer's entry
 * point: callers import `{ SessionStore, SCHEMA_VERSION, … }` from one path, and where the definitions
 * physically live is this package's business. Splitting them out is what keeps this file about the
 * database rather than about the shape of its rows.
 */
export {
  APPLICATION_FORMAT,
  APPLICATION_ID,
  APPLICATION_NAME,
  MAX_SEARCH_MATCHES,
  MAX_SEARCH_SESSIONS,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
  SESSION_DATABASE_POLICY,
  ftsQuery,
  messageSearchText,
  projectionFoldIdentity,
} from './session-schema.ts';
export type {
  Session,
  SessionSearchHit,
  SessionSearchMatch,
  SessionSearchPage,
  StoredFileChange,
  TaskCreate,
  TaskUpdate,
} from './session-schema.ts';
/**
 * A transcript this store has already folded, plus what it takes to know the fold is still current.
 *
 * `dataVersion` is SQLite's `PRAGMA data_version` at the moment the fold was taken: SQLite bumps it when
 * *another* connection commits, so comparing it is how a reader notices a writer it does not own — a
 * second agent-host process, or the CLI appending while the desktop has the session open.
 */
interface LogCacheEntry {
  events: SessionEvent[];
  /** The folded transcript, or null while nobody has asked for it: reading the log is not reading it. */
  messages: Message[] | null;
  /**
   * Whether every event in this log is one this build can interpret: `null` until a *derived* answer asks.
   *
   * Kept on the entry because the check is over the whole log and the answer cannot change while the entry is
   * current — the cached log is dropped when another connection commits, exactly as the transcript is. The raw
   * log does not consult it: a reader diagnosing a session written by a newer build still needs to see the events.
   */
  readable: boolean | null;
  dataVersion: number;
}
/** One message waiting to be written, with the parts of it that are cheaper to compute before the write. */
interface QueuedMessage {
  message: Message;
  /** The same message as the row and the log store it: images replaced by their content addresses. */
  stored: unknown;
  /** The row body, serialised when the message is appended so a bad message is refused by its appender. */
  body: string;
  searchText: string;
  /** Bytes this message adds to `attachment_blobs`, written in the same transaction as the row. */
  blobs: readonly QueuedBlob[];
  /** The title a user message gives its session; null for the roles that never set one. */
  title: string | null;
}
export class SessionStore implements PlanRepository {
  private readonly eventObservers = new Map<
    (event: SessionEvent) => void,
    ReadonlySet<string> | undefined
  >();
  /** Notifications follow COMMIT and cannot affect its outcome or the cached durable payload. */
  observeEvents(listener: (event: SessionEvent) => void, types?: ReadonlySet<string>): () => void {
    this.eventObservers.set(listener, types);
    return () => {
      this.eventObservers.delete(listener);
    };
  }
  private notifyCommitted(events: readonly SessionEvent[]): void {
    for (const event of events)
      for (const [listener, types] of this.eventObservers) {
        if (types && !types.has(event.type)) continue;
        try {
          listener(structuredClone(event));
        } catch {
          /* Observation cannot undo a committed fact. */
        }
      }
  }
  private readonly schema: SessionMigrations;
  private readonly changes: SessionFileChanges;
  private readonly search: SessionSearch;
  private readonly checkpoints: SessionCheckpoints;
  private db!: DatabaseSync;
  private releaseDatabase?: () => void;
  private readonly plans: SqlitePlanStore;
  /** The task execution journal; this class forwards to it (see `./session-tasks.ts`). */
  private readonly tasks: TaskJournal;
  /** Streamed-answer recovery points; this class forwards to it (see `./session-streams.ts`). */
  private readonly streams: StreamCheckpoints;
  /** Renaming, generated titles and deletion; this class forwards to it (see `./session-lifecycle.ts`). */
  private readonly lifecycle: SessionLifecycle;
  /**
   * The projections a reader can fold the log with. The store hosts them because it owns the log; a host
   * that wants its own views registers them here, and `stateOf`/`snapshot` read them.
   */
  readonly projections = new SessionProjectionRegistry();
  /**
   * Transcripts already folded, oldest entry first, so the least recently read one is the one evicted.
   *
   * The run loop reads a session's history several times per round — the context builder, the pre-step
   * hook and the title path — and every one of those reads used to re-parse and re-fold the whole log, so
   * the cost of a run grew with the square of its length. The cache is bounded rather than unbounded
   * because an agent-host process outlives the sessions it reads.
   */
  private logCache = new Map<string, LogCacheEntry>();
  /** Events appended inside an open transaction, folded into the cache when that transaction commits. */
  private pendingLog: Map<string, SessionEvent[]> | null = null;
  /** Messages appended but not yet written, per session: one commit per batch instead of one per message. */
  private pendingAppends = new Map<string, QueuedMessage[]>();
  constructor(file: string, options: { backupRetention?: BackupPolicy } = {}) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.releaseDatabase = registerDatabase(file);
    try {
      this.db = new DatabaseSync(file);
      this.checkpoints = new SessionCheckpoints({
        db: this.db,
        projections: this.projections,
        transaction: (fn) => this.transaction(fn),
        checkedLog: (id) => this.checkedLog(id),
        events: (id, afterSeq, limit) => this.events(id, afterSeq, limit),
        flush: (id) => this.flush(id),
      });
      this.search = new SessionSearch({
        db: this.db,
        flush: (id) => this.flush(id),
        get: (id) => this.get(id),
      });
      this.changes = new SessionFileChanges({
        db: this.db,
        transaction: (fn) => this.transaction(fn),
        get: (id) => this.get(id),
        append: (id, message) => this.append(id, message),
        prepareFileChangeGroup: (sessionId, change, files) =>
          this.prepareFileChangeGroup(sessionId, change, files),
        markFileChange: (id, status) => this.markFileChange(id, status),
        fileChangeBytes: (sessionId, id) => this.fileChangeBytes(sessionId, id),
      });
      this.schema = new SessionMigrations({
        db: this.db,
        transaction: (fn) => this.transaction(fn),
      });
      this.plans = new SqlitePlanStore(this.db, (id) => {
        this.get(id);
      });
      /**
       * The task journal, given this store as its port.
       *
       * Constructed here, once the connection exists, and it borrows the store's own members rather than a copy:
       * `transaction` is what makes a multi-write task transition atomic, and `recordEvent` is what puts the same
       * change in the log. The methods below forward to it, so every existing caller keeps the signature it had
       * (see `./session-tasks.ts`).
       */
      this.tasks = new TaskJournal({
        db: this.db,
        transaction: (fn) => this.transaction(fn),
        getTask: (sessionId, id) => this.getTask(sessionId, id),
        getTaskAttempt: (sessionId, taskId, attemptId) =>
          this.getTaskAttempt(sessionId, taskId, attemptId),
        hasPendingTaskEffects: (sessionId, taskId, attemptId) =>
          this.hasPendingTaskEffects(sessionId, taskId, attemptId),
        settleAbandonedRun: (sessionId, runId, reason) =>
          this.settleAbandonedRun(sessionId, runId, reason),
        recordEvent: (id, type, data, stored) => this.recordEvent(id, type, data, stored),
      });
      /**
       * The stream checkpoints, given the four members it borrows: the connection, the transaction wrapper, and
       * the two writes that must go through the same log (`append`, `recordEvent`).
       */
      this.streams = new StreamCheckpoints({
        db: this.db,
        transaction: (fn) => this.transaction(fn),
        append: (id, message) => this.append(id, message),
        recordEvent: (id, type, data, stored) => this.recordEvent(id, type, data, stored),
      });
      /**
       * The session-lifecycle collaborator. Its two cache members are handed over as operations rather than
       * references: this module may say a session's cached rows are stale, not reach into the caches itself.
       */
      this.lifecycle = new SessionLifecycle({
        db: this.db,
        transaction: (fn) => this.transaction(fn),
        get: (id) => this.get(id),
        recordEvent: (id, type, data, stored) => this.recordEvent(id, type, data, stored),
        dropLogCache: (id) => {
          this.logCache.delete(id);
        },
        dropPendingAppends: (id) => {
          this.pendingAppends.delete(id);
        },
      });
      for (const projection of BUILT_IN_SESSION_PROJECTIONS) this.projections.register(projection);
      initializeDatabase(file, () => this.initialize(file, options));
    } catch (error) {
      try {
        this.db?.close();
      } catch {
        /* A refusal may already have closed it. */
      }
      this.releaseDatabase?.();
      throw error;
    }
  }
  private initialize(file: string, options: { backupRetention?: BackupPolicy }): void {
    return this.schema.initialize(file, options);
  }
  /**
   * The upgrade path as data, for a caller that wants to check it rather than run it.
   *
   * Exposed because the property worth testing here is a property of the *list* — ordered, reachable, reaching
   * this build — and a test cannot assert that about a run of statements it cannot see.
   */
  migrationSteps(): { from: number; upTo: number }[] {
    return this.schema.migrationSteps();
  }
  prepareFileChange(
    sessionId: string,
    change: FileChange,
    before: Uint8Array | null,
    after: Uint8Array,
  ): string {
    return this.changes.prepareFileChange(sessionId, change, before, after);
  }
  prepareFileChangeGroup(sessionId: string, change: FileChange, files: FileSnapshot[]): string {
    return this.changes.prepareFileChangeGroup(sessionId, change, files);
  }
  markFileChange(id: string, status: StoredFileChange['status']): void {
    return this.changes.markFileChange(id, status);
  }
  completeFileUndo(sessionId: string, id: string, notice: string): void {
    return this.changes.completeFileUndo(sessionId, id, notice);
  }
  fileChanges(sessionId: string): StoredFileChange[] {
    return this.changes.fileChanges(sessionId);
  }
  fileChangeSnapshots(sessionId: string, id: string): FileSnapshot[] {
    return this.changes.fileChangeSnapshots(sessionId, id);
  }
  fileChangeBytes(sessionId: string, id: string): { before: Buffer | null; after: Buffer } {
    return this.changes.fileChangeBytes(sessionId, id);
  }
  /**
   * Sub-agent summaries from the most recent finished run.
   *
   * They are read back out of the parent's durable log: `subagent.assigned` records that a child exists,
   * `subagent.finished` how it ended, and `subagent.interrupted` what crash recovery found. The child
   * session holds the transcript and the file-change journal holds the effects, so a summary stays derived
   * data — but it is now derived from the record rather than stored beside it.
   *
   * Each card is completed with the child's own turn timing, folded from that child session's log. It is the
   * one figure the parent's log cannot answer — the parent records one assignment and one end per turn, so a
   * resident child's later turns have no start of their own there — and a catalog that showed a delegated
   * child's age instead of its work time would be measuring the wrong thing.
   */
  subagents(sessionId: string): SubAgentSummary[] {
    return subAgentCards(this.stateOf<SubAgentCardsState>('subagents', sessionId)).map((card) =>
      card.sessionId ? this.withTurnTiming(card) : card,
    );
  }
  /** One child card plus the timing of the session that holds its work. */
  private withTurnTiming(card: SubAgentSummary): SubAgentSummary {
    const timing = this.turnTiming(card.sessionId);
    return { ...card, durationMs: timing.settledMs, runningSince: timing.runningSince };
  }
  /**
   * How long this session's runs have been active, folded from its own run boundaries.
   *
   * Asked for a child session as often as for the session being read: a sub-agent's duration is its own
   * session's work time, so the same fold answers both and there is no second tally to drift from it.
   */
  turnTiming(sessionId: string): TurnTiming {
    return this.stateOf<TurnTiming>('turnTiming', sessionId);
  }
  /**
   * The `messages` rows as they are on disk, which is the one read that can disagree with the transcript.
   *
   * The transcript is folded from the log, so this is the write-through side of the I8 promise: both are
   * written from a single call, and a divergence here is the only way to see that the two halves of that
   * call stopped agreeing. It is also what a second connection would read, minus the connection.
   */
  messagesFromTable(sessionId: string): Message[] {
    this.get(sessionId);
    this.flush(sessionId);
    return this.db
      .prepare('SELECT body FROM messages WHERE session_id=? ORDER BY seq')
      .all(sessionId)
      .map((row) => this.hydrateMessage(JSON.parse(String(row.body))) as Message);
  }
  /**
   * The session's checklist as the model last wrote it.
   *
   * Read from the log like the sub-agent cards: the latest `todo.written` *is* the list, so a reload rebuilds
   * the checklist from the record rather than from a table that could disagree with it.
   */
  todos(sessionId: string): TodoItem[] {
    return this.stateOf<TodoItem[]>('todos', sessionId);
  }
  /**
   * What the most recent `todo_write` changed about the checklist — `null` when nothing has been written yet
   * or when the last write left the plan exactly as it was.
   *
   * Derived from the log like every other projection, so a session restored after a restart answers this the
   * same way the process that wrote it did, without a column beside the events that could disagree with them.
   */
  todoChange(sessionId: string): TodoChange | null {
    return this.stateOf<{ todos: TodoItem[]; change: TodoChange | null }>('todoChange', sessionId)
      .change;
  }
  /**
   * The files this session presented as deliverables, folded from the log.
   *
   * Read rather than stored beside the events for the same reason the checklist is: the presentation is a
   * record of what the model said, and a table would be a second copy of it that a crash could leave behind.
   */
  deliverables(sessionId: string): PresentedFile[] {
    return this.stateOf<PresentedFile[]>('deliverables', sessionId);
  }
  /** The objective this session is pursuing, or `null` when no run has recorded one. */
  goal(sessionId: string): Goal | null {
    return this.stateOf<Goal | null>('goal', sessionId);
  }
  close(): void {
    this.eventObservers.clear();
    // A store that closes writes what it was given. This is the one write that does not report a failure:
    // `close` runs in teardown paths, where throwing would replace the error that caused the shutdown.
    // Everything that promises durability — `flush` and every read — is loud about a write that failed.
    try {
      this.flush();
      // Only the sessions this process actually read (they are what the log cache holds): checkpointing every
      // session in the database on the way out would make closing a store cost as much as reading all of it.
      // The list is copied because folding a projection re-inserts the session's cache entry, and a Map that is
      // re-inserted into while it is being iterated hands the same key back forever.
      for (const id of [...this.logCache.keys()]) this.saveProjectionCheckpoints(id);
    } catch {
      // Left unwritten deliberately: the caller was told by `flush` if it asked, and asking is what promises.
    }
    this.logCache.clear();
    this.pendingLog = null;
    this.pendingAppends.clear();
    this.db.close();
    this.releaseDatabase?.();
  }
  /**
   * A delegated child's session. `parent_session_id` records the lineage, and both lineage columns
   * were already present (v11) for features that had not been built yet: a sub-agent child is a
   * session with a parent **and no fork count**, while a session fork (still unimplemented) is a
   * session with a parent **and** a fork count. Every predicate below relies on that distinction,
   * because the two relationships must not share behaviour: a child is hidden from `list()` and dies
   * with its parent, whereas a fork is an independent conversation that must survive the original.
   */
  create(workspace: string, parentSessionId?: string): Session {
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    if (parentSessionId !== undefined) {
      const parent = this.get(parentSessionId);
      if (path.resolve(workspace) !== parent.workspace)
        throw new Error('A child session must share its parent workspace');
    }
    this.db
      .prepare('INSERT INTO sessions(id,workspace,created_at,parent_session_id) VALUES(?,?,?,?)')
      .run(id, path.resolve(workspace), createdAt, parentSessionId ?? null);
    return this.get(id);
  }
  createTask(sessionId: string, input: TaskCreate): Task {
    this.get(sessionId);
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
    this.db
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
    this.get(sessionId);
    const row = this.db
      .prepare(`${TASK_SELECT} WHERE t.session_id=? AND t.id=?`)
      .get(sessionId, id);
    if (!row) throw new Error(`Task not found: ${id}`);
    return taskFromRow(row);
  }
  listTasks(sessionId: string, status?: TaskStatus): Task[] {
    this.get(sessionId);
    if (status !== undefined && !taskStatuses.has(status)) throw new Error('Invalid task status');
    return this.db
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
    return this.db
      .prepare(
        `${TASK_SELECT} WHERE t.trigger IS NOT NULL AND (? IS NULL OR t.session_id IN (SELECT id FROM sessions WHERE workspace=?)) ORDER BY t.next_run_at IS NULL,t.next_run_at,t.id`,
      )
      .all(workspace ?? null, workspace ?? null)
      .map((row) => taskFromRow(row));
  }
  updateTask(sessionId: string, id: string, update: TaskUpdate): Task {
    return this.transaction(() => {
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
      this.db
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
        this.db.prepare('DELETE FROM task_approvals WHERE task_id=?').run(id);
        this.db.prepare('UPDATE tasks SET current_delivery_id=NULL WHERE id=?').run(id);
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
    return this.transaction(() => {
      const task = this.getTask(sessionId, id);
      if (task.status === 'in_progress') throw new Error('Task is running');
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== task.updatedAt)
        throw new Error('Task changed; reload before saving');
      const draft = normalizeTaskDraft(input);
      const now = nextTaskTimestamp(task.updatedAt);
      this.db
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
      this.db.prepare('DELETE FROM task_step_checkpoints WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM task_approvals WHERE task_id=?').run(id);
      return this.getTask(sessionId, id);
    });
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
  ) {
    return this.tasks.startTaskAttempt(sessionId, taskId, input);
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
  ) {
    return this.tasks.finishTaskAttempt(sessionId, taskId, attemptId, input);
  }
  getTaskAttempt(sessionId: string, taskId: string, attemptId: string) {
    return this.tasks.getTaskAttempt(sessionId, taskId, attemptId);
  }
  listTaskAttempts(sessionId: string, taskId: string) {
    return this.tasks.listTaskAttempts(sessionId, taskId);
  }
  checkpointTaskStep(
    sessionId: string,
    taskId: string,
    input: { attemptId: string; index: number; status: TaskStepStatus; note?: string },
  ) {
    return this.tasks.checkpointTaskStep(sessionId, taskId, input);
  }
  taskStepCheckpoints(sessionId: string, taskId: string) {
    return this.tasks.taskStepCheckpoints(sessionId, taskId);
  }
  completedStepIndexes(taskId: string) {
    return this.tasks.completedStepIndexes(taskId);
  }
  beginTaskEffect(sessionId: string, taskId: string, attemptId: string, toolName: string) {
    return this.tasks.beginTaskEffect(sessionId, taskId, attemptId, toolName);
  }
  completeTaskEffect(sessionId: string, taskId: string, effectId: string) {
    return this.tasks.completeTaskEffect(sessionId, taskId, effectId);
  }
  hasPendingTaskEffects(sessionId: string, taskId: string, attemptId?: string) {
    return this.tasks.hasPendingTaskEffects(sessionId, taskId, attemptId);
  }
  deferTaskApproval(sessionId: string, taskId: string, approval: Approval) {
    return this.tasks.deferTaskApproval(sessionId, taskId, approval);
  }
  resolveTaskApproval(
    sessionId: string,
    taskId: string,
    allow: boolean,
    expectedApprovalId: string,
  ) {
    return this.tasks.resolveTaskApproval(sessionId, taskId, allow, expectedApprovalId);
  }
  consumeTaskApproval(sessionId: string, taskId: string, approval: Approval) {
    return this.tasks.consumeTaskApproval(sessionId, taskId, approval);
  }
  clearApprovedTaskApproval(sessionId: string, taskId: string, expectedRule?: string) {
    return this.tasks.clearApprovedTaskApproval(sessionId, taskId, expectedRule);
  }
  claimTaskSchedule(task: Task, source: TaskTriggerSource, scheduledAt?: string) {
    return this.tasks.claimTaskSchedule(task, source, scheduledAt);
  }
  skipTaskSchedule(task: Task, now: Date) {
    return this.tasks.skipTaskSchedule(task, now);
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
  ) {
    return this.tasks.recordTaskRun(sessionId, taskId, input);
  }
  scheduleImmediateRun(sessionId: string, taskId: string, error?: string) {
    return this.tasks.scheduleImmediateRun(sessionId, taskId, error);
  }
  taskAttemptBaselines(sessionId: string, taskId: string, attemptId: string) {
    return this.tasks.taskAttemptBaselines(sessionId, taskId, attemptId);
  }
  latestRunAttemptBaselines(sessionId: string, taskId: string) {
    return this.tasks.latestRunAttemptBaselines(sessionId, taskId);
  }
  recoverInterruptedTasks(workspace?: string) {
    return this.tasks.recoverInterruptedTasks(workspace);
  }
  reconcileChildRuns(workspace?: string) {
    return this.tasks.reconcileChildRuns(workspace);
  }
  resumableTasks(workspace?: string) {
    return this.tasks.resumableTasks(workspace);
  }
  transitionTask(sessionId: string, id: string, status: TaskStatus) {
    return this.tasks.transitionTask(sessionId, id, status);
  }
  deleteTask(sessionId: string, id: string) {
    return this.tasks.deleteTask(sessionId, id);
  }
  get(id: string): Session {
    // Reading a session is reading its title, and a title written by an unwritten append is still the
    // session's title. The buffered messages go first so that what a reader is told is what is recorded.
    this.flush(id);
    const row = this.db
      .prepare(
        'SELECT id,workspace,created_at AS createdAt,active_run AS activeRun,title,parent_session_id AS parentSessionId FROM sessions WHERE id=?',
      )
      .get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    return row as unknown as Session;
  }
  /**
   * Sessions a sub-agent ran in, oldest first. They are excluded from `list()` so the user's session
   * list stays a list of conversations, but their transcripts stay in the store for auditing.
   */
  childSessions(parentSessionId: string): Session[] {
    this.get(parentSessionId);
    return this.db
      .prepare(
        'SELECT id,workspace,created_at AS createdAt,active_run AS activeRun,title,parent_session_id AS parentSessionId FROM sessions WHERE parent_session_id=? AND fork_message_count IS NULL ORDER BY created_at,rowid',
      )
      .all(parentSessionId) as unknown as Session[];
  }
  list(query = '', workspace?: string): Session[] {
    return this.search.list(query, workspace);
  }
  /**
   * Full-text search across this workspace's conversations, with the text that matched.
   *
   * `list(query)` answers "which sessions mention this"; this answers "where, and what did it say" — the model
   * asking "how did we solve this last time" needs the sentence, not the session id. Three properties are
   * deliberate:
   *
   * - **Ranked by session, not by row.** bm25 over the same `messages_fts` index the session list uses, summed
   *   over each session's matching messages: a conversation that mentions the words five times outranks one that
   *   mentions them once, which is the question "which conversation was this" rather than "which message scored
   *   best". Within a session the excerpts are ranked the same way, so the first line is the strongest evidence.
   * - **Bounded on every axis.** The query length, the sessions returned and the matches per session are all
   *   capped here rather than by the caller: a search that returns the whole database is the failure mode this
   *   exists to avoid, and a caller that forgets to bound it should not be able to.
   * - **The same visibility rule as the session list.** A sub-agent's child session is not a conversation of this
   *   workspace — it is reachable through `job_output` — so it is excluded unless asked for. Forks are included,
   *   because a fork *is* one of the user's conversations.
   * - **`parent` replaces that rule instead of narrowing it.** Asking for one session's children and then
   *   filtering them out again would be an empty answer to a question that has one, so `parent` is the scope
   *   rather than an extra condition on top of "conversations only". `activeOnly` is a separate axis and only
   *   ever narrows: sessions with a run recorded as in flight.
   *
   * A query with nothing indexable in it (punctuation, an empty string) matches nothing rather than throwing:
   * user text must never reach `MATCH` verbatim, and `ftsQuery` is where that is decided.
   */
  searchSessions(
    query: string,
    options: {
      workspace?: string;
      limit?: number;
      perSession?: number;
      includeChildren?: boolean;
      /** Sessions recorded as children of this id: the sub-agents it delegated to, and the forks branched from it. */
      parent?: string;
      /** Sessions whose `active_run` is set — the same recorded fact the session list shows, not a liveness probe. */
      activeOnly?: boolean;
      /**
       * Where to continue from, as returned by the previous page's `cursor`.
       *
       * Opaque on purpose: it encodes a position in *this* query's ordering, so a caller that changed the query,
       * the scope or the page size should not try to reuse one — the page it lands on would be from a different
       * list. It is bounded work, not a stable index into a growing table: the order is computed per call, so a
       * session appended between two pages can shift what the next page holds. That is the same trade every
       * search over a changing corpus makes, and the reason this returns a cursor rather than promising offsets.
       */
      cursor?: string;
    } = {},
  ): SessionSearchPage {
    return this.search.searchSessions(query, options);
  }
  /**
   * Plans live in their own table rather than on the task row.
   *
   * `replaceTaskDefinition` clears a task's verification, step checkpoints and approvals and forces
   * its status back to `pending`, so an approval stored on the task would be destroyed by any later
   * re-propose. The plan row is independent of the task lifecycle by construction.
   */
  createPlan(sessionId: string, runId?: string): Plan {
    return this.plans.createPlan(sessionId, runId);
  }
  /** Records which run is filling in a plan, so a stale `planning` row is diagnosable. */
  linkPlanRun(sessionId: string, planId: string, runId: string): void {
    return this.plans.linkPlanRun(sessionId, planId, runId);
  }
  getPlan(sessionId: string, planId: string): Plan {
    return this.plans.getPlan(sessionId, planId);
  }
  /** The most recent plan for a session, which is the one the UI shows. */
  latestPlan(sessionId: string): Plan | null {
    return this.plans.latestPlan(sessionId);
  }
  /**
   * The plan mode a session is in, as durable state rather than as a request parameter.
   *
   * Plan mode is a promise that a run cannot change anything, and it outlives the request that started it: the
   * planning run can be stopped, killed, or left behind by a restart. The row is the state — a plan still
   * `planning` means nobody has decided anything yet, so the next run of that session is *continuing* the plan —
   * while a row that was submitted, approved, rejected or abandoned has had its decision recorded and is no
   * longer plan mode.
   *
   * A function rather than a method on one call site because the rule is the same everywhere it is asked: the
   * CLI's `resume` and the Host's `run.start` both need it, and a rule written twice is a rule that can come
   * apart (it did: the CLI continued planning and the Host ran with the full tool set).
   */
  planMode(sessionId: string): { planId: string } | null {
    return this.plans.planMode(sessionId);
  }
  /** Records the agent's plan body and moves the row to `proposed`. */
  submitPlan(sessionId: string, planId: string, body: PlanBody): Plan {
    return this.plans.submitPlan(sessionId, planId, body);
  }
  /**
   * Approves a plan. `hash` is the digest the human actually reviewed, so approving a plan that was
   * edited in the meantime is refused rather than silently blessing text nobody read.
   */
  approvePlan(sessionId: string, planId: string, hash: string): Plan {
    return this.plans.approvePlan(sessionId, planId, hash);
  }
  rejectPlan(sessionId: string, planId: string, reason?: string): Plan {
    return this.plans.rejectPlan(sessionId, planId, reason);
  }
  /**
   * Resolves the plan that an execution run is allowed to follow. Both checks matter: the status
   * proves a human approved it, and the hash proves the approved text is still the text on the row —
   * otherwise an edit between approval and execution would run unreviewed work.
   */
  executablePlan(sessionId: string, planId: string): Plan {
    return this.plans.executablePlan(sessionId, planId);
  }
  /** Rename a session by hand; a manual name is never replaced by a generated one. */
  rename(id: string, title: string): Session {
    return this.lifecycle.rename(id, title);
  }
  /** Whether a model-generated title may still replace this session's own (see `./session-lifecycle.ts`). */
  canGenerateTitle(id: string): boolean {
    return this.lifecycle.canGenerateTitle(id);
  }
  /** Apply a model-generated title, unless a person has named the session in the meantime. */
  setGeneratedTitle(id: string, title: string, usage?: Usage): boolean {
    return this.lifecycle.setGeneratedTitle(id, title, usage);
  }
  /** Remove a session and its whole lineage; a sub-agent session never outlives its parent. */
  delete(id: string): void {
    this.lifecycle.delete(id);
  }
  /**
   * The message projection: the transcript is the fold of the durable log, not a table a second writer
   * could add to. Sessions written before schema v14 had their log backfilled by the migration, so this
   * reads the same history those sessions always had.
   */
  messages(id: string): Message[] {
    this.get(id);
    this.flush(id);
    return this.transcriptOf(id);
  }
  /**
   * The durable log, oldest first. `afterSeq` reads only what was appended since a checkpoint.
   *
   * `limit` is for a reader that *walks* a log rather than consuming it: the event reader a session's owner can
   * call needs a page, not the tail of a ten-thousand-event history held in memory to print fifty lines of it.
   * Without a limit the behaviour is unchanged, which is what every existing reader relies on.
   */
  events(id: string, afterSeq = 0, limit?: number): SessionEvent[] {
    // A reader must not be shown less than is recorded, so buffered appends are written before a read.
    this.flush(id);
    if (afterSeq === 0 && limit === undefined) return this.logOf(id).events;
    const cached = this.transactionDepth === 0 ? this.cachedLog(id) : undefined;
    if (cached) {
      // A delta read asks for a tail, and the cached log is ordered by seq, so the position is found by
      // bisection rather than by filtering the whole log: a reader that polls for new events should not pay for
      // the history it has already seen on every poll.
      let low = 0;
      let high = cached.events.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (cached.events[middle]!.seq <= afterSeq) low = middle + 1;
        else high = middle;
      }
      return frozen(cached.events.slice(low, limit === undefined ? undefined : low + limit));
    }
    // A delta read asks for a tail, not for the log, so it stays a bounded query instead of reading the
    // whole history to answer a question about its end.
    return frozen(this.readEvents(id, afterSeq, limit));
  }
  /**
   * The process record, read as a bounded page rather than as the log.
   *
   * `limit` is required because this is a cursor read: the caller asks for a page and gets the sequence to
   * continue from. The type filter is pushed into the query rather than applied to what came back, which is what
   * keeps a diagnostic reader from parsing — and failing on — message payloads it was never going to show.
   */
  auditEvents(id: string, afterSeq = 0, limit = 200): SessionEvent[] {
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error('Invalid audit cursor');
    this.get(id);
    this.flush(id);
    return frozen(this.readEvents(id, afterSeq, limit, AUDIT_SESSION_EVENTS));
  }
  private readEvents(
    id: string,
    afterSeq: number,
    limit?: number,
    types?: readonly string[],
  ): SessionEvent[] {
    return this.db
      .prepare(
        `SELECT seq,session_id AS sessionId,type,data,at FROM session_events WHERE session_id=? AND seq>?${
          types ? ` AND type IN (${types.map(() => '?').join(',')})` : ''
        } ORDER BY seq${limit === undefined ? '' : ' LIMIT ?'}`,
      )
      .all(id, afterSeq, ...(types ?? []), ...(limit === undefined ? [] : [limit]))
      .map((row) => ({
        seq: Number(row.seq),
        sessionId: String(row.sessionId),
        type: String(row.type),
        data: this.hydratePayload(JSON.parse(String(row.data)) as Record<string, unknown>),
        at: String(row.at),
      }));
  }
  /**
   * A stored image as a live one, or an error naming the address that could not be resolved.
   *
   * The error is the point: an image silently dropped on the way out would leave the model and the person
   * alike believing a screenshot was part of the conversation. An inline image — one written before schema
   * v21, or by a caller that stored something this build does not recognise — is returned untouched, so
   * hydration is idempotent and the two shapes coexist without a migration.
   */
  private hydrateImage(value: unknown): unknown {
    if (!isImageReference(value)) return value;
    const row = this.db
      .prepare('SELECT mime_type AS mimeType,bytes FROM attachment_blobs WHERE hash=?')
      .get(value.hash);
    if (!row) throw new Error(`Attachment ${value.hash} is missing from the session database`);
    const data = Buffer.from(row.bytes as Uint8Array).toString('base64');
    const reference = value as unknown as Record<string, unknown>;
    // `data` goes back exactly where `hash` was, so the hydrated image has the same key order the live one did
    // (`{data,mimeType}` from the attachment validator, `{mimeType,data,name}` from a tool). Key order is not
    // cosmetic here: I8 compares rows and fold as strings.
    return Object.fromEntries(
      Object.entries(reference).map(([key, entry]) => [
        key === 'hash' ? 'data' : key,
        key === 'hash' ? data : entry,
      ]),
    );
  }
  /** One message out of a row or a log payload, with every reference resolved back to bytes. */
  private hydrateMessage(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const images = (value as { images?: unknown }).images;
    if (!Array.isArray(images)) return value;
    return { ...value, images: images.map((image) => this.hydrateImage(image)) };
  }
  /**
   * One log payload, hydrated. `{message}` is the shape that carries model-visible bytes — the `message.*`
   * entries written by `writeMessages` — and every other payload is a fact about the session rather than part
   * of a transcript, so it is returned as it was read.
   */
  private hydratePayload(data: Record<string, unknown>): Record<string, unknown> {
    return 'message' in data ? { ...data, message: this.hydrateMessage(data.message) } : data;
  }
  /**
   * The inbox: inputs accepted for this session that no turn ever folded in.
   *
   * Read from the log rather than from a table, because the log is where the acceptance, the consumption and the
   * discard are written (see `input.queued` in `./events.ts`) and a second copy in a column would be a second
   * answer. Only the three inbox types are queried, so this stays cheap on a session with a long history, and
   * the answer is a snapshot: it is "what is left over", which is what a client shows and what a person sends
   * again.
   */
  pendingInputs(id: string): PendingSessionInput[] {
    this.flush(id);
    const rows = this.db
      .prepare(
        `SELECT seq,session_id AS sessionId,type,data,at FROM session_events
         WHERE session_id=? AND type IN ('input.queued','input.consumed','input.discarded') ORDER BY seq`,
      )
      .all(id)
      .map((row) => ({
        seq: Number(row.seq),
        sessionId: String(row.sessionId),
        type: String(row.type),
        data: JSON.parse(String(row.data)) as Record<string, unknown>,
        at: String(row.at),
      }));
    return foldPendingInputs(rows);
  }
  /**
   * Settle every input the inbox still shows as undelivered, and say how many there were.
   *
   * The log is the authority here, not the queue in memory: an entry is written when it is accepted, so
   * everything still pending — the live queue's contents included — is in the log, and a caller that only
   * cleared an array would leave the log saying the input is still waiting. That is what makes clearing work
   * for the leftovers of a run that already ended or crashed, which is when a person most needs it.
   */
  discardPendingInputs(id: string, reason: string): number {
    const ids = this.pendingInputs(id).map((item) => item.id);
    if (ids.length) this.recordEvent(id, 'input.discarded', { ids, reason });
    return ids.length;
  }
  /** The log of a session, from the cache when it is still current and read from the file when it is not. */
  private logOf(id: string): LogCacheEntry {
    const cached = this.transactionDepth === 0 ? this.cachedLog(id) : undefined;
    if (cached) return cached;
    // The version is sampled *before* the log is read, so a commit that lands during the read makes this entry
    // stale on its next use instead of being stamped with the newer version and hidden behind it.
    const dataVersion = this.dataVersion();
    const entry: LogCacheEntry = {
      events: frozen(this.readEvents(id, 0)),
      messages: null,
      readable: null,
      dataVersion,
    };
    // A read inside an open transaction sees that transaction's uncommitted rows, which a rollback would
    // make fiction; only a statement-level read is a read of committed state.
    if (this.transactionDepth === 0) this.rememberLog(id, entry);
    return entry;
  }
  /**
   * The transcript, folded on first ask and kept after that.
   *
   * The refusal lives in the fold, so it happens when a transcript is asked for and not when the log is: a reader
   * diagnosing a session written by a newer build can still read the log, and is stopped only where it would be
   * shown a shorter history. Every *other* derived answer goes through `checkedLog` for the same reason.
   */
  private transcriptOf(id: string): Message[] {
    const entry = this.logOf(id);
    entry.messages ??= frozen(foldMessages(entry.events));
    return entry.messages;
  }
  /**
   * The log, refusing an event this build cannot interpret, for a reader that is about to derive state from it.
   *
   * The check is over the *whole* log and once per loaded log, and both halves are deliberate. Whole, because a
   * projection that resumes from a checkpoint only folds the events after it: an unknown type before that point
   * was either seen (and refused) by the build that wrote the checkpoint or was written by a build that knew it,
   * and in the second case folding from the checkpoint would never notice. Once, because the answer cannot change
   * while the entry is current — another connection's commit drops the entry, exactly as it drops the transcript.
   */
  private checkedLog(id: string): readonly SessionEvent[] {
    const entry = this.logOf(id);
    if (entry.readable === null) {
      assertKnownEvents(entry.events);
      entry.readable = true;
    }
    return entry.events;
  }
  private cachedLog(id: string): LogCacheEntry | undefined {
    const entry = this.logCache.get(id);
    if (!entry) return undefined;
    if (entry.dataVersion !== this.dataVersion()) {
      // Another connection committed since this fold was taken, so the fold is a prefix of the log rather
      // than the log. Dropping it is what keeps a second writer's messages from being invisible here.
      this.logCache.delete(id);
      return undefined;
    }
    this.rememberLog(id, entry); // recency: the entry read most recently is the last one evicted
    return entry;
  }
  private rememberLog(id: string, entry: LogCacheEntry): void {
    this.logCache.delete(id);
    this.logCache.set(id, entry);
    while (this.logCache.size > LOG_CACHE_ENTRIES) {
      const oldest = this.logCache.keys().next().value;
      if (oldest === undefined) break;
      this.logCache.delete(oldest);
    }
  }
  /**
   * `PRAGMA data_version` is SQLite's own answer to "did somebody else write?", which is the one thing a
   * cache of a shared database cannot learn from its own bookkeeping: SQLite bumps it when another
   * connection commits and leaves it alone when this one does.
   */
  private dataVersion(): number {
    return Number(this.db.prepare('PRAGMA data_version').get()?.data_version ?? 0);
  }
  /**
   * The session's durable cursor: the seq of the newest record it has.
   *
   * This is what a live frame is stamped with. Every durable fact already has a seq — the log assigns it and
   * every reader uses it as a cursor — and the live channel used to carry no cursor at all, so a client that
   * lost frames had no way to say where it was up to and no way to find out that it had lost any: the only
   * recovery was to re-read the session from the beginning (or, in a carrier that owns its Host, to restart
   * it). Stamping each frame with the log position it is ordered against turns "how much have you seen?" into
   * a number the client can keep and hand back.
   *
   * Read through the same cache and the same freshness rule every other read uses, rather than from a counter
   * of its own. A second mechanism here would be a second answer: this process's own writes are folded into the
   * cached log as they happen, and another connection's commit invalidates that cache (SQLite's `data_version`),
   * so "where does the log end" cannot drift from what a reader would fold. An unflushed append is not durable
   * yet and so is not in the mark, which is the safe direction: the replay that follows a cursor re-reads those
   * events rather than skipping them.
   */
  lastSeq(id: string): number {
    const cached = this.transactionDepth === 0 ? this.cachedLog(id) : undefined;
    if (cached) return cached.events.at(-1)?.seq ?? 0;
    const seq = Number(
      this.db.prepare('SELECT MAX(seq) AS seq FROM session_events WHERE session_id=?').get(id)
        ?.seq ?? 0,
    );
    return seq;
  }
  /**
   * The newest payload of one event type in a session, or `undefined` when the session has none.
   *
   * For the questions whose answer is "what did the last one say" rather than "read me the history". The envelope
   * writer is the one that needs it: before it records a prompt and a tool catalogue, it asks whether this session
   * already holds them under the same digest, and a writer that read the whole log to answer that would make every
   * run pay for the session's entire past. The query walks the log backwards and stops at the first match, which
   * the `(session_id, seq)` index serves.
   */
  newestPayload(id: string, type: SessionEventType): Record<string, unknown> | undefined {
    const row = this.db
      .prepare(
        'SELECT data FROM session_events WHERE session_id=? AND type=? ORDER BY seq DESC LIMIT 1',
      )
      .get(id, type);
    if (!row) return undefined;
    const data: unknown = JSON.parse(String(row.data));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  }
  /**
   * Append one durable fact. Every state change goes through here, so the log stays the record.
   *
   * `stored` is the payload as it is written to disk when that differs from the payload in memory. It exists
   * for one case — a `message.*` entry whose images are content addresses on disk and bytes in this process —
   * so that a reader of the file pays for one copy of a picture while the fold that follows this very write
   * still hands the model the bytes.
   */
  recordEvent(
    id: string,
    type: SessionEventType,
    data: Record<string, unknown>,
    stored: Record<string, unknown> = data,
  ): void {
    // A fact never overtakes the appends it is ordered against, so buffered messages go first.
    if (this.transactionDepth === 0) this.flush(id);
    const at = new Date().toISOString();
    const written = this.db
      .prepare('INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)')
      .run(id, type, JSON.stringify(stored), at);
    const event: SessionEvent = {
      seq: Number(written.lastInsertRowid),
      sessionId: id,
      type,
      data,
      at,
    };
    if (this.transactionDepth > 0) {
      const pending = (this.pendingLog ??= new Map());
      const queued = pending.get(id);
      if (queued) queued.push(event);
      else pending.set(id, [event]);
      return;
    }
    try {
      this.extendLog(id, [event]);
    } catch {
      this.logCache.delete(id);
    }
    this.notifyCommitted([event]);
  }
  /**
   * Fold what was just appended into the cached transcript, so the read that follows a write costs the
   * new event rather than the whole history.
   *
   * The events are copied into the fold instead of referenced: a caller that keeps a reference to the
   * object it appended and changes it later must not be able to change a transcript the model has
   * already been shown.
   */
  private extendLog(id: string, appended: readonly SessionEvent[]): void {
    const entry = this.logCache.get(id);
    if (!entry) return;
    if (entry.dataVersion !== this.dataVersion()) {
      this.logCache.delete(id);
      return;
    }
    const stored = appended.map((event) => ({ ...event, data: structuredClone(event.data) }));
    this.rememberLog(id, {
      events: frozen([...entry.events, ...stored]),
      messages: entry.messages ? frozen(appendFoldedMessages([...entry.messages], stored)) : null,
      // Appended events come from `recordEvent`, whose type is this build's own, so a log already checked stays
      // checked; one that has not been checked stays unchecked and pays for the check when a derived read asks.
      readable: entry.readable,
      dataVersion: entry.dataVersion,
    });
  }
  /** Fold a committed transaction's events into the cache; a failed one leaves nothing behind. */
  private applyPendingLog(): void {
    const pending = this.pendingLog;
    this.pendingLog = null;
    if (!pending) return;
    try {
      for (const [id, events] of pending) this.extendLog(id, events);
    } catch {
      // Folding into the cache is an optimisation: if it will not take, the next read rebuilds instead.
      this.logCache.clear();
    }
    for (const events of pending.values()) this.notifyCommitted(events);
  }
  /**
   * Append a message to the session.
   *
   * Outside a transaction the message is buffered and written by `flush`, because a round appends several
   * messages in a row — the assistant message that requests tools, then one result per tool — and it was
   * the commits, not the rows, that cost: one transaction per message measured 0.74ms, and the same
   * messages written in one batch cost a fraction of that. Nothing observable changes: everything that
   * could read the message, or order another fact against it, flushes first.
   */
  append(id: string, message: Message): void {
    // Everything that can fail about appending happens here, at the call site: serialising the message,
    // projecting its search text, and computing the title a user message gives the session. A message that
    // cannot be written is refused now rather than poisoning a batch that is written later. Image bytes are
    // hashed here too, so the only thing `writeMessages` has left to do with them is insert them.
    const { stored, blobs } = storedMessage(message);
    const queued: QueuedMessage = {
      message,
      stored,
      body: JSON.stringify(stored),
      searchText: messageSearchText(message),
      blobs,
      title: message.role === 'user' ? sessionTitle(message) : null,
    };
    // Inside a transaction the batch is already the atomic unit; there is nothing left to coalesce.
    if (this.transactionDepth > 0) {
      this.writeMessages(id, [queued]);
      return;
    }
    const pending = this.pendingAppends.get(id);
    if (pending) pending.push(queued);
    else this.pendingAppends.set(id, [queued]);
    if ((pending?.length ?? 1) >= APPEND_BATCH_LIMIT) this.flush(id);
  }
  /**
   * Write what is buffered, and say so.
   *
   * `flush` is the point at which an append is promised to survive a crash. A reader of the session, an
   * event recorded for it, a run that ends and a store that closes all flush first, so the only appends
   * that a crash can lose are the ones a reader had not been shown yet. The safety barrier the run loop
   * adds to that list is the one that matters: the message naming a tool call is flushed *before* the
   * tool runs, because a crash mid-tool has to leave the record that lets recovery report the outcome as
   * unknown instead of letting the call be replayed as if it had never happened.
   */
  flush(id?: string): void {
    // Inside a transaction there is nothing to write here: `transaction` empties the buffer before it
    // opens, and an append made while it is open goes straight to the database (see `append`).
    if (this.transactionDepth > 0) return;
    // `transaction` flushes before it opens, and this is the flush it is calling: one pass, no recursion.
    if (this.flushing) return;
    const ids =
      id === undefined ? [...this.pendingAppends.keys()] : this.pendingAppends.has(id) ? [id] : [];
    if (!ids.length) return;
    this.flushing = true;
    try {
      this.transaction(() => {
        for (const sessionId of ids) {
          const messages = this.pendingAppends.get(sessionId);
          if (messages) this.writeMessages(sessionId, messages);
        }
      });
    } finally {
      this.flushing = false;
    }
    // Only after the commit: a batch that failed to write is left in the buffer rather than dropped.
    for (const sessionId of ids) this.pendingAppends.delete(sessionId);
  }
  private writeMessages(id: string, batch: readonly QueuedMessage[]): void {
    const insert = this.db.prepare(
      'INSERT INTO messages(session_id,body,search_text) VALUES(?,?,?)',
    );
    const insertBlob = this.db.prepare(
      'INSERT OR IGNORE INTO attachment_blobs(hash,mime_type,bytes,size,created_at) VALUES(?,?,?,?,?)',
    );
    const retitle = this.db.prepare("UPDATE sessions SET title=? WHERE id=? AND title=''");
    for (const queued of batch) {
      // Inside the same transaction as the row that names them: a message cannot be durable while the bytes
      // it refers to are not, and a rolled-back batch leaves no blob behind either.
      for (const blob of queued.blobs)
        insertBlob.run(blob.hash, blob.mimeType, blob.bytes, blob.size, new Date().toISOString());
      insert.run(id, queued.body, queued.searchText);
      // The log entry and the row are written together: the projection and the write-through table can
      // never disagree about what happened, and a crash cannot leave one without the other. The log gets the
      // stored shape while the live object keeps its bytes, so the fold that reads this process's own writes
      // still shows the model an image rather than a reference to one.
      this.recordEvent(
        id,
        messageEventType(queued.message),
        { message: queued.message },
        { message: queued.stored },
      );
      if (queued.title !== null) retitle.run(queued.title, id);
    }
  }
  /**
   * The surface a compaction defines: what stands in for the covered messages.
   *
   * The answer comes from the log alone, which is the point: "what is the model shown" used to be a row in
   * `context_checkpoints`, so the log and the table could disagree and only the table was believed. Deriving
   * it here means a session reopened in another process, or read by a tool that never opened the write path,
   * computes the same view the run did.
   */
  contextSurface(id: string): Surface | null {
    this.get(id);
    const ops = this.surfaceOps(id);
    return surfaceOf(ops);
  }
  /** Every compaction this session recorded, oldest first: the surface's history, not just its state. */
  surfaceHistory(id: string): SurfaceOp[] {
    this.get(id);
    return this.surfaceOps(id);
  }
  /**
   * How many times a round's model request has already been re-sent, counted in the log.
   *
   * The counter is the log rather than a field on the run or a variable in the loop, because a retry that was
   * recorded is a retry that happened: a host that dies during the backoff comes back to a session whose
   * attempts are already counted, and a reader can see the number the run acted on without asking the run.
   */
  /**
   * How many times a round has been retried, optionally scoped to one session.
   *
   * The session scope is an *index* on the query, not a second rule: `session_events` is keyed and indexed by
   * session, so a count that names the session is served by that index, while a count across the whole database
   * has to look at every session's retry records. Callers that know the session pass it; the two-argument form
   * keeps working, which is what the public API promises.
   */
  retryCount(runId: string, round: number, sessionId?: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_events WHERE ${
          sessionId === undefined ? '' : 'session_id=? AND '
        } type='llm.retry' AND json_extract(data,'$.runId')=? AND json_extract(data,'$.round')=?`,
      )
      .get(...(sessionId === undefined ? [runId, round] : [sessionId, runId, round]));
    return Number(row?.n ?? 0);
  }
  private surfaceOps(id: string): SurfaceOp[] {
    // The surface is a state derived from this log, so it answers only from a log this build can interpret — the
    // same rule the projections follow, and for the same reason: an event whose meaning is unknown could have
    // changed it, and a surface that quietly ignored one is a transcript cut in the wrong place.
    this.checkedLog(id);
    const rows = this.db
      .prepare(
        "SELECT seq,data FROM session_events WHERE session_id=? AND type='context.compacted' ORDER BY seq",
      )
      .all(id);
    return rows.map((row, index) =>
      this.surfaceOp(id, Number(row.seq), index + 1, JSON.parse(String(row.data))),
    );
  }
  /**
   * One recorded op, with its range checked against the transcript it claims to replace.
   *
   * The check is what makes a range worth recording. A count is a claim about position and quietly re-points
   * when the transcript changes under it; a pair of log positions either names the covered records or does
   * not, and the log is append-only, so a mismatch means this op and these messages are not the same
   * conversation. Refusing to derive a surface from that is the same choice the message fold makes for an
   * event it cannot interpret: better to stop than to show a history nobody recorded.
   */
  private surfaceOp(id: string, seq: number, generation: number, data: unknown): SurfaceOp {
    const payload = (data ?? {}) as Record<string, unknown>;
    const coveredMessages = Number(payload.coveredMessages);
    const summary = typeof payload.summary === 'string' ? payload.summary : '';
    if (!Number.isSafeInteger(coveredMessages) || coveredMessages < 1 || !summary.trim())
      throw new Error(
        `Session log event context.compacted at seq ${seq} does not describe a surface replacement`,
      );
    const seqs = this.messageSeqs(id, coveredMessages);
    if (seqs.length !== coveredMessages)
      throw new Error(
        `Session log event context.compacted at seq ${seq} covers ${coveredMessages} message(s), ` +
          `but this session only has ${seqs.length}; refusing to derive a surface from it`,
      );
    const startSeq = seqs[0]!;
    const endSeq = seqs[coveredMessages - 1]!;
    const recordedStart = Number(payload.startSeq);
    const recordedEnd = Number(payload.endSeq);
    if (
      Number.isSafeInteger(recordedStart) &&
      Number.isSafeInteger(recordedEnd) &&
      (recordedStart !== startSeq || recordedEnd !== endSeq)
    )
      throw new Error(
        `Session log event context.compacted at seq ${seq} claims to replace ${recordedStart}–${recordedEnd}, ` +
          `but ${coveredMessages} message(s) from seq ${startSeq}–${endSeq} are what it covers; the record and ` +
          'the transcript do not describe the same conversation',
      );
    return {
      generation,
      startSeq,
      endSeq,
      coveredMessages,
      summary,
      ...(payload.usage ? { usage: payload.usage as Usage } : {}),
      ...(Number.isSafeInteger(Number(payload.replacedChars))
        ? { replacedChars: Number(payload.replacedChars) }
        : {}),
      ...(Number.isSafeInteger(Number(payload.surfaceChars))
        ? { surfaceChars: Number(payload.surfaceChars) }
        : {}),
      // The envelope the summary ran under, carried back out for the same reason it is written: a reader of the
      // *surface* asks "what produced this?" as often as a reader of the raw log does, and a field the record
      // declares but the fold drops answers that question with silence.
      ...(typeof payload.protocol === 'string' ? { protocol: payload.protocol } : {}),
      ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      ...(Number.isSafeInteger(Number(payload.maxTokens))
        ? { maxTokens: Number(payload.maxTokens) }
        : {}),
      ...(typeof payload.rawOutput === 'string' ? { rawOutput: payload.rawOutput } : {}),
    };
  }
  /** Log positions of this session's message events, oldest first, capped at `limit`. */
  private messageSeqs(id: string, limit: number): number[] {
    return this.db
      .prepare(
        "SELECT seq FROM session_events WHERE session_id=? AND type IN ('message.user','message.assistant','message.tool') ORDER BY seq LIMIT ?",
      )
      .all(id, limit)
      .map((row) => Number(row.seq));
  }
  /**
   * Record a compaction: the messages it covers, and what replaces them.
   *
   * `usage` is what the summary request cost. It is a real model call, so the session's statistics fold it
   * in; it is not a run, so no run budget is charged for it. A caller that does not report usage leaves the
   * event exactly as it always was.
   *
   * `replacedChars`/`surfaceChars` are the price of the trade: what the conversation cost before, and what
   * it costs after. A summary that does not make it smaller is refused here rather than applied — compacting
   * a conversation into something larger is not a compaction, and the caller's alternative (keep the
   * history) is always available.
   *
   * `runId` is the write half of the compaction lock (`claimCompaction` is the acquire half): while a session
   * is held by a run, only that run may record a compaction for it. A session with no lease on record has no
   * competing writer to exclude, which is the store-level caller's path (a migration, a repair).
   *
   * `model`/`maxTokens` are the envelope the summary itself ran under: which model answered, and how much output
   * it was allowed. Together with the per-round `context.envelope` — which records the system prompt and the tool
   * catalogue the summary request replayed — they are what makes "this summary was produced like this" a question
   * the log answers, rather than one only the process that asked it could.
   */
  applyCompaction(
    id: string,
    input: {
      coveredMessages: number;
      summary: string;
      usage?: Usage;
      replacedChars?: number;
      cacheKnown?: boolean;
      surfaceChars?: number;
      runId?: string;
      /**
       * Which adapter answered the summary request, and which model, when the caller knows them.
       *
       * Recorded together because a reader reconstructing the summary needs both halves of the route: the model
       * alone does not say which wire protocol produced it, and the protocol alone does not say which model.
       */
      protocol?: string;
      model?: string;
      /** The output budget that summary request was given. */
      maxTokens?: number;
      /** The answer as it arrived, when storing it changed something (see `SurfaceOp.rawOutput`). */
      rawOutput?: string;
    },
  ): void {
    const lease = this.leaseOf(id);
    if (lease && lease.runId !== input.runId)
      throw new Error(
        `Another run is writing this session (run ${lease.runId}, pid ${lease.ownerPid}${ageSuffix(lease.renewedAt)}); ` +
          'the compaction was not recorded.',
      );
    const history = this.messages(id);
    if (
      !Number.isSafeInteger(input.coveredMessages) ||
      input.coveredMessages < 1 ||
      input.coveredMessages > history.length ||
      !contextBoundaries(history).includes(input.coveredMessages) ||
      !input.summary.trim()
    )
      throw new Error('Invalid context checkpoint boundary');
    const seqs = this.messageSeqs(id, input.coveredMessages);
    if (seqs.length !== input.coveredMessages)
      throw new Error(
        `The log has ${seqs.length} message(s); a compaction cannot cover ${input.coveredMessages}`,
      );
    if (
      input.replacedChars !== undefined &&
      input.surfaceChars !== undefined &&
      input.surfaceChars >= input.replacedChars
    )
      throw new Error(
        `Refusing a compaction that would not shrink the conversation: ${input.replacedChars} characters ` +
          `replaced by ${input.surfaceChars}`,
      );
    this.recordEvent(id, 'context.compacted', {
      coveredMessages: input.coveredMessages,
      startSeq: seqs[0]!,
      endSeq: seqs[input.coveredMessages - 1]!,
      summary: input.summary,
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.cacheKnown === undefined ? {} : { cacheKnown: input.cacheKnown }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.replacedChars !== undefined && input.surfaceChars !== undefined
        ? { replacedChars: input.replacedChars, surfaceChars: input.surfaceChars }
        : {}),
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
    });
  }
  private transactionDepth = 0;
  /** True while a flush is writing, so that the flush a transaction starts with is not attempted twice. */
  private flushing = false;
  /**
   * Runs `fn` in a transaction, or joins the one already open.
   *
   * SQLite has no nested transactions, and nesting is now easy to reach by accident: `beginRun` settles
   * a previously interrupted run, which appends a message, which writes its log entry — three levels that
   * must all land or none of them. Joining the open transaction is what makes that composition work
   * instead of throwing "cannot start a transaction within a transaction".
   */
  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    // A fact written inside this transaction must not overtake appends that are still buffered.
    this.flush();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      this.transactionDepth--;
      // Reads during the transaction bypassed the cache, because they had to see this transaction's own
      // uncommitted rows. Now that it has committed, the events it appended can be folded in as a batch.
      this.applyPendingLog();
      return value;
    } catch (error) {
      this.transactionDepth--;
      if (this.pendingLog) this.pendingLog = null;
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A commit that failed on its own has already ended the transaction; there is nothing to undo.
      }
      throw error;
    }
  }
  // An unresolved call may already have had effects: record uncertainty, never replay it.
  resolvePending(id: string, reason: string): number {
    const messages = this.messages(id);
    const pending = new Map<string, Message & { role: 'assistant' }>();
    for (const message of messages) {
      if (message.role === 'assistant')
        for (const call of message.toolCalls) pending.set(call.id, message);
      if (message.role === 'tool') pending.delete(message.toolCallId);
    }
    for (const callId of pending.keys())
      this.append(id, { role: 'tool', toolCallId: callId, isError: true, content: reason });
    return pending.size;
  }
  /**
   * Converge one run whose owning process is gone, and record the fact in the session's log.
   *
   * Every path that finds an abandoned run goes through here, because the three effects have to happen
   * together or not at all: the unresolved calls must be answered with uncertainty (they may have had
   * effects, so they are never replayed), the run row must stop saying `running`, and the session must stop
   * pointing at it. The last of those is why this is not just housekeeping — a stale `active_run` blocks
   * deleting the session and editing its history, so a crash used to leave a session that could not be
   * cleaned up until something else happened to converge it.
   *
   * The `run.interrupted` record is the part that replaces what the stale pointer was carrying: "this run
   * ended because its process died" belongs in the log, where a reader finds it next to the run's start,
   * rather than in a column that only says a run is *somewhere* in flight.
   */
  /**
   * Converge one run whose owning process is gone; the task journal settles a dead attempt through this.
   *
   * `private` would be the default, but the journal is a collaborator rather than a caller: it borrows exactly
   * this and the five other members named in the port it is constructed with.
   */
  settleAbandonedRun(sessionId: string, runId: string, reason: string): void {
    const pendingCalls = this.resolvePending(sessionId, reason);
    const step = this.inFlightStep(sessionId, runId);
    /**
     * Inputs the dead process was holding when it stopped.
     *
     * Counted here, where the interruption is already being described, because it is the same kind of fact as
     * `pendingCalls`: something was accepted and never happened. The inbox fold answers it too, but a reader
     * looking for the aftermath of a crash reads this record, and "a follow-up was waiting and was never sent"
     * is part of that aftermath. Left off the record when there was none, so absence means "nothing was
     * waiting" rather than "nobody counted".
     */
    const undelivered = this.pendingInputs(sessionId).length;
    /**
     * The plan this run was filling in, if it never finished filling it.
     *
     * The row was created before the planning run started, on purpose, so that a crash leaves a record rather than
     * nothing. What it must not keep saying is that somebody is still working on it: `planning` is a promise, and
     * the run that made it is gone. Moving it to `abandoned` keeps the record and drops the promise, and the count
     * rides the interruption record so a reader learns it where they learn about the crash.
     */
    const abandonedPlans = this.db
      .prepare(
        "UPDATE plans SET status='abandoned', updated_at=? WHERE run_id=? AND status='planning'",
      )
      .run(new Date().toISOString(), runId).changes;
    this.db
      .prepare("UPDATE runs SET status='interrupted' WHERE id=? AND status='running'")
      .run(runId);
    this.db.prepare('UPDATE sessions SET active_run=NULL WHERE active_run=?').run(runId);
    // The abandoned run's lease goes with it: it is presence, and the process that held it is gone. Only the
    // owner's own lease is cleared, so converging one run cannot release another run's hold on the session.
    this.db
      .prepare('DELETE FROM session_leases WHERE session_id=? AND run_id=?')
      .run(sessionId, runId);
    this.recordEvent(sessionId, 'run.interrupted', {
      runId,
      pendingCalls,
      reason,
      /**
       * The step it died in, when the run opened one.
       *
       * The first question a crash raises is "where was it?", and the answer is in the log already — a
       * `step.started` with no end — but only for a reader who knows to pair the boundaries up. Carrying the
       * number here means the record of the interruption answers it where somebody looks for the interruption,
       * and `null`-less absence means the process died before the run's first step, which is a different (and
       * equally useful) answer.
       */
      ...(step ? { step: step.step } : {}),
      ...(undelivered ? { undeliveredInputs: undelivered } : {}),
      ...(abandonedPlans ? { abandonedPlans } : {}),
    });
  }
  /**
   * The step a run left open in the log, or `null` when every step it opened was closed.
   *
   * Read from the log rather than kept in a column, for the same reason `retryCount` is counted from the log: a
   * second copy of "which step was in flight" is a second answer, and the one that survives a crash is the one
   * written before it. Only the two boundary types are read and the fold is bounded, so this stays cheap on a
   * session with a long history.
   */
  inFlightStep(sessionId: string, runId: string): StepRecord | null {
    const events = this.db
      .prepare(
        "SELECT type,data,at FROM session_events WHERE session_id=? AND type IN ('step.started','step.finished') ORDER BY seq",
      )
      .all(sessionId)
      .map((row) => ({
        type: String(row.type),
        data: JSON.parse(String(row.data)) as Record<string, unknown>,
        at: String(row.at),
      }));
    return openStepOf(foldSteps(events, { runId }));
  }
  /**
   * Converge every ordinary session a dead Host left with a run in flight.
   *
   * Run at startup, so reopening a workspace after a crash shows sessions that can be used, deleted or
   * edited, and shows the interruption in each session's own record. Only runs whose owner process is gone
   * are touched: another Host on the same workspace is a live owner, and its runs are left alone.
   *
   * Delegated child sessions are excluded because `reconcileChildRuns` converges them and additionally records
   * the interruption on the parent's log, where a reader of the parent can see it. A fork is not a child in that
   * sense — it is an ordinary conversation that happens to point at its source — so it is converged here.
   *
   * Every carrier that opens a workspace has to call this at startup, next to `reconcileChildRuns`: a
   * conversation is only usable again once something has looked at it, and a carrier that forgets leaves
   * sessions its own UI cannot delete, rename or continue. `tests/cli.test.ts` pins that for the CLI.
   */
  reconcileInterruptedRuns(workspace?: string): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT s.id AS sessionId, s.active_run AS runId, r.owner_pid AS ownerPid
           FROM sessions s JOIN runs r ON r.id=s.active_run
           WHERE (s.parent_session_id IS NULL OR s.fork_message_count IS NOT NULL)
             AND r.status='running' AND (? IS NULL OR s.workspace=?)`,
        )
        .all(workspace ?? null, workspace ?? null)
        .filter((row) => deadOwner(row.ownerPid));
      for (const row of rows)
        this.settleAbandonedRun(String(row.sessionId), String(row.runId), RUN_INTERRUPTED_REASON);
      return rows.length;
    });
  }
  /** Save a bounded-frequency recovery point while a provider is streaming visible text. */
  /** A durable recovery point for a run that is still streaming; see `./session-streams.ts`. */
  checkpointStream(id: string, runId: string, messageId: string, text: string): void {
    this.streams.checkpointStream(id, runId, messageId, text);
  }
  /** Fold one queued input into the transcript and settle its inbox entry, in one transaction. */
  consumeQueuedInput(id: string, inputId: string, message: Message): void {
    this.streams.consumeQueuedInput(id, inputId, message);
  }
  /** Commit a streamed answer and remove its recovery point atomically. */
  appendStreamMessage(id: string, runId: string, messageId: string, message: Message): void {
    this.streams.appendStreamMessage(id, runId, messageId, message);
  }
  /** Persist an unfinished answer once, without ever replaying incomplete tool calls. */
  persistStreamCheckpoint(id: string, runId: string): string {
    return this.streams.persistStreamCheckpoint(id, runId);
  }
  /** Converge only the streams whose owning process is gone; a live Host keeps writing its own rows. */
  recoverInterruptedStreams(workspace?: string): number {
    return this.streams.recoverInterruptedStreams(workspace);
  }
  beginRun(id: string): string {
    return this.transaction(() => {
      const session = this.get(id);
      if (session.activeRun) {
        const row = this.db.prepare('SELECT owner_pid FROM runs WHERE id=?').get(session.activeRun);
        let alive = false;
        if (row) {
          try {
            process.kill(Number(row.owner_pid), 0);
            alive = true;
          } catch (error) {
            alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        }
        if (alive)
          throw new Error(
            'This session is already running. Cancel or stop its owning process first.' +
              leaseEvidence(this.leaseOf(id)),
          );
        // The same convergence startup performs, in case this session was never read since the crash.
        this.settleAbandonedRun(id, session.activeRun, RUN_INTERRUPTED_REASON);
      }
      const runId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'running',?)",
        )
        .run(runId, id, process.pid, new Date().toISOString());
      this.db.prepare('UPDATE sessions SET active_run=? WHERE id=?').run(runId, id);
      /**
       * The lease is taken in the same transaction as the run row, so "this session has a writer" and "here is
       * which run" cannot disagree — the pair is what makes a refusal precise and a takeover safe.
       */
      this.db
        .prepare(
          `INSERT INTO session_leases(session_id,run_id,owner_pid,renewed_at,renewals,compacting_run_id)
           VALUES(?,?,?,?,0,NULL)
           ON CONFLICT(session_id) DO UPDATE SET
             run_id=excluded.run_id, owner_pid=excluded.owner_pid,
             renewed_at=excluded.renewed_at, renewals=0, compacting_run_id=NULL`,
        )
        .run(id, runId, process.pid, new Date().toISOString());
      this.recordEvent(id, 'run.started', { runId, ownerPid: process.pid });
      return runId;
    });
  }
  /**
   * The lease on a session, or `null` when nothing holds it.
   *
   * A reader, not a decision: the only code that *acts* on a lease is `beginRun` (mutual exclusion) and the
   * compaction lock. `renewedAt` is there so a refusal can say how long ago the owner last did anything.
   */
  leaseOf(sessionId: string): SessionLease | null {
    const row = this.db
      .prepare('SELECT * FROM session_leases WHERE session_id=?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      ownerPid: Number(row.owner_pid),
      renewedAt: String(row.renewed_at),
      renewals: Number(row.renewals),
      ...(row.compacting_run_id ? { compactingRunId: String(row.compacting_run_id) } : {}),
    };
  }
  /**
   * Records that the owning run is still working. Returns false when the session is no longer this run's.
   *
   * Called at every step boundary and on a timer while a request is in flight (`LEASE_RENEW_INTERVAL_MS`).
   * Nothing expires because of it — see `SessionLease`: it is how "last active" stays true during a long model
   * call rather than reporting a working run as idle.
   */
  renewLease(sessionId: string, runId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE session_leases SET renewed_at=?, renewals=renewals+1 WHERE session_id=? AND run_id=?',
      )
      .run(new Date().toISOString(), sessionId, runId);
    return Number(result.changes) > 0;
  }
  /** Gives up a lease this run holds. False means it is not ours any more, which is worth knowing. */
  releaseLease(sessionId: string, runId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM session_leases WHERE session_id=? AND run_id=?')
      .run(sessionId, runId);
    return Number(result.changes) > 0;
  }
  /**
   * Takes the compaction lock for a session, before the summary request is sent.
   *
   * The rule is one sentence: **a compaction may only be recorded by the run that holds the session**. The lock
   * is taken here so a run does not pay for a summary it will be refused at the write, and `applyCompaction`
   * re-checks the same rule — the two checkpoints are the acquire and the commit of one lock, not two locks.
   *
   * A session with no lease has no competing writer on record (a store-level caller, a migration), so there is
   * nothing to exclude; a lease held by a *different* run is exactly the case this refuses.
   */
  claimCompaction(sessionId: string, runId?: string): void {
    const lease = this.leaseOf(sessionId);
    if (!lease) return;
    if (lease.runId !== runId)
      throw new Error(
        `Another run is writing this session (run ${lease.runId}, pid ${lease.ownerPid}${ageSuffix(lease.renewedAt)}); ` +
          'a compaction was not attempted.',
      );
    if (lease.compactingRunId !== undefined)
      throw new Error(
        `A summary is already in flight for this session (run ${lease.compactingRunId}); a second compaction was not attempted.`,
      );
    this.db
      .prepare('UPDATE session_leases SET compacting_run_id=? WHERE session_id=?')
      .run(runId ?? null, sessionId);
  }
  /** Releases the compaction lock. Only the run that took it releases it, so a stale release is a no-op. */
  releaseCompaction(sessionId: string, runId?: string): void {
    this.db
      .prepare(
        'UPDATE session_leases SET compacting_run_id=NULL WHERE session_id=? AND compacting_run_id IS ?',
      )
      .run(sessionId, runId ?? null);
  }
  /**
   * One projection's state for a session, folded from the log.
   *
   * This is the reader-facing form: a view is whatever the log folds to, so the same session read twice
   * gives the same answer, and a session read by a build that does not know an event refuses rather than
   * showing a shorter history.
   *
   * A persisted checkpoint, when there is a usable one, is the *starting point* rather than the answer: the
   * events after it are folded on top, so the result is still "what the log folds to" — and when the
   * checkpoint has already reached the end of the log, nothing is folded at all. That is the difference
   * between this and a cache: a cache answers, this one only skips work whose answer is already written down.
   */
  stateOf<State>(name: string, sessionId: string): State {
    this.get(sessionId);
    const folded = this.foldProjections([name], sessionId).states.get(name);
    return (name === 'statistics' ? (folded as StatisticsState).statistics : folded) as State;
  }
  /** Every projection in one pass, for a host rendering a whole session. */
  snapshot(sessionId: string): Record<string, unknown> {
    this.get(sessionId);
    const folded = this.foldProjections(this.projections.names(), sessionId).states;
    const statistics = folded.get('statistics') as StatisticsState;
    folded.set('statistics', statistics.statistics);
    return Object.fromEntries(folded);
  }
  /**
   * Folds the requested projections, reading the log once and using each projection's own checkpoint.
   *
   * The read starts at the earliest checkpoint **only when every projection being folded has one**. A
   * projection without a checkpoint must be folded from the beginning, so one such projection (the transcript,
   * always) makes the read start at 0 — and the projections that do have checkpoints still skip the events
   * theirs already covered, so the fold work saved is theirs either way.
   *
   * A checkpoint is a *shortcut* to what the log says, never a second answer, so doubt about one is settled the
   * same way in every case: fold from the beginning. Two kinds of doubt are handled here.
   *
   * The **structure** is checked against the projection's own empty state, because a state that parses as JSON
   * but has the wrong shape is the corruption a fold will not necessarily notice: an `apply` that walks an array
   * which arrived as an object can produce a quietly wrong answer instead of an error.
   *
   * And the state must survive **one real fold step** before it is trusted — `trustedCheckpoint` below. That is
   * the case the structural check cannot cover and the one that matters most: when a checkpoint has already
   * reached the end of the log, nothing is folded on top of it, so a rotten state is not "corrected by the next
   * event" — it is handed to the caller verbatim. Proving the state against one actual event is what makes the
   * answer the same as the log's rather than merely shaped like it.
   */
  private foldProjections(
    names: readonly string[],
    sessionId: string,
  ): { states: Map<string, unknown>; seq: number } {
    return this.checkpoints.foldProjections(names, sessionId);
  }
  /**
   * How much folding reads have done in this process, for tests and benchmarks.
   *
   * `checkpointHits` says how many projection reads started from persisted state; `events` says how many
   * events those reads actually folded. They exist because "the checkpoint saved work" is otherwise a claim
   * nobody can check — the correctness tests compare against a full fold, and these numbers are what show the
   * fold did not happen.
   */
  foldStats(): { checkpointHits: number; events: number } {
    return this.checkpoints.foldStats();
  }
  resetFoldCounters(): void {
    return this.checkpoints.resetFoldCounters();
  }
  /**
   * Writes the folded state of this session's projections, so the next process reads instead of folds.
   *
   * Deliberately not called on every read: that would turn a read into a write. It is called where a run or a
   * process is already at a stopping point (`finishRun`, `close`) and can be called explicitly by a host.
   * Failures are swallowed — this is derived data, and a session that cannot be checkpointed must still be
   * readable.
   */
  saveProjectionCheckpoints(sessionId?: string): number {
    return this.checkpoints.saveProjectionCheckpoints(sessionId);
  }
  statistics(sessionId: string): SessionStatistics {
    return this.stateOf<SessionStatistics>('statistics', sessionId);
  }
  finishRun(result: RunResult): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE runs SET status=?,result=? WHERE id=?')
        .run(result.status, JSON.stringify(result), result.runId);
      this.db
        .prepare('UPDATE sessions SET active_run=NULL WHERE id=? AND active_run=?')
        .run(result.sessionId, result.runId);
      // The run stops being this session's writer the moment it stops writing. A lease left behind would be a
      // row claiming presence for a process that is done, and the next run would have to reason around it.
      this.db
        .prepare('DELETE FROM session_leases WHERE session_id=? AND run_id=?')
        .run(result.sessionId, result.runId);
      this.recordEvent(result.sessionId, 'run.finished', {
        runId: result.runId,
        status: result.status,
        // Usage is what the statistics projection folds; the full result row stays the record of record
        // for everything else, so a multi-megabyte payload is not duplicated into the log.
        usage: result.usage,
        ...(result.statistics ? { statistics: result.statistics } : {}),
        ...(result.compactionUsage ? { compactionUsage: result.compactionUsage } : {}),
        ...(result.error ? { error: redactSecrets(result.error).slice(0, 600) } : {}),
        // Why it ended, when the reason has a name. It rides the durable event rather than only the run row so
        // that "why did this fail?" is answerable from the log alone, and so a client that only follows events
        // learns as much as one that reads the row.
        ...(result.code ? { code: result.code } : {}),
        // The endpoint's own two facts about the call, when the failure came from one. They ride the event for
        // the same reason the code does: "it failed" is answerable from the log, and so is *what* the endpoint
        // said — which is what somebody has to quote when they ask the provider about it.
        ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      });
    });
    // After the run is closed, not inside it: the checkpoint is derived data, and a failure to write it must not
    // be able to fail the run's own transaction. `saveProjectionCheckpoints` swallows its errors for the same
    // reason.
    this.saveProjectionCheckpoints(result.sessionId);
  }
}
