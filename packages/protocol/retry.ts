import type { FailureCode } from './failure.ts';
/**
 * Whether re-sending the same request could plausibly end differently. A table, not a `switch`, so
 * a new code does not compile until someone decides.
 *
 * - Retryable: `rate-limit`, `server`, `transport`, `timeout`, `no-stream`, and `empty-response`
 *   (usually a gateway hiccup; bounded by the retry allowance).
 * - Same answer every time: `auth`, `http` (rejected on its merits), `content-filtered`.
 * - Out of room: `context-window-exceeded`, `output-limit`; the remedy is a smaller task.
 * - Not a model request problem: `tool-cleanup`.
 * - No code: unknown defects are not retried.
 */
const RETRYABLE: Record<FailureCode, boolean> = {
  'tool-arguments-dropped': false,
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
  'run-budget': false,
  'context-window-exceeded': false,
  'output-limit': false,
  'content-filtered': false,
};
export function retryable(code: FailureCode | undefined): boolean {
  return code !== undefined && RETRYABLE[code];
}
/**
 * The longest a round is held open waiting to re-send. A server cooldown longer than this abandons
 * the attempt instead of being shortened.
 */
export const RETRY_MAX_WAIT_MS = 30_000;
/**
 * Wait before attempt `attempt` (1-based), honouring the endpoint's cooldown. Exponential with
 * small additive jitter so clients do not retry in lockstep.
 */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  // Jitter is inside the cap, so the wait never exceeds `RETRY_MAX_WAIT_MS`.
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
 * The cooldown from a `retry-after` header, in ms: delay-seconds (fractional allowed) or an HTTP
 * date. Unreadable values are ignored.
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
