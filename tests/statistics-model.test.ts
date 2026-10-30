import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, translate } from '../apps/desktop/i18n.ts';
import type { SessionSnapshot, StatisticsDelta } from '../packages/client/session-controller.ts';
import type { SessionStatistics } from '../packages/protocol/statistics.ts';
import {
  applyStatisticsDelta,
  billedInputTokens,
  cacheHitPercent,
  countsReading,
  durationReading,
  statisticsView,
  throughputReading,
  uncachedInputTokens,
  usagePillReading,
} from '../apps/desktop/ui/panels/statistics-model.ts';

/**
 * The figures the two pills under the composer print: which of them are measurements at all, and what a row says
 * when its session has no figure for it (nothing — the row is absent, not a zero).
 */
setLocale('zh-CN');

function stats(overrides: Partial<SessionStatistics> = {}): SessionStatistics {
  return {
    turns: 0,
    steps: 0,
    modelMs: 0,
    toolMs: 0,
    firstTokenMs: 0,
    firstTokenCount: 0,
    decodeMs: 0,
    decodeTokens: 0,
    decodeKnown: false,
    cacheKnown: false,
    timingKnown: false,
    usageComplete: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

test('the throughput row exists only when a decode was measured', () => {
  assert.equal(throughputReading(stats()), null);
  assert.equal(
    throughputReading(stats({ decodeMs: 2000, decodeTokens: 200 })),
    null,
    'unknown timing',
  );
  assert.equal(
    throughputReading(stats({ decodeMs: 2000, decodeTokens: 200, decodeKnown: true })),
    '100 tok/s',
  );
  assert.equal(
    throughputReading(stats({ decodeMs: 500, decodeTokens: 200, decodeKnown: true })),
    null,
    'under a second is arithmetic',
  );
  assert.equal(
    throughputReading(stats({ decodeMs: 2000, decodeTokens: 40, decodeKnown: true })),
    null,
    'under fifty tokens is arithmetic',
  );
  assert.equal(
    throughputReading(stats({ decodeMs: 6000, decodeTokens: 50, decodeKnown: true })),
    '8.3 tok/s',
    'below ten keeps a decimal',
  );
});

test('a partial cache hit never displays as a full one', () => {
  assert.equal(cacheHitPercent(stats()), null);
  assert.equal(cacheHitPercent(stats({ inputTokens: 100, cachedInputTokens: 100 })), '100');
  assert.equal(
    cacheHitPercent(stats({ inputTokens: 100, cachedInputTokens: 120 })),
    '100',
    'a bucket larger than the total is not 101%',
  );
  assert.equal(cacheHitPercent(stats({ inputTokens: 100, cachedInputTokens: 99 })), '99');
  const nearly = cacheHitPercent(stats({ inputTokens: 1000, cachedInputTokens: 999 }));
  assert.notEqual(nearly, '100');
  assert.ok(nearly?.startsWith('99.'), nearly ?? '');
});

test('uncached input subtracts both cache buckets and never goes negative', () => {
  assert.equal(
    uncachedInputTokens(
      stats({ inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 20 }),
    ),
    50,
  );
  assert.equal(
    uncachedInputTokens(
      stats({ inputTokens: 10, cachedInputTokens: 30, cacheWriteInputTokens: 20 }),
    ),
    0,
  );
  assert.equal(billedInputTokens(stats({ inputTokens: 42 })), 42);
});

test('durations are written the way the panels render them', () => {
  assert.equal(durationReading(4200, 'zh-CN'), '4.2秒');
  assert.equal(durationReading(4200, 'en-US'), '4.2s');
  assert.equal(durationReading(61_500, 'zh-CN'), '1分2秒');
  assert.equal(durationReading(61_500, 'en-US'), '1m2s');
});

test('the counts line carries turns, steps and the throughput reading', () => {
  const counts = stats({ turns: 3, steps: 7 });
  assert.equal(
    countsReading(counts, 'zh-CN', null),
    translate('statistics.counts', 'zh-CN', { turns: 3, steps: 7 }),
  );
  assert.equal(
    countsReading(counts, 'en-US', '42 tok/s'),
    'This session: 3 turns 7 steps · 42 tok/s',
  );
});

test('the usage pill leads with the run share and warns about a long context', () => {
  const short = usagePillReading(
    { total: 1000, cacheHit: '80', runTotal: 200, contextTokens: 1000 },
    'zh-CN',
  );
  assert.match(short, /^本次 200 · 本会话累计 1K tok（含缓存读取） · 缓存命中 80%$/);
  const same = usagePillReading(
    { total: 1000, cacheHit: null, runTotal: 1000, contextTokens: 1000 },
    'zh-CN',
  );
  assert.doesNotMatch(same, /本次/, 'a run equal to the session adds nothing');
  const long = usagePillReading(
    { total: 1000, cacheHit: null, runTotal: 0, contextTokens: 400_000 },
    'zh-CN',
  );
  assert.match(long, /上下文已较长/);
});

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 's1',
    statistics: stats(),
    messages: [],
    ...overrides,
  } as unknown as SessionSnapshot;
}

test('an empty session has no readings; a timed session has only the rows it measured', () => {
  const empty = statisticsView(snapshot(), 'zh-CN');
  assert.equal(empty.hidden, true);
  assert.equal(empty.session, null);
  assert.equal(empty.tokens, null);

  const view = statisticsView(
    snapshot({
      statistics: stats({
        turns: 2,
        steps: 2,
        modelMs: 4200,
        toolMs: 0,
        firstTokenMs: 500,
        firstTokenCount: 2,
        decodeMs: 2000,
        decodeTokens: 200,
        decodeKnown: true,
        inputTokens: 1000,
        cachedInputTokens: 800,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
      }),
    }),
    'zh-CN',
  );
  assert.equal(view.hidden, false);
  assert.equal(view.session?.titleKey, 'statistics.sessionTitle');
  assert.deepEqual(
    view.session?.rows.map((row) => row.key),
    ['statistics.modelTime', 'statistics.ttft', 'statistics.tps'],
    'a zero tool time is absent, not a zero row',
  );
  assert.equal(view.session?.rows[1]?.value, '0.3秒');
  assert.deepEqual(
    view.tokens?.rows.map((row) => row.key),
    [
      'statistics.cacheHit',
      'statistics.uncachedInput',
      'statistics.cachedInput',
      'statistics.output',
    ],
    'a zero cache write is absent',
  );
  assert.equal(view.tokens?.total, '1,100');
});

test('steps without a timed figure keep the counts but not an empty dialog', () => {
  const view = statisticsView(snapshot({ statistics: stats({ turns: 1, steps: 1 }) }), 'zh-CN');
  assert.equal(view.session, null);
  assert.equal(view.sessionVisible, true, 'the counts stay as a plain reading');
  assert.equal(view.sessionOpenable, false, 'but there is no dialog to open');
  assert.equal(view.counts, translate('statistics.counts', 'zh-CN', { turns: 1, steps: 1 }));
});

test('a statistics delta patches only the session it names', () => {
  const current = snapshot({ statistics: stats({ turns: 1, steps: 1 }) });
  const delta = {
    sessionId: 's2',
    statistics: stats({ turns: 9, steps: 9 }),
    activity: 'idle',
  } as unknown as StatisticsDelta;
  assert.equal(applyStatisticsDelta(current, delta), null);

  const matching = {
    ...delta,
    sessionId: 's1',
    statistics: stats({ turns: 2, steps: 4, inputTokens: 10, outputTokens: 5 }),
    activity: 'thinking',
  } as unknown as StatisticsDelta;
  const next = applyStatisticsDelta(current, matching);
  assert.equal(next?.sessionId, 's1');
  assert.equal(next?.statistics?.turns, 2);
  assert.equal(next?.statisticsActivity, 'thinking');
  assert.equal(next?.messages, current.messages, 'the rest of the snapshot is kept');

  const withoutRun = applyStatisticsDelta(
    { ...current, runStatistics: stats({ turns: 1, steps: 1 }) },
    matching,
  );
  assert.equal(
    withoutRun?.runStatistics?.turns,
    1,
    'an absent run figure does not erase the one already known',
  );
});
