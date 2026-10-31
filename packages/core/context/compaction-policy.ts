import type { Message } from '../../protocol/index.ts';
import { estimateMessageTokens } from './budget.ts';
/**
 * When to compress, how much to keep verbatim, and how hard to retry. Defaults match DeepSeek
 * Harness: compress at 80% of the window, with at least 64K of headroom (15% on small windows) on
 * top of the request's output reservation; keep the newest 16% of the message budget verbatim;
 * retry once if still over the threshold. The output reservation comes off first because messages
 * cannot use it.
 */
export const COMPACTION_DEFAULTS = {
  /** Share of the window at which compression starts. */
  thresholdRatio: 0.8,
  /** Room kept free beyond the request's own output reservation, at most. */
  headroomTokens: 65_536,
  /** Headroom as a share of the window, used on windows too small for the fixed cap. */
  headroomRatio: 0.15,
  /** Share of the message budget kept verbatim at the tail. */
  retainRatio: 0.16,
  /** Further compressions one over-threshold round may trigger; a third attempt would be a loop. */
  compactionRetries: 1,
  /** How many times a provider-confirmed overflow may compress and re-send the round. */
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
 * Scale the policy into budgets for one route's window. A window leaving no message or pressure
 * budget is a configuration error and throws rather than clamping.
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
  const headroomTokens = Math.max(
    0,
    Math.min(policy.headroomTokens, Math.floor(contextWindow * policy.headroomRatio)),
  );
  const pressureBudgetTokens = messageBudgetTokens - headroomTokens;
  if (pressureBudgetTokens <= 0)
    throw new Error(
      `The request reserves ${reserved} output tokens and ${headroomTokens} headroom tokens of a ` +
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
 * Where the verbatim tail starts: walk back from the end until the newest messages reach
 * `retainTokens`, then snap to a cut (`cuts` follow complete tool-call groups). With no cut before
 * that point, the newest earlier cut wins; with none at all, `undefined`.
 *
 * `factor` is the route's learned correction, since `retainTokens` is in billed tokens: a heavier
 * tokenizer keeps fewer messages.
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
     * Nothing kept verbatim: compact as much as the history allows. `contextTail` still prepends
     * the user turn.
     */
    return [...cuts].reverse().find((cut) => cut > covered);
  }
  let accumulated = 0;
  let reached = history.length;
  for (let index = history.length - 1; index > covered; index--) {
    // Per message, without the request's 256-token margin (see `estimateMessageTokens`).
    accumulated += estimateMessageTokens(history[index]!, factor);
    if (accumulated >= retainTokens) {
      reached = index;
      break;
    }
  }
  if (accumulated < retainTokens) return undefined;
  return [...cuts].reverse().find((cut) => cut > covered && cut <= reached);
}
