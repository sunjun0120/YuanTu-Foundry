/**
 * Step boundaries: the durable record of a run's rounds, and why each one ended.
 *
 * A run's beginning and end are in the log (`run.started`, `run.finished`) and its middle is visible as
 * messages and tool calls — but "how many steps did it get through, and where was it when it stopped" is not
 * a question either of those answers. The messages are the *work*, not the boundaries: a crash between two
 * steps and a crash in the middle of one leave the same shape behind, because the record of a step that never
 * ended is the record that was never written. These two events are that boundary, and a `step.started` with no
 * matching `step.finished` is the one fact that says "the process died while this step was open" without
 * inferring it from the shape of a conversation.
 *
 * This module is the vocabulary and the fold, shared by the writer (the run loop), the log that stores them
 * and the readers that fold them, so all three agree on what a reason means.
 */

/**
 * Why a step ended.
 *
 * Closed on purpose: a reader switches on it, so a new value is a change to every reader and has to be added
 * deliberately. The values describe what the *step* did — what the *run* concluded is carried separately, by
 * its status and failure code, and the two are read together when they differ.
 */
export const STEP_END_REASONS = [
  /** The model asked for tools and they ran; the run continues with another step. */
  'tool-calls',
  /** The run had nothing left to do: the model answered, or it submitted a plan or report and stopped there. */
  'final',
  /** The model answered with no tool calls, but queued input (a steer or a follow-up) kept the loop going. */
  'queued-input',
  /**
   * The step stopped on a person: a pre-step hook refused the round, or an approval was deferred for review.
   * Distinct from `failed` because nothing is broken — the run is waiting for a decision that a later run can
   * make, which is why it is recorded as a *reason* rather than left to the error text.
   */
  'blocked',
  /** A window or output limit stopped the run here (there is no round limit: the loop has none). */
  'limited',
  /** A failure stopped the run here. */
  'failed',
  /** The run was aborted. */
  'cancelled',
] as const;
export type StepEndReason = (typeof STEP_END_REASONS)[number];
const REASONS = new Set<string>(STEP_END_REASONS);
export function isStepEndReason(value: unknown): value is StepEndReason {
  return typeof value === 'string' && REASONS.has(value);
}
/** One step as a reader sees it. `endedAt === null` is a step that was opened and never closed. */
export interface StepRecord {
  runId: string;
  /** Zero-based, and deliberately the same number the log's other per-round records use (`llm.retry`, `llm.request`). */
  step: number;
  startedAt: string;
  endedAt: string | null;
  reason: StepEndReason | null;
}
/**
 * How many step records a fold keeps.
 *
 * A step is two log rows and a long run has one per model request, so a fold that kept everything would make
 * every session snapshot grow with the session's age. What a reader asks is "which step is open" and "how did
 * the last few end", both of which the newest records answer; the older ones stay in the log for anyone who
 * needs them, which is where history belongs.
 */
export const STEP_HISTORY_LIMIT = 50;
/**
 * The slice of a durable event this fold reads.
 *
 * Structural rather than the log's own `SessionEvent`, because `protocol` is below the log and must not
 * import it: the log imports this vocabulary, and a fold that needed the log's module would make that a cycle.
 */
export interface StepEvent {
  type: string;
  data: Record<string, unknown>;
  at: string;
}
function stepOf(event: StepEvent): { runId: string; step: number } | null {
  const runId = event.data.runId;
  const step = event.data.step;
  if (typeof runId !== 'string' || !Number.isSafeInteger(step) || (step as number) < 0) return null;
  return { runId, step: step as number };
}
/**
 * Fold one event into the records.
 *
 * Unreadable payloads are skipped rather than thrown on: this folds a log a different build may have written,
 * and losing one boundary is a smaller failure than refusing to show a session. A `step.finished` for a step
 * that was never opened is skipped for the same reason — there is no record to close.
 */
export function applyStepEvent(
  records: readonly StepRecord[],
  event: StepEvent,
  limit = STEP_HISTORY_LIMIT,
): readonly StepRecord[] {
  if (event.type === 'step.started') {
    const step = stepOf(event);
    if (!step) return records;
    const next = [
      ...records,
      { runId: step.runId, step: step.step, startedAt: event.at, endedAt: null, reason: null },
    ];
    return next.length > limit ? next.slice(-limit) : next;
  }
  if (event.type !== 'step.finished') return records;
  const step = stepOf(event);
  if (!step) return records;
  const reason = event.data.reason;
  if (!isStepEndReason(reason)) return records;
  // Matched by run *and* step, because a step number means nothing on its own: the pair is what a boundary
  // belongs to, and it is also why a session running several runs over time folds correctly. The newest open
  // match is closed, so a log that somehow holds two records for one boundary closes the later one.
  const index = records.findLastIndex(
    (record) => record.runId === step.runId && record.step === step.step && record.endedAt === null,
  );
  if (index === -1) return records;
  return records.map((record, at) =>
    at === index ? { ...record, endedAt: event.at, reason } : record,
  );
}
/** The step records in a log, oldest first. `runId` narrows the fold to one run's steps. */
export function foldSteps(
  events: readonly StepEvent[],
  options: { runId?: string; limit?: number } = {},
): readonly StepRecord[] {
  const limit = options.limit ?? STEP_HISTORY_LIMIT;
  let records: readonly StepRecord[] = [];
  for (const event of events) {
    if (options.runId !== undefined && event.data.runId !== options.runId) continue;
    records = applyStepEvent(records, event, limit);
  }
  return records;
}
/**
 * The step a run never finished, or `null` when every step it opened was closed.
 *
 * This is the answer to "where was it when it died": read against a run whose process is gone, a record with
 * no end is the step that was in flight, and the run's own `run.interrupted` record names the same number.
 */
export function inFlightStep(records: readonly StepRecord[]): StepRecord | null {
  return records.findLast((record) => record.endedAt === null) ?? null;
}
