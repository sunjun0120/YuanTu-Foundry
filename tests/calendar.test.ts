import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { nextCalendarRun, normalizeTimeZone, wallClockInstant } from '../packages/core/calendar.ts';

test('explicit calendar zones ignore host TZ and weekly calendars advance on local weekdays', () => {
  const after = new Date('2026-10-05T01:00:00Z');
  assert.equal(
    nextCalendarRun(9 * 60, 'Asia/Shanghai', after).toISOString(),
    '2026-10-06T01:00:00.000Z',
  );
  assert.equal(
    nextCalendarRun(9 * 60, 'America/New_York', after, [1]).toISOString(),
    '2026-10-05T13:00:00.000Z',
  );
  assert.throws(() => normalizeTimeZone('Mars/Olympus'), /time zone/i);
});
test('DST gaps skip that day and folds deliver only the earlier wall-clock occurrence', () => {
  assert.equal(
    nextCalendarRun(150, 'America/New_York', new Date('2026-03-08T00:00:00Z')).toISOString(),
    '2026-03-09T06:30:00.000Z',
  );
  assert.equal(
    nextCalendarRun(90, 'America/New_York', new Date('2026-11-01T00:00:00Z')).toISOString(),
    '2026-11-01T05:30:00.000Z',
  );
  assert.equal(
    nextCalendarRun(90, 'America/New_York', new Date('2026-11-01T05:45:00Z')).toISOString(),
    '2026-11-02T06:30:00.000Z',
  );
  assert.equal(
    wallClockInstant({ year: 2026, month: 3, day: 8 }, 150, 'America/New_York'),
    undefined,
  );
});

test('half-hour transitions and a removed calendar day keep the same missing/fold policy', () => {
  assert.equal(
    nextCalendarRun(135, 'Australia/Lord_Howe', new Date('2026-10-03T00:00:00Z')).toISOString(),
    '2026-10-04T15:15:00.000Z',
  );
  assert.equal(
    nextCalendarRun(105, 'Australia/Lord_Howe', new Date('2026-04-04T00:00:00Z')).toISOString(),
    '2026-04-04T14:45:00.000Z',
  );
  assert.equal(
    nextCalendarRun(540, 'Pacific/Apia', new Date('2011-12-29T12:00:00Z'), [5]).toISOString(),
    '2012-01-05T19:00:00.000Z',
  );
});

test('explicit daily zones give identical answers in differently configured Host processes', () => {
  const module = pathToFileURL(path.resolve('packages/core/task-trigger.ts')).href;
  const source = `import {nextRunAt} from ${JSON.stringify(module)};console.log(JSON.stringify({explicit:nextRunAt({kind:'daily',enabled:true,atMinutes:540,timeZone:'Asia/Shanghai'},new Date('2026-10-05T01:00:00Z')),legacy:nextRunAt({kind:'daily',enabled:true,atMinutes:540},new Date('2026-10-05T01:00:00Z'))}));`;
  const run = (zone: string) =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, TZ: zone },
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  const east = run('Asia/Shanghai'),
    west = run('America/Los_Angeles');
  assert.equal(east.explicit, west.explicit);
  assert.notEqual(east.legacy, west.legacy);
});
