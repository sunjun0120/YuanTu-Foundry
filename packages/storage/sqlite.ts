import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertRuntimeFile,
  ensureRuntimeDirectory,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  RUNTIME_DIRECTORY_NAME,
  restrictToOwner,
} from '../platform/runtime-directory.ts';
import { canonicalKey } from '../platform/workspace-paths.ts';
import type { Surface, SurfaceOp } from '../protocol/context.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import { type Goal } from '../protocol/goals.ts';
import type {
  Approval,
  CompletionRecord,
  FileChange,
  FileSnapshot,
  Message,
  Plan,
  RunResult,
  SubAgentSummary,
  Task,
  TaskStatus,
  TaskStepStatus,
  TaskTriggerSource,
  TodoItem,
  Usage,
} from '../protocol/index.ts';
import type { PlanBody, PlanRepository } from '../protocol/plans.ts';
import type { SessionLease } from '../protocol/session-lease.ts';
import type { RunTaskSettlement, SessionRecovery } from './session-runs.ts';
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
import {
  initializeDatabase,
  registerDatabase,
  sharedWithOtherProcess,
  type BackupPolicy,
} from './database-maintenance.ts';
import { type PendingSessionInput, type SessionEvent, type SessionEventType } from './events.ts';
import type { TurnTiming } from './projections.ts';
import { BUILT_IN_SESSION_PROJECTIONS, SessionProjectionRegistry } from './projections.ts';
import type { SessionContext } from './session-context.ts';
import type { SessionEventJournal } from './session-event-journal.ts';
import type {
  Session,
  SessionSearchPage,
  StoredFileChange,
  TaskCreate,
  TaskUpdate,
} from './session-schema.ts';
import type { SessionListPage, SessionSearch } from './session-search.ts';
import { createSessionStoreParts, type SessionStoreParts } from './session-store-parts.ts';
import type { TaskJournal } from './session-tasks.ts';
import type { SessionWorkspaceApply } from './session-workspace-apply.ts';
import type { SessionWorkspaces } from './session-workspaces.ts';
export { normalizePlanBody, planHash } from '../protocol/plans.ts';
export type { PlanBody } from '../protocol/plans.ts';
export { LEASE_RENEW_INTERVAL_MS } from '../protocol/session-lease.ts';
export type { SessionLease } from '../protocol/session-lease.ts';
export type { RunTaskSettlement, SessionRecovery } from './session-runs.ts';
/**
 * The workspace vocabulary is re-exported for the same reason the row shapes are: a caller that has to name a
 * state, a failure code or a binding should not have to know which package physically declares it.
 */
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

/** `PRAGMA auto_vacuum` reports 2 for INCREMENTAL. */
const INCREMENTAL_AUTO_VACUUM = 2;
/** Pages one reclaim pass frees at most; see `SessionStore.reclaimFreePages`. */
export const RECLAIM_BATCH_PAGES = 1024;
/**
 * Check the database's directory and fixed file names before anything is opened (see `secureDatabaseFiles`).
 *
 * The database holds whole transcripts — command output, file contents, sometimes secrets — and used to be created
 * with the umask's defaults (0644 in a 0755 directory), readable by every local user, while the spill files beside
 * it were already 0600. And SQLite opens by name, which follows a link: a `.yuantu/sessions.sqlite` or `-wal` shipped
 * as a link would have put the session database outside the workspace. So the fixed names are refused unless they
 * are missing or regular files, a new database is created 0600 without following a link (SQLite then gives its
 * `-wal`/`-shm` the database's own mode), an existing one is narrowed to 0600, and `.yuantu` itself to 0700. A
 * `--db` elsewhere keeps its directory's permissions: that directory is the caller's, not runtime state.
 */
function prepareDatabaseFiles(file: string): void {
  const directory = ensureRuntimeDirectory(path.dirname(file), { mode: PRIVATE_DIRECTORY_MODE });
  if (path.basename(directory) === RUNTIME_DIRECTORY_NAME)
    restrictToOwner(directory, PRIVATE_DIRECTORY_MODE);
  const sidecars = ['-wal', '-shm', '-journal'].map((suffix) => `${file}${suffix}`);
  for (const target of [file, ...sidecars]) assertRuntimeFile(target);
}
/** The second half, once `registerDatabase` has ruled out an interrupted restore that a new file would confuse. */
function secureDatabaseFiles(file: string): void {
  const sidecars = ['-wal', '-shm', '-journal'].map((suffix) => `${file}${suffix}`);
  try {
    closeSync(
      openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  for (const target of [file, ...sidecars]) restrictToOwner(target, PRIVATE_FILE_MODE);
}

/**
 * The storage layer's single entry point: one connection, and every session operation as a method.
 *
 * The work lives in the `session-*.ts` collaborators, built over this connection by `createSessionStoreParts`
 * (`./session-store-parts.ts`); this class owns the connection's lifetime and forwards to them, so every caller
 * keeps one object and one signature per operation. A method documented in its collaborator is documented there.
 */
export class SessionStore implements PlanRepository {
  private readonly parts: SessionStoreParts;
  /** The connection's write ordering and log cache; kept as its own member for the probes that inspect it. */
  private readonly journal: SessionEventJournal;
  private db!: DatabaseSync;
  private readonly file: string;
  private releaseDatabase?: () => void;
  /**
   * The projections a reader can fold the log with. The store hosts them because it owns the log; a host
   * that wants its own views registers them here, and `stateOf`/`snapshot` read them.
   */
  readonly projections = new SessionProjectionRegistry();
  observeEvents(listener: (event: SessionEvent) => void, types?: ReadonlySet<string>): () => void {
    return this.journal.observeEvents(listener, types);
  }
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
  /**
   * The name this database's share of a workspace snapshot is kept under (`refs/yuantu/snapshot-owners/<id>/<this>`).
   *
   * Derived from where the file is, not stored in it: a copy of the database at another path is another owner, so
   * two stores can never release each other's share. A database that moved keeps its old refs, which then never
   * reach zero — a leak `workspace-gc --dry-run` reports, and never a snapshot deleted while it is in use. An
   * in-memory store gets a name of its own for its lifetime.
   */
  snapshotOwner(): string {
    this.ownerName ??=
      this.file === ':memory:'
        ? `memory-${randomUUID()}`
        : createHash('sha256')
            .update(canonicalKey(realpathSync.native(this.file)))
            .digest('hex')
            .slice(0, 32);
    return this.ownerName;
  }
  private ownerName: string | undefined;
  constructor(file: string, options: { backupRetention?: BackupPolicy } = {}) {
    // A database under `<workspace>/.yuantu` must not follow a link out of the workspace.
    if (file !== ':memory:') prepareDatabaseFiles(path.resolve(file));
    this.file = file === ':memory:' ? file : path.resolve(file);
    this.releaseDatabase = registerDatabase(file);
    try {
      if (file !== ':memory:') secureDatabaseFiles(this.file);
      this.db = new DatabaseSync(file);
      this.parts = createSessionStoreParts(this.db, this.projections, this, (fn) =>
        this.transaction(fn),
      );
      this.journal = this.parts.journal;
      for (const projection of BUILT_IN_SESSION_PROJECTIONS) this.projections.register(projection);
      initializeDatabase(file, () => {
        this.parts.schema.initialize(file, options);
        this.enableIncrementalVacuum();
      });
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
  /**
   * The upgrade path as data, for a caller that wants to check it rather than run it.
   *
   * Exposed because the property worth testing here is a property of the *list* — ordered, reachable, reaching
   * this build — and a test cannot assert that about a run of statements it cannot see.
   */
  migrationSteps(): { from: number; upTo: number }[] {
    return this.parts.schema.migrationSteps();
  }
  /**
   * The directory a session executes in, as a durable binding.
   *
   * A session written before isolation existed has no row, and the answer for it is the synthesised `shared`
   * binding — its own project directory — rather than a refusal. That is what makes every existing session
   * readable by the new seams without a migration that would have had to invent a record this service never made.
   */
  workspaceBinding(sessionId: string): WorkspaceBinding {
    return this.parts.workspaces.resolve(sessionId);
  }
  workspaceById(id: string): WorkspaceBinding | null {
    return this.parts.workspaces.byId(id);
  }
  workspaceBindingsByState(states: readonly WorkspaceState[]): WorkspaceBinding[] {
    return this.parts.workspaces.byState(states);
  }
  /** Removed workspaces removed before `before` (ISO), for the opt-in retention pass. */
  removedWorkspacesBefore(before: string): WorkspaceBinding[] {
    return this.parts.workspaces.removedBefore(before);
  }
  /**
   * The managed workspaces of this project whose session is gone.
   *
   * The directory a deleted session worked in stays this service's to manage, and after the deletion no session
   * id can name it; this read is what a project-scoped caller uses instead.
   */
  orphanedWorkspaceBindings(projectRoot: string, includeRemoved = false): WorkspaceBinding[] {
    return this.parts.workspaces.orphaned(projectRoot, includeRemoved);
  }
  createWorkspaceBinding(
    input: Parameters<SessionWorkspaces['createBinding']>[0],
  ): WorkspaceBinding {
    return this.parts.workspaces.createBinding(input);
  }
  attachWorkspaceBinding(input: { bindingId: string; childSessionId: string }): WorkspaceBinding {
    return this.parts.workspaces.attach(input);
  }
  setWorkspaceState(input: Parameters<SessionWorkspaces['setState']>[0]): WorkspaceBinding {
    return this.parts.workspaces.setState(input);
  }
  claimWorkspaceOperation(bindingId: string): string {
    return this.parts.workspaces.claimOperation(bindingId);
  }
  assertWorkspaceOperation(bindingId: string, token: string): void {
    this.parts.workspaces.assertOperation(bindingId, token);
  }
  releaseWorkspaceOperation(bindingId: string, token: string): void {
    this.parts.workspaces.releaseOperation(bindingId, token);
  }
  /** Forget a removed workspace's rows; see `SessionWorkspaces.purgeRemoved` for what it refuses. */
  purgeRemovedWorkspace(bindingId: string, token: string): { resultIds: string[] } {
    return this.parts.workspaces.purgeRemoved(bindingId, token);
  }
  /** Every workspace snapshot this database has recorded. */
  workspaceSnapshotIds(): string[] {
    return this.parts.workspaces.snapshotIds();
  }
  /** Drop a snapshot's record when nothing in this database names it; see `SessionWorkspaces.dropUnusedSnapshot`. */
  dropUnusedWorkspaceSnapshot(snapshotId: string, namedByRemovals: ReadonlySet<string>): boolean {
    return this.parts.workspaces.dropUnusedSnapshot(snapshotId, namedByRemovals);
  }
  /**
   * An operator's release of a workspace operation lease no process can prove dead (`workspace-lease-recover`).
   *
   * The release and its record are one transaction: the delegating session's log says which lease was dropped,
   * whose it was, who asked and why, so a later reader can tell an operator's decision from a lost lease.
   */
  recoverWorkspaceOperation(
    bindingId: string,
    input: { operator: string; reason: string },
  ): ReturnType<SessionWorkspaces['forceReleaseOperation']> & { bindingId: string; at: string } {
    return this.transaction(() => {
      const released = this.parts.workspaces.forceReleaseOperation(bindingId);
      const at = new Date().toISOString();
      const parent = this.workspaceById(bindingId)?.parentSessionId ?? null;
      let parentExists = false;
      if (parent)
        try {
          this.get(parent);
          parentExists = true;
        } catch {
          // An orphan's delegating session may be gone too; the release is still reported to the operator.
        }
      if (released.released && parent && parentExists)
        this.recordEvent(parent, 'workspace.lease.recovered', {
          bindingId,
          previousOwnerPid: released.previousOwnerPid,
          previousOwnerStartedAt: released.previousOwnerStartedAt,
          operator: input.operator,
          reason: input.reason,
          at,
        });
      return { bindingId, ...released, at };
    });
  }
  recordWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    return this.parts.workspaces.recordSnapshot(snapshot);
  }
  workspaceSnapshot(id: string): WorkspaceSnapshot | null {
    return this.parts.workspaces.snapshot(id);
  }
  workspaceSnapshots(): WorkspaceSnapshot[] {
    return this.parts.workspaces.snapshots();
  }
  recordWorkspaceResult(result: WorkspaceResult): WorkspaceResult {
    return this.parts.workspaces.recordResult(result);
  }
  workspaceResult(id: string): WorkspaceResult | null {
    return this.parts.workspaces.result(id);
  }
  workspaceResults(parentSessionId: string): WorkspaceResult[] {
    return this.parts.workspaces.resultsForParent(parentSessionId);
  }
  childWorkspaceResults(childSessionId: string): WorkspaceResult[] {
    return this.parts.workspaces.resultsForChild(childSessionId);
  }
  /** What one binding produced, which is the only key that survives the deletion of both sessions involved. */
  workspaceResultsForBinding(bindingId: string): WorkspaceResult[] {
    return this.parts.workspaces.resultsForBinding(bindingId);
  }
  /** Every result in one state, for the start-up pass that converges interrupted imports. */
  workspaceResultsInState(status: WorkspaceResultStatus): WorkspaceResult[] {
    return this.parts.workspaces.resultsInState(status);
  }
  /** The import receipts of one result, so a recovery pass can find the change an interruption left behind. */
  workspaceApplyReceipts(resultId: string): WorkspaceApplyReceipt[] {
    return this.parts.workspaces.receiptsForResult(resultId);
  }
  setWorkspaceResultStatus(
    input: Parameters<SessionWorkspaces['setResultStatus']>[0],
  ): WorkspaceResult {
    return this.parts.workspaces.setResultStatus(input);
  }
  supersedeWorkspaceResults(childSessionId: string): WorkspaceResult[] {
    return this.parts.workspaces.supersedeResults(childSessionId);
  }
  workspaceApplyReceipt(input: {
    resultId: string;
    digest: string;
    targetBindingId: string;
  }): WorkspaceApplyReceipt | null {
    return this.parts.workspaces.receipt(input);
  }
  recordWorkspaceApplyReceipt(
    input: Parameters<SessionWorkspaces['recordReceipt']>[0],
  ): WorkspaceApplyReceipt {
    return this.parts.workspaces.recordReceipt(input);
  }
  /** Publish an import attempt and its recovery journal atomically (see `./session-workspace-apply.ts`). */
  beginWorkspaceApply(input: Parameters<SessionWorkspaceApply['begin']>[0]): string {
    return this.parts.workspaceApply.begin(input);
  }
  /** The durable success state and the journal must commit together. */
  finishWorkspaceApply(resultId: string, changeId: string): void {
    this.parts.workspaceApply.finish(resultId, changeId);
  }
  /** Recovery proved every path still has its before bytes; abandon this attempt and allow new approval. */
  resetUnwrittenWorkspaceApply(receipt: WorkspaceApplyReceipt): void {
    this.parts.workspaceApply.resetUnwritten(receipt);
  }
  prepareFileChange(
    sessionId: string,
    change: FileChange,
    before: Uint8Array | null,
    after: Uint8Array,
  ): string {
    return this.parts.changes.prepareFileChange(sessionId, change, before, after);
  }
  prepareFileChangeGroup(sessionId: string, change: FileChange, files: FileSnapshot[]): string {
    return this.parts.changes.prepareFileChangeGroup(sessionId, change, files);
  }
  markFileChange(id: string, status: StoredFileChange['status']): void {
    return this.parts.changes.markFileChange(id, status);
  }
  completeFileUndo(sessionId: string, id: string, notice: string): void {
    return this.parts.changes.completeFileUndo(sessionId, id, notice);
  }
  fileChanges(sessionId: string): StoredFileChange[] {
    return this.parts.changes.fileChanges(sessionId);
  }
  /**
   * Which session's journal holds one change, for a recovery pass that has only the id.
   *
   * An import receipt records the change id; the session that owns it is the *parent's*, which is not necessarily the
   * session whose directory the bytes went into. Asking the row is what keeps a caller from having to already know
   * the answer it is asking for.
   */
  fileChangeOwner(id: string): string | null {
    return this.parts.changes.fileChangeOwner(id);
  }
  fileChangeSnapshots(sessionId: string, id: string): FileSnapshot[] {
    return this.parts.changes.fileChangeSnapshots(sessionId, id);
  }
  fileChangeBytes(sessionId: string, id: string): { before: Buffer | null; after: Buffer } {
    return this.parts.changes.fileChangeBytes(sessionId, id);
  }
  /** Sub-agent summaries from the most recent finished run (see `./session-projection-reads.ts`). */
  subagents(sessionId: string, includePreviousRuns = false): SubAgentSummary[] {
    return this.parts.reads.subagents(sessionId, includePreviousRuns);
  }
  /** How long this session's runs have been active, folded from its own run boundaries. */
  turnTiming(sessionId: string): TurnTiming {
    return this.parts.reads.turnTiming(sessionId);
  }
  messagesFromTable(sessionId: string, offset = 0): Message[] {
    return this.journal.messagesFromTable(sessionId, offset);
  }
  messageRowCount(sessionId: string): number {
    return this.journal.messageRowCount(sessionId);
  }
  /** The session's checklist as the model last wrote it. */
  todos(sessionId: string): TodoItem[] {
    return this.parts.reads.todos(sessionId);
  }
  /** What the most recent `todo_write` changed about the checklist, or `null`. */
  todoChange(sessionId: string): TodoChange | null {
    return this.parts.reads.todoChange(sessionId);
  }
  /** The files this session presented as deliverables, folded from the log. */
  deliverables(sessionId: string): PresentedFile[] {
    return this.parts.reads.deliverables(sessionId);
  }
  /** Per-run declarations, reconstructed from the log without overwriting earlier turns. */
  turnDeliverables(sessionId: string): PresentedFile[] {
    return this.parts.reads.turnDeliverables(sessionId);
  }
  /** The objective this session is pursuing, or `null` when no run has recorded one. */
  goal(sessionId: string): Goal | null {
    return this.parts.reads.goal(sessionId);
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
  /** A new session, or a delegated child's (see `./session-records.ts` for the lineage rules). */
  create(workspace: string, parentSessionId?: string): Session {
    return this.parts.records.create(workspace, parentSessionId);
  }
  createTask(sessionId: string, input: TaskCreate): Task {
    return this.parts.taskDefinitions.createTask(sessionId, input);
  }
  getTask(sessionId: string, id: string): Task {
    return this.parts.taskDefinitions.getTask(sessionId, id);
  }
  listTasks(sessionId: string, status?: TaskStatus): Task[] {
    return this.parts.taskDefinitions.listTasks(sessionId, status);
  }
  listScheduledTasks(workspace?: string): Task[] {
    return this.parts.taskDefinitions.listScheduledTasks(workspace);
  }
  updateTask(sessionId: string, id: string, update: TaskUpdate): Task {
    return this.parts.taskDefinitions.updateTask(sessionId, id, update);
  }
  replaceTaskDefinition(
    sessionId: string,
    id: string,
    input: unknown,
    expectedUpdatedAt?: string,
  ): Task {
    return this.parts.taskDefinitions.replaceTaskDefinition(
      sessionId,
      id,
      input,
      expectedUpdatedAt,
    );
  }
  startTaskAttempt(
    sessionId: string,
    taskId: string,
    input: Parameters<TaskJournal['startTaskAttempt']>[2],
  ) {
    return this.parts.tasks.startTaskAttempt(sessionId, taskId, input);
  }
  finishTaskAttempt(
    sessionId: string,
    taskId: string,
    attemptId: string,
    input: Parameters<TaskJournal['finishTaskAttempt']>[3],
  ) {
    return this.parts.tasks.finishTaskAttempt(sessionId, taskId, attemptId, input);
  }
  getTaskAttempt(sessionId: string, taskId: string, attemptId: string) {
    return this.parts.tasks.getTaskAttempt(sessionId, taskId, attemptId);
  }
  recordTaskVerificationRound(
    sessionId: string,
    taskId: string,
    attemptId: string,
    input: Parameters<TaskJournal['recordTaskVerificationRound']>[3],
  ) {
    return this.parts.tasks.recordTaskVerificationRound(sessionId, taskId, attemptId, input);
  }
  listTaskAttempts(sessionId: string, taskId: string) {
    return this.parts.tasks.listTaskAttempts(sessionId, taskId);
  }
  checkpointTaskStep(
    sessionId: string,
    taskId: string,
    input: { attemptId: string; index: number; status: TaskStepStatus; note?: string },
  ) {
    return this.parts.tasks.checkpointTaskStep(sessionId, taskId, input);
  }
  taskStepCheckpoints(sessionId: string, taskId: string) {
    return this.parts.tasks.taskStepCheckpoints(sessionId, taskId);
  }
  completedStepIndexes(taskId: string) {
    return this.parts.tasks.completedStepIndexes(taskId);
  }
  beginTaskEffect(sessionId: string, taskId: string, attemptId: string, toolName: string) {
    return this.parts.tasks.beginTaskEffect(sessionId, taskId, attemptId, toolName);
  }
  completeTaskEffect(sessionId: string, taskId: string, effectId: string) {
    return this.parts.tasks.completeTaskEffect(sessionId, taskId, effectId);
  }
  hasPendingTaskEffects(sessionId: string, taskId: string, attemptId?: string) {
    return this.parts.tasks.hasPendingTaskEffects(sessionId, taskId, attemptId);
  }
  deferTaskApproval(sessionId: string, taskId: string, approval: Approval) {
    return this.parts.tasks.deferTaskApproval(sessionId, taskId, approval);
  }
  resolveTaskApproval(
    sessionId: string,
    taskId: string,
    allow: boolean,
    expectedApprovalId: string,
  ) {
    return this.parts.tasks.resolveTaskApproval(sessionId, taskId, allow, expectedApprovalId);
  }
  consumeTaskApproval(sessionId: string, taskId: string, approval: Approval) {
    return this.parts.tasks.consumeTaskApproval(sessionId, taskId, approval);
  }
  clearApprovedTaskApproval(sessionId: string, taskId: string, expectedRule?: string) {
    return this.parts.tasks.clearApprovedTaskApproval(sessionId, taskId, expectedRule);
  }
  claimTaskSchedule(task: Task, source: TaskTriggerSource, scheduledAt?: string) {
    return this.parts.tasks.claimTaskSchedule(task, source, scheduledAt);
  }
  skipTaskSchedule(task: Task, now: Date) {
    return this.parts.tasks.skipTaskSchedule(task, now);
  }
  recordTaskRun(
    sessionId: string,
    taskId: string,
    input: Parameters<TaskJournal['recordTaskRun']>[2],
  ) {
    return this.parts.tasks.recordTaskRun(sessionId, taskId, input);
  }
  scheduleImmediateRun(sessionId: string, taskId: string, error?: string) {
    return this.parts.tasks.scheduleImmediateRun(sessionId, taskId, error);
  }
  taskAttemptBaselines(sessionId: string, taskId: string, attemptId: string) {
    return this.parts.tasks.taskAttemptBaselines(sessionId, taskId, attemptId);
  }
  latestRunAttemptBaselines(sessionId: string, taskId: string) {
    return this.parts.tasks.latestRunAttemptBaselines(sessionId, taskId);
  }
  definitionRunAttemptBaselines(sessionId: string, taskId: string) {
    return this.parts.tasks.definitionRunAttemptBaselines(sessionId, taskId);
  }
  recoverInterruptedTasks(workspace?: string) {
    return this.parts.tasks.recoverInterruptedTasks(workspace);
  }
  reconcileChildRuns(workspace?: string) {
    return this.parts.tasks.reconcileChildRuns(workspace);
  }
  resumableTasks(workspace?: string) {
    return this.parts.tasks.resumableTasks(workspace);
  }
  transitionTask(sessionId: string, id: string, status: TaskStatus) {
    return this.parts.tasks.transitionTask(sessionId, id, status);
  }
  deleteTask(sessionId: string, id: string) {
    return this.parts.tasks.deleteTask(sessionId, id);
  }
  get(id: string): Session {
    return this.parts.records.get(id);
  }
  /** Sessions a sub-agent ran in, oldest first; excluded from `list()` but kept for auditing. */
  childSessions(parentSessionId: string): Session[] {
    return this.parts.records.childSessions(parentSessionId);
  }
  list(query = '', workspace?: string, page?: SessionListPage): Session[] {
    return this.parts.search.list(query, workspace, page);
  }
  /**
   * Full-text search across this workspace's conversations, with the text that matched: ranked by session,
   * bounded on every axis, and under the session list's visibility rule (see `./session-search.ts`).
   */
  searchSessions(
    query: string,
    options: Parameters<SessionSearch['searchSessions']>[1] = {},
  ): SessionSearchPage {
    return this.parts.search.searchSessions(query, options);
  }
  /**
   * Plans live in their own table rather than on the task row.
   *
   * `replaceTaskDefinition` clears a task's verification, step checkpoints and approvals and forces
   * its status back to `pending`, so an approval stored on the task would be destroyed by any later
   * re-propose. The plan row is independent of the task lifecycle by construction.
   */
  createPlan(sessionId: string, runId?: string): Plan {
    return this.parts.plans.createPlan(sessionId, runId);
  }
  /** Records which run is filling in a plan, so a stale `planning` row is diagnosable. */
  linkPlanRun(sessionId: string, planId: string, runId: string): void {
    return this.parts.plans.linkPlanRun(sessionId, planId, runId);
  }
  getPlan(sessionId: string, planId: string): Plan {
    return this.parts.plans.getPlan(sessionId, planId);
  }
  /** The most recent plan for a session, which is the one the UI shows. */
  latestPlan(sessionId: string): Plan | null {
    return this.parts.plans.latestPlan(sessionId);
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
    return this.parts.plans.planMode(sessionId);
  }
  /** Records the agent's plan body and moves the row to `proposed`. */
  submitPlan(sessionId: string, planId: string, body: PlanBody): Plan {
    return this.parts.plans.submitPlan(sessionId, planId, body);
  }
  /**
   * Approves a plan. `hash` is the digest the human actually reviewed, so approving a plan that was
   * edited in the meantime is refused rather than silently blessing text nobody read.
   */
  approvePlan(sessionId: string, planId: string, hash: string): Plan {
    return this.parts.plans.approvePlan(sessionId, planId, hash);
  }
  rejectPlan(sessionId: string, planId: string, reason?: string): Plan {
    return this.parts.plans.rejectPlan(sessionId, planId, reason);
  }
  /**
   * Resolves the plan that an execution run is allowed to follow. Both checks matter: the status
   * proves a human approved it, and the hash proves the approved text is still the text on the row —
   * otherwise an edit between approval and execution would run unreviewed work.
   */
  executablePlan(sessionId: string, planId: string): Plan {
    return this.parts.plans.executablePlan(sessionId, planId);
  }
  /** Rename a session by hand; a manual name is never replaced by a generated one. */
  rename(id: string, title: string): Session {
    return this.parts.lifecycle.rename(id, title);
  }
  /** Archive a session, or bring it back to the list; nothing it holds changes. */
  setArchived(id: string, archived: boolean): Session {
    return this.parts.lifecycle.setArchived(id, archived);
  }
  /** Whether a model-generated title may still replace this session's own (see `./session-lifecycle.ts`). */
  canGenerateTitle(id: string): boolean {
    return this.parts.lifecycle.canGenerateTitle(id);
  }
  /** Apply a model-generated title, unless a person has named the session in the meantime. */
  setGeneratedTitle(id: string, title: string, usage?: Usage): boolean {
    return this.parts.lifecycle.setGeneratedTitle(id, title, usage);
  }
  /** Remove a session and its whole lineage; a sub-agent session never outlives its parent. */
  delete(id: string): void {
    this.parts.lifecycle.delete(id);
  }
  /**
   * Put the database in `auto_vacuum=INCREMENTAL`, once, so space freed by deletes can be given back while it is open.
   *
   * SQLite never shrinks a file on its own: a deleted session's pages go on a free list and the file keeps its
   * historical peak. A workspace measured during the audit held 14 MB of sessions in a 58 MB file. The only way back
   * was `db-compact`, an offline maintainer command nobody runs. The mode can only change through a full `VACUUM`,
   * which needs the database to itself, so it happens here — at open, under the initialization gate, after the
   * schema — and only when no other process has the file open. It is best effort: a database it cannot convert
   * this time works exactly as before and is tried again at the next open. On that measured file it took 250 ms;
   * a brand-new database is converted before it holds anything.
   */
  private enableIncrementalVacuum(): void {
    if (this.file === ':memory:' || this.autoVacuumMode() === INCREMENTAL_AUTO_VACUUM) return;
    if (sharedWithOtherProcess(this.file)) return;
    try {
      this.db.exec('PRAGMA auto_vacuum=INCREMENTAL');
      this.db.exec('VACUUM');
    } catch (error) {
      console.error(`[storage] could not enable incremental vacuum: ${(error as Error).message}`);
    }
  }
  private autoVacuumMode(): number {
    return Number(this.db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0);
  }
  /**
   * Give up to `maxPages` free pages back to the file system, and say how many went.
   *
   * Bounded because it runs on the Host's one thread: a batch of 1024 pages (4 MB) measured about 30 ms. The Host
   * calls it after a delete and again while idle, so a large delete is reclaimed over a few passes instead of in one
   * stall. Nothing happens in a database that is not in incremental mode, or inside an open transaction, which
   * `incremental_vacuum` would otherwise join.
   */
  reclaimFreePages(maxPages = RECLAIM_BATCH_PAGES): number {
    if (this.file === ':memory:' || this.db.isTransaction) return 0;
    if (this.autoVacuumMode() !== INCREMENTAL_AUTO_VACUUM) return 0;
    const before = this.freePages();
    if (before === 0) return 0;
    this.db.prepare(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(maxPages))})`).all();
    return before - this.freePages();
  }
  /** Pages on the free list: space the file holds that no record uses. */
  freePages(): number {
    return Number(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
  }
  /** The session and its delegated descendants: exactly the sessions `delete(id)` removes. */
  sessionTree(id: string): string[] {
    return this.parts.lifecycle.tree(id);
  }
  messages(id: string): Message[] {
    return this.journal.messages(id);
  }
  events(id: string, afterSeq = 0, limit?: number): SessionEvent[] {
    return this.journal.events(id, afterSeq, limit);
  }
  /**
   * Whether a transaction is open on this connection: what it reads now may still be rolled back, so a reader that
   * keeps a fold across calls must not keep one taken here.
   */
  get inTransaction(): boolean {
    return this.db.isTransaction;
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
  lastSeq(id: string): number {
    return this.journal.lastSeq(id);
  }
  newestPayload(id: string, type: SessionEventType): Record<string, unknown> | undefined {
    return this.journal.newestPayload(id, type);
  }
  completionCurrent(sessionId: string): CompletionRecord | null {
    return this.parts.completion.completionCurrent(sessionId);
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
    return this.parts.context.contextSurface(id);
  }
  surfaceHistory(id: string): SurfaceOp[] {
    return this.parts.context.surfaceHistory(id);
  }
  retryCount(runId: string, round: number, sessionId?: string): number {
    return this.parts.runs.retryCount(runId, round, sessionId);
  }
  zeroByteRetryCount(runId: string, round: number, sessionId?: string): number {
    return this.parts.runs.zeroByteRetryCount(runId, round, sessionId);
  }
  reasoningResendCount(runId: string, round: number, sessionId?: string): number {
    return this.parts.runs.reasoningResendCount(runId, round, sessionId);
  }
  /** Record a compaction summary over the transcript (see `./session-context.ts`). */
  applyCompaction(id: string, input: Parameters<SessionContext['applyCompaction']>[1]): void {
    return this.parts.context.applyCompaction(id, input);
  }
  private transaction<T>(fn: () => T): T {
    return this.journal.transaction(fn);
  }
  resolvePending(id: string, reason: string): number {
    return this.parts.runs.resolvePending(id, reason);
  }
  settleAbandonedRun(sessionId: string, runId: string, reason: string): void {
    return this.parts.runs.settleAbandonedRun(sessionId, runId, reason);
  }
  /** An operator's override for a session whose lease owner cannot be confirmed dead; see `SessionRuns`. */
  recoverSession(sessionId: string, reason: string): SessionRecovery {
    return this.parts.runs.recoverSession(sessionId, reason);
  }
  inFlightStep(sessionId: string, runId: string): StepRecord | null {
    return this.parts.runs.inFlightStep(sessionId, runId);
  }
  reconcileInterruptedRuns(workspace?: string): number {
    return this.parts.runs.reconcileInterruptedRuns(workspace);
  }
  /** A durable recovery point for a run that is still streaming; see `./session-streams.ts`. */
  checkpointStream(id: string, runId: string, messageId: string, text: string): void {
    this.parts.streams.checkpointStream(id, runId, messageId, text);
  }
  /** Fold one queued input into the transcript and settle its inbox entry, in one transaction. */
  consumeQueuedInput(id: string, inputId: string, message: Message): void {
    this.parts.streams.consumeQueuedInput(id, inputId, message);
  }
  /** Commit a streamed answer and remove its recovery point atomically. */
  appendStreamMessage(id: string, runId: string, messageId: string, message: Message): void {
    this.parts.streams.appendStreamMessage(id, runId, messageId, message);
  }
  /** Persist an unfinished answer once, without ever replaying incomplete tool calls. */
  persistStreamCheckpoint(id: string, runId: string): string {
    return this.parts.streams.persistStreamCheckpoint(id, runId);
  }
  /** Converge only the streams whose owning process is gone; a live Host keeps writing its own rows. */
  recoverInterruptedStreams(workspace?: string): number {
    return this.parts.streams.recoverInterruptedStreams(workspace);
  }
  beginRun(id: string): string {
    return this.parts.runs.beginRun(id);
  }
  leaseOf(sessionId: string): SessionLease | null {
    return this.parts.runs.leaseOf(sessionId);
  }
  renewLease(sessionId: string, runId: string): boolean {
    return this.parts.runs.renewLease(sessionId, runId);
  }
  releaseLease(sessionId: string, runId: string): boolean {
    return this.parts.runs.releaseLease(sessionId, runId);
  }
  forsakeRun(runId: string): void {
    this.parts.runs.forsakeRun(runId);
  }
  claimCompaction(sessionId: string, runId?: string): void {
    return this.parts.runs.claimCompaction(sessionId, runId);
  }
  releaseCompaction(sessionId: string, runId?: string): void {
    return this.parts.runs.releaseCompaction(sessionId, runId);
  }
  /**
   * One projection's state for a session, folded from the log; a persisted checkpoint only shortens the fold
   * (see `./session-projection-reads.ts`).
   */
  stateOf<State>(name: string, sessionId: string): State {
    return this.parts.reads.stateOf<State>(name, sessionId);
  }
  /** Every projection in one pass, for a host rendering a whole session. */
  snapshot(sessionId: string): Record<string, unknown> {
    return this.parts.reads.snapshot(sessionId);
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
    return this.parts.checkpoints.foldStats();
  }
  resetFoldCounters(): void {
    return this.parts.checkpoints.resetFoldCounters();
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
    return this.parts.checkpoints.saveProjectionCheckpoints(sessionId);
  }
  /** Checkpoint a session once its log has grown `everyEvents` past this process's last checkpoint of it. */
  checkpointIfDue(sessionId: string, everyEvents = 2_000): boolean {
    return this.parts.reads.checkpointIfDue(sessionId, everyEvents);
  }
  statistics(sessionId: string): SessionStatistics {
    return this.parts.reads.statistics(sessionId);
  }
  finishRun(
    result: RunResult,
    options: {
      completeGoalObjective?: string;
      settleTask?: () => RunTaskSettlement | undefined;
    } = {},
  ): void {
    return this.parts.runs.finishRun(result, options);
  }
}
