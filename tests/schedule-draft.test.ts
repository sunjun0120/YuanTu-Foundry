import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskTrigger } from '../packages/protocol/index.ts';
import { normalizeTaskTrigger } from '../packages/protocol/task-trigger.ts';
import {
  buildScheduleTrigger,
  initialScheduleDraft,
  scheduleControls,
  type ScheduleDraft,
} from '../apps/desktop/ui/panels/schedule-draft.ts';

/**
 * The trigger editor's rules, checked without a window.
 *
 * Reopening a stored rule, changing one field and saving is the whole use case, so the tests are round trips: a stored
 * trigger becomes a draft, the draft becomes a trigger, and the protocol's own normalizer has to accept the result.
 * The disabled set is checked the same way: it is the contract that keeps a field from silently contributing to a
 * cadence that does not read it.
 */
const NOW = new Date('2026-10-27T09:30:00.000Z');

function roundTrip(stored: TaskTrigger): TaskTrigger | undefined {
  return normalizeTaskTrigger(buildScheduleTrigger(initialScheduleDraft(stored, NOW), stored), NOW);
}

function build(stored: TaskTrigger, change: Partial<ScheduleDraft> = {}): TaskTrigger {
  const trigger = buildScheduleTrigger({ ...initialScheduleDraft(stored, NOW), ...change }, stored);
  if (!trigger) throw new Error('the draft produced no trigger');
  return trigger;
}

/** The built trigger narrowed to one kind, so its fields are checked rather than cast blindly. */
function builtAs<K extends TaskTrigger['kind']>(
  stored: TaskTrigger,
  kind: K,
  change: Partial<ScheduleDraft> = {},
): Extract<TaskTrigger, { kind: K }> {
  const trigger = build(stored, change);
  if (trigger.kind !== kind) throw new Error(`expected ${kind}, got ${trigger.kind}`);
  return trigger as Extract<TaskTrigger, { kind: K }>;
}

test('a stored trigger reopens in the fields that produced it', () => {
  const stored: TaskTrigger[] = [
    { kind: 'interval', enabled: true, everyMinutes: 15 },
    { kind: 'interval', enabled: false, everyMinutes: 120, misfire: 'skip' },
    { kind: 'daily', enabled: true, atMinutes: 9 * 60 },
    { kind: 'daily', enabled: true, atMinutes: 8 * 60 + 30, timeZone: 'America/New_York' },
    {
      kind: 'weekly',
      enabled: true,
      atMinutes: 9 * 60,
      weekdays: [1, 3, 5],
      timeZone: 'Europe/Berlin',
    },
    {
      kind: 'cron',
      enabled: true,
      expression: '0 9 * * 1-5',
      timeZone: 'America/New_York',
      misfire: 'skip',
    },
    { kind: 'at', enabled: true, at: '2030-01-01T01:00:00.000Z' },
    { kind: 'after', enabled: true, afterMinutes: 120, anchorAt: '2026-10-27T09:00:00.000Z' },
    { kind: 'event', enabled: true, on: 'run.finished' },
    { kind: 'event', enabled: true, on: 'task.completed', taskId: 'task-2' },
  ];
  for (const trigger of stored) assert.deepEqual(roundTrip(trigger), trigger, trigger.kind);
});

test('a first-open draft has the documented defaults', () => {
  const draft = initialScheduleDraft(undefined, NOW);
  assert.equal(draft.kind, 'none');
  assert.equal(draft.enabled, true);
  assert.equal(draft.everyMinutes, 60);
  assert.equal(draft.atMinutes, 9 * 60);
  assert.equal(draft.afterMinutes, 60);
  assert.equal(draft.expression, '0 9 * * 1-5');
  assert.deepEqual(draft.weekdays, [1]);
  assert.equal(draft.taskId, '');
  // The absolute field suggests an hour from now rather than a past instant the protocol would reject.
  assert.equal(draft.instant, '2026-10-27T10:30:00.000Z');
  // "No automatic trigger" clears whatever was stored.
  assert.equal(buildScheduleTrigger(draft, undefined), null);
});

test('a cron rule never saves the legacy policy it cannot store', () => {
  const stored: TaskTrigger = {
    kind: 'cron',
    enabled: true,
    expression: '0 9 * * *',
    timeZone: 'UTC',
  };
  // A stored cron trigger normalizes to `latest`; a draft that still reads `legacy` must save `latest` too.
  const reopened = roundTrip(stored);
  assert.equal(
    reopened && 'misfire' in reopened ? reopened.misfire : undefined,
    'latest',
    'the normalizer did not fill the cron policy',
  );
  assert.equal(builtAs(stored, 'cron', { misfire: 'legacy' }).misfire, 'latest');
});

test('an unchanged delay keeps its anchor, a changed one starts over', () => {
  const stored: TaskTrigger = {
    kind: 'after',
    enabled: true,
    afterMinutes: 120,
    anchorAt: '2026-10-27T09:00:00.000Z',
  };
  assert.equal(builtAs(stored, 'after').anchorAt, stored.anchorAt);
  assert.equal(builtAs(stored, 'after', { afterMinutes: 240 }).anchorAt, undefined);
  assert.equal(builtAs(stored, 'after', { enabled: false }).anchorAt, undefined);
});

test('a source task is only kept for a task-completion event', () => {
  const stored: TaskTrigger = {
    kind: 'event',
    enabled: true,
    on: 'task.completed',
    taskId: 'task-2',
  };
  assert.equal(initialScheduleDraft(stored, NOW).taskId, 'task-2');
  assert.equal(builtAs(stored, 'event', { on: 'run.finished' }).taskId, undefined);
  // "Any task" is the empty filter, not a task id that happens to be blank.
  assert.equal(builtAs(stored, 'event', { taskId: '' }).taskId, undefined);
});

test('each cadence enables exactly the fields it reads', () => {
  const base = initialScheduleDraft(undefined, NOW);
  const usable = (change: Partial<ScheduleDraft>) =>
    Object.entries(scheduleControls({ ...base, ...change }))
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
  assert.deepEqual(usable({ kind: 'interval' }), ['enabled', 'everyMinutes', 'misfire']);
  assert.deepEqual(usable({ kind: 'weekly' }), [
    'enabled',
    'atMinutes',
    'timeZone',
    'misfire',
    'weekdays',
  ]);
  assert.deepEqual(usable({ kind: 'cron' }), ['enabled', 'timeZone', 'misfire', 'expression']);
  assert.deepEqual(usable({ kind: 'event' }), ['enabled', 'on', 'taskId']);
  // No source task is read for the events that do not name one.
  assert.equal(scheduleControls({ ...base, kind: 'event', on: 'run.finished' }).taskId, false);
  // "No automatic trigger" turns the switch off, so every other field is inert.
  assert.deepEqual(usable({ kind: 'none' }), []);
});
