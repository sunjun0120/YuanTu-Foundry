import type { Message } from '../protocol/index.ts';
import { estimateMessageTokens } from './budget.ts';
/**
 * When this conversation should be compressed, how much of it to keep verbatim, and how hard to try again.
 *
 * Three numbers, and they are the whole policy. They used to be two separate ideas — a character ceiling and a
 * "does this request fit" check — which meant compression happened at the model's limit rather than before it,
 * and the part that was kept was whatever happened to start at the previous user turn.
 *
 * The defaults are the ones DeepSeek Harness resolves for a routed model, restated here as one object:
 * compress at 80% of the window, but never with less than 64K of headroom on top of the output this request
 * already reserved; keep the newest 16% of the message budget verbatim; after a compression that did not get
 * the conversation under the threshold, try once more.
 *
 * The output reservation is subtracted first because it is not available to messages: a request that fills the
 * window with context has no room to answer, so "the window" is not the number messages may use. Headroom is
 * subtracted on top of it because a compression that lands exactly at the ceiling has not bought anything —
 * the next request would need another one immediately.
 */
export const COMPACTION_DEFAULTS = {
  /** Share of the window at which compression starts. */
  thresholdRatio: 0.8,
  /** Room kept free beyond the request's own output reservation. */
  headroomTokens: 65_536,
  /** Share of the message budget kept verbatim at the tail. */
  retainRatio: 0.16,
  /**
   * How many further compressions one over-threshold round may trigger.
   *
   * One, because a compression that did not help is usually a compression with no boundary left; a second
   * attempt is worth paying for, a third is a loop.
   */
  compactionRetries: 1,
  /**
   * How many times a provider-confirmed overflow may compress and re-send the round.
   *
   * One: the same request that was refused cannot be made to fit twice by the same decision.
   */
  maxOverflowRetries: 1,
} as const;
export interface CompactionSpec {
  contextWindow: number;
  /** What messages may use: the window minus the request's own output reservation. */
  messageBudgetTokens: number;
  /** `messageBudgetTokens` minus headroom — the ceiling the threshold is capped by. */
  pressureBudgetTokens: number;
  /** Compress at or above this. */
  thresholdTokens: number;
  /** Keep this much of the newest conversation verbatim. */
  retainTokens: number;
  compactionRetries: number;
  maxOverflowRetries: number;
}
/**
 * Scale the policy into concrete budgets for one route's window.
 *
 * A window that leaves no message budget, or no pressure budget, is a configuration failure rather than a
 * runtime condition: it means the request reserves everything the endpoint allows. It is thrown rather than
 * clamped because clamping would silently compress a conversation into nothing on every round.
 */
export function resolveCompactionSpec(input: {
  contextWindow: number;
  /** Output tokens one routed request reserves — the request's own cap, or the adapter's default for it. */
  reservedCompletionTokens: number;
  /** An operator's explicit threshold, which replaces the computed one. */
  thresholdTokens?: number;
  policy?: Partial<typeof COMPACTION_DEFAULTS> & { retainTokens?: number };
}): CompactionSpec {
  const policy = { ...COMPACTION_DEFAULTS, ...input.policy };
  const { contextWindow } = input;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0)
    throw new Error(`Compaction needs a positive context window, got ${contextWindow}`);
  const reserved = Math.max(0, Math.floor(input.reservedCompletionTokens));
  const messageBudgetTokens = contextWindow - reserved;
  if (messageBudgetTokens <= 0)
    throw new Error(
      `The request reserves ${reserved} output tokens of a ${contextWindow}-token window, leaving no room ` +
        "for messages; lower the model's output cap or declare a larger window",
    );
  const pressureBudgetTokens = messageBudgetTokens - Math.max(0, policy.headroomTokens);
  if (pressureBudgetTokens <= 0)
    throw new Error(
      `The request reserves ${reserved} output tokens and ${policy.headroomTokens} headroom tokens of a ` +
        `${contextWindow}-token window, leaving nothing to compress towards; lower the output cap, lower the ` +
        'headroom, or declare a larger window',
    );
  const thresholdTokens =
    input.thresholdTokens === undefined
      ? Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))
      : Math.min(input.thresholdTokens, messageBudgetTokens);
  const retainTokens =
    policy.retainTokens === undefined
      ? Math.floor(messageBudgetTokens * policy.retainRatio)
      : policy.retainTokens;
  if (retainTokens >= thresholdTokens)
    throw new Error(
      `Retaining ${retainTokens} verbatim tokens already reaches the ${thresholdTokens}-token threshold; ` +
        'lower the retention or raise the threshold',
    );
  return {
    contextWindow,
    messageBudgetTokens,
    pressureBudgetTokens,
    thresholdTokens,
    retainTokens,
    compactionRetries: Math.max(0, Math.floor(policy.compactionRetries)),
    maxOverflowRetries: Math.max(0, Math.floor(policy.maxOverflowRetries)),
  };
}
/**
 * Where the verbatim tail starts: the newest messages worth `retainTokens`, snapped to a cut.
 *
 * Walking from the end and stopping once the estimate reaches the budget is what makes the retained part the
 * *newest* conversation rather than "everything after some earlier user turn": a long tool call near the end
 * used to drag its whole turn into the tail, which is how a compaction could leave a conversation that still
 * did not fit.
 *
 * `cuts` are positions only reachable after a complete tool-call/result group, so a tool result never survives
 * its call. When no cut is at or before the point the budget reached, the newest cut that is still before it
 * wins; when there is none, the caller's own boundary rule applies (`undefined`).
 *
 * `factor` is the session's learned correction for the route this round is on, and it belongs here for the same
 * reason it belongs in the request estimate: `retainTokens` is a share of a window measured in the tokens the
 * *endpoint* bills, so a tail sized in the estimator's own units is the wrong size exactly when the estimator is
 * wrong — which is the state the correction describes. A correction above one therefore keeps fewer messages, and
 * that is the honest answer rather than a bug: the same budget buys less conversation when each message costs
 * more. Without it, a route whose real tokenizer is three times the heuristic kept a verbatim tail three times
 * the policy's size, which is the size that then has to fit the window the compaction was called to clear.
 */
export function retentionStart(
  history: readonly Message[],
  cuts: readonly number[],
  covered: number,
  retainTokens: number,
  factor = 1,
): number | undefined {
  if (retainTokens <= 0) {
    /**
     * Nothing is kept verbatim: compact everything the history allows, which is what an overflow recovery
     * wants. The newest cut *is* the end of the history, so this keeps strictly less than any positive budget —
     * and the round still has the message it is about to send, because `contextTail` prepends the user turn a
     * cut would otherwise have removed.
     */
    return [...cuts].reverse().find((cut) => cut > covered);
  }
  let accumulated = 0;
  let reached = history.length;
  for (let index = history.length - 1; index > covered; index--) {
    // Per message, not per request: `estimateInputTokens` on a one-message request would add the request's own
    // 256-token protocol margin to every message, which is most of a small message (see
    // `estimateMessageTokens`).
    accumulated += estimateMessageTokens(history[index]!, factor);
    if (accumulated >= retainTokens) {
      reached = index;
      break;
    }
  }
  if (accumulated < retainTokens) return undefined;
  return [...cuts].reverse().find((cut) => cut > covered && cut <= reached);
}
