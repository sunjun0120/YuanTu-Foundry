import test from 'node:test';
import assert from 'node:assert/strict';
import { runDelegationCase } from '../benchmarks/performance-delegation.ts';

for (const variant of ['blocking', 'overlap'] as const) {
  test(`delegation benchmark ${variant} collects the child and releases both sessions`, async () => {
    const row = await runDelegationCase({ variant });
    assert.equal(row.verified, true);
    assert.equal(row.sessionsReleased, true);
    assert.equal(row.childStatus, 'completed');
    assert.equal(row.parentReadVerified, true);
    assert.equal(row.childReportVerified, true);
    if (variant === 'blocking') assert.equal(row.collectCalls, 0);
    else assert.ok(row.collectCalls >= 1 && row.collectCalls <= 2);
    assert.equal(row.intervals.length, 2);
    if (variant === 'overlap') assert.ok(row.overlapMs > 0);
    else assert.equal(row.overlapMs, 0);
  });
}

test('overlap benchmark cancels active work and retains the cancellation sample', async () => {
  const controller = new AbortController();
  const row = await runDelegationCase({ variant: 'overlap', cancelOnRead: controller });
  assert.equal(row.status, 'cancelled');
  assert.equal(row.verified, false);
  assert.equal(row.sessionsReleased, true);
  assert.equal(row.childStatus, 'cancelled');
});

test('an already collected child does not trigger another bounded collection round', async () => {
  const row = await runDelegationCase({ variant: 'overlap', childDelayMs: 5, parentDelayMs: 120 });
  assert.equal(row.verified, true);
  assert.equal(row.collectCalls, 1);
});

test('a child provider failure cannot count as a completed delegation sample', async () => {
  const row = await runDelegationCase({ variant: 'overlap', childFailure: true });
  assert.equal(row.verified, false);
  assert.equal(row.childStatus, 'failed');
  assert.equal(row.sessionsReleased, true);
});
