/**
 * Turning "how much reasoning should this request buy" into what each protocol actually accepts.
 *
 * Two of the three protocols speak levels, so they are passed through unchanged. Anthropic speaks levels too on
 * its adaptive-thinking models ({@link usesAdaptiveThinking}); older Claude models have no levels — they take
 * `thinking.budget_tokens`, a token budget that must be at least 1024 and strictly less than `max_tokens`. There
 * is no reading of that API under which "high" is a number, so the mapping is *our* policy and is stated here
 * rather than hidden in the adapter: a level is a fraction of the request's own output limit, because the budget
 * comes out of that same limit.
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
  const share = SHARE[effort as Exclude<ReasoningEffort, 'none'>];
  /**
   * A level outside this union is refused before the arithmetic rather than after it: `Math.floor(n * undefined)`
   * is `NaN`, and `NaN` passes both bounds below, so the request would go out with `budget_tokens: null` and come
   * back as a generic HTTP failure. Workspace hooks supply this value at runtime, so the type is not a check.
   */
  if (share === undefined)
    throw new RunFailure('unsupported', `Unknown reasoning effort "${String(effort)}"`);
  const budget = Math.floor(maxOutputTokens * share);
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

/**
 * Whether a model takes *adaptive* thinking rather than a token budget.
 *
 * From Claude Opus 4.6 and Sonnet 4.6 on, Anthropic sizes thinking itself and takes the level as
 * `output_config.effort`; the budget is deprecated there and refused with a 400 on Opus 4.7 and later and on
 * every Claude 5 model. Older Claude models (Haiku 4.5, Sonnet and Opus 4.5 and before) only know the budget, and
 * so does any non-Claude model behind an Anthropic-compatible gateway — which is why the test is the model id and
 * an unrecognised id keeps the budget it always had. The id may carry a platform prefix or suffix
 * (`anthropic.claude-opus-5-5`, `claude-opus-4-6@…`), so the family is searched for rather than anchored.
 */
const ADAPTIVE_MODEL =
  /claude-(?:(?:opus|sonnet)-4-[6-9]|(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|\d{2,}))(?!\d)/;
export function usesAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_MODEL.test(model.toLowerCase());
}

/**
 * The request fields that ask an Anthropic model for a level of reasoning, or none when no level was asked for.
 *
 * Adaptive models get the level itself (`low`, `medium`, `high` are all levels Anthropic accepts, so nothing is
 * translated); budget models get {@link anthropicThinkingBudget}, with its refusal when the output limit is too
 * small. `none` stays the absence of the parameters on both: on the newest models thinking cannot be switched off
 * at all, and sending `disabled` there is a 400, so leaving the model its default is the only request that works
 * everywhere.
 */
export function anthropicThinkingFields(
  model: string,
  effort: ReasoningEffort,
  maxOutputTokens: number,
): Record<string, unknown> {
  if (!usesAdaptiveThinking(model)) {
    const budget = anthropicThinkingBudget(effort, maxOutputTokens);
    return budget === undefined ? {} : { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  if (effort === 'none') return {};
  if (SHARE[effort as Exclude<ReasoningEffort, 'none'>] === undefined)
    throw new RunFailure('unsupported', `Unknown reasoning effort "${String(effort)}"`);
  return { thinking: { type: 'adaptive' }, output_config: { effort } };
}
