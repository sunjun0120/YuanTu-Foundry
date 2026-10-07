import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCronRun, latestCronRun, parseCron } from '../packages/core/cron.ts';
import { normalizeTaskTrigger, nextRunAt } from '../packages/core/task-trigger.ts';

test('five-field cron validates numeric lists ranges and within-field steps', () => {
  const rule = parseCron('*/15 9-17/2 1,15 * 0,7');
  assert.deepEqual(rule.minute.values, [0, 15, 30, 45]);
  assert.deepEqual(rule.hour.values, [9, 11, 13, 15, 17]);
  assert.deepEqual(rule.weekday.values, [0]);
  for (const bad of [
    '@daily',
    '0 0 * * * *',
    '0 0 L * *',
    '0 0 * * MON',
    '0/5 * * * *',
    '*/0 * * * *',
    '60 * * * *',
    '0 0 32 * *',
    '0 0 * 13 *',
    '0 0 * * 8',
    '*,1 * * * *',
    '10-2 * * * *',
  ])
    assert.throws(() => parseCron(bad));
  assert.throws(
    () =>
      normalizeTaskTrigger({
        kind: 'cron',
        enabled: true,
        expression: '0 0 30 2 *',
        timeZone: 'UTC',
      }),
    /reachable|occurrence/,
  );
  assert.throws(
    () =>
      normalizeTaskTrigger({
        kind: 'cron',
        enabled: true,
        expression: '* * * * *',
        timeZone: 'Mars/Nowhere',
      }),
    /zone/i,
  );
  assert.throws(
    () =>
      normalizeTaskTrigger({
        kind: 'cron',
        enabled: true,
        expression: '* * * * *',
        timeZone: '+08:00',
      }),
    /IANA|zone/i,
  );
});

test('cron month-day and weekday use OR when restricted and retain wildcard semantics', () => {
  assert.equal(
    nextCronRun('0 9 15 * 1', 'UTC', new Date('2026-10-06T00:00Z')).toISOString(),
    '2026-10-12T09:00:00.000Z',
  );
  assert.equal(
    nextCronRun('0 9 * * 1', 'UTC', new Date('2026-10-06T00:00Z')).toISOString(),
    '2026-10-12T09:00:00.000Z',
  );
  assert.equal(
    nextCronRun('0 9 */2 * 1', 'UTC', new Date('2026-10-06T00:00Z')).toISOString(),
    '2026-10-19T09:00:00.000Z',
  );
});

test('cron jumps month ends and the eight-year Gregorian leap gap', () => {
  assert.equal(
    nextCronRun('0 0 31 * *', 'UTC', new Date('2026-04-01T00:00Z')).toISOString(),
    '2026-05-31T00:00:00.000Z',
  );
  assert.equal(
    nextCronRun('0 0 29 2 *', 'UTC', new Date('2096-03-01T00:00Z')).toISOString(),
    '2104-02-29T00:00:00.000Z',
  );
  const trigger = normalizeTaskTrigger({
    kind: 'cron',
    enabled: true,
    expression: '0 9 * * 1-5',
    timeZone: 'Asia/Shanghai',
  })!;
  assert.equal(nextRunAt(trigger, new Date('2026-10-09T02:00Z')), '2026-10-12T01:00:00.000Z');
});

test('cron skips missing DST clocks and admits only the earliest folded minute', () => {
  assert.equal(
    nextCronRun('30 2 * * *', 'America/New_York', new Date('2026-03-08T00:00Z')).toISOString(),
    '2026-03-09T06:30:00.000Z',
  );
  assert.equal(
    nextCronRun('30 1 * * *', 'America/New_York', new Date('2026-11-01T05:30Z')).toISOString(),
    '2026-11-02T06:30:00.000Z',
  );
  assert.equal(
    latestCronRun('30 1 * * *', 'America/New_York', new Date('2026-11-01T06:45Z')).toISOString(),
    '2026-11-01T05:30:00.000Z',
  );
  assert.equal(
    nextCronRun('15 2 * * *', 'Australia/Lord_Howe', new Date('2026-10-03T00:00Z')).toISOString(),
    '2026-10-04T15:15:00.000Z',
  );
});

test('latest cron calculation is bounded independently of decades offline', () => {
  assert.equal(
    latestCronRun('* * * * *', 'UTC', new Date('2046-10-06T12:34:59Z')).toISOString(),
    '2046-10-06T12:34:00.000Z',
  );
});
