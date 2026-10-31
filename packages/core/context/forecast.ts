import type { Message, ToolSpec } from '../../protocol/index.ts';
import { measureRequest, type RequestBytes } from './budget.ts';
import type { ContextBreakdown } from './budget.ts';
import type { PartFactors } from './calibration.ts';

/**
 * What one request is expected to cost and whether it fits, computed together once before the
 * request so decisions (shorten, compact, send) and reports agree. There is no cumulative token
 * allowance; the window bounds a request.
 */
/**
 * Which ceiling an unsendable request violates. `problem` present means the request must be made
 * smaller.
 */
export type ForecastProblem = 'window';
export interface RequestForecast {
  /** Tokens the provider is expected to bill for this request's input, with the learned correction applied. */
  inputTokens: number;
  /**
   * Where the input goes (system prompt, tool schemas, messages, margin), carried so the displayed
   * split is the one the request was decided on (see `contextBreakdown`).
   */
  breakdown: ContextBreakdown;
  /** The same estimate before correction, which is the figure calibration has to observe. */
  rawInputTokens: number;
  /**
   * The serialised size of each part, so an observation can attribute misestimation per part. Not
   * reported live.
   */
  bytes: RequestBytes;
  /** Tokens this request may still ask the model to produce. */
  outputTokens: number;
  /**
   * What the window leaves for this request's answer, before the output cap. Absent with no window.
   */
  windowRoom?: number;
  /**
   * Why this request cannot be sent: it does not fit the window with room to answer. Remedied by
   * shortening or compressing.
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
  /** Per-part learned correction; preferred over `factor`, never combined. */
  factors?: PartFactors;
}
/** A request must fit at least one output token, or its only reply is a length truncation. */
const MINIMUM_OUTPUT_TOKENS = 1;
/** The model's window cannot take this request, with room left for it to answer. */
export const WINDOW_EXHAUSTED =
  'Current user request exceeds context budget; history was preserved';
/**
 * How far past a window an estimate must be before a run refuses without asking the endpoint. The
 * calibration is clamped to 0.5-3, so marginal overruns are sent and recovered via
 * `recoverFromOverflow` if refused.
 */
export const LOCAL_REFUSAL_RATIO = 2;
/** Whether the estimate is hopelessly past the window. `false` when no window is declared. */
export function hopelessForWindow(
  forecast: Pick<RequestForecast, 'inputTokens'>,
  window: number | undefined,
): boolean {
  if (window === undefined || window <= 0) return false;
  return forecast.inputTokens > window * LOCAL_REFUSAL_RATIO;
}
/**
 * Predict the next request once. An unsendable request returns `outputTokens: 0` and a `problem`
 * rather than throwing, so the caller decides what to do.
 */
export function forecastRequest(input: ForecastInput): RequestForecast {
  /** One traversal yields the uncorrected total, the corrected one and the breakdown. */
  const measured = measureRequest({
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    ...(input.factors ? { factors: input.factors } : { factor: input.factor ?? 1 }),
  });
  const { rawInputTokens, inputTokens, breakdown, bytes } = measured;
  // The window is the only ceiling. `Infinity` when none is configured: an unknown window cannot be
  // checked.
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
 * Whether the window is filling enough to shrink the conversation early. `percent` is a share of
 * the effective window; no window means no pressure.
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
