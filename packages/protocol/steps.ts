/**
 * Step boundaries: the durable record of a run's rounds and why each ended. A `step.started`
 * without a matching `step.finished` means the process died while that step was open. Shared by the
 * run loop, the log and the readers so all agree on what a reason means.
 */

/**
 * Why a step ended. Closed, since readers switch on it. Describes the step; the run's outcome is
 * its status and failure code.
 */
export const STEP_END_REASONS = [
  /** The model asked for tools and they ran; the run continues with another step. */
  'tool-calls',
  /** The run had nothing left to do: the model answered, or it submitted a plan or report and stopped there. */
  'final',
  /** The model answered with no tool calls, but queued input (a steer or a follow-up) kept the loop going. */
  'queued-input',
  /**
   * The step stopped on a person: a pre-step hook refused the round, or an approval was deferred.
   * Not `failed`: nothing is broken, a later run can continue.
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
 * How many step records a fold keeps, so snapshots do not grow with session age. Older records stay
 * in the log.
 */
export const STEP_HISTORY_LIMIT = 50;
/**
 * The slice of a durable event this fold reads. Structural because `protocol` must not import the
 * log.
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
 * Fold one event into the records. Unreadable payloads and finishes for unopened steps are skipped:
 * the log may come from another build.
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
  // Matched by run and step; the newest open match is closed.
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
 * The step a run never finished, or `null`. For a dead run, this is the step in flight;
 * `run.interrupted` names the same number.
 */
export function inFlightStep(records: readonly StepRecord[]): StepRecord | null {
  return records.findLast((record) => record.endedAt === null) ?? null;
}
