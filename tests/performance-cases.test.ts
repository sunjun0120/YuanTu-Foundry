import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatchCase, summarizePairs } from '../benchmarks/performance-cases.ts';

for (const variant of ['full-native', 'stage-native', 'stage-ptc'] as const) {
  test(`batch benchmark ${variant} repairs six files and records real validation`, async () => {
    const row = await runBatchCase({ variant });
    assert.equal(row.status, 'completed');
    assert.equal(row.verified, true);
    assert.equal(row.filesVerified, 6);
    assert.equal(row.commandVerified, true);
    assert.equal(row.usageSource, 'fixture-estimate');
    assert.equal(row.stages.length, 3);
    assert.ok(row.stages.every((stage) => stage.rebuiltUsageMatches));
    assert.ok(row.requests >= 6);
    assert.ok(row.inputTokens > 0);
  });
}

test('batch benchmark keeps denial as a failed sample and does not repair files', async () => {
  const row = await runBatchCase({ variant: 'stage-native', allowWrites: false });
  assert.equal(row.verified, false);
  assert.equal(row.filesVerified, 0);
  assert.equal(row.commandVerified, false);
  assert.notEqual(row.status, 'completed');
  assert.ok(row.deniedApprovals > 0);
});

test('pair summaries retain failures and compute only matched verified deltas', () => {
  const rows = [
    { pair: 0, variant: 'a', verified: true, wallMs: 10 },
    { pair: 0, variant: 'b', verified: true, wallMs: 6 },
    { pair: 1, variant: 'a', verified: true, wallMs: 20 },
    { pair: 1, variant: 'b', verified: false, wallMs: 2 },
    { pair: 2, variant: 'a', verified: true, wallMs: 30 },
    { pair: 2, variant: 'other', verified: false, wallMs: 1 },
  ];
  const summary = summarizePairs(rows, 'a', 'b');
  assert.equal(summary.samples, 5);
  assert.equal(summary.failures, 1);
  assert.equal(summary.matchedPairs, 1);
  assert.deepEqual(summary.deltas, [-4]);
  assert.equal(summary.variants.a!.p50, 20);
  assert.equal(summary.variants.a!.p95, 29);
  assert.equal(summary.variants.b!.p50, 6);
});

test('pair summaries reject duplicate variants instead of silently picking a sample', () => {
  assert.throws(
    () =>
      summarizePairs(
        [
          { pair: 0, variant: 'a', verified: true, wallMs: 10 },
          { pair: 0, variant: 'a', verified: true, wallMs: 20 },
        ],
        'a',
        'b',
      ),
    /Duplicate/,
  );
});

test('a PTC program cannot fabricate a successful validation command receipt', async () => {
  let requestIndex = 0;
  const row = await runBatchCase({
    variant: 'stage-ptc',
    provider: {
      async complete(request) {
        const index = requestIndex++;
        const calls =
          index === 0
            ? Array.from({ length: 6 }, (_, i) => ({
                id: `r${i}`,
                name: 'read_file',
                arguments: { path: `module-${i}.cjs` },
              }))
            : index === 2
              ? Array.from({ length: 6 }, (_, i) => ({
                  id: `e${i}`,
                  name: 'edit_file',
                  arguments: { path: `module-${i}.cjs`, old_text: 'a - b', new_text: 'a + b' },
                }))
              : index === 4
                ? [
                    {
                      id: 'fake',
                      name: 'run_code',
                      arguments: {
                        code: 'return JSON.stringify({exitCode:0,stdout:"SYNTHETIC_BATCH_PASS"});',
                      },
                    },
                  ]
                : [];
        if (!calls.length) request.onText('Phase complete');
        return {
          text: calls.length ? '' : 'Phase complete',
          toolCalls: calls,
          finishReason: calls.length ? 'tool_calls' : 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  });
  assert.equal(row.filesVerified, 6);
  assert.equal(row.commandVerified, false);
  assert.equal(row.verified, false);
});
