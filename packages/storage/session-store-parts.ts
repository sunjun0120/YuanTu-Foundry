import type { DatabaseSync } from 'node:sqlite';
import { SqlitePlanStore } from './plans.ts';
import type { SessionProjectionRegistry } from './projections.ts';
import { SessionCheckpoints, type SessionCheckpointPort } from './session-checkpoints.ts';
import { SessionCompletion } from './session-completion.ts';
import { SessionContext, type SessionContextPort } from './session-context.ts';
import { SessionEventJournal } from './session-event-journal.ts';
import { SessionFileChanges, type FileChangePort } from './session-file-changes.ts';
import { SessionLifecycle } from './session-lifecycle.ts';
import { SessionMigrations } from './session-migrations.ts';
import { SessionProjectionReads } from './session-projection-reads.ts';
import { SessionRecords } from './session-records.ts';
import { SessionRuns, type SessionRunsPort } from './session-runs.ts';
import { SessionSearch } from './session-search.ts';
import { StreamCheckpoints } from './session-streams.ts';
import { SessionTaskDefinitions } from './session-task-definitions.ts';
import { TaskJournal, type TaskJournalPort } from './session-tasks.ts';
import { SessionWorkspaceApply } from './session-workspace-apply.ts';
import { SessionWorkspaces } from './session-workspaces.ts';

/**
 * The public store members its collaborators call back into.
 *
 * They are reached through the store rather than through the collaborator that implements them, and lazily, so a
 * caller that replaces one of these on a store instance (tests do, for `recordEvent`) is replacing it for every
 * collaborator too — exactly as when each callback was written inline in the store's constructor.
 */
export type SessionStoreFacade = Pick<
  TaskJournalPort,
  'getTask' | 'getTaskAttempt' | 'hasPendingTaskEffects' | 'settleAbandonedRun' | 'recordEvent'
> &
  Pick<
    SessionRunsPort,
    | 'get'
    | 'messages'
    | 'append'
    | 'pendingInputs'
    | 'workspaceBinding'
    | 'goal'
    | 'saveProjectionCheckpoints'
  > &
  Pick<SessionContextPort, 'leaseOf'> &
  Pick<SessionCheckpointPort, 'events' | 'flush'> &
  Pick<FileChangePort, 'prepareFileChangeGroup' | 'markFileChange' | 'fileChangeBytes'> & {
    lastSeq(id: string): number;
  };

/** Every collaborator a `SessionStore` forwards to, built over one connection. */
export interface SessionStoreParts {
  journal: SessionEventJournal;
  checkpoints: SessionCheckpoints;
  search: SessionSearch;
  changes: SessionFileChanges;
  schema: SessionMigrations;
  plans: SqlitePlanStore;
  /** The task execution journal (see `./session-tasks.ts`). */
  tasks: TaskJournal;
  /** Streamed-answer recovery points (see `./session-streams.ts`). */
  streams: StreamCheckpoints;
  /** Renaming, generated titles and deletion (see `./session-lifecycle.ts`). */
  lifecycle: SessionLifecycle;
  /**
   * Durable execution bindings: which directory a session actually works in.
   *
   * Deliberately separate from `Session.workspace`, which keeps meaning *the logical project* the run belongs to
   * — session lists, ownership checks and the scheduler all read that. A sub-agent's directory is a second fact,
   * and this is where it lives; see `./session-workspaces.ts` for why the two must not be merged.
   */
  workspaces: SessionWorkspaces;
  workspaceApply: SessionWorkspaceApply;
  taskDefinitions: SessionTaskDefinitions;
  completion: SessionCompletion;
  context: SessionContext;
  runs: SessionRuns;
  records: SessionRecords;
  reads: SessionProjectionReads;
}

/**
 * The store's composition root: each collaborator is given the connection and the operations it borrows.
 *
 * The journal comes first because it owns the connection's write ordering — `transaction` and the log every
 * other module reads — and the rest borrow it rather than a copy.
 */
export function createSessionStoreParts(
  db: DatabaseSync,
  projections: SessionProjectionRegistry,
  store: SessionStoreFacade,
  /** The store's transaction wrapper, which is the journal's: every collaborator commits through the same one. */
  transaction: <T>(fn: () => T) => T,
): SessionStoreParts {
  const journal = new SessionEventJournal({ db, get: (id) => store.get(id) });
  const checkedLog = (id: string) => journal.checkedLog(id);
  const checkpoints = new SessionCheckpoints({
    db,
    projections,
    transaction,
    checkedLog,
    events: (id, afterSeq, limit) => store.events(id, afterSeq, limit),
    flush: (id) => store.flush(id),
  });
  const search = new SessionSearch({
    db,
    flush: (id) => store.flush(id),
    get: (id) => store.get(id),
  });
  const changes = new SessionFileChanges({
    db,
    transaction,
    get: (id) => store.get(id),
    append: (id, message) => store.append(id, message),
    prepareFileChangeGroup: (sessionId, change, files) =>
      store.prepareFileChangeGroup(sessionId, change, files),
    markFileChange: (id, status) => store.markFileChange(id, status),
    fileChangeBytes: (sessionId, id) => store.fileChangeBytes(sessionId, id),
  });
  const schema = new SessionMigrations({ db, transaction });
  const plans = new SqlitePlanStore(db, (id) => {
    store.get(id);
  });
  const completion = new SessionCompletion({ db });
  /**
   * The task journal. `transaction` is what makes a multi-write task transition atomic, and `recordEvent` is what
   * puts the same change in the log; the store forwards to it, so every caller keeps the signature it had.
   */
  const tasks = new TaskJournal({
    db,
    transaction,
    getTask: (sessionId, id) => store.getTask(sessionId, id),
    getTaskAttempt: (sessionId, taskId, attemptId) =>
      store.getTaskAttempt(sessionId, taskId, attemptId),
    hasPendingTaskEffects: (sessionId, taskId, attemptId) =>
      store.hasPendingTaskEffects(sessionId, taskId, attemptId),
    completionVerificationRounds: (sessionId, attemptId) =>
      completion.completionVerificationRounds(sessionId, attemptId),
    settleAbandonedRun: (sessionId, runId, reason) =>
      store.settleAbandonedRun(sessionId, runId, reason),
    recordEvent: (id, type, data, stored) => store.recordEvent(id, type, data, stored),
  });
  /** The two writes that must go through the same log as the stream checkpoints: `append`, `recordEvent`. */
  const streams = new StreamCheckpoints({
    db,
    transaction,
    append: (id, message) => store.append(id, message),
    recordEvent: (id, type, data, stored) => store.recordEvent(id, type, data, stored),
  });
  /**
   * The journal's two cache members are handed over as operations rather than references: this module may say a
   * session's cached rows are stale, not reach into the caches itself.
   */
  const lifecycle = new SessionLifecycle({
    db,
    transaction,
    get: (id) => store.get(id),
    recordEvent: (id, type, data, stored) => store.recordEvent(id, type, data, stored),
    dropLogCache: (id) => {
      journal.dropLogCache(id);
    },
    dropPendingAppends: (id) => {
      journal.dropPendingAppends(id);
    },
  });
  /**
   * The workspace bindings borrow `get` rather than a copy of the workspace string because the ownership check it
   * makes has to be against what the row says *now*: a session whose project was edited after a binding was
   * written is a binding that no longer describes where the session belongs.
   */
  const workspaces = new SessionWorkspaces({
    db,
    transaction,
    sessionProject: (sessionId) => {
      const session = store.get(sessionId);
      return {
        workspace: session.workspace,
        parentSessionId: session.parentSessionId ?? null,
      };
    },
  });
  const workspaceApply = new SessionWorkspaceApply({
    transaction,
    workspaces,
    prepareFileChangeGroup: (sessionId, change, files) =>
      store.prepareFileChangeGroup(sessionId, change, files),
    markFileChange: (id, status) => store.markFileChange(id, status),
  });
  const taskDefinitions = new SessionTaskDefinitions({
    db,
    get: (id) => store.get(id),
    transaction,
  });
  const context = new SessionContext({
    db,
    get: (id) => store.get(id),
    checkedLog,
    leaseOf: (id) => store.leaseOf(id),
    messages: (id) => store.messages(id),
    recordEvent: (id, type, data) => store.recordEvent(id, type, data),
  });
  const runs = new SessionRuns({
    db,
    transaction,
    get: (id) => store.get(id),
    messages: (id) => store.messages(id),
    append: (id, message) => store.append(id, message),
    pendingInputs: (id) => store.pendingInputs(id),
    recordEvent: (id, type, data) => store.recordEvent(id, type, data),
    workspaceBinding: (id) => store.workspaceBinding(id),
    workspaces,
    goal: (id) => store.goal(id),
    saveProjectionCheckpoints: (id) => store.saveProjectionCheckpoints(id),
  });
  const records = new SessionRecords({
    db,
    flush: (id) => store.flush(id),
    get: (id) => store.get(id),
  });
  const reads = new SessionProjectionReads({
    get: (id) => store.get(id),
    flush: (id) => store.flush(id),
    lastSeq: (id) => store.lastSeq(id),
    projectionNames: () => projections.names(),
    foldProjections: (names, sessionId) => checkpoints.foldProjections(names, sessionId),
    saveProjectionCheckpoints: (id) => store.saveProjectionCheckpoints(id),
  });
  return {
    journal,
    checkpoints,
    search,
    changes,
    schema,
    plans,
    tasks,
    streams,
    lifecycle,
    workspaces,
    workspaceApply,
    taskDefinitions,
    completion,
    context,
    runs,
    records,
    reads,
  };
}
