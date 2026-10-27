/**
 * The trigger editor's state, without the controls.
 *
 * The draft holds exactly the values the fields show, so reopening the editor is the same operation as reading a
 * stored trigger; `buildScheduleTrigger` turns it back into the protocol's shape and `initialRunAt` (the protocol's
 * own) explains when the next run would start. Keeping this out of the component is what lets the cadence rules be
 * checked without a window: which fields a kind uses, how a stored trigger reopens, and what a save actually sends.
 */
import type { TaskEventName, TaskTrigger } from '../../../../packages/protocol/index.ts';

export interface ScheduleDraft {
  kind: 'none' | TaskTrigger['kind'];
  enabled: boolean;
  everyMinutes: number;
  atMinutes: number;
  on: TaskEventName;
  taskId: string;
  timeZone: string;
  weekdays: number[];
  instant: string;
  afterMinutes: number;
  expression: string;
  misfire: 'legacy' | 'skip' | 'latest';
}

/** The value each field falls back to when the stored trigger does not carry it. */
export function initialScheduleDraft(
  current: TaskTrigger | undefined,
  now = new Date(),
): ScheduleDraft {
  return {
    kind: current?.kind ?? 'none',
    enabled: current?.enabled ?? true,
    everyMinutes: current?.kind === 'interval' ? current.everyMinutes : 60,
    atMinutes: current?.kind === 'daily' || current?.kind === 'weekly' ? current.atMinutes : 9 * 60,
    on: current?.kind === 'event' ? current.on : 'task.completed',
    taskId: (current?.kind === 'event' ? current.taskId : undefined) ?? '',
    timeZone:
      current?.kind === 'weekly' || current?.kind === 'daily' || current?.kind === 'cron'
        ? (current.timeZone ?? '')
        : '',
    weekdays: current?.kind === 'weekly' ? [...current.weekdays] : [1],
    instant: current?.kind === 'at' ? current.at : new Date(now.getTime() + 3600000).toISOString(),
    afterMinutes: current?.kind === 'after' ? current.afterMinutes : 60,
    expression: current?.kind === 'cron' ? current.expression : '0 9 * * 1-5',
    misfire: current && 'misfire' in current ? (current.misfire ?? 'legacy') : 'legacy',
  };
}

/**
 * The trigger a draft would save.
 *
 * `current` is only consulted for the one field a draft cannot express: an `after` rule keeps its original anchor
 * when neither the delay nor the enabled flag changed, so reopening the editor and pressing save must not restart
 * the countdown.
 */
export function buildScheduleTrigger(
  draft: ScheduleDraft,
  current: TaskTrigger | undefined,
): TaskTrigger | null {
  const policy = draft.misfire === 'legacy' ? {} : { misfire: draft.misfire };
  if (draft.kind === 'none') return null;
  if (draft.kind === 'interval')
    return {
      kind: 'interval',
      enabled: draft.enabled,
      everyMinutes: draft.everyMinutes,
      ...policy,
    };
  if (draft.kind === 'daily')
    return {
      kind: 'daily',
      enabled: draft.enabled,
      atMinutes: draft.atMinutes,
      ...(draft.timeZone ? { timeZone: draft.timeZone } : {}),
      ...policy,
    };
  if (draft.kind === 'weekly')
    return {
      kind: 'weekly',
      enabled: draft.enabled,
      atMinutes: draft.atMinutes,
      weekdays: draft.weekdays,
      timeZone: draft.timeZone,
      ...policy,
    };
  if (draft.kind === 'cron')
    return {
      kind: 'cron',
      enabled: draft.enabled,
      expression: draft.expression,
      timeZone: draft.timeZone,
      // A stored cron rule always names its policy; `legacy` is only a reading of older interval/calendar rules.
      misfire: draft.misfire === 'skip' ? 'skip' : 'latest',
    };
  if (draft.kind === 'at') return { kind: 'at', enabled: draft.enabled, at: draft.instant };
  if (draft.kind === 'after')
    return {
      kind: 'after',
      enabled: draft.enabled,
      afterMinutes: draft.afterMinutes,
      ...(current?.kind === 'after' &&
      current.afterMinutes === draft.afterMinutes &&
      current.enabled === draft.enabled
        ? { anchorAt: current.anchorAt }
        : {}),
    };
  return {
    kind: 'event',
    enabled: draft.enabled,
    on: draft.on,
    ...(draft.on === 'task.completed' && draft.taskId ? { taskId: draft.taskId } : {}),
  };
}

/** Which controls accept input, keyed by the draft field they edit. */
export interface ScheduleControls {
  enabled: boolean;
  everyMinutes: boolean;
  atMinutes: boolean;
  timeZone: boolean;
  misfire: boolean;
  weekdays: boolean;
  instant: boolean;
  afterMinutes: boolean;
  expression: boolean;
  on: boolean;
  taskId: boolean;
}

/**
 * The disabled set for a cadence.
 *
 * The legacy editor disabled fields rather than hiding them, and that is load-bearing: the form keeps its height, a
 * half-filled field survives a kind switch, and the person can see which fields the new cadence is going to use.
 */
export function scheduleControls(draft: ScheduleDraft): ScheduleControls {
  const kind = draft.kind;
  return {
    enabled: kind !== 'none',
    everyMinutes: kind === 'interval',
    atMinutes: kind === 'daily' || kind === 'weekly',
    timeZone: kind === 'daily' || kind === 'weekly' || kind === 'cron',
    misfire: kind === 'interval' || kind === 'daily' || kind === 'weekly' || kind === 'cron',
    weekdays: kind === 'weekly',
    instant: kind === 'at',
    afterMinutes: kind === 'after',
    expression: kind === 'cron',
    on: kind === 'event',
    taskId: kind === 'event' && draft.on === 'task.completed',
  };
}
