/** What `prepareContext` is handed (shrink and prune seams) and what it hands back. */
import type { Message, SpilledOutput } from '../protocol/index.ts';
import type { RequestForecast } from './forecast.ts';
import type { PrunePolicy } from './prune.ts';
import type { MeasureText, ShrinkPolicy } from './shrink.ts';

/** Where a shortened result's full text goes, and how much of a result is worth keeping. */
export interface ShrinkSeam {
  policy: ShrinkPolicy;
  spill: (input: { message: Message; content: string }) => SpilledOutput | null;
  /**
   * How the round prices text, so the policy's token budget can become a character cut.
   *
   * It is the caller's own calibrated estimate rather than a tokenizer, for the same reason every other budget
   * decision uses it: the numbers that decide what gets cut and the numbers reported to the operator have to be
   * the same numbers, or "this result was shortened to fit" and "the request is 4,000 tokens over" can both be
   * true of the same request.
   */
  measure: MeasureText;
}
/**
 * How much of an oversized tool result this round is willing to drop the middle of.
 *
 * Separate from {@link ShrinkSeam} because it needs nothing from the caller: no spill target, no calibrated
 * measure, no workspace. That is the whole difference — shortening trades a pointer to a file for the text,
 * and this trades the text for a marker — so a deployment that cannot write files still gets a bound.
 */
export interface PruneSeam {
  policy: PrunePolicy;
  /**
   * How many of the newest tool results stay whole.
   *
   * The same number the shortening seam uses, passed rather than restated: two settings for one question would
   * be two answers to "which results is the model still reading".
   */
  keepRecent: number;
}
export interface PreparedContext {
  system: string;
  messages: Message[];
  /**
   * The prediction the whole round was decided on: the same object that chose what to shorten, whether to
   * compress, and — in the run loop — how much output this request may ask for. Reported so the operator sees
   * the numbers the decision was actually made from, rather than a recomputation that may differ.
   */
  forecast: RequestForecast;
  /** Tool results shortened by this call's view passes, including a view later superseded by compaction. */
  shortened: number;
  /** Characters removed by those passes; not additive with the durable compaction's surface savings. */
  freedChars: number;
  /** Tool results this round drops the middle of, keeping their head and their tail. */
  pruned: number;
  /** Characters removed by pruning passes; not additive with durable compaction savings. */
  prunedChars: number;
  /** True when this call compressed the conversation. */
  compacted: boolean;
  /**
   * Why this round has no proactive compaction threshold, when it has none.
   *
   * A window that cannot carry the request's output reservation plus the headroom is a configuration mistake,
   * not a condition: the round still runs (the endpoint may well answer it), but nothing compresses it before
   * the window forces the issue, and an operator reading the stream has to be told that rather than left to
   * wonder why a small window never compressed.
   */
  policyProblem?: string;
  /**
   * How many times a provider-confirmed overflow may compress and re-send, under this round's policy.
   *
   * Reported so the loop that answers the provider's refusal uses the number the policy resolved rather than a
   * copy of it. Absent means the round resolved no policy (no window), and the caller's own default applies.
   */
  maxOverflowRetries?: number;
  /**
   * Why this round is being sent without the compression it was decided on, when that is the case.
   *
   * A compaction that cannot be performed is not a reason to abandon the request. The estimate that says "this
   * does not fit" is a character heuristic, and only the endpoint can confirm it — which is exactly what
   * `recoverFromOverflow` exists for, and what it could never reach while these verdicts were thrown. So a run
   * sends the round and reports why it is uncompressed, and a *provider-confirmed* refusal is the verdict the
   * user finally sees. A caller that asked for a compression on purpose (a person's `/compact`) still gets a
   * thrown failure, which is what `compactionFailure` selects.
   */
  compactionProblem?: string;
}
