import { createHash } from 'node:crypto';
import type {
  Acceptance,
  Approval,
  Message,
  Task,
  TaskAttempt,
  TaskAttemptKind,
  TaskStatus,
  TaskStep,
  TaskStepStatus,
  TaskTrigger,
  TaskTriggerSource,
} from '../protocol/index.ts';
import type { FileChange } from '../protocol/index.ts';
import type { SessionLease } from '../protocol/session-lease.ts';
import {
  normalizeTaskDraft,
  validateAcceptance as normalizeAcceptance,
} from '../core/task-spec.ts';
import { initialRunAt } from '../core/task-trigger.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabasePolicy } from './database-maintenance.ts';
import type { SessionEvent } from './events.ts';
import type { SessionProjection } from './projections.ts';
import { redactSecrets } from '../core/errors.ts';

/**
 * The storage layer's own vocabulary: what a session record is, whose database file this is, and what
 * a task definition and its step list have to look like before they are written.
 *
 * Nothing here touches a database connection, which is why it can be lifted out of the store: the
 * validators and the identity constants are answers about *shape*, and the store is the only thing
 * that knows how to write them down.
 */

export interface Session {
  title: string;
  id: string;
  workspace: string;
  createdAt: string;
  activeRun: string | null;
  /** The session that delegated to this one, when this session belongs to a sub-agent run. */
  parentSessionId?: string | null;
}
export interface StoredFileChange {
  id: string;
  sessionId: string;
  change: FileChange;
  status: 'pending' | 'applied' | 'abandoned' | 'conflict' | 'undoing' | 'undone';
  createdAt: string;
}
/** How many sessions one search may return, and how many matching messages it shows per session. */
export const MAX_SEARCH_SESSIONS = 10;
export const MAX_SEARCH_MATCHES = 5;
/** One message that matched, with the text around the match. */
export interface SessionSearchMatch {
  /** The message's log position in its session, which is also how a reader resumes from it. */
  seq: number;
  role: string;
  /** The matched text with the hit marked, produced by FTS5 rather than by a substring search here. */
  snippet: string;
}
export interface SessionSearchHit {
  session: Session;
  matches: SessionSearchMatch[];
  /** How many messages in this session match in total, which may exceed `matches.length`. */
  total: number;
}
export interface SessionSearchPage {
  hits: SessionSearchHit[];
  /** Present when more sessions could be ranked; pass it back as `cursor` for the next page. */
  cursor?: string;
  /**
   * How many sessions this call ranked — the size of the window the pages walk.
   *
   * Not "how many sessions match in the database": the ranking is computed from a bounded row slice per call (see
   * `searchSessions`), so this is the length of the list the cursor is a position in. A caller that shows
   * "N results" should say what N is rather than implying the count is exhaustive.
   */
  rankedTotal: number;
}
/**
 * The cursor is opaque: base64 of a small JSON object rather than a bare number.
 *
 * Not for secrecy — for shape. A plain integer would invite a caller to do arithmetic on it, and this is not an
 * offset into a table but a position in an ordering that is recomputed per call. Encoding it keeps that a detail
 * of this module, and leaves room to carry more of the ordering later without changing the API.
 */
export function writeSearchCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}
export function readSearchCursor(cursor: string): number {
  if (typeof cursor !== 'string' || !cursor.trim())
    throw new Error('Invalid session search cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid session search cursor');
  }
  const value = parsed as { v?: unknown; offset?: unknown };
  // A cursor from a future shape is refused rather than guessed at: the ordering it encodes may not exist here.
  if (!value || typeof value !== 'object' || value.v !== 1)
    throw new Error('Invalid session search cursor');
  // `typeof` before the numeric checks: `Number('3')` is 3, and a cursor this module did not write is not one
  // this module should be lenient about.
  if (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0)
    throw new Error('Invalid session search cursor');
  return value.offset;
}
export interface TaskCreate {
  title: string;
  description?: string;
  acceptance?: Acceptance[];
  steps?: TaskStep[];
  trigger?: TaskTrigger;
}
export interface TaskUpdate {
  title?: string;
  description?: string;
  status?: TaskStatus;
  acceptance?: Acceptance[];
  steps?: TaskStep[];
  trigger?: TaskTrigger | null;
}

/**
 * Shared projection for every task read. Keeping one definition means a new column cannot be
 * added to `getTask` while silently missing from `listTasks`.
 */
export const TASK_SELECT =
  "SELECT t.id,t.session_id AS sessionId,t.title,t.description,t.status,t.acceptance,t.verification,t.steps,t.trigger,t.trigger_revision AS triggerRevision,t.next_run_at AS nextRunAt,t.last_run_at AS lastRunAt,t.last_trigger_error AS lastTriggerError,t.created_at AS createdAt,t.updated_at AS updatedAt,(SELECT count(*) FROM task_attempts a WHERE a.task_id=t.id) AS attemptCount,(SELECT a.id FROM task_attempts a WHERE a.task_id=t.id ORDER BY a.ordinal DESC LIMIT 1) AS latestAttemptId,(SELECT a.run_id FROM task_attempts a WHERE a.task_id=t.id AND a.run_id IS NOT NULL AND a.ordinal>t.definition_attempt_floor ORDER BY a.ordinal DESC LIMIT 1) AS latestRunId,EXISTS(SELECT 1 FROM task_effects e WHERE e.task_id=t.id AND e.status='pending') AS pendingEffect,p.state AS approvalState,p.approval AS approvalJson,p.created_at AS approvalCreatedAt,p.reviewed_at AS approvalReviewedAt FROM tasks t LEFT JOIN task_approvals p ON p.task_id=t.id";

export const TASK_ATTEMPT_SELECT =
  'SELECT id,task_id AS taskId,session_id AS sessionId,ordinal,kind,run_id AS runId,status,prompt,trigger,resume,verification,error,started_at AS startedAt,finished_at AS finishedAt FROM task_attempts';

export function sameApprovalDescription(saved: Approval, next: Approval): boolean {
  if (saved.description === next.description) return true;
  // Registry descriptions prefix the rendered tool arguments. Their object key order may differ
  // on a resumed model call even when the approved arguments and preview are identical.
  const savedPrefix = `${saved.toolCall.name}: ${JSON.stringify(saved.toolCall.arguments)}`;
  const nextPrefix = `${next.toolCall.name}: ${JSON.stringify(next.toolCall.arguments)}`;
  return (
    saved.description.startsWith(savedPrefix) &&
    next.description.startsWith(nextPrefix) &&
    saved.description.slice(savedPrefix.length) === next.description.slice(nextPrefix.length)
  );
}

export const TASK_APPROVAL_OUTCOME_UNKNOWN =
  'Approved operation outcome unknown after Host interruption; inspect workspace before retrying or rearming this task.';
export const TASK_EFFECT_OUTCOME_UNKNOWN =
  'Task side effect outcome unknown; inspect the workspace or external system before retrying or rearming this task.';
/**
 * What an unresolved tool call is answered with when the process that made it is gone.
 *
 * One constant for every path that converges an abandoned run, because the sentence is the *record* of the
 * interruption: a reader has to be able to tell that a call's outcome is unknown from the call's own result,
 * and three slightly different wordings would make that a guess.
 */
export const RUN_INTERRUPTED_REASON =
  'Previous run was interrupted. Execution outcome is unknown; inspect current state before retrying.';

/** The statuses a task may be in, for the refusals that name an invalid one. */
export const taskStatuses = new Set<TaskStatus>([
  'pending',
  'in_progress',
  'completed',
  'needs_review',
  'blocked',
  'cancelled',
]);
/** The status a step may be in, checked when a definition or a resume result is written. */
export const taskStepStatuses = new Set<TaskStepStatus>([
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'skipped',
]);
const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(['in_progress', 'cancelled']),
  in_progress: new Set(['completed', 'needs_review', 'blocked', 'cancelled']),
  completed: new Set(['in_progress', 'needs_review']),
  needs_review: new Set(['in_progress', 'completed', 'cancelled']),
  blocked: new Set(['in_progress', 'cancelled']),
  cancelled: new Set(['in_progress']),
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from !== to && !taskTransitions[from].has(to))
    throw new Error(`Invalid task status transition: ${from} -> ${to}`);
}

/**
 * Step list for a resumed attempt: everything previously completed stays completed, the first
 * unfinished step is marked in progress, and later steps start from a clean pending state so a
 * previous failure's `blocked` marker does not leak into the new attempt.
 */
export function resumeSteps(
  steps: TaskStep[],
  checkpointed: Map<number, TaskStepStatus>,
): TaskStep[] {
  const seeded: TaskStep[] = steps.map((step, index) =>
    checkpointed.get(index) === 'completed'
      ? { ...step, status: 'completed' }
      : { ...step, status: 'pending' },
  );
  const firstOpen = seeded.findIndex((step) => step.status !== 'completed');
  if (firstOpen !== -1) seeded[firstOpen] = { ...seeded[firstOpen]!, status: 'in_progress' };
  return seeded;
}

/** A disabled trigger has no pending obligation, so it stores no next run time. */
export function scheduledNextRunAt(trigger: TaskTrigger | undefined, from: Date): string | null {
  if (!trigger?.enabled) return null;
  return initialRunAt(trigger, from) ?? null;
}

/** Preserve revision ordering without hiding a damaged timestamp behind an opaque RangeError. */
export function nextTaskTimestamp(previous?: string): string {
  const parsed = previous === undefined ? 0 : Date.parse(previous);
  if (!Number.isFinite(parsed))
    throw new Error('Invalid persisted task timestamp; inspect the task before editing');
  return new Date(Math.max(Date.now(), parsed + 1)).toISOString();
}

/** Completed step indexes straight from the journal, without opening a nested transaction. */
export function completedStepIndexesFor(db: DatabaseSync, taskId: string): number[] {
  const rows = db
    .prepare(
      'SELECT step_index AS stepIndex,status FROM task_step_checkpoints WHERE task_id=? ORDER BY seq',
    )
    .all(taskId);
  const latest = new Map<number, string>();
  for (const row of rows) latest.set(Number(row.stepIndex), String(row.status));
  return [...latest.entries()]
    .filter(([, status]) => status === 'completed')
    .map(([index]) => index)
    .sort((left, right) => left - right);
}

export function validateTaskText(
  value: string,
  field: string,
  maximum: number,
  empty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    /[\x00]/.test(value)
  )
    throw new Error(`Invalid task ${field}`);
  return field === 'title' ? value.trim() : value;
}

export function validateAcceptance(value: Acceptance[]): Acceptance[] {
  return normalizeAcceptance(value);
}

export function validateSteps(value: TaskStep[]): TaskStep[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid task steps');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || !taskStepStatuses.has(item.status))
      throw new Error('Invalid task step');
    return {
      description: validateTaskText(item.description, 'step description', 2_000),
      status: item.status,
    };
  });
}

/** The normalized definition an `updateTask` writes, or a refusal. */
export function taskDraft(input: unknown): ReturnType<typeof normalizeTaskDraft> {
  return normalizeTaskDraft(input);
}
/**
 * The plain-text projection of a message that session search indexes.
 *
 * Session search used to run `instr(lower(json_extract(body, …)))` over every row, which parses each
 * message body and scans the same blob that holds base64 image data. This projection keeps only the
 * conversational text in a column the FTS5 index can cover, so a search never touches an image
 * payload. Non-conversational roles project to '' and therefore match nothing, which preserves the
 * previous behaviour of searching user and assistant text only.
 */
export function messageSearchText(message: Message): string {
  if (message.role !== 'user' && message.role !== 'assistant') return '';
  const text =
    message.role === 'user' ? (message.displayContent ?? message.content) : message.content;
  // Control characters would end up in the index and make MATCH behave oddly; collapse whitespace so
  // a phrase query can still line up across the newlines of a multi-line message.
  return typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() : '';
}
/**
 * Turn free-form search text into an FTS5 query, or null when there is nothing indexable to match.
 *
 * User input must never reach MATCH verbatim: a stray `"`, `*`, `-`, `:` or `NEAR` is FTS5 syntax and
 * makes the statement throw, which would turn the search box into an error path. Words are extracted
 * and each is quoted, so punctuation is literal, and they are AND-joined to keep the previous
 * "all words must appear" behaviour of the substring scan. Text with no word characters at all
 * returns null so the caller can skip the MATCH clause entirely — an empty FTS5 phrase is itself a
 * syntax error.
 */
export function ftsQuery(text: string): string | null {
  const words = [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => match[0]!).slice(0, 12);
  return words.length ? words.map((word) => `"${word}"`).join(' AND ') : null;
}
/**
 * True when the process that owned a run is gone. A live owner means the run is genuinely still
 * running, so recovery must leave it alone; only a dead owner makes a `running` row a leftover.
 */
export function deadOwner(ownerPid: unknown): boolean {
  if (ownerPid === null || ownerPid === undefined) return true;
  try {
    process.kill(Number(ownerPid), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * The identity a session database declares, so it can tell whose file this is.
 *
 * `PRAGMA application_id` is the SQLite-native answer to this question and the wrong one to *rely* on here: this
 * runtime's `node:sqlite` binding accepts `PRAGMA application_id=…` and applies it to the connection only. The
 * value reads back in the session that set it and is never written to the header — measured, not assumed: byte 68
 * of the file stays 0 while `user_version` (byte 60) persists through the same sequence. A database that cannot
 * write the value cannot use it as its identity, so the identity lives in a row instead (`application_marker`),
 * which is portable, readable by any tool, and checkable *before* the schema is applied.
 *
 * The pragma is still read, because a file written by some other build or another tool may carry one, and a
 * different non-zero value is a fact worth refusing on.
 */
export const APPLICATION_ID = parseInt(
  createHash('sha256').update('yuantu-agent').digest('hex').slice(0, 8),
  16,
);
/** The name the marker row carries: the file's own answer to "whose database is this". */
export const APPLICATION_NAME = 'yuantu-agent';
/**
 * The marker's format, so a future shape can be recognised rather than mistaken for a stranger's file.
 *
 * The schema version in `user_version` cannot serve this purpose: it is the number a *reader* must already know
 * how to interpret, which is exactly what is in doubt when the file turns out to be somebody else's.
 */
export const APPLICATION_FORMAT = 1;
/**
 * The identity of one projection's fold, recorded with every checkpoint it writes.
 *
 * This replaces a single global integer. That integer was one number for every projection in the build, so
 * changing *one* fold's shape invalidated *every* session's checkpoints for *every* projection — the cost of a
 * small edit was a cold fold of the whole database — while it still could not answer the question the checkpoint
 * actually needs answered, which is whether *this* projection's fold produced this state.
 *
 * Both halves of the name matter. The projection's own name is what the row is keyed by, and folding it in means
 * two different projections can never share a checkpoint. The source of `initial` and `apply` is what makes the
 * answer automatic: a fold whose shape changed produces a different identity, so its checkpoints are ignored and
 * it re-folds from the log — which is always correct, and is the whole reason stale state is safe to keep on disk
 * at all. Forgetting to bump a hand-written version is the mistake this cannot make, and one extra cold fold per
 * session is what it costs.
 *
 * It is a property of the fold *code*, not of the runtime: the same source under a different `tsc`/bundler
 * output is a different identity, and a checkpoint written by one build is not continued by the other. That is
 * the conservative direction — a re-fold — and it is why this is a digest rather than a number anybody maintains.
 */
export function projectionFoldIdentity(projection: SessionProjection<unknown>): string {
  const source = (fn: unknown) => {
    const text = typeof fn === 'function' ? String(fn) : '';
    // A function whose source the runtime will not give up (a proxy, a native binding) still deserves an
    // identity: the name alone then decides, which is coarser but never silently continues a changed fold --
    // it just cannot tell two versions of one name apart, and the next branch re-folds.
    return text || 'unknown';
  };
  return createHash('sha256')
    .update(
      `${projection.name}\u0000${source(projection.initial)}\u0000${source(projection.apply)}`,
    )
    .digest('hex');
}
/**
 * The schema this build writes, and the newest one it will open.
 *
 * One constant rather than a literal in two places: the write at the end of migration and the guard at the top
 * of the constructor have to agree, and the failure they would produce apart is silent in one direction (an
 * older build opening a newer file) and fatal in the other.
 */
export const SCHEMA_VERSION = 28;
/**
 * Every table this build creates, so "is this file ours?" can be answered without guessing.
 *
 * Used only for a file with no marker row and no `sessions` table — the state a database written by somebody
 * else is in. A table of theirs is evidence; a table of ours (or one of our older tables, which a migration
 * drops) is not. Kept as a list rather than derived from the schema text because deriving it would mean parsing
 * the statements at startup to answer a question about a file that is probably not ours in the first place.
 */
export const SCHEMA_TABLES = [
  'application_marker',
  'attachment_blobs',
  'context_checkpoints',
  'file_change_files',
  'file_changes',
  'messages',
  'messages_fts',
  'plans',
  'projection_checkpoints',
  'run_stream_checkpoints',
  'runs',
  'session_events',
  'session_leases',
  'sessions',
  'subagent_assignments',
  'task_approvals',
  'task_attempts',
  'task_effects',
  'task_step_checkpoints',
  'tasks',
] as const;
export const SESSION_DATABASE_POLICY: DatabasePolicy = {
  application: APPLICATION_NAME,
  applicationId: APPLICATION_ID,
  format: APPLICATION_FORMAT,
  maxVersion: SCHEMA_VERSION,
};
/**
 * Whether a restored state has the same top-level shape as the projection's own empty state.
 *
 * Arrays, objects and primitives are the three answers this can give, and that is the point: the layer that
 * stores states knows nothing about what they mean, so the only claim it can honestly check is "this is the kind
 * of thing this projection produces". Null is allowed anywhere because several projections fold to `null` — a
 * goal that has not been set, a plan that does not exist — which makes "was it null before" uninformative.
 */
export function shapedLike(state: unknown, fresh: unknown): boolean {
  if (Array.isArray(fresh)) return Array.isArray(state);
  if (fresh === null || typeof fresh !== 'object') return typeof state === typeof fresh;
  return typeof state === 'object' && state !== null && !Array.isArray(state);
}
/**
 * Whether a checkpoint state can be trusted, by putting it through one real fold step.
 *
 * This is the check that makes a checkpoint an *optimisation* rather than a second source of truth. Its critical
 * case is the one where nothing else would catch a bad state: a checkpoint that has already reached the end of
 * the log, so the loop that reads it folds no events on top of it and the state is returned as the answer.
 * Replaying the event the checkpoint claims to include proves the state is one this fold can actually continue —
 * a state that throws, or that comes back with a different shape than it went in with, is not.
 *
 * A projection whose fold is non-deterministic or position-dependent would be caught here as a false alarm and
 * simply re-fold from the log, which is the safe direction; folds in this runtime are pure functions of
 * (state, event) by contract, and `tests/projection-checkpoint.test.ts` holds the built-ins to it.
 */
export function trustedCheckpoint(
  projection: SessionProjection<unknown>,
  checkpoint: { seq: number; state: unknown },
  events: readonly SessionEvent[],
): boolean {
  const last = events.find((event) => event.seq === checkpoint.seq);
  // A checkpoint at a sequence the log no longer holds was already refused by `readProjectionCheckpoint`.
  if (!last) return true;
  try {
    const next = projection.apply(checkpoint.state, last);
    return shapedLike(next, checkpoint.state);
  } catch {
    return false;
  }
}
/**
 * How many buffered messages force a write. The buffer is emptied by reads and by the run loop's own
 * flush points, so this only bounds a session nobody reads: it is a memory guard, not a durability rule.
 */
export const APPEND_BATCH_LIMIT = 64;
/**
 * Reads hand out the same arrays the cache holds, so they are frozen: a reader that reorders or appends to
 * what it was given would be editing the store's own fold. A caller that needs its own order copies first.
 */
export function frozen<T>(values: T[]): T[] {
  return Object.freeze(values) as T[];
}
/**
 * How many sessions' transcripts one store keeps folded. A store is shared by a host that outlives the
 * sessions it reads, so the cache is bounded; eight covers the sessions a reader is actually working with.
 */
export const LOG_CACHE_ENTRIES = 8;
/** How long ago a lease was renewed, as a phrase, or nothing when the timestamp is unusable. */
export function ageSuffix(renewedAt: string | undefined): string {
  const at = renewedAt === undefined ? Number.NaN : Date.parse(renewedAt);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return `, last active ${seconds}s ago`;
}
/**
 * What a refusal can say about the run that holds a session, when the lease still knows.
 *
 * Evidence, not a verdict: it never decides that a run is dead — the pid does that — it only tells the person
 * reading the error whether the owner was doing something a moment ago.
 */
export function leaseEvidence(lease: SessionLease | null): string {
  if (!lease) return '';
  return ` It is run ${lease.runId} (pid ${lease.ownerPid}${ageSuffix(lease.renewedAt)}, ${lease.renewals} renewal(s)).`;
}

/**
 * The status of every step a task has checkpointed, from the journal rather than from a nested read.
 *
 * A row is *evidence*, so an unrecognised status is dropped rather than trusted: a checkpoint written by a newer
 * build naming a status this one does not know must not enter a step list that would then be written back from.
 */
export function stepStatusMap(db: DatabaseSync, taskId: string): Map<number, TaskStepStatus> {
  const rows = db
    .prepare(
      'SELECT step_index AS stepIndex,status FROM task_step_checkpoints WHERE task_id=? ORDER BY seq',
    )
    .all(taskId);
  const map = new Map<number, TaskStepStatus>();
  for (const row of rows) {
    const status = String(row.status) as TaskStepStatus;
    if (taskStepStatuses.has(status)) map.set(Number(row.stepIndex), status);
  }
  return map;
}

/**
 * One task attempt as its row stores it.
 *
 * The trigger is checked against the known sources rather than cast: a value this build does not recognise — a
 * row written by a newer build, or a damaged one — reads as `manual`, which is the only source that claims
 * nothing about why an attempt started.
 */
export function taskAttemptFromRow(row: Record<string, unknown>): TaskAttempt {
  const source = String(row.trigger ?? 'manual');
  return {
    id: String(row.id),
    taskId: String(row.taskId),
    sessionId: String(row.sessionId),
    ordinal: Number(row.ordinal),
    kind: String(row.kind) as TaskAttemptKind,
    ...(row.runId ? { runId: String(row.runId) } : {}),
    status: String(row.status) as TaskStatus,
    ...(row.prompt ? { prompt: String(row.prompt) } : {}),
    trigger: [
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
      ? (source as TaskTriggerSource)
      : 'manual',
    resume: Number(row.resume ?? 0) === 1,
    ...(row.verification
      ? {
          verification: JSON.parse(String(row.verification)) as NonNullable<Task['verification']>,
        }
      : {}),
    ...(row.error ? { error: String(row.error) } : {}),
    startedAt: String(row.startedAt),
    ...(row.finishedAt ? { finishedAt: String(row.finishedAt) } : {}),
  };
}

/**
 * One task as its row stores it, including the one fact that comes from *outside* the row.
 *
 * `pendingEffect` is a column of the task SELECT's own EXISTS subquery rather than a query per task: a list of a
 * hundred tasks must not run a hundred existence checks to answer a question the row already carries.
 * `approvalOutcomeUnknown` is then derived from it and the two recorded refusals, because "an approved
 * operation's outcome is unknown" is the one state a reader must not be able to miss — it is what stops a task
 * from being rearmed over an effect that may already have happened.
 */
export function taskFromRow(row: Record<string, unknown>): Task {
  const pendingEffect = Boolean(row.pendingEffect);
  const persistedApproval = row.approvalJson
    ? (JSON.parse(String(row.approvalJson)) as Approval & { requestId?: string })
    : undefined;
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as TaskStatus,
    acceptance: JSON.parse(String(row.acceptance)) as Acceptance[],
    ...(row.verification
      ? {
          verification: JSON.parse(String(row.verification)) as NonNullable<Task['verification']>,
        }
      : {}),
    steps: JSON.parse(String(row.steps)) as TaskStep[],
    ...(row.trigger ? { trigger: JSON.parse(String(row.trigger)) as TaskTrigger } : {}),
    ...(row.triggerRevision ? { triggerRevision: String(row.triggerRevision) } : {}),
    ...(row.nextRunAt ? { nextRunAt: String(row.nextRunAt) } : {}),
    ...(row.lastRunAt ? { lastRunAt: String(row.lastRunAt) } : {}),
    ...(row.lastTriggerError ? { lastTriggerError: String(row.lastTriggerError) } : {}),
    ...(pendingEffect ||
    row.lastTriggerError === TASK_APPROVAL_OUTCOME_UNKNOWN ||
    row.lastTriggerError === TASK_EFFECT_OUTCOME_UNKNOWN
      ? { approvalOutcomeUnknown: true }
      : {}),
    ...(row.approvalState && persistedApproval
      ? {
          pendingApproval: {
            // The request's own id when it has one; otherwise derived from the row, so the same stored approval
            // presents the same id on every read and in every process.
            id:
              persistedApproval.requestId ??
              createHash('sha256')
                .update(String(row.approvalCreatedAt))
                .update(String(row.approvalJson))
                .digest('hex')
                .slice(0, 32),
            state: String(row.approvalState) as NonNullable<Task['pendingApproval']>['state'],
            phase: persistedApproval.toolCall.id.startsWith('acceptance:') ? 'acceptance' : 'tool',
            kind: persistedApproval.kind,
            tool: persistedApproval.toolCall.name,
            description: redactSecrets(persistedApproval.description),
            createdAt: String(row.approvalCreatedAt),
            ...(row.approvalReviewedAt ? { reviewedAt: String(row.approvalReviewedAt) } : {}),
          },
        }
      : {}),
    attemptCount: Number(row.attemptCount ?? 0),
    ...(row.latestAttemptId ? { latestAttemptId: String(row.latestAttemptId) } : {}),
    ...(row.latestRunId ? { latestRunId: String(row.latestRunId) } : {}),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}
