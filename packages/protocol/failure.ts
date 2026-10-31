/**
 * Why a run failed, named by what went wrong rather than by HTTP status. The message stays generic
 * for the user; the code lets the runtime branch, e.g. `limited` (task too large) versus `failed`
 * (something broke). Only codes something reads are listed; add a code together with its reader.
 */
export type FailureCode =
  /** The conversation was larger than the model accepts. */
  | 'context-window-exceeded'
  /** The provider stopped at the output limit, so the turn is partial by construction. */
  | 'output-limit'
  /**
   * The provider stopped the turn by its own content policy. Re-sending or compressing cannot help.
   */
  | 'content-filtered'
  /** The endpoint refused the credential or the model access: every retry gets the same answer. */
  | 'auth'
  /** HTTP 429: the endpoint asked for a slower rate. */
  | 'rate-limit'
  /** HTTP 5xx: the endpoint failed on its own side. */
  | 'server'
  /** Any other unsuccessful HTTP status (400, 404, …) with nothing more specific to say. */
  | 'http'
  /** A wall-clock or idle timeout — ours, not the endpoint's. */
  | 'timeout'
  /**
   * No complete response: DNS, TLS, refused or closed connection, or a stream cut off before its
   * terminal event.
   */
  | 'transport'
  /** The endpoint accepted the request and then said nothing usable. */
  | 'empty-response'
  /**
   * The request asked for something this protocol or endpoint cannot express (e.g. an effort that
   * does not fit the output limit). Retrying cannot help.
   */
  | 'unsupported'
  /** The endpoint answered with something that is not the stream this protocol speaks. */
  | 'no-stream'
  /** A complete parallel tool batch lost its required argument fragments. */
  | 'tool-arguments-dropped'
  /** A tool could not be cleaned up, so an external process may still be running. */
  | 'tool-cleanup'
  /** The run reached its own total budget: rounds, wall clock or tokens (`RunDefaults.maxRunRounds`). */
  | 'run-budget';
export interface FailureDetails {
  usage?: import('./index.ts').Usage;
  finishReason?: import('./index.ts').ModelResponse['finishReason'];
  requestNumber?: number;
  durationMs?: number;
  /**
   * Response-body bytes received before the failure, when countable. `0` marks an empty failure,
   * which cannot be recovered a layer up.
   */
  responseBytes?: number;
  /** Stream events parsed from those bytes, which is 0 whenever `responseBytes` is. */
  events?: number;
}
export interface FailureOptions {
  details?: FailureDetails;
  cause?: unknown;
  retryAfterMs?: number;
  /**
   * The HTTP status, when the failure arrived as a response. Kept beside the coarse code for
   * readers; nothing branches on it.
   */
  httpStatus?: number;
  /** The endpoint's request id, when it sent one, for asking the provider about the call. */
  requestId?: string;
}
/**
 * A failure this runtime named. `cause` keeps the original error, since the message is generic.
 * `retryAfterMs`, `httpStatus` and `requestId` carry response details to the step boundary, where
 * the retry decision is made.
 */
export class RunFailure extends Error {
  readonly code: FailureCode;
  readonly details?: FailureDetails;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly requestId?: string;
  constructor(code: FailureCode, message: string, options?: FailureOptions) {
    super(message, options);
    this.name = 'RunFailure';
    this.code = code;
    if (options?.details) this.details = options.details;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
  }
}
/**
 * A failure the model provider reported. Separate because only a provider-confirmed overflow is
 * answered by compressing and re-sending.
 */
export type ModelFailureCode = 'context-window-exceeded';
export class ModelFailure extends RunFailure {
  constructor(code: ModelFailureCode, message: string, options?: FailureOptions) {
    super(code, message, options);
    this.name = 'ModelFailure';
  }
}
/**
 * The prose endpoints use for a context-window overflow (OpenAI `context_length_exceeded`,
 * Anthropic "prompt is too long", and similar). Matched against error bodies and messages only,
 * never model-visible text.
 */
const CONTEXT_WINDOW_SIGNATURE =
  /context[_ ]length[_ ]exceeded|model_context_window_exceeded|context[_ ]window[_ ]exceeded|maximum context length|prompt is too long|too many tokens|input token count exceed/i;
/**
 * Whether a failure means the request exceeded the model's context window. Recognises the typed
 * failure, the raw error body, and an untyped error whose message describes the overflow.
 */
export function isContextWindowExceeded(value: unknown): boolean {
  if (value instanceof RunFailure) return value.code === 'context-window-exceeded';
  if (typeof value === 'string') return CONTEXT_WINDOW_SIGNATURE.test(value);
  return value instanceof Error && CONTEXT_WINDOW_SIGNATURE.test(value.message);
}
/**
 * The code a thrown value carries. Also names a raw `AbortSignal.timeout()` abort as `timeout`, and
 * a prose-only overflow as `context-window-exceeded` so every protocol codes it alike.
 */
export function failureCodeOf(value: unknown): FailureCode | undefined {
  if (value instanceof RunFailure) return value.code;
  if (value instanceof Error && value.name === 'TimeoutError') return 'timeout';
  return isContextWindowExceeded(value) ? 'context-window-exceeded' : undefined;
}
/**
 * Whether a failure means the run ran out of room (`limited`: overflow, truncated output, spent run
 * budget) or broke (`failed`). Retrying a limited run changes nothing.
 */
export function statusForFailure(code: FailureCode | undefined): 'limited' | 'failed' | undefined {
  if (!code) return undefined;
  return code === 'context-window-exceeded' || code === 'output-limit' || code === 'run-budget'
    ? 'limited'
    : 'failed';
}
/**
 * The code for an unsuccessful HTTP status. A run ending with a transient code means its retries
 * were spent or the requested cooldown was too long.
 */
export function codeForHttpStatus(status: number): FailureCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  return status >= 500 ? 'server' : 'http';
}

/** Stop an unattended attempt before executing a tool that requires human review. */
export class DeferredApprovalError extends Error {
  constructor() {
    super('Approval required; scheduled task paused until reviewed.');
    this.name = 'DeferredApprovalError';
  }
}
