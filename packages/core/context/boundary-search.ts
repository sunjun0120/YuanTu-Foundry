/**
 * Binary searches over a compaction's candidate cuts.
 *
 * Choosing where a summary batch ends, or where the kept tail begins, used to walk the candidates one by one and
 * re-serialise a growing transcript at each — every forecast is linear in what it measures, so one batch cost on
 * the order of candidates × transcript, all of it synchronous on the Host's event loop. The predicates are
 * monotone (a longer batch never fits where a shorter one did not; a shorter tail never stops fitting where a
 * longer one fitted), so the walk's answer is the boundary of a prefix or a suffix, and a binary search finds the
 * same boundary in a logarithmic number of measurements.
 */

/**
 * The last index in `[0, length)` at which `holds` is true, when it holds on a prefix of the range; `-1` when it
 * holds nowhere.
 *
 * The same answer as walking forward and stopping at the first index where it fails.
 */
export function lastHolding(length: number, holds: (index: number) => boolean): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (holds(middle)) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/**
 * The first index in `[0, length)` at which `holds` is true, when it holds on a suffix of the range; `-1` when it
 * holds nowhere.
 *
 * The same answer as `Array.prototype.findIndex` over that range.
 */
export function firstHolding(length: number, holds: (index: number) => boolean): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (holds(middle)) high = middle;
    else low = middle + 1;
  }
  return low < length ? low : -1;
}
