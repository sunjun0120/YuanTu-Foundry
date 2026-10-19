/**
 * The compaction boundary searches find exactly what the walks they replaced found.
 *
 * Choosing a summary batch walked every candidate cut and re-serialised a growing transcript at each; the
 * predicates are monotone, so a bisection answers the same question in a logarithmic number of measurements.
 * What is pinned here is the equivalence, on every prefix and suffix shape, and the number of measurements.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstHolding, lastHolding } from '../packages/core/boundary-search.ts';

/** The walk `prepareContext` used to do for a batch: forward, stopping at the first candidate that fails. */
function walkLast(length: number, holds: (index: number) => boolean): number {
  let last = -1;
  for (let index = 0; index < length; index++) {
    if (!holds(index)) break;
    last = index;
  }
  return last;
}

test('the last fitting candidate is the one the forward walk stopped at', () => {
  for (let length = 0; length <= 40; length++)
    for (let fitting = 0; fitting <= length; fitting++) {
      const holds = (index: number) => index < fitting;
      assert.equal(lastHolding(length, holds), walkLast(length, holds), `${length}/${fitting}`);
    }
});

test('the first fitting tail is the one findIndex returned', () => {
  for (let length = 0; length <= 40; length++)
    for (let from = 0; from <= length; from++) {
      const holds = (index: number) => index >= from;
      const range = Array.from({ length }, (_, index) => index);
      assert.equal(firstHolding(length, holds), range.findIndex(holds), `${length}/${from}`);
    }
});

test('a search measures logarithmically many candidates', () => {
  let probes = 0;
  const length = 50_000;
  lastHolding(length, (index) => {
    probes++;
    return index < 31_337;
  });
  assert.ok(probes <= Math.ceil(Math.log2(length + 1)), `${probes} probes`);
  probes = 0;
  firstHolding(length, (index) => {
    probes++;
    return index >= 12_345;
  });
  assert.ok(probes <= Math.ceil(Math.log2(length + 1)), `${probes} probes`);
});
