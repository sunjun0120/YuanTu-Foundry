import {
  addCivilDays,
  calendarParts,
  calendarOffsets,
  dayNumber,
  wallClockInstant,
  validCivilDate,
} from './calendar.ts';

export interface CronField {
  values: number[];
  wildcard: boolean;
}
export interface CronRule {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
}
const HORIZON_DAYS = 8 * 366;

function field(text: string, min: number, max: number, sunday = false): CronField {
  const values = new Set<number>();
  const parts = text.split(',');
  if (parts.length > 64 || (parts.length > 1 && parts.some((p) => p.includes('*'))))
    throw Error('Unsupported cron wildcard list');
  for (const part of parts) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw Error('Unsupported cron field syntax');
    const base = match[1]!,
      step = Number(match[2] ?? 1);
    if (
      !Number.isSafeInteger(step) ||
      step < 1 ||
      (match[2] && base !== '*' && !base.includes('-'))
    )
      throw Error('Invalid cron step');
    const [low, high] =
      base === '*'
        ? [min, max]
        : base.includes('-')
          ? base.split('-').map(Number)
          : [Number(base), Number(base)];
    if (
      !Number.isSafeInteger(low) ||
      !Number.isSafeInteger(high) ||
      low! < min ||
      high! > max ||
      low! > high!
    )
      throw Error('Invalid cron range');
    for (let value = low!; value <= high!; value += step)
      values.add(sunday && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard: text.startsWith('*') };
}
export function parseCron(input: unknown): CronRule {
  if (typeof input !== 'string' || input.length > 256) throw Error('Invalid cron expression');
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 5) throw Error('Cron requires five fields');
  return {
    minute: field(parts[0]!, 0, 59),
    hour: field(parts[1]!, 0, 23),
    day: field(parts[2]!, 1, 31),
    month: field(parts[3]!, 1, 12),
    weekday: field(parts[4]!, 0, 7, true),
  };
}
/** Restricted month-day and weekday fields match by OR; a wildcard in either uses AND. */
function matchesDay(rule: CronRule, date: { year: number; month: number; day: number }): boolean {
  if (!rule.month.values.includes(date.month)) return false;
  const dom = rule.day.values.includes(date.day),
    dow = rule.weekday.values.includes(new Date(dayNumber(date)).getUTCDay());
  return !rule.day.wildcard && !rule.weekday.wildcard ? dom || dow : dom && dow;
}
function occurrence(expression: string, timeZone: string, pivot: Date, previous: boolean): Date {
  const rule = parseCron(expression),
    first = calendarParts(pivot, timeZone);
  const minutes = rule.hour.values.flatMap((hour) =>
    rule.minute.values.map((minute) => hour * 60 + minute),
  );
  if (previous) minutes.reverse();
  for (let days = 0; days <= HORIZON_DAYS; days++) {
    const date = addCivilDays(first, previous ? -days : days);
    if (!validCivilDate(date)) break;
    if (!matchesDay(rule, date)) continue;
    const offsets = calendarOffsets(date, timeZone);
    for (const minute of minutes) {
      const at = wallClockInstant(date, minute, timeZone, offsets);
      if (at && (previous ? at.getTime() <= pivot.getTime() : at.getTime() > pivot.getTime()))
        return at;
    }
  }
  throw Error('Cron has no reachable occurrence within eight years');
}
export function nextCronRun(expression: string, timeZone: string, after: Date): Date {
  return occurrence(expression, timeZone, after, false);
}
export function latestCronRun(expression: string, timeZone: string, now: Date): Date {
  return occurrence(expression, timeZone, now, true);
}
