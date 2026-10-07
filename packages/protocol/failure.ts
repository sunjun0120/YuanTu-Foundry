/**
 * Why a run failed, named by what went wrong rather than by the HTTP status it arrived with.
 *
 * Two readers need this and neither can use the other's form. A person needs the message: an endpoint's
 * error body can name a model, an account or an internal path, so the message stays deliberately generic
 * and user-visible. The runtime needs a value it can branch on: whether a run ended because it ran out of
 * room (`limited`) or because something broke (`failed`) is the difference between "start a smaller task"
 * and "look for a bug".
 *
 * Only codes something actually reads are listed. A vocabulary nothing branches on is a comment that can
 * drift away from the code, so the rule for adding one is "whatever reads it is in the same change".
 */
export type FailureCode =
  /** The conversation was larger than the model accepts. */
  | 'context-window-exceeded'
  /** The provider stopped at the output limit, so the turn is partial by construction. */
  | 'output-limit'
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
   * The request never reached a response, or the connection ended before the response was complete: DNS, TLS, a
   * closed socket, a refused connection, a stream cut off before its terminal event.
   */
  | 'transport'
  /** The endpoint accepted the request and then said nothing usable. */
  | 'empty-response'
  /**
   * The request asked for something this protocol (or this endpoint) cannot express — a reasoning effort that
   * does not fit the request's own output limit, for instance. Retrying cannot help: it is the same request.
   */
  | 'unsupported'
  /** The endpoint answered with something that is not the stream this protocol speaks. */
  | 'no-stream'
  /** A tool could not be cleaned up, so an external process may still be running. */
  | 'tool-cleanup';
export interface FailureOptions {
  cause?: unknown;
  retryAfterMs?: number;
  /**
   * The HTTP status the endpoint answered with, when the failure arrived as a response.
   *
   * The code stays deliberately coarse — 400, 402, 404 and 413 are all `http`, because what a person can do
   * about them is one sentence — so the number itself rides alongside it rather than being folded in. Nothing
   * branches on this; a reader does, which is the difference between "the endpoint refused something" and
   * "the endpoint said 413".
   */
  httpStatus?: number;
  /**
   * The endpoint's own id for the request that failed, when it sent one.
   *
   * It is the one field a person needs to ask a provider what happened: support looks the call up by it, and
   * nothing else on the failure identifies which call it was. Absent when the endpoint named no request, which
   * is honest rather than an id invented here.
   */
  requestId?: string;
}
/**
 * A failure this runtime named, as opposed to one an endpoint's error body described.
 *
 * `cause` is kept because the wrapper's message is deliberately generic — the original error is the only
 * place the actual socket or status lives, and a debugger should not have to guess.
 *
 * `retryAfterMs` is the endpoint's own cooldown, when it sent one. It rides on the failure rather than being
 * acted on where the response is read because the decision it belongs to — "wait, or give up?" — is made at the
 * step boundary, and the header is gone by then. `httpStatus` and `requestId` ride here for the same reason:
 * both are things the response held and neither survives on its own.
 */
export class RunFailure extends Error {
  readonly code: FailureCode;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly requestId?: string;
  constructor(code: FailureCode, message: string, options?: FailureOptions) {
    super(message, options);
    this.name = 'RunFailure';
    this.code = code;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
  }
}
/**
 * A failure the model provider itself reported, named by what went wrong rather than by the HTTP status it
 * arrived with.
 *
 * Its own name because the difference matters where the run recovers: only a provider-confirmed overflow is
 * answered by compressing the conversation and sending the round again.
 */
export type ModelFailureCode = 'context-window-exceeded';
export class ModelFailure extends RunFailure {
  constructor(code: ModelFailureCode, message: string, options?: FailureOptions) {
    super(code, message, options);
    this.name = 'ModelFailure';
  }
}
/**
 * The prose an endpoint uses when a request did not fit its context window, across the protocols this runtime
 * speaks: OpenAI reports `context_length_exceeded` ("This model's maximum context length is ... tokens"),
 * Anthropic says "prompt is too long: ... tokens > ... maximum", and others describe the same condition as the
 * input token count exceeding a maximum or as too many tokens.
 *
 * It is matched against an error body or an error message, never against model-visible text.
 */
const CONTEXT_WINDOW_SIGNATURE =
  /context[_ ]length[_ ]exceeded|model_context_window_exceeded|context[_ ]window[_ ]exceeded|maximum context length|prompt is too long|too many tokens|input token count exceed/i;
/**
 * Whether a failure means "this request was larger than the model's context window".
 *
 * Three shapes arrive, and all three have to be recognised: the typed failure an adapter throws after reading
 * the endpoint's error body, the body text itself (which is what an adapter has in hand before it decides what
 * to throw), and an untyped error whose message only describes the overflow in prose.
 */
export function isContextWindowExceeded(value: unknown): boolean {
  if (value instanceof RunFailure) return value.code === 'context-window-exceeded';
  if (typeof value === 'string') return CONTEXT_WINDOW_SIGNATURE.test(value);
  return value instanceof Error && CONTEXT_WINDOW_SIGNATURE.test(value.message);
}
/**
 * The code a thrown value carries, when it carries one.
 *
 * A timeout that arrives as a raw `AbortSignal.timeout()` abort is classified here too: that abort is a
 * `DOMException` named `TimeoutError` with no code of ours on it, and it is the one failure the runtime
 * raises against itself often enough to be worth naming rather than reporting as an anonymous `failed`.
 *
 * A prose-only overflow is named as well. An endpoint that says "prompt is too long" instead of sending the
 * structured error is reporting the same condition, and it is the *only* prose this runtime matches, so
 * leaving it uncoded would mean the same failure had a code under one protocol and none under another.
 */
export function failureCodeOf(value: unknown): FailureCode | undefined {
  if (value instanceof RunFailure) return value.code;
  if (value instanceof Error && value.name === 'TimeoutError') return 'timeout';
  return isContextWindowExceeded(value) ? 'context-window-exceeded' : undefined;
}
/**
 * Whether a run that ended with this failure ran out of room or broke.
 *
 * `limited` is not a softer `failed`: it is the answer to a different question. A conversation the model will
 * not accept and a truncated output both mean the task needs to be smaller — retrying the same run changes
 * nothing. A run that ran out of *rounds* is not on this list, because a run has no round cap to run out of.
 */
export function statusForFailure(code: FailureCode | undefined): 'limited' | 'failed' | undefined {
  if (!code) return undefined;
  return code === 'context-window-exceeded' || code === 'output-limit' ? 'limited' : 'failed';
}
/**
 * The code an unsuccessful HTTP response has, before anything reads its body.
 *
 * The two transient statuses are the ones a step retries, so a run that *ends* with one of these codes means
 * the retries were spent — or the endpoint asked for a cooldown longer than we will hold a round open. A
 * reader sees the same code either way; what differs is how many attempts are recorded before it.
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
