import { SqlitePlanStore } from './plans.ts';
import type { PlanBody, PlanRepository } from '../protocol/plans.ts';
export { normalizePlanBody, planHash } from '../protocol/plans.ts';
export type { PlanBody } from '../protocol/plans.ts';
import type { SessionLease } from '../protocol/session-lease.ts';
export { LEASE_RENEW_INTERVAL_MS } from '../protocol/session-lease.ts';
export type { SessionLease } from '../protocol/session-lease.ts';
import { DatabaseSync } from 'node:sqlite';
import {
  createDatabaseBackup,
  initializeDatabase,
  registerDatabase,
  type BackupPolicy,
  type DatabasePolicy,
} from './database-maintenance.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  Acceptance,
  Approval,
  FileChange,
  FileSnapshot,
  Message,
  Plan,
  RunResult,
  SubAgentSummary,
  Task,
  TaskAttempt,
  TaskAttemptKind,
  TaskStatus,
  TodoItem,
  TaskStep,
  TaskStepCheckpoint,
  TaskStepStatus,
  TaskTrigger,
  TaskTriggerSource,
  Usage,
} from '../protocol/index.ts';
import {
  normalizeTaskDraft,
  validateAcceptance as normalizeAcceptance,
} from '../core/task-spec.ts';
import {
  normalizeTaskTrigger,
  initialRunAt,
  oneShot,
  misfirePolicy,
  nextRunAt as nextRunAtValue,
} from '../core/task-trigger.ts';
import { contextBoundaries, isMachineContext, surfaceOf } from '../protocol/context.ts';
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
import type { SessionProjection } from './projections.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import type { Goal } from '../protocol/goals.ts';

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
function writeSearchCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}
function readSearchCursor(cursor: string): number {
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
const TASK_SELECT =
  'SELECT t.id,t.session_id AS sessionId,t.title,t.description,t.status,t.acceptance,t.verification,t.steps,t.trigger,t.trigger_revision AS triggerRevision,t.next_run_at AS nextRunAt,t.last_run_at AS lastRunAt,t.last_trigger_error AS lastTriggerError,t.created_at AS createdAt,t.updated_at AS updatedAt,(SELECT count(*) FROM task_attempts a WHERE a.task_id=t.id) AS attemptCount,(SELECT a.id FROM task_attempts a WHERE a.task_id=t.id ORDER BY a.ordinal DESC LIMIT 1) AS latestAttemptId,(SELECT a.run_id FROM task_attempts a WHERE a.task_id=t.id AND a.run_id IS NOT NULL AND a.ordinal>t.definition_attempt_floor ORDER BY a.ordinal DESC LIMIT 1) AS latestRunId,p.state AS approvalState,p.approval AS approvalJson,p.created_at AS approvalCreatedAt,p.reviewed_at AS approvalReviewedAt FROM tasks t LEFT JOIN task_approvals p ON p.task_id=t.id';

function sameApprovalDescription(saved: Approval, next: Approval): boolean {
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
const TASK_APPROVAL_OUTCOME_UNKNOWN =
  'Approved operation outcome unknown after Host interruption; inspect workspace before retrying or rearming this task.';
const TASK_EFFECT_OUTCOME_UNKNOWN =
  'Task side effect outcome unknown; inspect the workspace or external system before retrying or rearming this task.';
/**
 * What an unresolved tool call is answered with when the process that made it is gone.
 *
 * One constant for every path that converges an abandoned run, because the sentence is the *record* of the
 * interruption: a reader has to be able to tell that a call's outcome is unknown from the call's own result,
 * and three slightly different wordings would make that a guess.
 */
const RUN_INTERRUPTED_REASON =
  'Previous run was interrupted. Execution outcome is unknown; inspect current state before retrying.';

const TASK_ATTEMPT_SELECT =
  'SELECT id,task_id AS taskId,session_id AS sessionId,ordinal,kind,run_id AS runId,status,prompt,trigger,resume,verification,error,started_at AS startedAt,finished_at AS finishedAt FROM task_attempts';

const taskStatuses = new Set<TaskStatus>([
  'pending',
  'in_progress',
  'completed',
  'needs_review',
  'blocked',
  'cancelled',
]);
const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(['in_progress', 'cancelled']),
  in_progress: new Set(['completed', 'needs_review', 'blocked', 'cancelled']),
  completed: new Set(['in_progress', 'needs_review']),
  needs_review: new Set(['in_progress', 'completed', 'cancelled']),
  blocked: new Set(['in_progress', 'cancelled']),
  cancelled: new Set(['in_progress']),
};

function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from !== to && !taskTransitions[from].has(to))
    throw new Error(`Invalid task status transition: ${from} -> ${to}`);
}

const taskStepStatuses = new Set<TaskStep['status']>([
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'skipped',
]);

/**
 * Step list for a resumed attempt: everything previously completed stays completed, the first
 * unfinished step is marked in progress, and later steps start from a clean pending state so a
 * previous failure's `blocked` marker does not leak into the new attempt.
 */
function resumeSteps(steps: TaskStep[], checkpointed: Map<number, TaskStepStatus>): TaskStep[] {
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
function scheduledNextRunAt(trigger: TaskTrigger | undefined, from: Date): string | null {
  if (!trigger?.enabled) return null;
  return initialRunAt(trigger, from) ?? null;
}

/** Completed step indexes straight from the journal, without opening a nested transaction. */
function completedStepIndexesFor(db: DatabaseSync, taskId: string): number[] {
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

function validateTaskText(value: string, field: string, maximum: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    /[\x00]/.test(value)
  )
    throw new Error(`Invalid task ${field}`);
  return field === 'title' ? value.trim() : value;
}

function validateAcceptance(value: Acceptance[]): Acceptance[] {
  return normalizeAcceptance(value);
}

function validateSteps(value: TaskStep[]): TaskStep[] {
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
function deadOwner(ownerPid: unknown): boolean {
  if (ownerPid === null || ownerPid === undefined) return true;
  try {
    process.kill(Number(ownerPid), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
/** How long ago a lease was renewed, as a phrase, or nothing when the timestamp is unusable. */
function ageSuffix(renewedAt: string | undefined): string {
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
function leaseEvidence(lease: SessionLease | null): string {
  if (!lease) return '';
  return ` It is run ${lease.runId} (pid ${lease.ownerPid}${ageSuffix(lease.renewedAt)}, ${lease.renewals} renewal(s)).`;
}
/**
 * How many sessions' transcripts one store keeps folded. A store is shared by a host that outlives the
 * sessions it reads, so the cache is bounded; eight covers the sessions a reader is actually working with.
 */
const LOG_CACHE_ENTRIES = 8;
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
function shapedLike(state: unknown, fresh: unknown): boolean {
  if (Array.isArray(fresh)) return Array.isArray(state);
  if (fresh === null || typeof fresh !== 'object') return typeof state === typeof fresh;
  return typeof state === 'object' && state !== null && !Array.isArray(state);
}
/**
 * Whether a checkpoint state can be trusted, by putting it through one real fold step.
 *
 * This is the check that makes a checkpoint an *optimisation* rather than a second source of truth. Its critical
 * case is the one where nothing else would catch a bad state: a checkpoint that has already reached the end of
 * the log, so the loop below folds no events on top of it and the state is returned as the answer. Replaying the
 * event the checkpoint claims to include proves the state is one this fold can actually continue — a state that
 * throws, or that comes back with a different shape than it went in with, is not.
 *
 * A projection whose fold is non-deterministic or position-dependent would be caught here as a false alarm and
 * simply re-fold from the log, which is the safe direction; folds in this runtime are pure functions of
 * (state, event) by contract, and `tests/projection-checkpoint.test.ts` holds the built-ins to it.
 */
function trustedCheckpoint(
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
const APPEND_BATCH_LIMIT = 64;
/**
 * Reads hand out the same arrays the cache holds, so they are frozen: a reader that reorders or appends to
 * what it was given would be editing the store's own fold. A caller that needs its own order copies first.
 */
function frozen<T>(values: T[]): T[] {
  return Object.freeze(values) as T[];
}
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
/** One image's bytes, keyed by the sha256 of those bytes. */
interface QueuedBlob {
  hash: string;
  mimeType: string;
  bytes: Buffer;
  size: number;
}
/** The content address of an image: sha256 over the decoded bytes, the convention `deliverables` also uses. */
function imageHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/**
 * The message as it is stored, plus the bytes the stored form refers to.
 *
 * A message with no images comes back unchanged — the bytes written for the ordinary case are exactly what
 * they were before this migration, which is what keeps a text-only session's rows (and every snapshot) stable.
 * An image this store cannot read as bytes is stored as it is rather than refused: refusing would turn an
 * unrecognised image into a failed append, and the reader is where that has to be said.
 */
function storedMessage(message: Message): { stored: unknown; blobs: QueuedBlob[] } {
  const images = (message as { images?: unknown }).images;
  if (!Array.isArray(images) || !images.length) return { stored: message, blobs: [] };
  const blobs: QueuedBlob[] = [];
  const stored = images.map((image) => {
    if (!image || typeof image !== 'object') return image;
    const record = image as Record<string, unknown>;
    const { data, mimeType } = record;
    if (typeof data !== 'string' || typeof mimeType !== 'string') return image;
    const bytes = Buffer.from(data, 'base64');
    const hash = imageHash(bytes);
    blobs.push({ hash, mimeType, bytes, size: bytes.length });
    // The address takes the bytes' place *in the same position*, so hydrating it back reproduces the key order
    // the live message had. Invariant I8 compares the write-through rows with the fold of the log through
    // `JSON.stringify`, and two shapes that differ only in key order would read as two different histories.
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) =>
        key === 'data' ? ['hash', hash] : [key, value],
      ),
    );
  });
  return { stored: { ...message, images: stored }, blobs };
}
/** Every content address a stored value mentions, for deciding which blobs a deletion orphans. */
function hashesIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) hashesIn(item, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (isImageReference(value)) into.add(value.hash);
  for (const child of Object.values(value as Record<string, unknown>)) hashesIn(child, into);
}
/**
 * The title a user message gives a session, with the whitespace a title cannot carry collapsed.
 *
 * `null` for a machine-written message. The first user message is not always a person's — a runtime snapshot or
 * a compaction summary can be there first — and a session named `<runtime-context source="memory"> …` is named
 * by bookkeeping rather than by what anybody asked. Returning `null` leaves the title empty, so the first
 * *person's* message names the session instead (or the model does, through `setGeneratedTitle`).
 */
function sessionTitle(message: Extract<Message, { role: 'user' }>): string | null {
  const source = message.displayContent ?? message.content;
  if (isMachineContext(source)) return null;
  return source
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
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
  private db!: DatabaseSync;
  private releaseDatabase?: () => void;
  private readonly plans: SqlitePlanStore;
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
  /** What projection reads have folded in this process; see `foldCounters`. */
  private foldCounters = { checkpointHits: 0, events: 0 };
  /** Events appended inside an open transaction, folded into the cache when that transaction commits. */
  private pendingLog: Map<string, SessionEvent[]> | null = null;
  /** Messages appended but not yet written, per session: one commit per batch instead of one per message. */
  private pendingAppends = new Map<string, QueuedMessage[]>();
  constructor(file: string, options: { backupRetention?: BackupPolicy } = {}) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.releaseDatabase = registerDatabase(file);
    try {
      this.db = new DatabaseSync(file);
      this.plans = new SqlitePlanStore(this.db, (id) => {
        this.get(id);
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
    this.db.exec('PRAGMA busy_timeout=5000');
    /**
     * Whose file is this? Answered before a single table of ours is interpreted.
     *
     * Three states, and each needs a different answer. A file that says it is ours is ours. A file that says it
     * is somebody else's — by marker row or by the `application_id` pragma — is refused by name, because the
     * alternative is our `CREATE TABLE IF NOT EXISTS` statements landing on top of a stranger's schema and a
     * later query failing to find one of our columns. A file that says nothing is either brand new or older than
     * this check; the second case is a database we wrote before we said so, and refusing it would strand the
     * users this is meant to protect — so the ambiguity is resolved by the only evidence available: a file that
     * already holds *our* tables is ours, and one that holds tables but none of ours is not.
     */
    const claimed = Number(this.db.prepare('PRAGMA application_id').get()?.application_id ?? 0);
    if (claimed !== 0 && claimed !== APPLICATION_ID)
      throw this.notOurs(file, `application_id ${claimed}`);
    const marker = this.marker();
    if (marker) {
      if (marker.application !== APPLICATION_NAME)
        throw this.notOurs(file, `the marker row says "${marker.application}"`);
      if (Number(marker.format) > APPLICATION_FORMAT)
        throw this.notOurs(
          file,
          `marker format ${marker.format}, newer than this build's ${APPLICATION_FORMAT}`,
        );
    } else if (this.hasTable('sessions')) {
      // Our table, no marker: a database this build wrote before the marker existed. Claimed below.
    } else {
      const foreign = this.foreignTables();
      if (foreign.length)
        throw this.notOurs(
          file,
          `it holds tables this build did not create: ${foreign.join(', ')}`,
        );
    }
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`Unsupported session database version: ${version}`);
    }
    if (file !== ':memory:' && version < SCHEMA_VERSION && this.hasTable('sessions')) {
      try {
        createDatabaseBackup(
          this.db,
          file,
          SESSION_DATABASE_POLICY,
          'migration',
          options.backupRetention,
        );
      } catch (error) {
        throw new Error(
          'Migration stopped because its backup failed: ' + (error as Error).message,
          { cause: error },
        );
      }
    }
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      -- The file's own answer to "whose database is this", read before any of our tables are interpreted.
      -- A row rather than PRAGMA application_id, which this runtime's SQLite binding applies to the connection
      -- only and never writes to the header (see APPLICATION_ID).
      CREATE TABLE IF NOT EXISTS application_marker (
        application TEXT PRIMARY KEY,
        format INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq);
      -- Image bytes, content-addressed (schema v21). A message row and its message.* log entry carry a
      -- hash plus a mime type instead of the base64, so the same picture costs one row instead of one copy
      -- per mention. Rows written before v21 keep their inline bytes and are read exactly as they are; the
      -- migration therefore creates an empty table and moves nothing.
      CREATE TABLE IF NOT EXISTS attachment_blobs (
        hash TEXT PRIMARY KEY, mime_type TEXT NOT NULL, bytes BLOB NOT NULL,
        size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_events_session ON session_events(session_id,seq);
      -- Who is writing each session right now (see SessionLease). Ephemeral presence: taken by beginRun,
      -- renewed by the run loop, released when the run finishes, and reclaimed only through the dead-owner
      -- path. Never expired by age, so it is not a second source of truth about a run's status.
      CREATE TABLE IF NOT EXISTS session_leases (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        renewed_at TEXT NOT NULL,
        renewals INTEGER NOT NULL DEFAULT 0,
        compacting_run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner_pid INTEGER NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL, result TEXT
      );
      CREATE TABLE IF NOT EXISTS run_stream_checkpoints (
        run_id TEXT NOT NULL REFERENCES runs(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS file_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT,
        change TEXT NOT NULL, before_bytes BLOB, after_bytes BLOB NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS changes_session ON file_changes(session_id,seq);
      -- Folded projection state, kept between processes. seq is how far into the session log it has been
      -- folded; version holds the identity of the fold that wrote it (see projectionFoldIdentity), so state
      -- written by a different fold of the same projection is ignored rather than continued.
      CREATE TABLE IF NOT EXISTS projection_checkpoints (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        seq INTEGER NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,name)
      );
      CREATE TABLE IF NOT EXISTS file_change_files (
        change_id TEXT NOT NULL REFERENCES file_changes(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, path TEXT NOT NULL,
        before_bytes BLOB, after_bytes BLOB,
        PRIMARY KEY(change_id,ordinal), UNIQUE(change_id,path)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        verification TEXT,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_session ON tasks(session_id,created_at,id);
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('planning','proposed','approved','rejected','abandoned')),
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        steps TEXT NOT NULL DEFAULT '[]',
        hash TEXT NOT NULL DEFAULT '',
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS plans_session ON plans(session_id,created_at DESC,id);
      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        prompt TEXT,
        baselines TEXT,
        verification TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(task_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS task_attempts_task ON task_attempts(task_id,ordinal);
      CREATE TABLE IF NOT EXISTS task_step_checkpoints (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_step_checkpoints_task ON task_step_checkpoints(task_id,seq);
      CREATE TABLE IF NOT EXISTS task_effects (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','completed','reviewed')),
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS task_effects_pending ON task_effects(task_id,status);
      CREATE TABLE IF NOT EXISTS task_approvals (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
        approval TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );

    `);
    this.transaction(() => {
      const columns = new Set(
        this.db
          .prepare('PRAGMA table_info(sessions)')
          .all()
          .map((row) => row.name),
      );
      if (!columns.has('title'))
        this.db.exec("ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''");
      /**
       * Where a session's title came from, which is what makes "may a model name this session" answerable in SQL.
       *
       * A session starts `fallback` (named from its first user message) and may be renamed to `generated` by the
       * title generator exactly once. A rename by a person writes `manual` and wins from then on: the generator's
       * `UPDATE` carries `WHERE title_source='fallback'`, so a title typed while the model call was in flight is
       * never overwritten — checking the condition in TypeScript would leave a window between the read and the
       * write, and that window is exactly when a person types.
       */
      if (!columns.has('title_source')) {
        this.db.exec(
          "ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'fallback'",
        );
        // A title from an older database may have been edited by its owner. Leave those names alone.
        this.db.exec("UPDATE sessions SET title_source='manual' WHERE title<>''");
      }
      if (!columns.has('parent_session_id'))
        this.db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
      if (!columns.has('fork_message_count'))
        this.db.exec('ALTER TABLE sessions ADD COLUMN fork_message_count INTEGER');
      const taskColumns = new Set(
        this.db
          .prepare('PRAGMA table_info(tasks)')
          .all()
          .map((row) => row.name),
      );
      if (!taskColumns.has('verification'))
        this.db.exec('ALTER TABLE tasks ADD COLUMN verification TEXT');
      if (!taskColumns.has('definition_attempt_floor'))
        this.db.exec(
          'ALTER TABLE tasks ADD COLUMN definition_attempt_floor INTEGER NOT NULL DEFAULT 0',
        );
      if (!taskColumns.has('trigger')) this.db.exec('ALTER TABLE tasks ADD COLUMN trigger TEXT');
      if (!taskColumns.has('trigger_revision'))
        this.db.exec('ALTER TABLE tasks ADD COLUMN trigger_revision TEXT');
      if (!taskColumns.has('current_delivery_id'))
        this.db.exec('ALTER TABLE tasks ADD COLUMN current_delivery_id TEXT');
      if (!taskColumns.has('next_run_at'))
        this.db.exec('ALTER TABLE tasks ADD COLUMN next_run_at TEXT');
      if (!taskColumns.has('last_run_at'))
        this.db.exec('ALTER TABLE tasks ADD COLUMN last_run_at TEXT');
      if (!taskColumns.has('last_trigger_error'))
        this.db.exec('ALTER TABLE tasks ADD COLUMN last_trigger_error TEXT');
      const attemptColumns = new Set(
        this.db
          .prepare('PRAGMA table_info(task_attempts)')
          .all()
          .map((row) => row.name),
      );
      if (!attemptColumns.has('trigger'))
        this.db.exec("ALTER TABLE task_attempts ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual'");
      if (!attemptColumns.has('resume'))
        this.db.exec('ALTER TABLE task_attempts ADD COLUMN resume INTEGER NOT NULL DEFAULT 0');
      // Session search index (v10). The projection column is filled by `append`, and the triggers keep
      // the FTS index in step for every write path, including the backfill below.
      const messageColumns = new Set(
        this.db
          .prepare('PRAGMA table_info(messages)')
          .all()
          .map((row) => row.name),
      );
      const needsBackfill = !messageColumns.has('search_text');
      if (needsBackfill)
        this.db.exec("ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
      // The triggers must exist before the backfill below, because that backfill fills the projection
      // and lets the update trigger mirror each row into the index.
      this.db
        .exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(search_text, tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
          WHEN new.search_text <> '' BEGIN
          INSERT INTO messages_fts(rowid,search_text) VALUES(new.seq,new.search_text); END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid=old.seq; END;
        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF search_text ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid=old.seq;
          INSERT INTO messages_fts(rowid,search_text)
            SELECT new.seq,new.search_text WHERE new.search_text <> ''; END;`);
      if (needsBackfill) {
        const rows = this.db.prepare('SELECT seq, body FROM messages').all();
        const update = this.db.prepare(
          "UPDATE messages SET search_text=? WHERE seq=? AND search_text=''",
        );
        for (const row of rows) {
          let text = '';
          try {
            text = messageSearchText(JSON.parse(String(row.body)) as Message);
          } catch {
            /* A body that no longer parses simply stays unsearchable. */
          }
          if (text) update.run(text, Number(row.seq));
        }
      }
      for (const step of this.migrations()) step.run(version);
      this.claimApplication();
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  }
  /**
   * The marker row, when the file carries one.
   *
   * Read before the schema is applied, which is why it does not go through `hasTable`: at that point the table
   * may be ours, somebody else's, or absent, and the query has to be the one that answers rather than throws.
   *
   * `format` is coerced because this binding hands INTEGER columns back as BigInt, and a BigInt form of a number
   * is not the number: `{format: 1n}` would silently fail every `> APPLICATION_FORMAT` comparison that matters.
   */
  private marker(): { application: string; format: number } | undefined {
    try {
      const row = this.db
        .prepare('SELECT application,format FROM application_marker LIMIT 1')
        .get() as { application?: unknown; format?: unknown } | undefined;
      if (!row) return undefined;
      return { application: String(row.application), format: Number(row.format) };
    } catch {
      // No such table: a file that has never been claimed. Not an error — it is the state every database
      // written before the marker existed is in, and the caller decides what that means.
      return undefined;
    }
  }
  /** Tables in this file that this build does not create — the evidence that the file is somebody else's. */
  private foreignTables(): string[] {
    const ours = new Set<string>(SCHEMA_TABLES);
    return this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name))
      .filter((name) => !ours.has(name));
  }
  /** The refusal, in one place so every path names the file and the evidence the same way. */
  private notOurs(file: string, evidence: string): Error {
    this.db.close();
    return new Error(
      `${file} belongs to another application (${evidence}); refusing to write this session database`,
    );
  }
  /** Writes the marker row when the file lacks one, so the next open has an answer that does not need inference. */
  private claimApplication(): void {
    if (this.marker()) return;
    this.db
      .prepare('INSERT INTO application_marker(application,format,created_at) VALUES(?,?,?)')
      .run(APPLICATION_NAME, APPLICATION_FORMAT, new Date().toISOString());
    this.db.exec(
      `PRAGMA application_id=${APPLICATION_ID}`,
    ); /* Read back by this and future builds; not portable, see APPLICATION_ID. */
  }
  /**
   * The upgrade a database written by an older build goes through, as a list rather than as a run of statements.
   *
   * Every entry used to be one more line in the constructor plus a `fromVersion` guard inside its own method, so
   * "what happens when an old database is opened" was answerable only by reading the constructor and then seven
   * methods. That shape had two costs, and both were paid: the order was invisible, and a step whose guard was
   * wrong (a `>=` where a `>` belonged) would silently skip its work on exactly the databases that needed it.
   *
   * Here each step says once what it costs — the version it exists for — and the list is the order. `SCHEMA_TABLES`
   * and this list are the two halves of "every historical version opens": the schema brings a file up to date,
   * and these bring its *data* along.
   *
   * The steps keep their own `fromVersion` guard, because each one already refused a *different* upstream version
   * (`v14` for the log, `v15` for cards, `v17` for the checkpoint usage) and collapsing those into `upTo` would
   * lose the reason. `upTo` is the version the step produces, and a test asserts `upTo > from` for every entry:
   * a step whose gate is at or before its threshold is one that can never run.
   */
  private migrations(): {
    /** The oldest schema that still needs this step. */
    from: number;
    /** The version this step produces; `SCHEMA_VERSION` for the newest. */
    upTo: number;
    run(fromVersion: number): void;
  }[] {
    return [
      { from: 13, upTo: 14, run: (from) => this.migrateSessionLog(from) },
      { from: 14, upTo: 15, run: (from) => this.migrateSubAgentCards(from) },
      { from: 15, upTo: 16, run: (from) => this.migrateDropSubAgentAssignments(from) },
      { from: 16, upTo: 17, run: (from) => this.migrateContextCheckpointUsage(from) },
      { from: 17, upTo: 18, run: (from) => this.migrateCompactionSurface(from) },
      { from: 21, upTo: 22, run: (from) => this.migratePlanAbandoned(from) },
      { from: 21, upTo: 22, run: (from) => this.migrateProjectionCheckpointIdentity(from) },
      { from: 22, upTo: 23, run: (from) => this.migrateMachineTitledSessions(from) },
      // A reader compatibility fence: v23 cannot interpret durable program outcomes.
      { from: 23, upTo: 24, run: () => {} },
      { from: 24, upTo: 25, run: () => {} },
      { from: 25, upTo: 26, run: () => {} },
      { from: 26, upTo: 27, run: () => {} },
      // Old readers must not launch automatic work while ignoring its durable authority.
      { from: 27, upTo: 28, run: () => {} },
    ];
  }
  /**
   * The upgrade path as data, for a caller that wants to check it rather than run it.
   *
   * Exposed because the property worth testing here is a property of the *list* — ordered, reachable, reaching
   * this build — and a test cannot assert that about a run of statements it cannot see.
   */
  migrationSteps(): { from: number; upTo: number }[] {
    return this.migrations().map(({ from, upTo }) => ({ from, upTo }));
  }
  /** Whether a table exists in this database. Migrations read tables this build no longer creates. */
  private hasTable(name: string): boolean {
    return (
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !==
      undefined
    );
  }
  /**
   * The migration that un-names the sessions a machine message named.
   *
   * The fallback title is "the first user message", and a runtime snapshot or a compaction summary is a user
   * message the runtime wrote to itself — so a session could be called `<runtime-context source="memory">
   * Machine-written snapshot …`, which is what the sidebar showed. The title is blanked rather than recomputed:
   * the message it should have come from is the first one a *person* wrote, and the next append names the
   * session from it (a blank title is the only one that may be retitled). A session nobody has asked anything
   * stays blank, which is the truth about it.
   */
  private migrateMachineTitledSessions(fromVersion: number): void {
    if (fromVersion >= 23) return;
    this.db
      .prepare(
        "UPDATE sessions SET title='' WHERE title_source='fallback' AND (title LIKE '<runtime-context %' OR title LIKE '<compacted-summary>%')",
      )
      .run();
  }
  /**
   * The adjacent migration that records what a compaction cost.
   *
   * The summary request is a model call the user pays for, but its usage only ever existed as a local
   * variable — so a session's statistics disagreed with the bill exactly for the sessions that compact the
   * most. Recording it in the write-through table as well as the log keeps the two views reconcilable, which
   * is what the statistics projection is checked against.
   */
  /**
   * The migration that gave every checkpoint the identity of the fold that wrote it.
   *
   * The column has to change type as well as meaning: it held one global integer and now holds a digest, and
   * SQLite's INTEGER affinity would turn a hex digest into a number. There is nothing to copy — checkpoints are
   * derived data by definition, so the migration is "drop it and let the schema above recreate it", and every
   * session folds once more from the log, which is where a checkpoint's contents come from anyway.
   */
  private migrateProjectionCheckpointIdentity(fromVersion: number): void {
    if (fromVersion >= 22) return;
    if (!this.hasTable('projection_checkpoints')) return;
    this.db.exec('DROP TABLE projection_checkpoints');
    this.db.exec(`
      CREATE TABLE projection_checkpoints (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        seq INTEGER NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,name)
      );`);
    console.error(
      '[session log] dropped projection_checkpoints (version is a fold identity now, not a global integer)',
    );
  }
  /**
   * The migration that let a plan say it was abandoned.
   *
   * The status vocabulary lives in a `CHECK`, and SQLite cannot widen one in place, so this is the rebuild the
   * platform requires: create the table with the new constraint, copy every row, swap. Nothing is reinterpreted —
   * an old `planning` row stays `planning` until the convergence that settles its run moves it — so the migration
   * is about the *constraint*, not about the data. The index is recreated because dropping the table drops it.
   */
  private migratePlanAbandoned(fromVersion: number): void {
    if (fromVersion >= 22) return;
    if (!this.hasTable('plans')) return;
    this.db.exec(`
      ALTER TABLE plans RENAME TO plans_previous;
      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('planning','proposed','approved','rejected','abandoned')),
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        steps TEXT NOT NULL DEFAULT '[]',
        hash TEXT NOT NULL DEFAULT '',
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT
      );
      INSERT INTO plans(id,session_id,run_id,status,title,summary,steps,hash,reason,created_at,updated_at,approved_at)
        SELECT id,session_id,run_id,status,title,summary,steps,hash,reason,created_at,updated_at,approved_at FROM plans_previous;
      DROP TABLE plans_previous;
      CREATE INDEX IF NOT EXISTS plans_session ON plans(session_id,created_at DESC,id);
    `);
  }
  private migrateContextCheckpointUsage(fromVersion: number): void {
    if (fromVersion >= 17) return;
    if (!this.hasTable('context_checkpoints')) return;
    const columns = this.db.prepare('PRAGMA table_info(context_checkpoints)').all();
    if (columns.some((column) => String(column.name) === 'usage')) return;
    this.db.exec('ALTER TABLE context_checkpoints ADD COLUMN usage TEXT');
  }
  /**
   * The adjacent migration that made a compaction a log op.
   *
   * `context_checkpoints` used to be the read path for "what is the model shown", while the same compaction
   * was also recorded as a `context.compacted` event — the table by the writing call, the event by the same
   * call since v14 and by the v14 backfill before that. Two copies of one fact is how the two start to
   * disagree, and they already had: the row held only the *newest* summary's usage, while the log and the
   * statistics projection accumulate every compaction's. The table is dropped, so the surface a reader
   * derives comes from the log alone. A session that somehow has a row without its event — written by a
   * build between v14 and this one — gets the event it should have had, appended last, which is where it
   * belongs: the single row always held the newest compaction.
   */
  private migrateCompactionSurface(fromVersion: number): void {
    if (fromVersion >= 18) return;
    // A fresh database never created the table, so there is nothing to drop and nothing to report: this
    // migration is only ever visible on a database written before it.
    if (!this.hasTable('context_checkpoints')) return;
    const insert = this.db.prepare(
      'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
    );
    const at = new Date().toISOString();
    let backfilled = 0;
    const rows = this.db
      .prepare(
        'SELECT session_id AS sessionId,covered_messages AS coveredMessages,summary,usage FROM context_checkpoints',
      )
      .all();
    for (const row of rows) {
      const sessionId = String(row.sessionId);
      const recorded = this.db
        .prepare("SELECT 1 FROM session_events WHERE session_id=? AND type='context.compacted'")
        .get(sessionId);
      if (recorded) continue;
      let usage: Usage | undefined;
      try {
        usage = row.usage ? (JSON.parse(String(row.usage)) as Usage) : undefined;
      } catch {
        /* An unreadable usage simply contributes no cost, the same as a checkpoint written without one. */
      }
      insert.run(
        sessionId,
        'context.compacted',
        JSON.stringify({
          coveredMessages: Number(row.coveredMessages),
          summary: String(row.summary),
          ...(usage ? { usage } : {}),
        }),
        at,
      );
      backfilled++;
    }
    this.db.exec('DROP TABLE context_checkpoints');
    console.error(
      '[session log] dropped context_checkpoints (compaction is a log op now)' +
        (backfilled ? `, backfilled ${backfilled} checkpoint(s)` : ''),
    );
  }
  /**
   * The adjacent migration that drops `subagent_assignments`.
   *
   * The table was the card-restoration mechanism before cards became a projection, and the previous step
   * copied its contents into the parent's log. Dropping it is the point of the step: keeping a second copy
   * of a fact that no longer reads from it is exactly how the two copies start to disagree. A database
   * written before the table existed skips this, and a fresh database never creates it.
   */
  private migrateDropSubAgentAssignments(fromVersion: number): void {
    if (fromVersion >= 16) return;
    if (!this.hasTable('subagent_assignments')) return;
    this.db.exec('DROP TABLE subagent_assignments');
    console.error('[session log] dropped subagent_assignments (cards are a projection now)');
  }
  /**
   * The adjacent migration that moved sub-agent cards onto the log.
   *
   * A database written before v15 kept a child's identity in `subagent_assignments` (so a crashed parent's
   * card could still be restored) and took its outcome from the parent's stored run result. Cards are now a
   * fold of the parent's log, so an upgraded session needs those facts as events — otherwise every older
   * session would show no sub-agent cards at all, and a child left interrupted by a crash would vanish from
   * the UI that exists to show it.
   */
  private migrateSubAgentCards(fromVersion: number): void {
    if (fromVersion >= 15) return;
    // The table only exists in databases written before v16; a fresh one has no assignments to carry over.
    if (!this.hasTable('subagent_assignments')) return;
    const insert = this.db.prepare(
      'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
    );
    const at = new Date().toISOString();
    let interrupted = 0;
    let finished = 0;
    // Identity first, then outcome, then interruption: the order the runtime writes them in, and therefore
    // the order the fold expects. An outcome that arrived before its own assignment would be overwritten by
    // it and the card would look like it never ran.
    const parentOf = (childSessionId: string): string =>
      String(
        this.db.prepare('SELECT parent_session_id FROM sessions WHERE id=?').get(childSessionId)
          ?.parent_session_id ?? '',
      );
    const assignments = this.db
      .prepare(
        'SELECT child_session_id AS childSessionId,id,role,objective FROM subagent_assignments ORDER BY rowid',
      )
      .all();
    for (const row of assignments) {
      const childSessionId = String(row.childSessionId);
      const parent = parentOf(childSessionId);
      if (!parent) continue;
      insert.run(
        parent,
        'subagent.assigned',
        JSON.stringify({
          id: String(row.id),
          role: String(row.role),
          objective: String(row.objective),
          childSessionId,
        }),
        at,
      );
    }
    // A finished child's summary lives in the parent's stored run result; without it an upgraded session
    // would show every old child as still running.
    for (const run of this.db
      .prepare('SELECT id,session_id AS sessionId,result FROM runs WHERE result IS NOT NULL')
      .all()) {
      let summaries: SubAgentSummary[] = [];
      try {
        const parsed = JSON.parse(String(run.result)) as RunResult;
        summaries = Array.isArray(parsed.subagents) ? parsed.subagents : [];
      } catch {
        // A damaged historical result simply contributes no cards.
      }
      for (const summary of summaries) {
        finished++;
        insert.run(
          String(run.sessionId),
          'subagent.finished',
          JSON.stringify({
            runId: String(run.id),
            id: summary.id,
            sessionId: summary.sessionId,
            role: summary.role,
            objective: summary.objective,
            status: summary.status,
            rounds: summary.rounds,
            toolCalls: summary.toolCalls,
            usage: summary.usage,
            ...(summary.report ? { report: summary.report } : {}),
            ...(summary.error ? { error: summary.error } : {}),
          }),
          at,
        );
      }
    }
    for (const row of assignments) {
      const childSessionId = String(row.childSessionId);
      const parent = parentOf(childSessionId);
      if (!parent) continue;
      const latest = this.db
        .prepare(
          'SELECT status FROM runs WHERE session_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
        )
        .get(childSessionId);
      if (String(latest?.status ?? '') !== 'interrupted') continue;
      interrupted++;
      insert.run(
        parent,
        'subagent.interrupted',
        JSON.stringify({
          childSessionId,
          reason: 'Interrupted; inspect the child transcript and current state before retrying.',
        }),
        at,
      );
    }
    console.error(
      `[session log] backfilled ${assignments.length} sub-agent assignment(s)` +
        (finished ? `, ${finished} outcome(s)` : '') +
        (interrupted ? `, ${interrupted} interrupted` : '') +
        ' into schema v15',
    );
  }
  /**
   * The adjacent migration that introduced the session log.
   *
   * A database written before v14 has messages but no events, and the message projection reads events —
   * so an upgrade has to *backfill* the log from the rows that exist rather than start an empty log and
   * report every existing session as having no history at all. One step, one direction, self-contained:
   * the same shape every later format change should take, so nobody has to reason about an arbitrary
   * jump between versions.
   */
  private migrateSessionLog(fromVersion: number): void {
    if (fromVersion >= 14) return;
    const rows = this.db
      .prepare('SELECT seq, session_id AS sessionId, body FROM messages ORDER BY seq')
      .all();
    const insert = this.db.prepare(
      'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
    );
    const at = new Date().toISOString();
    for (const row of rows) {
      const message = JSON.parse(String(row.body)) as Message;
      insert.run(String(row.sessionId), messageEventType(message), JSON.stringify({ message }), at);
    }
    // Runs and compaction checkpoints are durable facts too, and a projection that folds the log would
    // otherwise report an upgraded session as never having run, or as never having compacted. The backfill
    // is grouped per fact type rather than interleaved by wall-clock time: within each group the order is
    // exact, and the transcript — the one order that has to be exact — is exact because `messages.seq` is.
    for (const row of this.db
      .prepare(
        'SELECT id,session_id AS sessionId,owner_pid AS ownerPid,status,started_at AS startedAt,result FROM runs ORDER BY started_at,rowid',
      )
      .all()) {
      insert.run(
        String(row.sessionId),
        'run.started',
        JSON.stringify({ runId: String(row.id), ownerPid: Number(row.ownerPid) }),
        String(row.startedAt),
      );
      if (row.result === null) continue;
      const result = JSON.parse(String(row.result)) as RunResult;
      insert.run(
        String(row.sessionId),
        'run.finished',
        JSON.stringify({
          runId: String(row.id),
          status: String(row.status),
          usage: result.usage,
          ...(result.statistics ? { statistics: result.statistics } : {}),
          ...(result.error ? { error: redactSecrets(result.error).slice(0, 600) } : {}),
        }),
        String(row.startedAt),
      );
    }
    // The table only exists in a database written before schema v18 dropped it; a fresh one has no
    // checkpoints to backfill, and asking for a table that was never created is an error rather than an
    // empty result.
    if (this.hasTable('context_checkpoints'))
      for (const row of this.db
        .prepare(
          'SELECT session_id AS sessionId,covered_messages AS coveredMessages,summary FROM context_checkpoints',
        )
        .all())
        insert.run(
          String(row.sessionId),
          'context.compacted',
          JSON.stringify({
            coveredMessages: Number(row.coveredMessages),
            summary: String(row.summary),
          }),
          at,
        );
    if (rows.length)
      console.error(`[session log] backfilled ${rows.length} message event(s) into schema v14`);
  }
  prepareFileChange(
    sessionId: string,
    change: FileChange,
    before: Uint8Array | null,
    after: Uint8Array,
  ): string {
    return this.prepareFileChangeGroup(sessionId, change, [{ path: change.path, before, after }]);
  }
  prepareFileChangeGroup(sessionId: string, change: FileChange, files: FileSnapshot[]): string {
    const session = this.get(sessionId),
      id = randomUUID();
    if (!files.length || files.length > 100) throw new Error('Invalid file snapshot group');
    let total = 0;
    const paths = new Set<string>();
    for (const file of files) {
      if (!file.path || paths.has(file.path)) throw new Error('Invalid file snapshot path');
      paths.add(file.path);
      if ((file.before?.byteLength ?? 0) > 20_000_000 || (file.after?.byteLength ?? 0) > 20_000_000)
        throw new Error('Snapshot exceeds 20MB');
      total += (file.before?.byteLength ?? 0) + (file.after?.byteLength ?? 0);
    }
    if (total > 40_000_000) throw new Error('Snapshot group exceeds 40MB');
    return this.transaction(() => {
      const first = files[0]!;
      this.db
        .prepare(
          "INSERT INTO file_changes(id,session_id,run_id,change,before_bytes,after_bytes,status,created_at) VALUES(?,?,?,?,?,?, 'pending',?)",
        )
        .run(
          id,
          sessionId,
          session.activeRun,
          JSON.stringify({ ...change, id }),
          first.before,
          first.after ?? Buffer.alloc(0),
          new Date().toISOString(),
        );
      const insert = this.db.prepare(
        'INSERT INTO file_change_files(change_id,ordinal,path,before_bytes,after_bytes) VALUES(?,?,?,?,?)',
      );
      files.forEach((file, ordinal) => insert.run(id, ordinal, file.path, file.before, file.after));
      return id;
    });
  }
  markFileChange(id: string, status: StoredFileChange['status']): void {
    this.db.prepare('UPDATE file_changes SET status=? WHERE id=?').run(status, id);
  }
  completeFileUndo(sessionId: string, id: string, notice: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT status FROM file_changes WHERE session_id=? AND id=?')
        .get(sessionId, id);
      if (row?.status !== 'undoing') throw new Error('File restoration state changed');
      this.markFileChange(id, 'undone');
      this.append(sessionId, { role: 'user', content: notice });
    });
  }
  fileChanges(sessionId: string): StoredFileChange[] {
    this.get(sessionId);
    return this.db
      .prepare(
        'SELECT id,session_id AS sessionId,change,status,created_at AS createdAt FROM file_changes WHERE session_id=? ORDER BY seq DESC',
      )
      .all(sessionId)
      .map(
        (row) =>
          ({ ...row, change: JSON.parse(String(row.change)) }) as unknown as StoredFileChange,
      );
  }
  fileChangeSnapshots(sessionId: string, id: string): FileSnapshot[] {
    const owner = this.db
      .prepare('SELECT 1 FROM file_changes WHERE session_id=? AND id=?')
      .get(sessionId, id);
    if (!owner) throw new Error('File change not found in session');
    const rows = this.db
      .prepare(
        'SELECT path,before_bytes AS beforeBytes,after_bytes AS afterBytes FROM file_change_files WHERE change_id=? ORDER BY ordinal',
      )
      .all(id);
    if (rows.length)
      return rows.map((row) => ({
        path: String(row.path),
        before: row.beforeBytes === null ? null : Buffer.from(row.beforeBytes as Uint8Array),
        after: row.afterBytes === null ? null : Buffer.from(row.afterBytes as Uint8Array),
      }));
    const item = this.fileChanges(sessionId).find((change) => change.id === id)!;
    const bytes = this.fileChangeBytes(sessionId, id);
    return [{ path: item.change.path, before: bytes.before, after: bytes.after }];
  }
  fileChangeBytes(sessionId: string, id: string): { before: Buffer | null; after: Buffer } {
    const row = this.db
      .prepare('SELECT before_bytes,after_bytes FROM file_changes WHERE session_id=? AND id=?')
      .get(sessionId, id);
    if (!row) throw new Error('File change not found in session');
    return {
      before: row.before_bytes === null ? null : Buffer.from(row.before_bytes as Uint8Array),
      after: Buffer.from(row.after_bytes as Uint8Array),
    };
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
    return this.taskFromRow(row);
  }
  listTasks(sessionId: string, status?: TaskStatus): Task[] {
    this.get(sessionId);
    if (status !== undefined && !taskStatuses.has(status)) throw new Error('Invalid task status');
    return this.db
      .prepare(
        `${TASK_SELECT} WHERE t.session_id=? AND (? IS NULL OR t.status=?) ORDER BY t.created_at,t.id`,
      )
      .all(sessionId, status ?? null, status ?? null)
      .map((row) => this.taskFromRow(row));
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
      .map((row) => this.taskFromRow(row));
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
      const now = new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString();
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
    return this.transaction(() => {
      const task = this.getTask(sessionId, taskId);
      assertTaskTransition(task.status, 'in_progress');
      const active = this.db
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
          ? seed(input.resume === true ? this.stepStatusMap(taskId) : new Map())
          : null;
      this.db
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
      this.db
        .prepare(
          "UPDATE tasks SET status='in_progress',steps=?,updated_at=? WHERE session_id=? AND id=?",
        )
        .run(JSON.stringify(steps ?? task.steps), startedAt, sessionId, taskId);
      return this.getTaskAttempt(sessionId, taskId, id);
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
    return this.transaction(() => {
      const task = this.getTask(sessionId, taskId);
      assertTaskTransition(task.status, input.status);
      const attempt = this.getTaskAttempt(sessionId, taskId, attemptId);
      if (attempt.status !== 'in_progress') throw new Error('Task attempt is already finished');
      const finishedAt = new Date().toISOString();
      for (const effectId of input.resolvedEffectIds ?? []) {
        const changed = this.db
          .prepare(
            "UPDATE task_effects SET status='completed',completed_at=? WHERE id=? AND session_id=? AND task_id=? AND attempt_id=? AND status='pending'",
          )
          .run(finishedAt, effectId, sessionId, taskId, attemptId);
        if (Number(changed.changes) !== 1)
          throw new Error('Task effect is not pending in this attempt');
      }
      const uncertainEffect = this.hasPendingTaskEffects(sessionId, taskId, attemptId);
      const finalStatus =
        input.status === 'completed' && uncertainEffect ? 'needs_review' : input.status;
      const finalError = uncertainEffect ? TASK_EFFECT_OUTCOME_UNKNOWN : (input.error ?? null);
      this.db
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
      const checkpointed = this.stepStatusMap(taskId);
      const steps = input.steps
        ? input.steps.map((step, index) =>
            finalStatus !== 'completed' && checkpointed.get(index) === 'completed'
              ? { ...step, status: 'completed' as const }
              : step,
          )
        : task.steps;
      this.db
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
        this.db
          .prepare('UPDATE tasks SET next_run_at=NULL WHERE session_id=? AND id=?')
          .run(sessionId, taskId);
      if (
        finalStatus === 'completed' &&
        attempt.trigger === 'manual' &&
        task.approvalOutcomeUnknown
      ) {
        // A deliberate manual retry is the recovery boundary for effects left unknown by an
        // earlier attempt. Keep the journal rows for audit, but never clear a current pending effect.
        this.db
          .prepare(
            "UPDATE task_effects SET status='reviewed',completed_at=? WHERE session_id=? AND task_id=? AND status='pending' AND attempt_id<>?",
          )
          .run(finishedAt, sessionId, taskId, attemptId);
        this.db
          .prepare(
            'UPDATE tasks SET next_run_at=?,last_trigger_error=NULL WHERE session_id=? AND id=?',
          )
          .run(scheduledNextRunAt(task.trigger, new Date(finishedAt)), sessionId, taskId);
      }
      if (!this.hasPendingTaskEffects(sessionId, taskId)) {
        this.db
          .prepare(
            'UPDATE tasks SET last_trigger_error=NULL WHERE session_id=? AND id=? AND last_trigger_error=?',
          )
          .run(sessionId, taskId, TASK_EFFECT_OUTCOME_UNKNOWN);
        if (finalStatus === 'completed')
          this.db
            .prepare(
              'UPDATE tasks SET last_trigger_error=NULL WHERE session_id=? AND id=? AND last_trigger_error=?',
            )
            .run(sessionId, taskId, TASK_APPROVAL_OUTCOME_UNKNOWN);
      }
      return this.getTask(sessionId, taskId);
    });
  }
  getTaskAttempt(sessionId: string, taskId: string, attemptId: string): TaskAttempt {
    this.getTask(sessionId, taskId);
    const row = this.db
      .prepare(`${TASK_ATTEMPT_SELECT} WHERE session_id=? AND task_id=? AND id=?`)
      .get(sessionId, taskId, attemptId);
    if (!row) throw new Error(`Task attempt not found: ${attemptId}`);
    return this.taskAttemptFromRow(row);
  }
  listTaskAttempts(sessionId: string, taskId: string): TaskAttempt[] {
    this.getTask(sessionId, taskId);
    return this.db
      .prepare(`${TASK_ATTEMPT_SELECT} WHERE session_id=? AND task_id=? ORDER BY ordinal`)
      .all(sessionId, taskId)
      .map((row) => this.taskAttemptFromRow(row));
  }
  /**
   * Latest checkpoint per step index. Later entries win, which is what makes the journal
   * append-only instead of a mutable row per step.
   */
  private stepStatusMap(taskId: string): Map<number, TaskStepStatus> {
    const rows = this.db
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
   * Record one step transition. The journal is the durable progress record; `tasks.steps` is
   * updated in the same transaction so a reader never sees the two disagree.
   */
  checkpointTaskStep(
    sessionId: string,
    taskId: string,
    input: { attemptId: string; index: number; status: TaskStepStatus; note?: string },
  ): Task {
    return this.transaction(() => {
      const task = this.getTask(sessionId, taskId);
      const attempt = this.getTaskAttempt(sessionId, taskId, input.attemptId);
      if (attempt.status !== 'in_progress')
        throw new Error('Task attempt is not active; refusing to checkpoint a stale step');
      if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= task.steps.length)
        throw new Error('Invalid task step index');
      if (!taskStepStatuses.has(input.status)) throw new Error('Invalid task step status');
      const note =
        input.note === undefined ? undefined : validateTaskText(input.note, 'note', 500, true);
      const now = new Date().toISOString();
      this.db
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
      this.db
        .prepare('UPDATE tasks SET steps=?,updated_at=? WHERE session_id=? AND id=?')
        .run(JSON.stringify(steps), now, sessionId, taskId);
      return this.getTask(sessionId, taskId);
    });
  }
  taskStepCheckpoints(sessionId: string, taskId: string): TaskStepCheckpoint[] {
    this.getTask(sessionId, taskId);
    return this.db
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
    const map = this.stepStatusMap(taskId);
    return [...map.entries()]
      .filter(([, status]) => status === 'completed')
      .map(([index]) => index)
      .sort((left, right) => left - right);
  }
  /** Mark a permissioned task operation before it can affect the workspace or an external system. */
  beginTaskEffect(sessionId: string, taskId: string, attemptId: string, toolName: string): string {
    return this.transaction(() => {
      const attempt = this.getTaskAttempt(sessionId, taskId, attemptId);
      if (attempt.status !== 'in_progress' || !toolName.trim())
        throw new Error('Task effect requires an active attempt and a tool name');
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO task_effects(id,task_id,session_id,attempt_id,tool_name,status,started_at) VALUES(?,?,?,?,?,'pending',?)",
        )
        .run(id, taskId, sessionId, attemptId, toolName, now);
      this.db
        .prepare(
          'UPDATE tasks SET last_trigger_error=CASE WHEN last_trigger_error=? THEN last_trigger_error ELSE ? END,updated_at=? WHERE id=? AND session_id=?',
        )
        .run(TASK_APPROVAL_OUTCOME_UNKNOWN, TASK_EFFECT_OUTCOME_UNKNOWN, now, taskId, sessionId);
      return id;
    });
  }
  /** A successful tool result is durable only after the corresponding transcript entry is saved. */
  completeTaskEffect(sessionId: string, taskId: string, effectId: string): void {
    this.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE task_effects SET status='completed',completed_at=? WHERE id=? AND task_id=? AND session_id=? AND status='pending'",
        )
        .run(new Date().toISOString(), effectId, taskId, sessionId);
      if (Number(changed.changes) !== 1) throw new Error('Task effect is not pending');
      if (!this.hasPendingTaskEffects(sessionId, taskId))
        this.db
          .prepare(
            'UPDATE tasks SET last_trigger_error=NULL WHERE id=? AND session_id=? AND last_trigger_error=?',
          )
          .run(taskId, sessionId, TASK_EFFECT_OUTCOME_UNKNOWN);
    });
  }
  hasPendingTaskEffects(sessionId: string, taskId: string, attemptId?: string): boolean {
    this.getTask(sessionId, taskId);
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM task_effects WHERE session_id=? AND task_id=? AND status='pending' AND (? IS NULL OR attempt_id=?) LIMIT 1",
        )
        .get(sessionId, taskId, attemptId ?? null, attemptId ?? null),
    );
  }
  /** Persist a scheduled run's exact approval request before stopping the unattended attempt. */
  deferTaskApproval(sessionId: string, taskId: string, approval: Approval): Task {
    return this.transaction(() => {
      const task = this.getTask(sessionId, taskId);
      if (!task.trigger?.enabled || task.status !== 'in_progress')
        throw new Error('Only an active scheduled task can defer approval');
      const serialized = JSON.stringify({ ...approval, requestId: randomUUID() });
      if (Buffer.byteLength(serialized) > 128_000) throw new Error('Task approval exceeds 128KB');
      const previous = this.db
        .prepare('SELECT created_at AS createdAt FROM task_approvals WHERE task_id=?')
        .get(taskId);
      const now = new Date(
        Math.max(Date.now(), previous ? Date.parse(String(previous.createdAt)) + 1 : 0),
      ).toISOString();
      this.db
        .prepare(
          "INSERT INTO task_approvals(task_id,session_id,state,approval,created_at,reviewed_at) VALUES(?,?,'pending',?,?,NULL) ON CONFLICT(task_id) DO UPDATE SET state='pending',approval=excluded.approval,created_at=excluded.created_at,reviewed_at=NULL",
        )
        .run(taskId, sessionId, serialized, now);
      this.db
        .prepare('UPDATE tasks SET next_run_at=NULL,updated_at=? WHERE session_id=? AND id=?')
        .run(now, sessionId, taskId);
      return this.getTask(sessionId, taskId);
    });
  }
  /** Review a deferred request. Approval queues one recovery attempt; rejection keeps it paused. */
  resolveTaskApproval(
    sessionId: string,
    taskId: string,
    allow: boolean,
    expectedApprovalId: string,
  ): Task {
    return this.transaction(() => {
      const task = this.getTask(sessionId, taskId);
      if (task.pendingApproval?.state !== 'pending')
        throw new Error('Task approval is no longer pending');
      if (!expectedApprovalId || task.pendingApproval.id !== expectedApprovalId)
        throw new Error('Task approval changed; reload before reviewing');
      if (task.status === 'in_progress') throw new Error('Task is still running');
      if (allow && !task.trigger?.enabled) throw new Error('Task trigger is disabled');
      const now = new Date().toISOString();
      this.db
        .prepare(
          'UPDATE task_approvals SET state=?,reviewed_at=? WHERE session_id=? AND task_id=? AND state=?',
        )
        .run(allow ? 'approved' : 'rejected', now, sessionId, taskId, 'pending');
      this.db
        .prepare('UPDATE tasks SET next_run_at=?,updated_at=? WHERE session_id=? AND id=?')
        .run(allow ? now : null, now, sessionId, taskId);
      return this.getTask(sessionId, taskId);
    });
  }
  /** A grant applies to one matching tool operation only, never to the whole task. */
  consumeTaskApproval(sessionId: string, taskId: string, approval: Approval): boolean {
    return this.transaction(() => {
      this.getTask(sessionId, taskId);
      const row = this.db
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
      this.db
        .prepare("DELETE FROM task_approvals WHERE session_id=? AND task_id=? AND state='approved'")
        .run(sessionId, taskId);
      this.db
        .prepare(
          'UPDATE tasks SET next_run_at=NULL,last_trigger_error=? WHERE session_id=? AND id=?',
        )
        .run(TASK_APPROVAL_OUTCOME_UNKNOWN, sessionId, taskId);
      return true;
    });
  }
  /** An unused grant expires when its single recovery attempt finishes. */
  clearApprovedTaskApproval(sessionId: string, taskId: string, expectedRule?: string): void {
    this.transaction(() => {
      if (expectedRule !== undefined) {
        let task: Task;
        try {
          task = this.getTask(sessionId, taskId);
        } catch {
          return;
        }
        if ((task.triggerRevision ?? 'legacy') !== expectedRule) return;
      }
      this.db
        .prepare("DELETE FROM task_approvals WHERE session_id=? AND task_id=? AND state='approved'")
        .run(sessionId, taskId);
    });
  }
  /** Compare and reserve a clock obligation in one write transaction, across Host processes. */
  claimTaskSchedule(task: Task, source: TaskTriggerSource, scheduledAt?: string): boolean {
    return this.transaction(() => {
      let current: Task;
      try {
        current = this.getTask(task.sessionId, task.id);
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
      const admissions = this.events(task.sessionId).filter((e) => e.type === 'task.admitted');
      // v26 had the receipt but no current-delivery column. Only an explicit known recovery may
      // adopt that rule's last receipt; ordinary ticks never resurrect an already admitted run.
      const previousId = recovery
        ? (this.db.prepare('SELECT current_delivery_id AS id FROM tasks WHERE id=?').get(task.id)
            ?.id ??
          admissions.findLast((e) => e.data.taskId === task.id && e.data.ruleRevision === rule)
            ?.data.deliveryId)
        : undefined;
      const deliveryId = previousId
        ? String(previousId)
        : oneShot(current.trigger)
          ? `once:${task.id}:${rule}`
          : `clock:${task.id}:${rule}:${scheduledAt ?? task.nextRunAt}`;
      const known = admissions.some((e) => e.data.deliveryId === deliveryId);
      if (known && !recovery) return false;
      this.db
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
        this.recordEvent(task.sessionId, 'task.admitted', {
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
    return this.transaction(() => {
      let current: Task;
      try {
        current = this.getTask(task.sessionId, task.id);
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
        this.db.prepare('SELECT current_delivery_id AS id FROM tasks WHERE id=?').get(task.id)?.id
      )
        return false;
      const next = nextRunAtValue(current.trigger, now);
      this.db
        .prepare('UPDATE tasks SET next_run_at=?,last_trigger_error=? WHERE id=?')
        .run(next ?? null, 'Missed schedule skipped by policy.', task.id);
      this.recordEvent(task.sessionId, 'task.skipped', {
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
    return this.transaction(() => {
      const task = this.getTask(sessionId, taskId);
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
      this.db
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
      return this.getTask(sessionId, taskId);
    });
  }
  /** Put a task back on the due queue immediately, e.g. to resume it after a Host restart. */
  scheduleImmediateRun(sessionId: string, taskId: string, error?: string): Task {
    this.getTask(sessionId, taskId);
    this.db
      .prepare(
        'UPDATE tasks SET next_run_at=?,last_trigger_error=? WHERE session_id=? AND id=? AND trigger IS NOT NULL',
      )
      .run(new Date().toISOString(), error ?? null, sessionId, taskId);
    return this.getTask(sessionId, taskId);
  }
  taskAttemptBaselines(
    sessionId: string,
    taskId: string,
    attemptId: string,
  ): Record<string, unknown> {
    this.getTaskAttempt(sessionId, taskId, attemptId);
    const row = this.db.prepare('SELECT baselines FROM task_attempts WHERE id=?').get(attemptId);
    return row?.baselines ? (JSON.parse(String(row.baselines)) as Record<string, unknown>) : {};
  }
  latestRunAttemptBaselines(sessionId: string, taskId: string): Record<string, unknown> {
    this.getTask(sessionId, taskId);
    const row = this.db
      .prepare(
        "SELECT a.baselines FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.session_id=? AND a.task_id=? AND a.kind='run' AND a.ordinal>t.definition_attempt_floor ORDER BY a.ordinal DESC LIMIT 1",
      )
      .get(sessionId, taskId);
    return row?.baselines ? (JSON.parse(String(row.baselines)) as Record<string, unknown>) : {};
  }
  recoverInterruptedTasks(workspace?: string): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT a.id,a.task_id AS taskId,a.session_id AS sessionId,a.run_id AS runId,r.owner_pid AS ownerPid FROM task_attempts a JOIN tasks t ON t.id=a.task_id JOIN sessions s ON s.id=a.session_id LEFT JOIN runs r ON r.id=a.run_id WHERE a.status='in_progress' AND t.status='in_progress' AND (? IS NULL OR s.workspace=?)",
        )
        .all(workspace ?? null, workspace ?? null);
      const interrupted = rows.filter((row) => deadOwner(row.ownerPid));
      const now = new Date().toISOString();
      const deadRunIds = new Set<string>();
      for (const row of interrupted) {
        if (row.runId) deadRunIds.add(String(row.runId));
        this.db
          .prepare(
            "UPDATE task_attempts SET status='needs_review',error=?,finished_at=? WHERE id=?",
          )
          .run(
            'Host stopped before this task attempt finished; inspect workspace state before retrying.',
            now,
            String(row.id),
          );
        this.db
          .prepare(
            "UPDATE tasks SET status='needs_review',updated_at=? WHERE id=? AND session_id=?",
          )
          .run(now, String(row.taskId), String(row.sessionId));
      }
      const legacy = this.db
        .prepare(
          "SELECT t.id,t.session_id AS sessionId,s.active_run AS activeRun,r.owner_pid AS ownerPid FROM tasks t JOIN sessions s ON s.id=t.session_id LEFT JOIN runs r ON r.id=s.active_run WHERE t.status='in_progress' AND NOT EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id=t.id AND a.status='in_progress') AND (? IS NULL OR s.workspace=?)",
        )
        .all(workspace ?? null, workspace ?? null)
        .filter((row) => !row.activeRun || deadOwner(row.ownerPid));
      for (const row of legacy) {
        if (row.activeRun) deadRunIds.add(String(row.activeRun));
        this.db
          .prepare(
            "UPDATE tasks SET status='needs_review',updated_at=? WHERE id=? AND session_id=?",
          )
          .run(now, String(row.id), String(row.sessionId));
      }
      this.db
        .prepare(
          "UPDATE tasks SET next_run_at=NULL WHERE id IN (SELECT task_id FROM task_effects WHERE status='pending') AND (? IS NULL OR session_id IN (SELECT id FROM sessions WHERE workspace=?))",
        )
        .run(workspace ?? null, workspace ?? null);
      // Release any run this recovery marked dead so it no longer blocks session mutation,
      // mirroring the interrupted-run handling in beginRun.
      for (const runId of deadRunIds) {
        this.db
          .prepare("UPDATE runs SET status='interrupted' WHERE id=? AND status='running'")
          .run(runId);
        this.db.prepare('UPDATE sessions SET active_run=NULL WHERE active_run=?').run(runId);
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
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT r.id AS runId, r.owner_pid AS ownerPid FROM runs r JOIN sessions s ON s.id=r.session_id WHERE s.parent_session_id IS NOT NULL AND s.fork_message_count IS NULL AND r.status='running' AND (? IS NULL OR s.workspace=?)",
        )
        .all(workspace ?? null, workspace ?? null)
        .filter((row) => deadOwner(row.ownerPid));
      for (const row of rows) {
        const childId = String(
          this.db.prepare('SELECT session_id FROM runs WHERE id=?').get(String(row.runId))
            ?.session_id,
        );
        this.settleAbandonedRun(
          childId,
          String(row.runId),
          'Previous child run was interrupted. Execution outcome is unknown; inspect current state before retrying.',
        );
        // The parent's view of this child is a durable fact too: a reader of the parent's log must be able
        // to see "this child was interrupted" without reaching into the child's own session. Recorded here
        // because this is the only place that knows both the parent and the outcome.
        const parent = this.db
          .prepare(
            'SELECT parent_session_id AS parentSessionId FROM sessions WHERE id=? AND parent_session_id IS NOT NULL',
          )
          .get(childId);
        if (parent)
          this.recordEvent(String(parent.parentSessionId), 'subagent.interrupted', {
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
    return this.transaction(() => {
      const candidates = this.db
        .prepare(
          `${TASK_SELECT} WHERE t.trigger IS NOT NULL AND t.status IN ('in_progress','needs_review','blocked') AND (? IS NULL OR t.session_id IN (SELECT id FROM sessions WHERE workspace=?)) AND NOT EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id=t.id AND a.status='in_progress') ORDER BY t.next_run_at IS NULL,t.next_run_at,t.id`,
        )
        .all(workspace ?? null, workspace ?? null)
        .map((row) => this.taskFromRow(row));
      const resumable = candidates.filter((task) => {
        const trigger = task.trigger;
        if (!trigger?.enabled || task.approvalOutcomeUnknown) return false;
        if (task.pendingApproval?.state === 'pending' || task.pendingApproval?.state === 'rejected')
          return false;
        if (trigger.kind === 'event' && task.pendingApproval?.state !== 'approved') return false;
        return (
          task.pendingApproval?.state === 'approved' ||
          completedStepIndexesFor(this.db, task.id).length > 0
        );
      });
      const now = new Date().toISOString();
      for (const task of resumable) {
        this.db
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
      return resumable.map((task) => this.getTask(task.sessionId, task.id));
    });
  }
  private taskAttemptFromRow(row: Record<string, unknown>): TaskAttempt {
    const source = String(row.trigger ?? 'manual') as TaskTriggerSource;
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
        ? source
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
  transitionTask(sessionId: string, id: string, status: TaskStatus): Task {
    const current = this.getTask(sessionId, id);
    assertTaskTransition(current.status, status);
    this.db
      .prepare('UPDATE tasks SET status=?,updated_at=? WHERE session_id=? AND id=?')
      .run(status, new Date().toISOString(), sessionId, id);
    return this.getTask(sessionId, id);
  }
  deleteTask(sessionId: string, id: string): void {
    this.getTask(sessionId, id);
    this.db.prepare('DELETE FROM tasks WHERE session_id=? AND id=?').run(sessionId, id);
  }
  private taskFromRow(row: Record<string, unknown>): Task {
    const pendingEffect = Boolean(
      this.db
        .prepare("SELECT 1 FROM task_effects WHERE task_id=? AND status='pending' LIMIT 1")
        .get(String(row.id)),
    );
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
              id:
                persistedApproval.requestId ??
                createHash('sha256')
                  .update(String(row.approvalCreatedAt))
                  .update(String(row.approvalJson))
                  .digest('hex')
                  .slice(0, 32),
              state: String(row.approvalState) as NonNullable<Task['pendingApproval']>['state'],
              phase: persistedApproval.toolCall.id.startsWith('acceptance:')
                ? 'acceptance'
                : 'tool',
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
    if (typeof query !== 'string' || query.length > 200) throw new Error('Invalid session search');
    // Titles and the full-text index are written with the message, so a list or a search has to see the
    // appends that have not been written yet — a message the user just sent is searchable immediately.
    this.flush();
    const needle = query.trim();
    // Search runs against the FTS5 index over `messages.search_text` instead of
    // `json_extract(body,…)` + `instr` over every row. The old form parsed each message body — the
    // same blob that carries base64 image data — for every session on every keystroke of the search
    // box, which is why it was an unindexed full table scan. The title check stays a substring test
    // so a partial word still matches a session name.
    return this.db
      .prepare(
        `SELECT id,workspace,created_at AS createdAt,active_run AS activeRun,title,parent_session_id AS parentSessionId FROM sessions
         WHERE (? IS NULL OR workspace=?)
           AND (parent_session_id IS NULL OR fork_message_count IS NOT NULL)
           AND (?='' OR instr(lower(title),lower(?))>0 OR
             (? IS NOT NULL AND EXISTS (
               SELECT 1 FROM messages m JOIN messages_fts ON messages_fts.rowid=m.seq
               WHERE m.session_id=sessions.id AND messages_fts MATCH ?)))
         ORDER BY created_at DESC,rowid DESC`,
      )
      .all(
        workspace ?? null,
        workspace ?? null,
        needle,
        needle,
        needle ? ftsQuery(needle) : null,
        needle ? ftsQuery(needle) : null,
      ) as unknown as Session[];
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
    if (typeof query !== 'string' || query.length > 200) throw new Error('Invalid session search');
    const needle = query.trim();
    const match = needle ? ftsQuery(needle) : null;
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 5)), MAX_SEARCH_SESSIONS);
    const perSession = Math.min(
      Math.max(1, Math.trunc(options.perSession ?? 3)),
      MAX_SEARCH_MATCHES,
    );
    const workspace = options.workspace ?? null;
    // A cursor that cannot be read is refused rather than ignored: silently starting from the top again is how a
    // caller that meant "the next page" gets the first one, with no sign that anything went wrong.
    const offset = options.cursor === undefined ? 0 : readSearchCursor(options.cursor);
    // Buffered appends are written before a read, for the same reason `list` does it: a message the user just
    // sent is searchable immediately.
    this.flush();
    const parent = options.parent?.trim() || null;
    const visibility = parent
      ? 'AND s.parent_session_id = ?'
      : options.includeChildren
        ? ''
        : 'AND (s.parent_session_id IS NULL OR s.fork_message_count IS NOT NULL)';
    // The parent binding sits where the visibility clause does, so it is collected separately from the two
    // workspace bindings the scope always contributes.
    const scope: (string | null)[] = parent ? [parent] : [];
    const activeClause = options.activeOnly === true ? 'AND s.active_run IS NOT NULL' : '';
    /**
     * The candidate slice is sized by the *page*, not by how far into the ranking the caller has walked.
     *
     * `limit * perSession * 8` rows was the bound when one call returned one page; with a cursor the returned
     * order has to be recomputed on every call anyway, so the honest bound is "enough rows to rank a page of
     * sessions well", and a caller walking deep into a large result set pays the same constant per page rather
     * than a window that grows with its position. The consequence is documented on `cursor`: this walks within
     * the ranked window rather than promising every match in the database, which is what it promised before.
     */
    const window = limit * perSession * 8;
    const hits = new Map<string, SessionSearchHit>();
    /** Relevance per session, summed as the rows come in — see the note on ordering below. */
    const scores = new Map<string, number>();
    if (match) {
      /**
       * Ranked rows first, sessions second.
       *
       * FTS5's `bm25()` cannot be aggregated (`unable to use function bm25 in the requested context`), so the
       * per-session total is summed here from a bounded, ranked slice of rows: wide enough that a session with
       * several matches is fully seen, and still a constant, so a search never reads a table proportionally to
       * how much text matches.
       */
      const rows = this.db
        .prepare(
          `SELECT m.session_id AS sessionId, m.seq AS seq,
                  COALESCE(json_extract(m.body,'$.role'),'') AS role,
                  snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
                  bm25(messages_fts) AS rank
           FROM messages_fts
           JOIN messages m ON messages_fts.rowid = m.seq
           JOIN sessions s ON s.id = m.session_id
           WHERE messages_fts MATCH ?
             AND (? IS NULL OR s.workspace = ?)
             ${visibility}
             ${activeClause}
           ORDER BY rank ASC, m.seq DESC
           LIMIT ?`,
        )
        .all(match, workspace, workspace, ...scope, window) as unknown as {
        sessionId: string;
        seq: number;
        role: string;
        snippet: string;
        rank: number;
      }[];
      for (const row of rows) {
        const hit = this.sessionHit(hits, row.sessionId);
        // `bm25` is "lower is better" and negative; summing the negation makes "more relevant" larger.
        scores.set(row.sessionId, (scores.get(row.sessionId) ?? 0) - Number(row.rank));
        if (hit.matches.length < perSession)
          hit.matches.push({
            seq: Number(row.seq),
            role: String(row.role),
            snippet: String(row.snippet).replace(/\s+/g, ' ').trim(),
          });
      }
      /**
       * Then the totals, and the order.
       *
       * The order is by *summed* relevance rather than by best single row, because the question is which
       * conversation is about this: a short message that happens to contain both words would otherwise outrank a
       * long conversation that is entirely about them. The total comes from its own count — the row slice above
       * is capped, so reporting its length as the total would be a guess dressed as a fact.
       */
      const count = this.db.prepare(
        `SELECT COUNT(*) AS total FROM messages_fts
         JOIN messages m ON messages_fts.rowid = m.seq
         WHERE messages_fts MATCH ? AND m.session_id = ?`,
      );
      for (const hit of hits.values())
        hit.total = Number(
          (count.get(match, hit.session.id) as { total?: number } | undefined)?.total ??
            hit.matches.length,
        );
      /**
       * The tie-break is the session id, so the order is total rather than merely sorted: two sessions with the
       * same summed relevance have to come back in the same order on the next page, or a page boundary between
       * them could show one twice and the other never.
       */
      const ordered = [...hits.entries()].sort(
        ([leftId, left], [rightId, right]) =>
          (scores.get(rightId) ?? 0) - (scores.get(leftId) ?? 0) ||
          left.session.createdAt.localeCompare(right.session.createdAt) ||
          leftId.localeCompare(rightId),
      );
      hits.clear();
      for (const [id, hit] of ordered) hits.set(id, hit);
    }
    /**
     * Then the sessions whose *title* matches, appended after the ranked ones.
     *
     * A session named "deploy checklist" should be findable by that name even when no message repeats it, which
     * is what `list` already did with a substring test — the same lower-cased `instr` keeps a partial word working.
     * They are collected for the whole window and ordered the same way every call, for the same reason the
     * ranked ones are: a page boundary inside this section must not depend on which call is asking.
     */
    if (hits.size < window) {
      const titled = this.db
        .prepare(
          `SELECT id,workspace,created_at AS createdAt,active_run AS activeRun,title,parent_session_id AS parentSessionId
           FROM sessions s
           WHERE (? = '' OR instr(lower(COALESCE(s.title,'')), lower(?)) > 0)
             AND (? IS NULL OR s.workspace = ?)
             ${visibility}
             ${activeClause}
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`,
        )
        .all(needle, needle, workspace, workspace, ...scope, window) as unknown as Session[];
      for (const session of titled) this.sessionHit(hits, session.id, session);
    }
    const ranked = [...hits.values()];
    const page = ranked.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      hits: page,
      ...(next < ranked.length ? { cursor: writeSearchCursor(next) } : {}),
      /** How many sessions this call could rank — the size of the window the pages walk, not the whole database. */
      rankedTotal: ranked.length,
    };
  }
  /** The bucket for one session, created on first sight. */
  private sessionHit(
    hits: Map<string, SessionSearchHit>,
    sessionId: string,
    known?: Session,
  ): SessionSearchHit {
    const existing = hits.get(sessionId);
    if (existing) return existing;
    const session = known ?? this.get(sessionId);
    const hit: SessionSearchHit = { session, matches: [], total: 0 };
    hits.set(sessionId, hit);
    return hit;
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
  private assertMutable(id: string): Session {
    const session = this.get(id);
    if (session.activeRun)
      throw new Error(
        'Session is running or interrupted; finish or recover it before changing history',
      );
    if (
      this.db.prepare("SELECT 1 FROM file_changes WHERE session_id=? AND status='undoing'").get(id)
    )
      throw new Error('File restoration is busy');
    return session;
  }
  rename(id: string, title: string): Session {
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.trim().length > 120 ||
      /[\x00-\x1f\x7f]/.test(title)
    )
      throw new Error('Session title must contain 1 to 120 visible characters');
    return this.transaction(() => {
      this.assertMutable(id);
      this.db
        .prepare("UPDATE sessions SET title=?,title_source='manual' WHERE id=?")
        .run(title.trim(), id);
      return this.get(id);
    });
  }
  /**
   * Whether a model-generated title may still replace this session's own.
   *
   * True only while the session is still on its `fallback` title. The read is the cheap half of the pair below;
   * the write is the half that actually decides, because it repeats the condition inside the `UPDATE`.
   */
  canGenerateTitle(id: string): boolean {
    this.get(id);
    return Boolean(
      this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND title_source='fallback'").get(id),
    );
  }
  /**
   * Apply a model-generated title, unless a person has named the session in the meantime.
   *
   * The condition is checked in SQL rather than in this function so a rename that lands while the model call is
   * in flight always wins: `changes === 1` is the only evidence that *this* write is the one that took, and it is
   * returned rather than assumed.
   *
   * `usage` is what the title call cost. It is a real model call, so the session's statistics fold it in through
   * `session.title.generated` — the same treatment a compaction's summary request gets — and it is not a run, so
   * no run budget is charged for it. The event is only written when the title actually took: a refused write
   * charged to the session would be a cost reported for something that did not happen.
   */
  setGeneratedTitle(id: string, title: string, usage?: Usage): boolean {
    const clean = title.trim();
    if (!clean || clean.length > 120 || /[\x00-\x1f\x7f]/.test(clean)) return false;
    this.get(id);
    const took =
      this.db
        .prepare(
          "UPDATE sessions SET title=?,title_source='generated' WHERE id=? AND title_source='fallback'",
        )
        .run(clean, id).changes === 1;
    if (took)
      this.recordEvent(id, 'session.title.generated', {
        title: clean,
        ...(usage ? { usage } : {}),
      });
    return took;
  }
  delete(id: string): void {
    this.transaction(() => {
      this.assertMutable(id);
      // A sub-agent session is not an independent conversation: leaving it behind would strand a
      // hidden session whose parent no longer exists. Descendants are removed without the mutability
      // check, because an interrupted child must never block deleting the session the user asked to
      // delete.
      const descendants: string[] = [];
      for (let level = [id]; level.length;) {
        const next: string[] = [];
        for (const parent of level)
          for (const child of this.db
            // Only delegated children: a session fork points at its source too, and deleting a
            // conversation must never delete a copy someone else is working in.
            .prepare(
              'SELECT id FROM sessions WHERE parent_session_id=? AND fork_message_count IS NULL',
            )
            .all(parent))
            next.push(String(child.id));
        descendants.push(...next);
        level = next;
      }
      for (const sessionId of [...descendants.reverse(), id]) this.deleteSessionRows(sessionId);
    });
  }
  private deleteSessionRows(id: string): void {
    // The session and its log are about to stop existing, so neither its fold nor its unwritten appends
    // may outlive them: a later flush would write rows for a session that is gone.
    this.logCache.delete(id);
    this.pendingAppends.delete(id);
    // Which bytes this session was the last to mention is only answerable *before* its rows go, so the
    // addresses are collected first and the blobs are dropped afterwards if nothing else still names them.
    const referenced = this.sessionHashes(id);
    for (const table of [
      'file_changes',
      'messages',
      'run_stream_checkpoints',
      'runs',
      'session_events',
      'task_attempts',
      'tasks',
    ])
      this.db.prepare('DELETE FROM ' + table + ' WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    for (const hash of referenced)
      if (!this.blobReferenced(hash))
        this.db.prepare('DELETE FROM attachment_blobs WHERE hash=?').run(hash);
  }
  /** Every content address the session's rows and log entries name. */
  private sessionHashes(id: string): Set<string> {
    const hashes = new Set<string>();
    const rows = [
      ...this.db.prepare('SELECT body AS json FROM messages WHERE session_id=?').all(id),
      ...this.db.prepare('SELECT data AS json FROM session_events WHERE session_id=?').all(id),
    ];
    for (const row of rows) {
      try {
        hashesIn(JSON.parse(String(row.json)), hashes);
      } catch {
        // A row that no longer parses names nothing; it is not this path's job to report it.
      }
    }
    return hashes;
  }
  /**
   * Whether any row or log entry still names this address.
   *
   * The `LIKE` narrows the candidates to rows that contain the digest *at all*, and those few are then read
   * as JSON — a hash appearing in prose therefore keeps a blob alive rather than being mistaken for a
   * reference. It runs on session deletion only, which is why a scan is an honest price for not maintaining a
   * second copy of "who refers to what" that could drift from the rows themselves.
   */
  private blobReferenced(hash: string): boolean {
    const candidates = [
      ...this.db.prepare("SELECT body AS json FROM messages WHERE body LIKE '%'||?||'%'").all(hash),
      ...this.db
        .prepare("SELECT data AS json FROM session_events WHERE data LIKE '%'||?||'%'")
        .all(hash),
    ];
    for (const row of candidates) {
      const found = new Set<string>();
      try {
        hashesIn(JSON.parse(String(row.json)), found);
      } catch {
        continue;
      }
      if (found.has(hash)) return true;
    }
    return false;
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
      const tail = cached.events.filter((event) => event.seq > afterSeq);
      return frozen(limit === undefined ? tail : tail.slice(0, limit));
    }
    // A delta read asks for a tail, not for the log, so it stays a bounded query instead of reading the
    // whole history to answer a question about its end.
    return frozen(this.readEvents(id, afterSeq, limit));
  }
  private readEvents(id: string, afterSeq: number, limit?: number): SessionEvent[] {
    return this.db
      .prepare(
        `SELECT seq,session_id AS sessionId,type,data,at FROM session_events WHERE session_id=? AND seq>? ORDER BY seq${
          limit === undefined ? '' : ' LIMIT ?'
        }`,
      )
      .all(...(limit === undefined ? [id, afterSeq] : [id, afterSeq, limit]))
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
    const entry: LogCacheEntry = {
      events: frozen(this.readEvents(id, 0)),
      messages: null,
      readable: null,
      dataVersion: this.dataVersion(),
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
  retryCount(runId: string, round: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM session_events WHERE type='llm.retry' AND json_extract(data,'$.runId')=? AND json_extract(data,'$.round')=?",
      )
      .get(runId, round);
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
  private settleAbandonedRun(sessionId: string, runId: string, reason: string): void {
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
  checkpointStream(id: string, runId: string, messageId: string, text: string): void {
    if (!text) return;
    const saved = this.db
      .prepare(
        `INSERT INTO run_stream_checkpoints(run_id,session_id,message_id,text,updated_at)
         SELECT id,session_id,?,?,? FROM runs WHERE id=? AND session_id=? AND status='running'
         ON CONFLICT(run_id,message_id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at`,
      )
      .run(messageId, text, new Date().toISOString(), runId, id);
    if (saved.changes !== 1) throw new Error('Cannot checkpoint an inactive stream');
  }
  /**
   * Fold one queued input into the transcript, and record that it was consumed by *that* message.
   *
   * One transaction rather than two calls at the call site, because the two halves are one fact: the inbox
   * entry is settled exactly when a user message exists for it. Written the other way round — append, then
   * record — a crash in between would leave an inbox entry pointing at a message the model has already seen,
   * and a client would offer to send it twice; written this way round, a crash leaves neither.
   */
  consumeQueuedInput(id: string, inputId: string, message: Message): void {
    this.transaction(() => {
      this.append(id, message);
      this.recordEvent(id, 'input.consumed', { id: inputId });
    });
  }
  /** Commit the final assistant message and remove its recovery point atomically. */
  appendStreamMessage(id: string, runId: string, messageId: string, message: Message): void {
    this.transaction(() => {
      this.append(id, message);
      this.db
        .prepare('DELETE FROM run_stream_checkpoints WHERE run_id=? AND message_id=?')
        .run(runId, messageId);
    });
  }
  /** Preserve an unfinished response once, without ever replaying incomplete tool calls. */
  persistStreamCheckpoint(id: string, runId: string): string {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          'SELECT message_id AS messageId,text FROM run_stream_checkpoints WHERE session_id=? AND run_id=? ORDER BY updated_at,message_id',
        )
        .all(id, runId);
      let last = '';
      for (const row of rows) {
        const partial = String(row.text);
        if (partial) {
          this.append(id, {
            role: 'assistant',
            content: partial,
            toolCalls: [],
            interrupted: true,
          });
          last = partial;
        }
      }
      this.db
        .prepare('DELETE FROM run_stream_checkpoints WHERE session_id=? AND run_id=?')
        .run(id, runId);
      return last;
    });
  }
  /** Reconcile only streams whose owning process is gone; active Hosts keep writing their own rows. */
  recoverInterruptedStreams(workspace?: string): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT c.run_id AS runId,c.session_id AS sessionId,r.owner_pid AS ownerPid
           FROM run_stream_checkpoints c JOIN runs r ON r.id=c.run_id
           JOIN sessions s ON s.id=c.session_id
           WHERE (? IS NULL OR s.workspace=?)`,
        )
        .all(workspace ?? null, workspace ?? null)
        .filter((row) => deadOwner(row.ownerPid));
      for (const row of rows)
        this.persistStreamCheckpoint(String(row.sessionId), String(row.runId));
      return rows.length;
    });
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
    const folded = this.foldProjections([name], sessionId).get(name);
    return (name === 'statistics' ? (folded as StatisticsState).statistics : folded) as State;
  }
  /** Every projection in one pass, for a host rendering a whole session. */
  snapshot(sessionId: string): Record<string, unknown> {
    this.get(sessionId);
    const folded = this.foldProjections(this.projections.names(), sessionId);
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
  private foldProjections(names: readonly string[], sessionId: string): Map<string, unknown> {
    // Before anything is folded: a projection answers from a log it must be able to interpret (see `checkedLog`).
    this.checkedLog(sessionId);
    const projections = names.map((name) => this.projections.get<unknown>(name));
    const checkpoints = new Map<string, { seq: number; state: unknown }>();
    for (const projection of projections) {
      // The identity is computed per projection, so a checkpoint written by a different fold of the *same*
      // projection is the only thing this discards: changing one fold no longer invalidates the others.
      const checkpoint = this.readProjectionCheckpoint(
        sessionId,
        projection.name,
        projectionFoldIdentity(projection as SessionProjection<never>),
        projection.initial(),
      );
      if (checkpoint) checkpoints.set(projection.name, checkpoint);
    }
    const complete = checkpoints.size === projections.length;
    const earliest =
      checkpoints.size && complete
        ? Math.min(...[...checkpoints.values()].map((checkpoint) => checkpoint.seq))
        : 0;
    /**
     * The read starts one event *before* the earliest checkpoint, because `events(id, afterSeq)` is exclusive:
     * without that adjustment the event each checkpoint claims to have folded is not in the array, and the
     * validation below would have nothing to replay against. The loop skips everything up to each checkpoint's
     * own seq, so the extra event is read and not folded.
     */
    const events = this.events(sessionId, Math.max(0, earliest - (earliest ? 1 : 0)));
    const states = new Map<string, unknown>();
    for (const projection of projections) {
      const checkpoint = checkpoints.get(projection.name);
      /**
       * A refused checkpoint means this projection starts at the beginning of the log, **and so does the read**.
       *
       * Reading from the earliest *surviving* checkpoint is only sound while every projection being folded has
       * one: `events` below starts there, so a projection whose checkpoint was refused would otherwise be handed
       * a partial log and fold it into the empty state — a quietly wrong answer, which is precisely what the
       * refusal was meant to prevent. So a refusal anywhere moves the read back to seq 0, and the projections
       * that still have checkpoints skip their own events as they always did.
       */
      if (checkpoint && !trustedCheckpoint(projection, checkpoint, events))
        return this.foldFromScratch(names, sessionId);
    }
    for (const projection of projections) {
      const checkpoint = checkpoints.get(projection.name);
      let state = checkpoint ? checkpoint.state : projection.initial();
      for (const event of events) {
        if (checkpoint && event.seq <= checkpoint.seq) continue;
        state = projection.apply(state, event);
        this.foldCounters.events++;
      }
      if (checkpoint) this.foldCounters.checkpointHits++;
      states.set(projection.name, state);
    }
    return states;
  }
  /** The read every refusal falls back to: no checkpoints at all, from the first event in the log. */
  private foldFromScratch(names: readonly string[], sessionId: string): Map<string, unknown> {
    const events = this.events(sessionId, 0);
    const states = new Map<string, unknown>();
    for (const name of names) {
      const projection = this.projections.get<unknown>(name);
      let state = projection.initial();
      for (const event of events) {
        state = projection.apply(state, event);
        this.foldCounters.events++;
      }
      states.set(name, state);
    }
    return states;
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
    return { ...this.foldCounters };
  }
  resetFoldCounters(): void {
    this.foldCounters = { checkpointHits: 0, events: 0 };
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
    try {
      const sessions = sessionId === undefined ? this.sessionIds() : [sessionId];
      let written = 0;
      const write = this.db.prepare(
        `INSERT INTO projection_checkpoints(session_id,name,seq,version,state,updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(session_id,name) DO UPDATE SET
           seq=excluded.seq, version=excluded.version, state=excluded.state, updated_at=excluded.updated_at`,
      );
      for (const id of sessions) {
        const persistent = this.projections
          .names()
          .filter((name) => this.projections.get(name).persist !== false);
        if (!persistent.length) continue;
        const folded = this.foldProjections(persistent, id);
        const seq = this.lastEventSeq(id);
        const at = new Date().toISOString();
        this.transaction(() => {
          for (const name of persistent) {
            let state: string;
            try {
              state = JSON.stringify(folded.get(name));
            } catch {
              // A projection whose state cannot be serialised is simply not persisted; the reader falls back
              // to folding it, which is the same answer by a slower route.
              continue;
            }
            if (state === undefined) continue;
            write.run(
              id,
              name,
              seq,
              projectionFoldIdentity(this.projections.get<never>(name)),
              state,
              at,
            );
            written++;
          }
        });
      }
      return written;
    } catch {
      return 0;
    }
  }
  /**
   * The folded state a checkpoint holds, when one is usable. Anything doubtful reads as "no checkpoint".
   *
   * `identity` is the digest of the fold that would continue this state — see `projectionFoldIdentity`. A row
   * whose `version` is anything else (a different fold, an older build, a hand-edited file, a row written before
   * identities existed) is not a starting point, because folding from the log is always correct and continuing
   * somebody else's state is not.
   *
   * `fresh` is what the projection's own `initial()` returns, and the state has to have the same top-level
   * structure as it. That is the one structural claim this layer can make without knowing what a projection
   * means: an empty array and an empty object are both valid states, but only one of them is *this* projection's
   * kind of state, and a fold handed the other can produce a wrong answer instead of an error.
   */
  private readProjectionCheckpoint(
    sessionId: string,
    name: string,
    identity: string,
    fresh: unknown,
  ): { seq: number; state: unknown } | undefined {
    const row = this.db
      .prepare('SELECT seq,version,state FROM projection_checkpoints WHERE session_id=? AND name=?')
      .get(sessionId, name) as { seq?: number; version?: string; state?: string } | undefined;
    if (!row) return undefined;
    if (String(row.version) !== identity) return undefined;
    const seq = Number(row.seq);
    if (!Number.isFinite(seq) || seq < 0 || seq > this.lastEventSeq(sessionId)) return undefined;
    try {
      const state: unknown = JSON.parse(String(row.state));
      return shapedLike(state, fresh) ? { seq, state } : undefined;
    } catch {
      return undefined;
    }
  }
  private lastEventSeq(sessionId: string): number {
    this.flush(sessionId);
    return Number(
      (
        this.db
          .prepare('SELECT MAX(seq) AS seq FROM session_events WHERE session_id=?')
          .get(sessionId) as { seq?: number | null } | undefined
      )?.seq ?? 0,
    );
  }
  /** Session ids in this database, oldest first — what a whole-database checkpoint pass walks. */
  private sessionIds(): string[] {
    return (
      this.db.prepare('SELECT id FROM sessions ORDER BY created_at,rowid').all() as unknown as {
        id: string;
      }[]
    ).map((row) => row.id);
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
