import type { Message, ToolSpec } from '../protocol/index.ts';
import { measureRequest, type RequestBytes } from './budget.ts';
import type { ContextBreakdown } from './budget.ts';
import type { PartFactors } from './calibration.ts';

/**
 * What one request is expected to cost, and whether it fits the model — always computed together.
 *
 * These numbers used to be produced separately and at different moments: the context builder had its own
 * "does this fit" arithmetic, calibration was fed a second estimate of the same request, and the output
 * allowance computed a third one from scratch. Nothing made them agree, so a run could decide a request fit,
 * cap its output against a different figure, and report a third one to the operator.
 *
 * They are also the two things a person asks about when a run gets expensive or starts compacting: *how much
 * is this request going to need*, and *how much room does the model have left for it*. Computing both once,
 * before the request, is what lets the decisions (shorten, compact, send) and the report agree by
 * construction.
 *
 * There is no third number. A run has no cumulative token allowance to spend down: the same conversation is
 * re-sent every round, so an allowance would be consumed in proportion to rounds × context rather than to
 * work done, and it would refuse a request the model was perfectly willing to answer. What bounds a single
 * request is the window, and what bounds the run is its shape (rounds, wall clock).
 */
/**
 * Which ceiling a request that cannot be sent violates.
 *
 * One answer today, kept as a named type because the callers branch on it and because the window is a
 * *ceiling* rather than a flag: `problem` present means "this request must be made smaller before it can be
 * sent", which is the same decision for shortening, compressing and refusing.
 */
export type ForecastProblem = 'window';
export interface RequestForecast {
  /** Tokens the provider is expected to bill for this request's input, with the learned correction applied. */
  inputTokens: number;
  /**
   * Where that input goes: the system prompt, the tool schemas, the messages, and the fixed margin.
   *
   * Carried on the forecast rather than computed by whoever wants to display it, so the split a reader sees is
   * the split this request was decided on — and so "the tool schemas cost more than the conversation" is
   * answerable at the moment it matters (see `contextBreakdown`).
   */
  breakdown: ContextBreakdown;
  /** The same estimate before correction, which is the figure calibration has to observe. */
  rawInputTokens: number;
  /**
   * The serialised size of each part the estimate was made of.
   *
   * Carried because an observation needs to say *which part* was misestimated — the provider reports one total,
   * and the three sizes are what turns it into evidence about the system prompt, the catalogue and the
   * conversation separately. Not reported on the live channel: it is the input to a measurement, not a number a
   * person reads.
   */
  bytes: RequestBytes;
  /** Tokens this request may still ask the model to produce. */
  outputTokens: number;
  /**
   * What the model's window leaves for this request's answer. Absent when no window is configured.
   *
   * Measured before the output cap is applied, so it says how much room the window itself has rather than
   * restating the cap: for a request capped by the window, `windowRoom` and `outputTokens` agreeing is the
   * expected outcome, and for one capped by `maxOutputTokens` the difference is what is left unused.
   */
  windowRoom?: number;
  /**
   * Why this request cannot be sent as it stands: it does not fit the model's window, with room to answer.
   *
   * Answered by shortening old results or compressing the conversation — the two things that make a request
   * smaller without changing what the user asked for.
   */
  problem?: ForecastProblem;
}
export interface ForecastInput {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** The output cap this request would like to ask for. */
  maxOutputTokens: number;
  /** The model's window, when one is configured. */
  maxContextTokens?: number;
  /** The learned correction from `TokenCalibration`, applied to the request as a whole. */
  factor?: number;
  /**
   * The learned correction per part, when the caller has one.
   *
   * Preferred over `factor` and not combined with it: a per-part correction already answers "what is this request
   * sized with" for a request made of these bytes, and passing both would be two answers to one question.
   */
  factors?: PartFactors;
}
/**
 * The smallest answer a request must be able to ask for before sending it is worth anything.
 *
 * A request admitted with no room to answer comes back truncated, so "it fits" has to mean the input *and* one
 * token of output fit — measuring the input alone would admit a request whose only possible reply is a length
 * truncation.
 */
const MINIMUM_OUTPUT_TOKENS = 1;
/** The model's window cannot take this request, with room left for it to answer. */
export const WINDOW_EXHAUSTED =
  'Current user request exceeds context budget; history was preserved';
/**
 * How far past a window an *estimate* must be before a run refuses the request without asking the endpoint.
 *
 * The estimate is a character heuristic corrected by what the endpoint has already reported, and the correction is
 * itself clamped to 0.5–3 — so "the estimate says it does not fit" is a statement about the heuristic, not about
 * the request. Refusing on it ends a run the endpoint would have answered, and the failure the user sees names a
 * budget rather than the real condition. Past this ratio the request is over the window by more than any
 * correction could explain, which is when a refusal is safe; one marginally over is sent, and if the endpoint
 * refuses it for size the run compresses and re-sends (`recoverFromOverflow`).
 */
export const LOCAL_REFUSAL_RATIO = 2;
/**
 * Whether this estimate is so far past the window that sending it is not worth a request.
 *
 * `false` when no window is declared: a run that does not know the window cannot call a request hopeless against
 * it (see `RunDefaults.maxContextTokens`).
 */
export function hopelessForWindow(
  forecast: Pick<RequestForecast, 'inputTokens'>,
  window: number | undefined,
): boolean {
  if (window === undefined || window <= 0) return false;
  return forecast.inputTokens > window * LOCAL_REFUSAL_RATIO;
}
/**
 * Predict the next request, once.
 *
 * A request that cannot be sent comes back with `outputTokens: 0` and a `problem` instead of throwing: the
 * caller is what knows whether that means "shorten", "compress" or "fail", and a function that sometimes
 * throws and sometimes returns makes that decision in two places.
 */
export function forecastRequest(input: ForecastInput): RequestForecast {
  /**
   * One traversal, three answers.
   *
   * `measureRequest` yields the uncorrected total, the corrected one and the breakdown together, because all
   * three are derived from the same three part sizes. This used to call it three times — `estimateInputTokens`
   * twice and `contextBreakdown` once — so a round serialised the whole conversation once per question it asked,
   * which is the shape that gets worse the longer the session is. The numbers below are unchanged; the work is a
   * third of what it was.
   */
  const measured = measureRequest({
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    ...(input.factors ? { factors: input.factors } : { factor: input.factor ?? 1 }),
  });
  const { rawInputTokens, inputTokens, breakdown, bytes } = measured;
  // The window is the only ceiling, so the two questions collapse into one: does the input fit with room to
  // answer? `Infinity` when no window is configured, which is a real answer rather than a permissive default —
  // an unknown window is not one this runtime can check a request against.
  const window = input.maxContextTokens ?? Infinity;
  const wanted = inputTokens + MINIMUM_OUTPUT_TOKENS;
  const room = window - inputTokens;
  const outputTokens = room < MINIMUM_OUTPUT_TOKENS ? 0 : Math.min(input.maxOutputTokens, room);
  const problem: ForecastProblem | undefined = wanted > window ? 'window' : undefined;
  return {
    inputTokens,
    breakdown,
    rawInputTokens,
    bytes,
    outputTokens,
    ...(input.maxContextTokens === undefined ? {} : { windowRoom: room }),
    ...(problem ? { problem } : {}),
  };
}
/**
 * Whether the window is filling up enough that the conversation should be made smaller before it overflows.
 *
 * `percent` is a share of the effective window, so a run that configured `autoCompactTokens` starts working on
 * the context *before* that threshold instead of at it. No window means no pressure: a provider that reports
 * no window is not one this runtime can second-guess.
 */
export function windowPressure(
  forecast: RequestForecast,
  window: number | undefined,
  percent: number,
): boolean {
  if (window === undefined) return false;
  const threshold = Math.floor((window * percent) / 100);
  return (
    forecast.problem !== undefined ||
    forecast.inputTokens + forecast.outputTokens > Math.max(1, threshold)
  );
}
