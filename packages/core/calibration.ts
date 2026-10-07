/**
 * The pre-request estimate is a character heuristic, not a tokenizer, so it can drift
 * from the provider's real count by a large factor. Every provider response reports the
 * input tokens it actually billed, which is the only trustworthy measurement available.
 * This tracker turns those observations into a correction applied to later requests in
 * the same run, so a long run stops reserving output budget against a wrong estimate.
 *
 * Two properties matter more than accuracy:
 * - The correction only ever affects *future* requests. The estimate that was already
 *   used to admit a request is never revised, so a run cannot retroactively exceed a
 *   budget it was allowed to start.
 * - The correction is clamped. A single unusual response (an endpoint that reports
 *   partial usage, or a prompt dominated by content the heuristic handles badly) must
 *   not collapse or explode the estimate used to decide whether to compact.
 *
 * It also outlives the run that measured it. The correction is a fact about the *route*
 * — how far this model's tokenizer is from the heuristic — and a session resumed in a new
 * process used to start from 1 again, throwing away everything the earlier run had
 * learned and mis-sizing its first request the same way all over again. The run records
 * the state it arrived at (`context.calibration`) and the next run on the same route
 * starts from it; `TokenCalibration.from` is that read.
 *
 * **One number was the wrong shape.** A request is measured as three parts — the system
 * prompt, the tool catalogue, the conversation — and the heuristic is wrong about them by
 * *different* amounts: a tool catalogue is dense JSON punctuation and short keys, a system
 * prompt is prose, a conversation is whatever the tools returned. A single ratio therefore
 * had to be the average of errors pointing in opposite directions, and the average moved
 * with nothing but the *mix*: the same session corrected differently as a compaction shifted
 * bytes from the conversation into a summary. The correction is now one weight per part, each
 * signed and each moving on its own evidence, and a request is sized by the blend of the three
 * that its own bytes call for (`factorFor`). The observation carries the part sizes it was made
 * about, which is what makes that possible — the single total could never say which part was
 * misestimated.
 *
 * The blend keeps the arithmetic of one number: a request whose parts all carry the same weight
 * is measured exactly as it was before, which is why a fresh calibration and a record written by
 * an older build behave identically.
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
  /**
   * The correction as a whole, for a reader that only wants one number and for records written before the
   * parts were separated. It is the messages weight, which is the part every request has.
   */
  factor: number;
  samples: number;
  /** Absent in a record this build did not write; then all three weights are `factor`. */
  parts?: PartFactors;
}

/**
 * What "the same route" means for one of these measurements.
 *
 * A correction measures how far *one model's* tokenizer is from this heuristic, so it may only be carried to a
 * request that goes to the same place. The protocol is part of the name because the two protocols account for the
 * fixed overhead differently, so the same endpoint behind two adapters is two measurements — the model name is what
 * the estimate is actually about, and the connection is included when the host names one, because two endpoints
 * serving the same model name are two tokenizers and two overhead accounts.
 *
 * `undefined` when the embedder declared no model: a run that does not know which model answers it cannot claim an
 * earlier measurement was about the same one, and recording under a guessed name would carry a correction across
 * models, which is exactly the mistake this key exists to prevent.
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
   * A correction learned earlier for the same route.
   *
   * Restoring is not the same as the first observation of a run: the whole point of carrying the state is that the
   * new process does not start over, so the "first sample is adopted whole" rule must not fire again — a restored
   * calibration smooths its next sample like any other. The weights are clamped on the way in because the log is a
   * file a person can edit, and an out-of-range weight would be a budget decision nobody made.
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
   * The correction a run starts from, given what the log holds for its route.
   *
   * A record for another route — or one this build cannot read — is ignored rather than adapted: a correction is
   * only meaningful about the model it was measured on, and starting from 1 is the honest answer when the route is
   * not the one that was measured.
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
   * @param rawEstimate the uncorrected estimate for the request that was just answered
   * @param actualInputTokens provider-reported input usage, including cached tokens
   * @param parts the sizes that estimate was made of, when the caller has them
   *
   * Without `parts` the observation is about the request *as a whole*, which is all the caller knows — the
   * weights then move together, exactly as the single ratio used to. With them, each weight moves by its own
   * part's share of the residual, which is what lets a route whose catalogue is overestimated and whose
   * conversation is underestimated end up with two weights pointing in opposite directions instead of one
   * average that is wrong for both.
   */
  observe(rawEstimate: number, actualInputTokens: number, parts?: PartBytes): void {
    if (!Number.isFinite(rawEstimate) || rawEstimate <= 0) return;
    if (!Number.isSafeInteger(actualInputTokens) || actualInputTokens <= 0) return;
    const sample = actualInputTokens / rawEstimate;
    if (this.samples === 0) {
      // The first observation is adopted whole, as it always was: a run that has measured nothing should correct
      // immediately rather than creep towards the truth over four rounds.
      const weight = clamp(sample);
      this.weights = { system: weight, tools: weight, messages: weight };
      this.samples = 1;
      return;
    }
    if (!parts) {
      /**
       * A request-wide observation. The residual is relative to the correction the mix in hand would get, and
       * a caller that cannot name the parts gets the only honest reading of that: every part moves by the same
       * relative amount, so the shape the run has learned is kept and its overall size is corrected.
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
     * The residual, attributed by share and normalised so the *blend* moves like the single ratio did.
     *
     * `Σ share²` is the normaliser, and it is what makes this the same correction as before in the case nobody
     * can tell the parts apart: for equal shares it is 1/3, so each weight moves by the whole step and the
     * request's correction moves by `WEIGHT` of the residual — exactly the old rule. Without it a constant mix
     * would under-correct (each part moving by its share of a step, and the blend by less than one) while the
     * weights drifted apart on evidence that never distinguished them. With it, a mix in which one part dominates
     * gives that part the whole step, which is the only reading a dominant part supports.
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

  /**
   * The correction a request made of these parts is sized with.
   *
   * A blend rather than three separate multiplications, and deliberately: the estimate's arithmetic is one total
   * over three part sizes, so a per-part correction enters it as the weighted average of the weights. The weights
   * are in the units of the parts they correct, so a part that carries four fifths of the bytes carries four
   * fifths of the correction — which is exactly the statement a single ratio could not make.
   */
  factorFor(parts: PartBytes): number {
    return blendFactors(this.weights, parts);
  }

  /** Applies the learned correction to a raw estimate. */
  adjust(rawEstimate: number): number {
    return Math.ceil(rawEstimate * this.weights.messages);
  }

  /**
   * The correction when nothing more specific is known: the weight on the conversation.
   *
   * Every caller that asks for one number is measuring *messages* — the retention budget sums per-message costs,
   * the shrink policy prices a tool result, `adjust` scales an estimate the caller already made — so this is the
   * weight that answers them rather than an average that would be about a mix none of them has.
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
