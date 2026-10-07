/**
 * Turning "how much reasoning should this request buy" into what each protocol actually accepts.
 *
 * Two of the three protocols speak levels, so they are passed through unchanged. Anthropic has no levels — it
 * takes `thinking.budget_tokens`, a token budget that must be at least 1024 and strictly less than
 * `max_tokens`. There is no reading of Anthropic's API under which "high" is a number, so the mapping is *our*
 * policy and is stated here rather than hidden in the adapter: a level is a fraction of the request's own
 * output limit, because the budget comes out of that same limit.
 */
import type { ReasoningEffort } from '../protocol/index.ts';
import { RunFailure } from '../protocol/failure.ts';
/**
 * The share of the output limit a level asks to spend on thinking.
 *
 * Fractions rather than fixed token counts for the same reason the knob is per request: the honest size of a
 * thinking budget depends on how much room the request has. `high` leaves a quarter of the limit for the
 * answer, which is a real trade — an operator who asks for high effort is asking to think more and answer in
 * less space — and it is visible arithmetic rather than a surprise.
 */
const SHARE: Record<Exclude<ReasoningEffort, 'none'>, number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
};
/** Anthropic's own floor for `thinking.budget_tokens`; below it the request is malformed. */
export const MIN_THINKING_BUDGET_TOKENS = 1024;
/**
 * The thinking budget for a level, or `undefined` when the request asks for no thinking at all.
 *
 * Throws when the request's output limit leaves no room for Anthropic's floor: enabling thinking anyway would
 * be a malformed request (the endpoint would refuse it, after a round trip, for a reason we already knew), and
 * quietly not enabling it would ignore the policy the caller asked for. The failure is named `unsupported`
 * because the request asked for something this protocol cannot express at this size.
 */
export function anthropicThinkingBudget(
  effort: ReasoningEffort,
  maxOutputTokens: number,
): number | undefined {
  if (effort === 'none') return undefined;
  const budget = Math.floor(maxOutputTokens * SHARE[effort]);
  /**
   * Both of Anthropic's constraints, checked before anything is sent: `budget_tokens >= 1024` and
   * `budget_tokens < max_tokens` (the budget comes *out of* the output limit rather than adding to it, so a
   * budget equal to the limit would leave no room for an answer).
   */
  if (budget < MIN_THINKING_BUDGET_TOKENS || budget >= maxOutputTokens)
    throw new RunFailure(
      'unsupported',
      `Reasoning effort "${effort}" needs an Anthropic thinking budget of at least ${MIN_THINKING_BUDGET_TOKENS} tokens and less than the output limit, which does not fit in this request's output limit of ${maxOutputTokens}`,
    );
  return budget;
}
