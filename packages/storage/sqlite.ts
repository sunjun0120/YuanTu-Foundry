import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Surface, SurfaceOp } from '../protocol/context.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import { type Goal } from '../protocol/goals.ts';
import type {
  Acceptance,
  Approval,
  CompletionRecord,
  CompletionSummary,
  FileChange,
  FileSnapshot,
  Message,
  Plan,
  RunResult,
  SubAgentSummary,
  Task,
  TaskAttemptKind,
  TaskStatus,
  TaskStep,
  TaskStepStatus,
  TaskTrigger,
  TaskTriggerSource,
  TodoItem,
  Usage,
} from '../protocol/index.ts';
import type { PlanBody, PlanRepository } from '../protocol/plans.ts';
import type { SessionLease } from '../protocol/session-lease.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { StepRecord } from '../protocol/steps.ts';
import type { TodoChange } from '../protocol/todos.ts';
import type {
  WorkspaceApplyReceipt,
  WorkspaceBinding,
  WorkspaceResult,
  WorkspaceResultStatus,
  WorkspaceSnapshot,
  WorkspaceState,
} from '../protocol/workspaces.ts';
import { initializeDatabase, registerDatabase, type BackupPolicy } from './database-maintenance.ts';
import { type PendingSessionInput, type SessionEvent, type SessionEventType } from './events.ts';
import { SqlitePlanStore } from './plans.ts';
import type { StatisticsState, SubAgentCardsState, TurnTiming } from './projections.ts';
import {
  BUILT_IN_SESSION_PROJECTIONS,
  SessionProjectionRegistry,
  subAgentCards,
} from './projections.ts';
import { SessionCheckpoints } from './session-checkpoints.ts';
import { SessionCompletion } from './session-completion.ts';
import { SessionContext } from './session-context.ts';
import { SessionEventJournal } from './session-event-journal.ts';
import { SessionFileChanges } from './session-file-changes.ts';
import { SessionLifecycle } from './session-lifecycle.ts';
import { SessionMigrations } from './session-migrations.ts';
import { SessionRuns } from './session-runs.ts';
import type {
  Session,
  SessionSearchPage,
  StoredFileChange,
  TaskCreate,
  TaskUpdate,
} from './session-schema.ts';
import { SessionSearch, type SessionListPage } from './session-search.ts';
import { StreamCheckpoints } from './session-streams.ts';
import { SessionTaskDefinitions } from './session-task-definitions.ts';
import { TaskJournal } from './session-tasks.ts';
import { SessionWorkspaces } from './session-workspaces.ts';
export { normalizePlanBody, planHash } from '../protocol/plans.ts';
export type { PlanBody } from '../protocol/plans.ts';
export { LEASE_RENEW_INTERVAL_MS } from '../protocol/session-lease.ts';
export type { SessionLease } from '../protocol/session-lease.ts';
export {
  canTransition,
  isWorkspaceFailure,
  isWorkspaceMode,
  isWorkspaceState,
  workspaceBindingFrom,
  WorkspaceFailure,
  workspaceResultFrom,
  workspaceSnapshotFrom,
} from '../protocol/workspaces.ts';
export type {
  WorkspaceApplyReceipt,
  WorkspaceBinding,
  WorkspaceFailureCode,
  WorkspaceKind,
  WorkspaceMode,
  WorkspaceResult,
  WorkspaceResultStatus,
  WorkspaceSnapshot,
  WorkspaceState,
} from '../protocol/workspaces.ts';
export { hashesIn, imageHash, sessionTitle, storedMessage } from './session-blobs.ts';
export type { QueuedBlob } from './session-blobs.ts';
/**
 * The workspace vocabulary is re-exported for the same reason the row shapes are: a caller that has to name a
 * state, a failure code or a binding should not have to know which package physically declares it.
 */
import { WorkspaceFailure } from '../protocol/workspaces.ts';
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
  ftsQuery,
  MAX_SEARCH_MATCHES,
  MAX_SEARCH_SESSIONS,
  messageSearchText,
  projectionFoldIdentity,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
  SESSION_DATABASE_POLICY,
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
export class SessionStore implements PlanRepository {
  private readonly journal: SessionEventJournal;

  private readonly taskDefinitions: SessionTaskDefinitions;
  private readonly completion: SessionCompletion;
  private readonly context: SessionContext;
  private readonly runJournal: SessionRuns;
  observeEvents(listener: (event: SessionEvent) => void, types?: ReadonlySet<string>): () => void {
    return this.journal.observeEvents(listener, types);
  }
  private readonly schema: SessionMigrations;
  private readonly changes: SessionFileChanges;
  private readonly search: SessionSearch;
  private readonly checkpoints: SessionCheckpoints;
  private db!: DatabaseSync;
  private readonly file: string;
  private releaseDatabase?: () => void;
  private readonly plans: SqlitePlanStore;
  /** The task execution journal; this class forwards to it (see `./session-tasks.ts`). */
  private readonly tasks: TaskJournal;
  /** Streamed-answer recovery points; this class forwards to it (see `./session-streams.ts`). */
  private readonly streams: StreamCheckpoints;
  /** Renaming, generated titles and deletion; this class forwards to it (see `./session-lifecycle.ts`). */
  private readonly lifecycle: SessionLifecycle;
  /**
   * Durable execution bindings: which directory a session actually works in.
   *
   * Deliberately separate from `Session.workspace`, which keeps meaning *the logical project* the run belongs to
   * — session lists, ownership checks and the scheduler all read that. A sub-agent's directory is a second fact,
   * and this is where it lives; see `./session-workspaces.ts` for why the two must not be merged.
   */
  private readonly workspaces: SessionWorkspaces;
  /**
   * The projections a reader can fold the log with. The store hosts them because it owns the log; a host
   * that wants its own views registers them here, and `stateOf`/`snapshot` read them.
   */
  readonly projections = new SessionProjectionRegistry();
  /**
   * The files this store keeps its own state in: the database and the two sidecar files SQLite writes beside it.
   *
   * Exposed because a verifier that fingerprints a workspace has to exclude state the *runtime* is writing —
   * otherwise a session whose database lives inside its workspace would invalidate its own evidence on every
   * round, and a task could never pass. It is the resolved paths and not a `.sqlite` suffix rule: excluding every
   * file that ends that way would silently skip a user's own SQLite resource, which is source.
   */
  databaseFiles(): string[] {
    if (this.file === ':memory:') return [];
    const file = path.resolve(this.file);
    // `-wal`, `-shm` and `-journal` are SQLite's own sidecars; `.users` is the access-control record the sandbox
    // backend keeps beside the database. All four are written by the runtime rather than by the work.
    return [file, `${file}-wal`, `${file}-shm`, `${file}-journal`, `${file}.users`];
  }
  constructor(file: string, options: { backupRetention?: BackupPolicy } = {}) {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.file = file === ':memory:' ? file : path.resolve(file);
    this.releaseDatabase = registerDatabase(file);
    try {
      this.db = new DatabaseSync(file);
      this.journal = new SessionEventJournal({ db: this.db, get: (id) => this.get(id) });
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
        completionVerificationRounds: (sessionId, attemptId) =>
          this.completionVerificationRounds(sessionId, attemptId),
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
          this.journal.dropLogCache(id);
        },
        dropPendingAppends: (id) => {
          this.journal.dropPendingAppends(id);
        },
      });
      /**
       * The workspace bindings, given the connection, the transaction wrapper and one read of the session's own
       * project. It borrows `get` rather than a copy of the workspace string because the ownership check it makes
       * has to be against what the row says *now*: a session whose project was edited after a binding was written
       * is a binding that no longer describes where the session belongs.
       */
      this.workspaces = new SessionWorkspaces({
        db: this.db,
        transaction: (fn) => this.transaction(fn),
        sessionProject: (sessionId) => {
          const session = this.get(sessionId);
          return {
            workspace: session.workspace,
            parentSessionId: session.parentSessionId ?? null,
          };
        },
      });
      this.taskDefinitions = new SessionTaskDefinitions({
        db: this.db,
        get: (id) => this.get(id),
        transaction: (fn) => this.transaction(fn),
      });
      this.completion = new SessionCompletion({ db: this.db });
      this.context = new SessionContext({
        db: this.db,
        get: (id) => this.get(id),
        checkedLog: (id) => this.checkedLog(id),
        leaseOf: (id) => this.leaseOf(id),
        messages: (id) => this.messages(id),
        recordEvent: (id, type, data) => this.recordEvent(id, type, data),
      });
      this.runJournal = new SessionRuns({
        db: this.db,
        transaction: (fn) => this.transaction(fn),
        get: (id) => this.get(id),
        messages: (id) => this.messages(id),
        append: (id, message) => this.append(id, message),
        pendingInputs: (id) => this.pendingInputs(id),
        recordEvent: (id, type, data) => this.recordEvent(id, type, data),
        workspaceBinding: (id) => this.workspaceBinding(id),
        workspaces: this.workspaces,
        goal: (id) => this.goal(id),
        saveProjectionCheckpoints: (id) => this.saveProjectionCheckpoints(id),
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
  /**
   * The directory a session executes in, as a durable binding.
   *
   * A session written before isolation existed has no row, and the answer for it is the synthesised `shared`
   * binding — its own project directory — rather than a refusal. That is what makes every existing session
   * readable by the new seams without a migration that would have had to invent a record this service never made.
   */
  workspaceBinding(sessionId: string): WorkspaceBinding {
    return this.workspaces.resolve(sessionId);
  }
  workspaceById(id: string): WorkspaceBinding | null {
    return this.workspaces.byId(id);
  }
  workspaceBindingsByState(states: readonly WorkspaceState[]): WorkspaceBinding[] {
    return this.workspaces.byState(states);
  }
  /**
   * The managed workspaces of this project whose session is gone.
   *
   * The directory a deleted session worked in stays this service's to manage, and after the deletion no session
   * id can name it; this read is what a project-scoped caller uses instead.
   */
  orphanedWorkspaceBindings(projectRoot: string, includeRemoved = false): WorkspaceBinding[] {
    return this.workspaces.orphaned(projectRoot, includeRemoved);
  }
  createWorkspaceBinding(
    input: Parameters<SessionWorkspaces['createBinding']>[0],
  ): WorkspaceBinding {
    return this.workspaces.createBinding(input);
  }
  attachWorkspaceBinding(input: { bindingId: string; childSessionId: string }): WorkspaceBinding {
    return this.workspaces.attach(input);
  }
  setWorkspaceState(input: Parameters<SessionWorkspaces['setState']>[0]): WorkspaceBinding {
    return this.workspaces.setState(input);
  }
  claimWorkspaceOperation(bindingId: string): string {
    return this.workspaces.claimOperation(bindingId);
  }
  assertWorkspaceOperation(bindingId: string, token: string): void {
    this.workspaces.assertOperation(bindingId, token);
  }
  releaseWorkspaceOperation(bindingId: string, token: string): void {
    this.workspaces.releaseOperation(bindingId, token);
  }
  recordWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    return this.workspaces.recordSnapshot(snapshot);
  }
  workspaceSnapshot(id: string): WorkspaceSnapshot | null {
    return this.workspaces.snapshot(id);
  }
  workspaceSnapshots(): WorkspaceSnapshot[] {
    return this.workspaces.snapshots();
  }
  recordWorkspaceResult(result: WorkspaceResult): WorkspaceResult {
    return this.workspaces.recordResult(result);
  }
  workspaceResult(id: string): WorkspaceResult | null {
    return this.workspaces.result(id);
  }
  workspaceResults(parentSessionId: string): WorkspaceResult[] {
    return this.workspaces.resultsForParent(parentSessionId);
  }
  childWorkspaceResults(childSessionId: string): WorkspaceResult[] {
    return this.workspaces.resultsForChild(childSessionId);
  }
  /** What one binding produced, which is the only key that survives the deletion of both sessions involved. */
  workspaceResultsForBinding(bindingId: string): WorkspaceResult[] {
    return this.workspaces.resultsForBinding(bindingId);
  }
  /** Every result in one state, for the start-up pass that converges interrupted imports. */
  workspaceResultsInState(status: WorkspaceResultStatus): WorkspaceResult[] {
    return this.workspaces.resultsInState(status);
  }
  /** The import receipts of one result, so a recovery pass can find the change an interruption left behind. */
  workspaceApplyReceipts(resultId: string): WorkspaceApplyReceipt[] {
    return this.workspaces.receiptsForResult(resultId);
  }
  setWorkspaceResultStatus(
    input: Parameters<SessionWorkspaces['setResultStatus']>[0],
  ): WorkspaceResult {
    return this.workspaces.setResultStatus(input);
  }
  supersedeWorkspaceResults(childSessionId: string): WorkspaceResult[] {
    return this.workspaces.supersedeResults(childSessionId);
  }
  workspaceApplyReceipt(input: {
    resultId: string;
    digest: string;
    targetBindingId: string;
  }): WorkspaceApplyReceipt | null {
    return this.workspaces.receipt(input);
  }
  recordWorkspaceApplyReceipt(
    input: Parameters<SessionWorkspaces['recordReceipt']>[0],
  ): WorkspaceApplyReceipt {
    return this.workspaces.recordReceipt(input);
  }
  /** Publish an import attempt and its recovery journal atomically, before any file writes. */
  beginWorkspaceApply(input: {
    parentSessionId: string;
    resultId: string;
    digest: string;
    targetBindingId: string;
    change: FileChange;
    files: FileSnapshot[];
  }): string {
    return this.transaction(() => {
      if (this.workspaceApplyReceipt(input))
        throw new WorkspaceFailure('WORKSPACE_BUSY', 'This import already has a recovery record');
      this.setWorkspaceResultStatus({
        resultId: input.resultId,
        expect: ['ready', 'conflict'],
        to: 'applying',
      });
      const changeId = this.prepareFileChangeGroup(
        input.parentSessionId,
        input.change,
        input.files,
      );
      this.recordWorkspaceApplyReceipt({ ...input, changeId });
      return changeId;
    });
  }
  /** The durable success state and the journal must commit together. */
  finishWorkspaceApply(resultId: string, changeId: string): void {
    this.transaction(() => {
      this.markFileChange(changeId, 'applied');
      this.setWorkspaceResultStatus({ resultId, expect: 'applying', to: 'applied' });
    });
  }
  /** Recovery proved every path still has its before bytes; abandon this attempt and allow new approval. */
  resetUnwrittenWorkspaceApply(receipt: WorkspaceApplyReceipt): void {
    this.transaction(() => {
      this.markFileChange(receipt.changeId, 'abandoned');
      this.workspaces.removeReceipt(receipt.id, receipt.changeId);
      this.setWorkspaceResultStatus({
        resultId: receipt.resultId,
        expect: 'applying',
        to: 'ready',
      });
    });
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
  /**
   * Which session's journal holds one change, for a recovery pass that has only the id.
   *
   * An import receipt records the change id; the session that owns it is the *parent's*, which is not necessarily the
   * session whose directory the bytes went into. Asking the row is what keeps a caller from having to already know
   * the answer it is asking for.
   */
  fileChangeOwner(id: string): string | null {
    return this.changes.fileChangeOwner(id);
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
  subagents(sessionId: string, includePreviousRuns = false): SubAgentSummary[] {
    return subAgentCards(
      this.stateOf<SubAgentCardsState>('subagents', sessionId),
      includePreviousRuns,
    ).map((card) => (card.sessionId ? this.withTurnTiming(card) : card));
  }
  /** One child card plus the timing of the session that holds its work. */
  private withTurnTiming(card: SubAgentSummary): SubAgentSummary {
    /**
     * The card comes from the *parent's* log, so it outlives the child's own rows: a deleted child session
     * (the delete RPC accepts any id) left its card behind, and this lookup then threw "Session not found" —
     * making the whole catalog unreadable for a parent that was otherwise healthy. A missing child means
     * "there is no timing left to report", not "the catalog cannot be shown".
     */
    let timing: TurnTiming;
    try {
      timing = this.turnTiming(card.sessionId);
    } catch {
      return { ...card, durationMs: undefined, runningSince: undefined };
    }
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
  messagesFromTable(sessionId: string): Message[] {
    return this.journal.messagesFromTable(sessionId);
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
    this.journal.clearObservers();
    // A store that closes writes what it was given. This is the one write that does not report a failure:
    // `close` runs in teardown paths, where throwing would replace the error that caused the shutdown.
    // Everything that promises durability — `flush` and every read — is loud about a write that failed.
    try {
      this.flush();
      // Only the sessions this process actually read (they are what the log cache holds): checkpointing every
      // session in the database on the way out would make closing a store cost as much as reading all of it.
      // The list is copied because folding a projection re-inserts the session's cache entry, and a Map that is
      // re-inserted into while it is being iterated hands the same key back forever.
      for (const id of this.journal.cachedSessionIds()) this.saveProjectionCheckpoints(id);
    } catch {
      // Left unwritten deliberately: the caller was told by `flush` if it asked, and asking is what promises.
    }
    this.journal.clear();
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
    return this.taskDefinitions.createTask(sessionId, input);
  }
  getTask(sessionId: string, id: string): Task {
    return this.taskDefinitions.getTask(sessionId, id);
  }
  listTasks(sessionId: string, status?: TaskStatus): Task[] {
    return this.taskDefinitions.listTasks(sessionId, status);
  }
  listScheduledTasks(workspace?: string): Task[] {
    return this.taskDefinitions.listScheduledTasks(workspace);
  }
  updateTask(sessionId: string, id: string, update: TaskUpdate): Task {
    return this.taskDefinitions.updateTask(sessionId, id, update);
  }
  replaceTaskDefinition(
    sessionId: string,
    id: string,
    input: unknown,
    expectedUpdatedAt?: string,
  ): Task {
    return this.taskDefinitions.replaceTaskDefinition(sessionId, id, input, expectedUpdatedAt);
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
  recordTaskVerificationRound(
    sessionId: string,
    taskId: string,
    attemptId: string,
    input: {
      verificationRound: number;
      evidence: NonNullable<Task['verification']>;
      resolvedEffectIds: string[];
      summary: CompletionSummary;
    },
  ) {
    return this.tasks.recordTaskVerificationRound(sessionId, taskId, attemptId, input);
  }
  private completionVerificationRounds(sessionId: string, attemptId: string): number[] {
    return this.completion.completionVerificationRounds(sessionId, attemptId);
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
  list(query = '', workspace?: string, page?: SessionListPage): Session[] {
    return this.search.list(query, workspace, page);
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
  /** The session and its delegated descendants: exactly the sessions `delete(id)` removes. */
  sessionTree(id: string): string[] {
    return this.lifecycle.tree(id);
  }
  messages(id: string): Message[] {
    return this.journal.messages(id);
  }
  events(id: string, afterSeq = 0, limit?: number): SessionEvent[] {
    return this.journal.events(id, afterSeq, limit);
  }
  auditEvents(id: string, afterSeq = 0, limit = 200): SessionEvent[] {
    return this.journal.auditEvents(id, afterSeq, limit);
  }
  pendingInputs(id: string): PendingSessionInput[] {
    return this.journal.pendingInputs(id);
  }
  discardPendingInputs(id: string, reason: string): number {
    return this.journal.discardPendingInputs(id, reason);
  }
  private checkedLog(id: string): readonly SessionEvent[] {
    return this.journal.checkedLog(id);
  }
  lastSeq(id: string): number {
    return this.journal.lastSeq(id);
  }
  newestPayload(id: string, type: SessionEventType): Record<string, unknown> | undefined {
    return this.journal.newestPayload(id, type);
  }
  completionCurrent(sessionId: string): CompletionRecord | null {
    return this.completion.completionCurrent(sessionId);
  }
  recordEvent(
    id: string,
    type: SessionEventType,
    data: Record<string, unknown>,
    stored: Record<string, unknown> = data,
  ): void {
    return this.journal.recordEvent(id, type, data, stored);
  }
  append(id: string, message: Message): void {
    return this.journal.append(id, message);
  }
  flush(id?: string): void {
    return this.journal.flush(id);
  }
  contextSurface(id: string): Surface | null {
    return this.context.contextSurface(id);
  }
  surfaceHistory(id: string): SurfaceOp[] {
    return this.context.surfaceHistory(id);
  }
  retryCount(runId: string, round: number, sessionId?: string): number {
    return this.runJournal.retryCount(runId, round, sessionId);
  }
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
    return this.context.applyCompaction(id, input);
  }
  private transaction<T>(fn: () => T): T {
    return this.journal.transaction(fn);
  }
  resolvePending(id: string, reason: string): number {
    return this.runJournal.resolvePending(id, reason);
  }
  settleAbandonedRun(sessionId: string, runId: string, reason: string): void {
    return this.runJournal.settleAbandonedRun(sessionId, runId, reason);
  }
  inFlightStep(sessionId: string, runId: string): StepRecord | null {
    return this.runJournal.inFlightStep(sessionId, runId);
  }
  reconcileInterruptedRuns(workspace?: string): number {
    return this.runJournal.reconcileInterruptedRuns(workspace);
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
    return this.runJournal.beginRun(id);
  }
  leaseOf(sessionId: string): SessionLease | null {
    return this.runJournal.leaseOf(sessionId);
  }
  renewLease(sessionId: string, runId: string): boolean {
    return this.runJournal.renewLease(sessionId, runId);
  }
  releaseLease(sessionId: string, runId: string): boolean {
    return this.runJournal.releaseLease(sessionId, runId);
  }
  forsakeRun(runId: string): void {
    this.runJournal.forsakeRun(runId);
  }
  claimCompaction(sessionId: string, runId?: string): void {
    return this.runJournal.claimCompaction(sessionId, runId);
  }
  releaseCompaction(sessionId: string, runId?: string): void {
    return this.runJournal.releaseCompaction(sessionId, runId);
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
  /** The log position each session was last checkpointed at by {@link checkpointIfDue}, in this process. */
  private checkpointMarks = new Map<string, number>();
  /**
   * Checkpoint a session once its log has grown `everyEvents` past the last checkpoint this process wrote.
   *
   * `finishRun` and `close` checkpoint at their own stopping points; this is for the run that does not stop for
   * hours — a crash mid-run used to reopen by folding every event since the previous run ended. The first call
   * for a session only records where the log stands, so a short run never writes here and pays one map lookup
   * per step. Failures are swallowed like every checkpoint's: this is derived data.
   */
  checkpointIfDue(sessionId: string, everyEvents = 2_000): boolean {
    // `lastSeq` does not count buffered appends, so the log is written out first: the count has to be the log's.
    this.flush(sessionId);
    const seq = this.lastSeq(sessionId);
    const mark = this.checkpointMarks.get(sessionId);
    if (mark === undefined || seq < mark) {
      this.checkpointMarks.set(sessionId, seq);
      return false;
    }
    if (seq - mark < everyEvents) return false;
    this.checkpointMarks.set(sessionId, seq);
    return this.saveProjectionCheckpoints(sessionId) > 0;
  }
  statistics(sessionId: string): SessionStatistics {
    return this.stateOf<SessionStatistics>('statistics', sessionId);
  }
  finishRun(result: RunResult, options: { completeGoalObjective?: string } = {}): void {
    return this.runJournal.finishRun(result, options);
  }
}
