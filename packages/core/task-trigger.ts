import type { Task, TaskEventName, TaskTrigger, TaskTriggerSource } from '../protocol/index.ts';
import {
  nextCalendarRun,
  latestCalendarRun,
  normalizeInstant,
  normalizeTimeZone,
} from './calendar.ts';
import { nextCronRun, latestCronRun } from './cron.ts';

/** Interval triggers are capped at one week so a typo cannot park a task for years. */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const MINUTES_PER_DAY = 24 * 60;

const eventNames = new Set<TaskEventName>(['run.finished', 'task.completed', 'session.created']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid task trigger');
  return value as Record<string, unknown>;
}

/**
 * Validate a stored or user-supplied trigger. Unknown fields are rejected rather than ignored so a
 * typo such as `everyMinute` fails loudly instead of silently scheduling nothing.
 */
export function normalizeTaskTrigger(input: unknown, now = new Date()): TaskTrigger | undefined {
  if (input === undefined || input === null) return undefined;
  const value = object(input);
  const kind = value.kind;
  const enabled = value.enabled;
  if (typeof enabled !== 'boolean') throw new Error('Invalid task trigger enabled flag');
  if (value.misfire !== undefined && value.misfire !== 'skip' && value.misfire !== 'latest')
    throw Error('Invalid task misfire policy');
  const misfire = value.misfire as 'skip' | 'latest' | undefined;
  if (kind === 'cron') {
    if (
      Object.keys(value).some(
        (key) => !['kind', 'enabled', 'expression', 'timeZone', 'misfire'].includes(key),
      )
    )
      throw Error('Unknown task trigger field');
    if (typeof value.expression !== 'string') throw Error('Invalid cron expression');
    const expression = value.expression.trim().replace(/\s+/g, ' ');
    const timeZone = normalizeTimeZone(value.timeZone);
    nextCronRun(expression, timeZone, now);
    return { kind, enabled, expression, timeZone, misfire: misfire ?? 'latest' };
  }
  if (kind === 'interval') {
    if (
      Object.keys(value).some(
        (key) => !['kind', 'enabled', 'everyMinutes', 'misfire'].includes(key),
      )
    )
      throw new Error('Unknown task trigger field');
    const everyMinutes = value.everyMinutes;
    if (
      !Number.isSafeInteger(everyMinutes) ||
      (everyMinutes as number) < MIN_INTERVAL_MINUTES ||
      (everyMinutes as number) > MAX_INTERVAL_MINUTES
    )
      throw new Error('Invalid task trigger interval');
    return { kind, enabled, everyMinutes: everyMinutes as number, ...(misfire ? { misfire } : {}) };
  }
  if (kind === 'daily' || kind === 'weekly') {
    const keys = [
      'kind',
      'enabled',
      'atMinutes',
      'timeZone',
      'misfire',
      ...(kind === 'weekly' ? ['weekdays'] : []),
    ];
    if (Object.keys(value).some((key) => !keys.includes(key)))
      throw new Error('Unknown task trigger field');
    const atMinutes = value.atMinutes;
    if (
      !Number.isSafeInteger(atMinutes) ||
      (atMinutes as number) < 0 ||
      (atMinutes as number) >= MINUTES_PER_DAY
    )
      throw new Error('Invalid task trigger time of day');
    const timeZone =
      value.timeZone === undefined && kind === 'daily'
        ? undefined
        : normalizeTimeZone(value.timeZone);
    if (kind === 'weekly') {
      if (
        !Array.isArray(value.weekdays) ||
        !value.weekdays.length ||
        value.weekdays.length > 7 ||
        value.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
      )
        throw Error('Invalid calendar weekdays');
      return {
        kind,
        enabled,
        atMinutes: atMinutes as number,
        timeZone: timeZone!,
        weekdays: [...new Set(value.weekdays as number[])].sort(),
        ...(misfire ? { misfire } : {}),
      };
    }
    return {
      kind,
      enabled,
      atMinutes: atMinutes as number,
      ...(timeZone ? { timeZone } : {}),
      ...(misfire ? { misfire } : {}),
    };
  }
  if (kind === 'at') {
    if (Object.keys(value).some((key) => !['kind', 'enabled', 'at'].includes(key)))
      throw Error('Unknown task trigger field');
    return { kind, enabled, at: normalizeInstant(value.at) };
  }
  if (kind === 'after') {
    if (
      Object.keys(value).some(
        (key) => !['kind', 'enabled', 'afterMinutes', 'anchorAt'].includes(key),
      )
    )
      throw Error('Unknown task trigger field');
    if (
      !Number.isSafeInteger(value.afterMinutes) ||
      Number(value.afterMinutes) < 1 ||
      Number(value.afterMinutes) > 525600
    )
      throw Error('Invalid task trigger delay');
    return {
      kind,
      enabled,
      afterMinutes: Number(value.afterMinutes),
      anchorAt: value.anchorAt === undefined ? now.toISOString() : normalizeInstant(value.anchorAt),
    };
  }
  if (kind === 'event') {
    if (Object.keys(value).some((key) => !['kind', 'enabled', 'on', 'taskId'].includes(key)))
      throw new Error('Unknown task trigger field');
    if (typeof value.on !== 'string' || !eventNames.has(value.on as TaskEventName))
      throw new Error('Invalid task trigger event');
    // Only a completion names a source task; accepting it elsewhere would look like a filter that
    // the scheduler never applies.
    if (value.taskId !== undefined) {
      if (value.on !== 'task.completed' || typeof value.taskId !== 'string' || !value.taskId)
        throw new Error('Invalid task trigger event filter');
    }
    return {
      kind,
      enabled,
      on: value.on as TaskEventName,
      ...(value.taskId === undefined ? {} : { taskId: value.taskId as string }),
    };
  }
  throw new Error('Unsupported task trigger kind');
}

export function triggerSource(trigger: TaskTrigger): TaskTriggerSource {
  return trigger.kind;
}
export function oneShot(trigger: TaskTrigger | undefined): boolean {
  return trigger?.kind === 'at' || trigger?.kind === 'after';
}
/** Used only when saving a new rule: past absolute instants are due immediately, once. */
export function initialRunAt(trigger: TaskTrigger, after: Date): string | undefined {
  if (trigger.kind === 'at') return trigger.at;
  if (trigger.kind === 'after') {
    if (!trigger.anchorAt) throw Error('Unanchored after trigger');
    return new Date(Date.parse(trigger.anchorAt) + trigger.afterMinutes * 60000).toISOString();
  }
  return nextRunAt(trigger, after);
}

/**
 * Next local-time occurrence of `atMinutes` strictly after `after`. Computed through the host
 * timezone rather than a fixed offset so daylight-saving shifts move the wall-clock time with it.
 */
export function nextDailyRun(atMinutes: number, after: Date): Date {
  const candidate = new Date(after);
  candidate.setHours(Math.floor(atMinutes / 60), atMinutes % 60, 0, 0);
  if (candidate.getTime() <= after.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(Math.floor(atMinutes / 60), atMinutes % 60, 0, 0);
  }
  return candidate;
}

/**
 * When a trigger should next fire, expressed as an ISO timestamp. Event triggers have no clock, so
 * they carry no `nextRunAt` and are driven by `matchesEvent` instead.
 */
export function nextRunAt(trigger: TaskTrigger, after: Date): string | undefined {
  if (trigger.kind === 'cron')
    return nextCronRun(trigger.expression, trigger.timeZone, after).toISOString();
  if (trigger.kind === 'interval')
    return new Date(after.getTime() + trigger.everyMinutes * 60_000).toISOString();
  if (trigger.kind === 'daily')
    return (
      trigger.timeZone
        ? nextCalendarRun(trigger.atMinutes, trigger.timeZone, after)
        : nextDailyRun(trigger.atMinutes, after)
    ).toISOString();
  if (trigger.kind === 'weekly')
    return nextCalendarRun(
      trigger.atMinutes,
      trigger.timeZone,
      after,
      trigger.weekdays,
    ).toISOString();
  if (oneShot(trigger)) {
    const candidate = initialRunAt(trigger, after)!;
    return Date.parse(candidate) > after.getTime() ? candidate : undefined;
  }
  return undefined;
}

/** Legacy rules keep their historical catch-up behavior until an explicit policy is chosen. */
export function misfirePolicy(trigger: TaskTrigger): 'skip' | 'latest' | undefined {
  return trigger.kind === 'cron'
    ? (trigger.misfire ?? 'latest')
    : trigger.kind === 'interval' || trigger.kind === 'daily' || trigger.kind === 'weekly'
      ? trigger.misfire
      : undefined;
}
export function latestScheduledAt(trigger: TaskTrigger, dueAt: string, now: Date): string {
  const due = Date.parse(dueAt);
  let latest = due;
  if (trigger.kind === 'cron')
    latest = latestCronRun(trigger.expression, trigger.timeZone, now).getTime();
  else if (trigger.kind === 'interval') {
    const period = trigger.everyMinutes * 60000;
    latest = due + Math.floor((now.getTime() - due) / period) * period;
  } else if (trigger.kind === 'weekly')
    latest = latestCalendarRun(
      trigger.atMinutes,
      trigger.timeZone,
      now,
      trigger.weekdays,
    ).getTime();
  else if (trigger.kind === 'daily') {
    if (trigger.timeZone)
      latest = latestCalendarRun(trigger.atMinutes, trigger.timeZone, now).getTime();
    else {
      const candidate = new Date(now);
      candidate.setHours(Math.floor(trigger.atMinutes / 60), trigger.atMinutes % 60, 0, 0);
      if (candidate.getTime() > now.getTime()) {
        candidate.setDate(candidate.getDate() - 1);
        candidate.setHours(Math.floor(trigger.atMinutes / 60), trigger.atMinutes % 60, 0, 0);
      }
      latest = candidate.getTime();
    }
  }
  return new Date(Math.max(due, latest)).toISOString();
}

export interface TaskEvent {
  name: TaskEventName;
  taskId?: string;
  sessionId?: string;
}

/** Whether an event trigger reacts to this event. Interval/daily triggers never match events. */
export function matchesEvent(trigger: TaskTrigger, event: TaskEvent): boolean {
  if (trigger.kind !== 'event' || !trigger.enabled || trigger.on !== event.name) return false;
  if (trigger.on !== 'task.completed' || !trigger.taskId) return true;
  return trigger.taskId === event.taskId;
}

export interface DueTask {
  task: Task;
  source: TaskTriggerSource;
  /** True when the scheduled moment passed while nothing was running to observe it. */
  missed: boolean;
}

/**
 * Tasks whose scheduled moment has arrived. `catchUp` collapses an arbitrary number of missed
 * occurrences into at most one run per task, because replaying a backlog of identical runs is
 * never what an operator wants after an outage.
 */
export function dueTasks(
  tasks: readonly Task[],
  now: Date,
  options: { catchUp?: boolean; isRunning?: (task: Task) => boolean } = {},
): DueTask[] {
  const due: DueTask[] = [];
  for (const task of tasks) {
    const trigger = task.trigger;
    if (!trigger || !trigger.enabled || task.approvalOutcomeUnknown) continue;
    if (task.pendingApproval?.state === 'pending' || task.pendingApproval?.state === 'rejected')
      continue;
    if (task.status === 'cancelled' || task.status === 'in_progress') continue;
    if (options.isRunning?.(task)) continue;
    const scheduled = task.nextRunAt ? Date.parse(task.nextRunAt) : Number.NaN;
    if (Number.isNaN(scheduled)) continue;
    if (scheduled > now.getTime()) continue;
    if (task.pendingApproval?.state === 'approved') {
      due.push({ task, source: 'recovery', missed: false });
      continue;
    }
    if (trigger.kind === 'event') continue;
    const missed =
      (options.catchUp === true || misfirePolicy(trigger) !== undefined) &&
      now.getTime() - scheduled > 60_000;
    due.push({ task, source: triggerSource(trigger), missed });
  }
  // Oldest obligation first, and stable by id so a restart does not reshuffle the queue.
  return due.sort(
    (left, right) =>
      Date.parse(left.task.nextRunAt!) - Date.parse(right.task.nextRunAt!) ||
      left.task.id.localeCompare(right.task.id),
  );
}

export function isResumable(status: Task['status']): boolean {
  return status === 'in_progress' || status === 'needs_review' || status === 'blocked';
}
