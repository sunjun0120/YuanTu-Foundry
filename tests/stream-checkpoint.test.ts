import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCheckpointStream } from '../packages/core/run-request.ts';

test('the first fragment is saved at once, and nothing new is never saved', () => {
  assert.equal(shouldCheckpointStream(10, 0, 0), true);
  assert.equal(shouldCheckpointStream(10, 10, 60_000), false);
});

test('checkpoints grow geometrically, so a long answer is written a few times over, not squared', () => {
  // A 2 MB answer streamed over five minutes in 20-character deltas.
  const total = 2_000_000;
  const step = 20;
  const dt = 300_000 / (total / step);
  let written = 0;
  let saved = 0;
  let savedAt = 0;
  for (let chars = step, at = dt; chars <= total; chars += step, at += dt)
    if (shouldCheckpointStream(chars, saved, at - savedAt)) {
      written += chars;
      saved = chars;
      savedAt = at;
    }
  assert.ok(written < total * 10, `wrote ${written} bytes for a ${total}-byte answer`);
});

test('the loss window stays bounded by time and by size', () => {
  // Growth below an eighth is held back for a while…
  assert.equal(shouldCheckpointStream(100_000 + 5_000, 100_000, 5_000), false);
  // …but never past 30 seconds, nor past 256 K characters.
  assert.equal(shouldCheckpointStream(100_000 + 5, 100_000, 30_000), true);
  assert.equal(shouldCheckpointStream(1_000_000 + 256_000, 1_000_000, 10), true);
  // Small answers still checkpoint every couple of seconds once 4 KB has accrued.
  assert.equal(shouldCheckpointStream(1_000 + 4_096, 1_000, 2_000), true);
  assert.equal(shouldCheckpointStream(1_000 + 4_000, 1_000, 2_000), false);
});
