/**
 * The task panel's words and readings, without the DOM: a status, a trigger, the evidence a verification left, and
 * the durable step journal.
 *
 * The trigger sentence is the one place the task surface explains a schedule, so it keeps the legacy shape exactly:
 * the cadence, then the pause/misfire suffix, with the time zone only where the schedule carries one.
 */
import type {
  AcceptanceEvidence,
  Task,
  TaskEventName,
  TaskStepCheckpoint,
  TaskTrigger,
} from '../../../../packages/protocol/index.ts';
import { format, translate } from '../../i18n.ts';
import type { UiLanguage } from '../../ui-settings.ts';

const STATUS_KEYS: Record<string, string> = {
  pending: 'task.status.pending',
  in_progress: 'task.status.inProgress',
  completed: 'task.status.completed',
  needs_review: 'task.status.needsReview',
  blocked: 'task.status.blocked',
  cancelled: 'task.status.cancelled',
  skipped: 'task.status.skipped',
};

export function taskStatusReading(status: string, lang: UiLanguage): string {
  const key = STATUS_KEYS[status];
  return key ? translate(key, lang) : status;
}

export function clockReading(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const EVENT_KEYS: Record<TaskEventName, string> = {
  'run.finished': 'task.event.runFinished',
  'task.completed': 'task.event.taskCompleted',
  'session.created': 'task.event.sessionCreated',
};

export function taskEventReading(on: TaskEventName, lang: UiLanguage): string {
  return translate(EVENT_KEYS[on]!, lang);
}

function suffix(trigger: TaskTrigger, lang: UiLanguage): string {
  const parts: string[] = [];
  if (!trigger.enabled) parts.push(translate('task.trigger.paused', lang));
  if ('misfire' in trigger && trigger.misfire)
    parts.push(
      translate(
        trigger.misfire === 'skip' ? 'task.trigger.skipMissed' : 'task.trigger.latestMissed',
        lang,
      ),
    );
  return parts.map((part) => ` · ${part}`).join('');
}

export function triggerSummaryReading(task: Task, lang: UiLanguage): string {
  const trigger = task.trigger;
  if (!trigger) return translate('task.trigger.none', lang);
  const pause = suffix(trigger, lang);
  if (trigger.kind === 'interval')
    return format(translate('task.trigger.every', lang), { minutes: trigger.everyMinutes }) + pause;
  if (trigger.kind === 'daily')
    return (
      format(translate('task.trigger.daily', lang), { time: clockReading(trigger.atMinutes) }) +
      ` (${trigger.timeZone ?? translate('task.trigger.localZone', lang)})` +
      pause
    );
  if (trigger.kind === 'weekly')
    return (
      format(translate('task.trigger.weekly', lang), {
        days: trigger.weekdays.join(','),
        time: clockReading(trigger.atMinutes),
      }) +
      ` (${trigger.timeZone})` +
      pause
    );
  if (trigger.kind === 'cron') return `Cron ${trigger.expression} (${trigger.timeZone})` + pause;
  if (trigger.kind === 'at') return translate('task.trigger.once', lang) + trigger.at + pause;
  if (trigger.kind === 'after')
    return format(translate('task.trigger.after', lang), { minutes: trigger.afterMinutes }) + pause;
  return taskEventReading(trigger.on, lang) + pause;
}

export interface EvidenceReading {
  summary: string;
  checks: {
    mark: string;
    id: string;
    kind: string;
    detail: string;
    command: string | null;
  }[];
}

export function evidenceReading(
  value: AcceptanceEvidence | undefined,
  lang: UiLanguage,
): EvidenceReading | null {
  if (!value) return null;
  return {
    summary: `${translate('task.evidence.title', lang)} · ${
      value.passed
        ? translate('task.evidence.passed', lang)
        : translate('task.evidence.failed', lang)
    }`,
    checks: value.checks.map((check) => ({
      mark: check.passed ? '✓' : '×',
      id: check.id,
      kind: check.kind,
      detail: check.detail,
      command: check.command
        ? `exit: ${check.command.exitCode} · timeout: ${check.command.timedOut}\n${check.command.stdout}\n${check.command.stderr}`
        : null,
    })),
  };
}

export interface JournalReading {
  summary: string;
  entries: string[];
}

export function stepJournalReading(
  steps: TaskStepCheckpoint[],
  lang: UiLanguage,
): JournalReading | null {
  if (!steps.length) return null;
  return {
    summary: `${translate('task.steps.title', lang)} (${steps.length})`,
    entries: steps.map(
      (step) =>
        `${step.index} · ${step.status} · ${step.createdAt}${step.note ? ` · ${step.note}` : ''}`,
    ),
  };
}

export interface AcceptanceRow {
  index: number;
  description: string;
  met: boolean;
  selected: boolean;
  /** A criterion already met (or gone) cannot be confirmed again. */
  confirmable: boolean;
}

export function acceptanceRows(task: Task, selection: ReadonlySet<number>): AcceptanceRow[] {
  return task.acceptance.map((item, index) => ({
    index,
    description: item.description,
    met: item.met,
    selected: selection.has(index),
    confirmable: !item.met,
  }));
}
