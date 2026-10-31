/**
 * Corrects the character-heuristic estimate with the input tokens providers actually bill.
 *
 * - The correction only affects future requests; an admitted estimate is never revised.
 * - It is clamped, so one odd response cannot collapse or explode the estimate.
 * - It outlives the run: the state is recorded per route (`context.calibration`) and the next run
 *   on that route starts from it (`TokenCalibration.from`).
 * - It is one weight per request part (system prompt, tool catalogue, conversation), since the
 *   heuristic errs differently on each; a request is sized by the blend its bytes call for
 *   (`factorFor`). Equal weights reduce to the single-ratio arithmetic.
 */
import { blendFactors, type RequestBytes } from './budget.ts';
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 3;
/** Weight of each new sample. The first sample is adopted whole so a run corrects fast. */
const WEIGHT = 0.4;

function clamp(value: number): number {
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value));
}

/** The three parts a request is measured in. */
export interface PartFactors {
  system: number;
  tools: number;
  messages: number;
}
export type PartName = keyof PartFactors;
/** What each part costs in the estimator's own units — the bytes each part is made of. */
export type PartBytes = RequestBytes;

/** A correction as it is recorded and restored: the per-part weights, and how many observations they rest on. */
export interface CalibrationState {
  /** The correction as one number (the messages weight), for simple readers and older records. */
  factor: number;
  samples: number;
  /** Absent in a record this build did not write; then all three weights are `factor`. */
  parts?: PartFactors;
}

/**
 * What "the same route" means for a measurement: protocol, model and, when named, connection.
 * `undefined` when no model is declared, so a correction is never carried across models.
 */
export function calibrationRoute(
  modelInfo: { protocol?: string; model?: string; connectionId?: string } | undefined,
): string | undefined {
  if (!modelInfo?.model) return undefined;
  const route = `${modelInfo.protocol ?? ''}:${modelInfo.model}`;
  return modelInfo.connectionId ? `${route}@${modelInfo.connectionId}` : route;
}

/** Whether a recorded payload names three usable weights. Anything else falls back to the single factor. */
function partFactors(value: unknown): PartFactors | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parts = value as Record<string, unknown>;
  const read = (name: PartName): number | undefined => {
    const weight = Number(parts[name]);
    return Number.isFinite(weight) && weight > 0 ? clamp(weight) : undefined;
  };
  const system = read('system');
  const tools = read('tools');
  const messages = read('messages');
  return system === undefined || tools === undefined || messages === undefined
    ? undefined
    : { system, tools, messages };
}

export class TokenCalibration {
  private weights: PartFactors = { system: 1, tools: 1, messages: 1 };
  private samples = 0;

  /**
   * A correction learned earlier for the same route. Restored state smooths its next sample (the
   * "first sample adopted whole" rule does not fire again). Weights are clamped because the log is
   * editable.
   */
  static restored(state: CalibrationState): TokenCalibration {
    const calibration = new TokenCalibration();
    const parts = partFactors(state.parts);
    const factor = clamp(Number(state.factor));
    calibration.weights = parts ?? { system: factor, tools: factor, messages: factor };
    calibration.samples =
      Number.isSafeInteger(state.samples) && state.samples > 0 ? state.samples : 0;
    return calibration;
  }

  /**
   * The correction a run starts from, given the log's record for its route. Records for other
   * routes, or unreadable ones, are ignored.
   */
  static from(
    payload: Record<string, unknown> | undefined,
    route: string | undefined,
  ): TokenCalibration {
    if (!route || payload?.route !== route) return new TokenCalibration();
    const factor = Number(payload.factor);
    const samples = Number(payload.samples);
    if (!Number.isFinite(factor) || factor <= 0 || !Number.isSafeInteger(samples) || samples < 0)
      return new TokenCalibration();
    return TokenCalibration.restored({ factor, samples, parts: payload.parts as PartFactors });
  }

  /**
   * @param rawEstimate the uncorrected estimate for the request that was just answered @param
   * actualInputTokens provider-reported input usage, including cached tokens @param parts the sizes
   * that estimate was made of, when the caller has them
   *
   * Without `parts` all weights move together; with them, each moves by its part's share of the
   * residual.
   */
  observe(rawEstimate: number, actualInputTokens: number, parts?: PartBytes): void {
    if (!Number.isFinite(rawEstimate) || rawEstimate <= 0) return;
    if (!Number.isSafeInteger(actualInputTokens) || actualInputTokens <= 0) return;
    const sample = actualInputTokens / rawEstimate;
    if (this.samples === 0) {
      // The first observation is adopted whole so a fresh run corrects immediately.
      const weight = clamp(sample);
      this.weights = { system: weight, tools: weight, messages: weight };
      this.samples = 1;
      return;
    }
    if (!parts) {
      /**
       * Request-wide observation: every part moves by the same relative amount, keeping the learned
       * shape.
       */
      const current = this.factorFor(parts ?? this.weights);
      const move = 1 + WEIGHT * (sample / current - 1);
      this.weights = {
        system: clamp(this.weights.system * move),
        tools: clamp(this.weights.tools * move),
        messages: clamp(this.weights.messages * move),
      };
      this.samples += 1;
      return;
    }
    const total = parts.system + parts.tools + parts.messages;
    const current = this.factorFor(parts);
    /**
     * Attribute the residual by share, normalised by `sum(share^2)` so the blend moves like the
     * single ratio did (equal shares reproduce the old rule exactly) and a dominant part takes the
     * whole step.
     */
    const shares = [
      total > 0 ? parts.system / total : 1 / 3,
      total > 0 ? parts.tools / total : 1 / 3,
      total > 0 ? parts.messages / total : 1 / 3,
    ] as const;
    const sumSquares = shares[0] ** 2 + shares[1] ** 2 + shares[2] ** 2;
    const step = (share: number): number =>
      (WEIGHT * current * (sample / current - 1) * share) / (sumSquares || 1);
    this.weights = {
      system: clamp(this.weights.system + step(shares[0])),
      tools: clamp(this.weights.tools + step(shares[1])),
      messages: clamp(this.weights.messages + step(shares[2])),
    };
    this.samples += 1;
  }

  /** The correction for a request of these parts: the byte-weighted average of the weights. */
  factorFor(parts: PartBytes): number {
    return blendFactors(this.weights, parts);
  }

  /** Applies the learned correction to a raw estimate. */
  adjust(rawEstimate: number): number {
    return Math.ceil(rawEstimate * this.weights.messages);
  }

  /**
   * The correction when nothing more specific is known: the conversation weight, since
   * single-number callers all measure messages.
   */
  get factor(): number {
    return this.weights.messages;
  }

  /** All three, for a caller that is sizing a whole request and has its parts. */
  get parts(): PartFactors {
    return { ...this.weights };
  }

  get observed(): number {
    return this.samples;
  }

  /** What to record, so the next run in this session starts from this measurement rather than from 1. */
  get state(): CalibrationState {
    return { factor: this.weights.messages, samples: this.samples, parts: { ...this.weights } };
  }
}
