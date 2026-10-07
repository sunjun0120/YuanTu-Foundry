import type { FailureCode } from './failure.ts';
/**
 * What to do about a failure, as opposed to what it was.
 *
 * `failure.ts` names what went wrong. This module answers the next question — "would sending the same request
 * again plausibly end differently?" — and it is a *table* rather than a `switch` with a default so that adding
 * a code fails to compile until somebody decides. That decision is the whole content of this file:
 *
 * - **Transient by nature, and re-sending changes nothing about the request**: the endpoint was overloaded or
 *   asked for a slower rate (`rate-limit`), it failed on its own side (`server`), the connection was cut
 *   (`transport`), a timeout of ours fired (`timeout`), it answered with something that was not the stream this
 *   protocol speaks (`no-stream`), or it closed a turn that carried nothing at all (`empty-response`) — a turn
 *   with no text and no call is a gateway hiccup far more often than it is a considered answer, and the round
 *   is bounded by the retry allowance either way.
 * - **Every attempt gets the same answer**: a credential or model-access refusal (`auth`), or a request the
 *   endpoint rejected on its merits (`http`: 400, 404, a malformed body).
 * - **Room, not weather**: `context-window-exceeded` and `output-limit` are the run answering itself.
 *   Re-sending does not make the conversation smaller; the answer is a smaller task.
 * - **Not a transport question at all**: `tool-cleanup` means the run failed while releasing a resource. The
 *   model request is not what broke.
 * - **No code**: an unrecognised defect. Retrying an unknown failure spends a full round on a hope, and the
 *   record of what happened is more useful than a silent second attempt.
 */
const RETRYABLE: Record<FailureCode, boolean> = {
  'rate-limit': true,
  server: true,
  timeout: true,
  transport: true,
  'no-stream': true,
  auth: false,
  http: false,
  'empty-response': true,
  unsupported: false,
  'tool-cleanup': false,
  'context-window-exceeded': false,
  'output-limit': false,
};
export function retryable(code: FailureCode | undefined): boolean {
  return code !== undefined && RETRYABLE[code];
}
/**
 * The longest we will hold a round open waiting to re-send it.
 *
 * A retry is a wait the user is paying for without seeing progress, so it is bounded and visible (the retry is
 * recorded before the wait, not after). The backoff never exceeds this; a server-directed cooldown longer than
 * this is not shortened — the attempt is abandoned instead, which is what the endpoint asked for.
 */
export const RETRY_MAX_WAIT_MS = 30_000;
/**
 * How long to wait before attempt `attempt` (1-based), given the endpoint's own cooldown when it sent one.
 *
 * Exponential with jitter, because the clients sharing an endpoint that just returned 429 are the ones that
 * would otherwise all come back at the same instant. The jitter is additive and small relative to the step, so
 * the wait is predictable enough to reason about and uneven enough not to synchronise a fleet.
 */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  // Jitter is inside the cap, so "never longer than `RETRY_MAX_WAIT_MS`" is a property of this function rather
  // than something the arithmetic happens to satisfy for small attempts.
  const backoff = Math.min(
    RETRY_MAX_WAIT_MS,
    250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100),
  );
  const asked =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : 0;
  return Math.max(backoff, asked);
}
/**
 * The cooldown an endpoint asked for, in milliseconds, read from its `retry-after` header.
 *
 * Both forms the header allows are accepted: delay-seconds (including a fractional one, which some gateways
 * send) and an HTTP date. An unreadable value is not a cooldown, so it is ignored rather than guessed at.
 */
export function retryAfterMs(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
