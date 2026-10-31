/** What `prepareContext` is handed (shrink and prune seams) and what it hands back. */
import type { Message, SpilledOutput } from '../../protocol/index.ts';
import type { RequestForecast } from './forecast.ts';
import type { PrunePolicy } from './prune.ts';
import type { MeasureText, ShrinkPolicy } from './shrink.ts';

/** Where a shortened result's full text goes, and how much of a result is worth keeping. */
export interface ShrinkSeam {
  policy: ShrinkPolicy;
  spill: (input: { message: Message; content: string }) => SpilledOutput | null;
  /**
   * How the round prices text, turning the token budget into a character cut. The same calibrated
   * estimate as every other budget decision, so cuts and reports agree.
   */
  measure: MeasureText;
}
/**
 * How much of an oversized tool result to drop the middle of. Needs nothing from the caller, so
 * deployments that cannot write files still get a bound.
 */
export interface PruneSeam {
  policy: PrunePolicy;
  /** How many newest tool results stay whole; the same number as the shortening seam. */
  keepRecent: number;
}
export interface PreparedContext {
  system: string;
  messages: Message[];
  /** The prediction the round was decided on, reported as-is. */
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
   * Why this round has no proactive compaction threshold (window too small for output reservation
   * plus headroom).
   */
  policyProblem?: string;
  /**
   * Overflow recoveries allowed under this round's policy. Absent with no window; the caller's
   * default applies.
   */
  maxOverflowRetries?: number;
  /**
   * Why this round is sent without the compression it was decided on. A run sends anyway and lets a
   * provider-confirmed refusal (`recoverFromOverflow`) decide; an explicit `/compact` throws
   * instead (`compactionFailure`).
   */
  compactionProblem?: string;
}
