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
 * How a run that threw is described: status, message, code and the step's end reason, classified
 * side by side.
 */

/**
 * A round a pre-step hook refused. Names the step's end; the run still fails because the task did
 * not happen.
 */
export class StepBlockedError extends Error {
  constructor(blocked: string) {
    super(`Run refused by extension pre-step hook: ${blocked}`);
    this.name = 'StepBlockedError';
  }
}
/**
 * Whether a failure means the run ran out of room or broke, from the failure's code
 * (`failureCodeOf` also names timeouts and prose-only overflows). Anything uncoded is `failed`.
 */
function failureStatus(value: unknown): 'limited' | 'failed' | undefined {
  return statusForFailure(failureCodeOf(value));
}
/**
 * Why the open step ended, using the same sources as the run's status. An abort takes precedence.
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
  /** The failure itself, when this runtime named it; carries the optional status and request id. */
  endpointFailure: RunFailure | undefined;
}

const PERSIST_FAILED = 'Failed to persist partial model output';

/**
 * Settle a run whose loop threw: keep its partial answer, classify the failure and close pending
 * calls. A failure in either write is reported over the original, since it changes the session's
 * state.
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
   * The failure code. `tool-cleanup` is named here because that error has no code; a cancelled run
   * has none.
   */
  const code = persistFailed
    ? undefined
    : cause instanceof Error && cause.name === 'ToolCleanupError'
      ? 'tool-cleanup'
      : aborted
        ? undefined
        : failureCodeOf(cause);
  /** The endpoint's HTTP status and request id, when the endpoint failed. */
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
