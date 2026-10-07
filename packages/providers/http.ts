import {
  ModelFailure,
  RunFailure,
  codeForHttpStatus,
  isContextWindowExceeded,
} from '../protocol/failure.ts';
import { retryAfterMs } from '../protocol/retry.ts';
/** Enough of an error body to name the failure; an endpoint's stack trace is not worth buffering. */
const maxErrorBodyChars = 4_096;
const errorBodyTimeoutMs = 2_000;
/**
 * The endpoint's error text, bounded in both size and time.
 *
 * A context overflow is only identifiable here — it arrives as the generic 400 the adapters already report —
 * so the body has to be read instead of cancelled. It stays non-fatal: an endpoint that stalls or floods its
 * error body must not delay the failure that body explains, so the read gives up and the status speaks alone.
 */
async function errorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), errorBodyTimeoutMs);
  });
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === 'expired' || next.done) break;
      text += decoder.decode(next.value, { stream: true });
      if (text.length >= maxErrorBodyChars) break;
    }
  } catch {
    // A body that cannot be read says nothing about the failure; the status still does.
  } finally {
    if (timer) clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, maxErrorBodyChars);
}
/**
 * The endpoint's own name for the request, from whichever header it uses.
 *
 * A list rather than one name because the protocols disagree — Anthropic sends `request-id`, OpenAI and most
 * gateways `x-request-id`, Bedrock `x-amzn-requestid` — and none of them is wrong. The first one present wins;
 * an endpoint that sends none leaves the failure without an id rather than with a guessed one.
 */
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'x-amzn-requestid'] as const;
function requestIdOf(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}
/**
 * What the response itself says about a failure: the status it answered with, and the request it named.
 *
 * Both are read *here* because they are gone a layer up: the code is what a caller branches on, and the status
 * and the endpoint's request id are what a person needs to ask the provider what happened.
 */
function responseFacts(response: Response): { httpStatus: number; requestId?: string } {
  const requestId = requestIdOf(response.headers);
  return { httpStatus: response.status, ...(requestId === undefined ? {} : { requestId }) };
}
/**
 * The typed failure an unsuccessful response means, when its body names one.
 *
 * `undefined` means "no more specific story than the status", which leaves the adapter's generic message as
 * the right thing to say. The body is consumed either way, so the connection is not left half-read.
 */
export async function failureFromResponse(
  response: Response,
  credentials: readonly string[] = [],
): Promise<RunFailure | undefined> {
  const body = await errorBody(response);
  if (isContextWindowExceeded(body))
    return new ModelFailure(
      'context-window-exceeded',
      `Model API reported that the request exceeds the model's context window (HTTP ${response.status}). The conversation was larger than this model accepts.`,
      responseFacts(response),
    );
  // Only a structured endpoint message is a diagnostic: never publish a raw HTML page or stack trace.
  let message: unknown;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    message = parsed?.error?.message ?? parsed?.message;
  } catch {
    return undefined;
  }
  if (typeof message !== 'string' || !message.trim()) return undefined;
  for (const credential of credentials)
    if (credential) message = (message as string).split(credential).join('[redacted]');
  const detail = (message as string)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/sk-[a-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, 2048);
  return new RunFailure(
    codeForHttpStatus(response.status),
    `Model API returned HTTP ${response.status}: ${detail}`,
    {
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      ...responseFacts(response),
    },
  );
}
/**
 * The failure an unsuccessful response means when its body named nothing more specific.
 *
 * One message for every status, exactly as before, because the status is already in it and what a person can
 * do about a 401 and a 404 is the same sentence: check credentials, model access and endpoint configuration.
 * What changes is that the status is now also named as a code, so a run can report *why* it failed without
 * anyone parsing prose — and a 401 no longer looks like a 500 in the record.
 */
export function failureForStatus(response: Response): RunFailure {
  return new RunFailure(
    codeForHttpStatus(response.status),
    `Model API returned HTTP ${response.status}. Check credentials, model access and endpoint configuration.`,
    {
      // The endpoint's own cooldown survives into the failure: whether to wait it out is decided a layer up,
      // where the retry allowance and the round's cancellation live.
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      ...responseFacts(response),
    },
  );
}
/**
 * One attempt at a model request.
 *
 * The retry loop that used to live here is gone: it could only ever see a status before the stream started, it
 * was invisible in the record, and its count died with the process. Deciding to re-send a *round* now happens
 * at the step boundary, where the same decision covers a broken stream, where the count can be read back from
 * the log, and where the wait is interrupted by a Stop along with everything else. What stays here is the one
 * thing that belongs to the transport: the connect idle timeout.
 */
export async function fetchModel(
  url: string,
  init: RequestInit,
  connectTimeoutMs = 300_000,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const connection = new AbortController();
  const timer = setTimeout(
    () =>
      connection.abort(
        new RunFailure('timeout', 'Model connection idle timeout', {
          cause: new Error(`No response within ${connectTimeoutMs}ms`),
        }),
      ),
    connectTimeoutMs,
  );
  try {
    return await fetch(url, {
      ...init,
      signal: signal ? AbortSignal.any([signal, connection.signal]) : connection.signal,
    });
  } catch (error) {
    if (connection.signal.aborted && !signal?.aborted) throw connection.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
