/** Explicit-zone Gregorian calendars: missing local times skip; folds use the first occurrence. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}
const formats = new Map<string, Intl.DateTimeFormat>();
export function normalizeTimeZone(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 100 || /^[+-]/.test(input))
    throw Error('Invalid IANA time zone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: input }).resolvedOptions().timeZone;
  } catch {
    throw Error('Invalid IANA time zone');
  }
}
export function calendarParts(at: Date, timeZone: string): CivilDate & { minutes: number } {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}
export function dayNumber(date: CivilDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const at = new Date(dayNumber(date) + days * 86400000);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}
export function validCivilDate(date: CivilDate): boolean {
  if (
    !Number.isInteger(date.year) ||
    date.year < 1970 ||
    date.year > 9999 ||
    !Number.isInteger(date.month) ||
    !Number.isInteger(date.day)
  )
    return false;
  const at = new Date(dayNumber(date));
  return (
    at.getUTCFullYear() === date.year &&
    at.getUTCMonth() + 1 === date.month &&
    at.getUTCDate() === date.day
  );
}
/** Offsets near a civil day, reused across candidate minutes rather than scanning UTC minutes. */
export function calendarOffsets(date: CivilDate, timeZone: string): number[] {
  const anchor = dayNumber(date),
    offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const utc = anchor + hours * 3600000,
      local = calendarParts(new Date(utc), timeZone);
    offsets.add(dayNumber(local) + local.minutes * 60000 - utc);
  }
  return [...offsets];
}
export function wallClockInstant(
  date: CivilDate,
  minutes: number,
  timeZone: string,
  offsets = calendarOffsets(date, timeZone),
): Date | undefined {
  if (!validCivilDate(date) || !Number.isInteger(minutes) || minutes < 0 || minutes >= 1440)
    throw Error('Invalid calendar date or time');
  const wall = dayNumber(date) + minutes * 60000;
  const candidates = offsets
    .map((offset) => wall - offset)
    .filter((utc) => {
      const parts = calendarParts(new Date(utc), timeZone);
      return (
        parts.year === date.year &&
        parts.month === date.month &&
        parts.day === date.day &&
        parts.minutes === minutes
      );
    });
  return candidates.length ? new Date(Math.min(...candidates)) : undefined;
}
export function nextCalendarRun(
  minutes: number,
  timeZone: string,
  after: Date,
  weekdays?: readonly number[],
): Date {
  const first = calendarParts(after, timeZone);
  for (let days = 0; days < 370; days++) {
    const date = addCivilDays(first, days),
      weekday = new Date(dayNumber(date)).getUTCDay();
    if (weekdays && !weekdays.includes(weekday)) continue;
    const candidate = wallClockInstant(date, minutes, timeZone);
    if (candidate && candidate.getTime() > after.getTime()) return candidate;
  }
  throw Error('Calendar rule has no next occurrence');
}

export function latestCalendarRun(
  minutes: number,
  timeZone: string,
  now: Date,
  weekdays?: readonly number[],
): Date {
  const first = calendarParts(now, timeZone);
  for (let days = 0; days < 370; days++) {
    const date = addCivilDays(first, -days);
    if (weekdays && !weekdays.includes(new Date(dayNumber(date)).getUTCDay())) continue;
    const candidate = wallClockInstant(date, minutes, timeZone);
    if (candidate && candidate.getTime() <= now.getTime()) return candidate;
  }
  throw Error('Calendar rule has no previous occurrence');
}

/** Absolute instants must include an offset and name a real civil date, rather than Date's rollover. */
export function normalizeInstant(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)
  )
    throw Error('Invalid timestamp; include a UTC offset');
  const date = {
    year: Number(input.slice(0, 4)),
    month: Number(input.slice(5, 7)),
    day: Number(input.slice(8, 10)),
  };
  if (
    !validCivilDate(date) ||
    Number(input.slice(11, 13)) > 23 ||
    Number(input.slice(14, 16)) > 59 ||
    Number(input.slice(17, 19) || '0') > 59 ||
    !Number.isFinite(Date.parse(input))
  )
    throw Error('Invalid timestamp date or time');
  return new Date(input).toISOString();
}
