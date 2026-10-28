import {
  DeferredApprovalError,
  RunFailure,
  failureCodeOf,
  statusForFailure,
  type FailureCode,
} from '../../protocol/failure.ts';
import type { RunStatus } from '../../protocol/index.ts';
import type { StepEndReason } from '../../protocol/steps.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { redactSecrets } from '../../platform/redact.ts';
import { RunCancellation, type CancelReason } from '../../protocol/run-cancellation.ts';

export function runCancelReason(signal: AbortSignal): CancelReason | undefined {
  return signal.aborted && signal.reason instanceof RunCancellation
    ? signal.reason.cancelReason
    : undefined;
}

/**
 * How a run that threw is described: the status, the message, the code and the step's end reason.
 *
 * The round loop has one `catch`, and everything it decides is read from the thrown value and the abort signal.
 * Kept here so the step's end reason and the run's status are classified by the same rules side by side — the two
 * are answers to related questions, and a reader comparing them should not have to find them in a loop.
 */

/**
 * A round a pre-step hook refused.
 *
 * Its own class because the refusal is not a failure of anything: a policy said no to this round, and a reader
 * asking why the step ended should see that instead of the anonymous `failed` an unclassified error produces.
 * The message and the run's status are deliberately unchanged — the task did not happen, so the run still
 * fails — which is why this names the *step's* end and not the run's outcome.
 */
export class StepBlockedError extends Error {
  constructor(blocked: string) {
    super(`Run refused by extension pre-step hook: ${blocked}`);
    this.name = 'StepBlockedError';
  }
}
/**
 * Whether a failure ended a run because it ran out of room or because something broke.
 *
 * The distinction is what tells a user to start a smaller task instead of looking for a bug, so it is
 * answered from one place: the code the failure carries. Every failure this runtime raises itself now carries
 * one (`LimitError`, `ContextLimitError`, the provider adapters), `failureCodeOf` names the two that do not —
 * a `TimeoutError` abort and an endpoint that only describes an overflow in prose — and anything else is a
 * defect without a name, which is exactly what `failed` means.
 */
function failureStatus(value: unknown): 'limited' | 'failed' | undefined {
  return statusForFailure(failureCodeOf(value));
}
/**
 * Why the step that was open when the run threw ended.
 *
 * Read from the same places the run's own status is built from (see `settleThrownRun`), so the two never
 * disagree: a step that ended because a limit was reached is not a failure, and one that ended because a person
 * was asked to look at something is neither. The abort comes first because that is what the signal says,
 * whatever error arrived carrying it.
 */
export function stepEndReason(cause: unknown, aborted: boolean): StepEndReason {
  if (aborted) return 'cancelled';
  if (cause instanceof StepBlockedError || cause instanceof DeferredApprovalError) return 'blocked';
  return failureStatus(cause) === 'limited' ? 'limited' : 'failed';
}

export interface ThrownRunOutcome {
  /** The partial answer the stream checkpoint kept, when it kept one. */
  text?: string;
  status: RunStatus;
  error: string;
  /** Why the run ended, when the reason has a name. Absent is a real answer: some failures are prose only. */
  code: FailureCode | undefined;
  /**
   * The failure itself, when the thing that threw was one this runtime named.
   *
   * Kept as the object rather than as two more fields because what it carries is optional in both: `code` above
   * is read from it either way, and a failure that named neither a status nor a request id is the common case
   * rather than an error.
   */
  endpointFailure: RunFailure | undefined;
}

const PERSIST_FAILED = 'Failed to persist partial model output';

/**
 * Settle a run whose round loop threw: keep its partial answer, classify the failure and close pending calls.
 *
 * The two writes here can fail themselves, and each failure is reported over the original one, because each
 * leaves the session in a state the original message would misdescribe: an answer nobody kept, or tool calls whose
 * outcome is unknown.
 */
export function settleThrownRun(options: {
  store: SessionStore;
  sessionId: string;
  runId: string;
  cause: unknown;
  aborted: boolean;
}): ThrownRunOutcome {
  const { store, sessionId, runId, cause, aborted } = options;
  let text: string | undefined;
  let persistFailed = false;
  try {
    const partial = store.persistStreamCheckpoint(sessionId, runId);
    if (partial) text = partial;
  } catch {
    persistFailed = true;
  }
  let status: RunStatus = persistFailed
    ? 'failed'
    : aborted
      ? 'cancelled'
      : cause instanceof DeferredApprovalError
        ? 'needs_review'
        : (failureStatus(cause) ?? 'failed');
  let error = persistFailed
    ? PERSIST_FAILED
    : cause instanceof Error && cause.name === 'ToolCleanupError'
      ? cause.message
      : aborted
        ? 'Run cancelled'
        : cause instanceof Error
          ? cause.message
          : String(cause);
  /**
   * What kind of failure it was, in the form a client can branch on.
   *
   * A `tool-cleanup` failure is named here because that error class carries no code: the run failed
   * *after* its work, and a reader should be able to see that without matching on a message. A cancelled
   * run has no code at all — its status already says `cancelled`, and inventing a code for it would make
   * a deliberate stop look like a failure with a name.
   */
  const code = persistFailed
    ? undefined
    : cause instanceof Error && cause.name === 'ToolCleanupError'
      ? 'tool-cleanup'
      : aborted
        ? undefined
        : failureCodeOf(cause);
  /**
   * What the endpoint said about the request, when it was the endpoint that failed.
   *
   * Not codes: nothing branches on them and the run's own status already says `failed`. They are the two
   * facts a person needs to take the failure back to whoever runs the endpoint — the status, and the id
   * the endpoint filed the call under — and they are read from the same thrown value the code is, so a
   * failure that never carried them reports none rather than an empty one.
   */
  const endpointFailure = cause instanceof RunFailure ? cause : undefined;
  try {
    store.resolvePending(
      sessionId,
      cause instanceof DeferredApprovalError
        ? 'Approval deferred; the requested operation was not executed. Review it before retrying.'
        : `Run ${status}. A tool may already have had effects; inspect state before retrying.`,
    );
  } catch {
    status = 'failed';
    error = 'Failed to resolve pending tool calls; execution outcome is unknown';
  }
  return {
    ...(text === undefined ? {} : { text }),
    status,
    error: redactSecrets(error),
    code,
    endpointFailure,
  };
}
