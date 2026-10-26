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

/** `next`/`last` timeline suffixes: the trigger sentence plus the two locale-formatted moments. */
export function taskScheduleReading(task: Task, lang: UiLanguage): string {
  const parts = [triggerSummaryReading(task, lang)];
  if (task.nextRunAt)
    parts.push(
      `${translate('task.next', lang)} ${new Date(task.nextRunAt).toLocaleString(
        lang === 'en-US' ? 'en-US' : 'zh-CN',
      )}`,
    );
  if (task.lastRunAt)
    parts.push(
      `${translate('task.last', lang)} ${new Date(task.lastRunAt).toLocaleString(
        lang === 'en-US' ? 'en-US' : 'zh-CN',
      )}`,
    );
  return parts.join(' · ');
}

export interface ApprovalView {
  visible: boolean;
  label: string;
  detail: string;
  description: string;
  canRespond: boolean;
}

export function taskApprovalView(task: Task, lang: UiLanguage): ApprovalView {
  const pending = task.pendingApproval;
  if (!pending)
    return { visible: false, label: '', detail: '', description: '', canRespond: false };
  const key =
    pending.state === 'pending'
      ? 'task.approval.pending'
      : pending.state === 'approved'
        ? 'task.approval.approved'
        : 'task.approval.rejected';
  return {
    visible: true,
    label: translate(key, lang),
    detail: `${pending.kind} · ${pending.tool}`,
    description: pending.description,
    canRespond: pending.state === 'pending',
  };
}

/** A verification can only be confirmed after a run left evidence and the task is no longer pending. */
export function taskCanConfirm(task: Task): boolean {
  return (
    !!task.latestRunId && !!task.verification && !['pending', 'in_progress'].includes(task.status)
  );
}

export interface TaskAction {
  kind:
    | 'edit'
    | 'schedule'
    | 'approve'
    | 'reject'
    | 'start'
    | 'retry'
    | 'propose'
    | 'verify'
    | 'confirm'
    | 'history';
  label: string;
  command: string;
  unavailable: boolean;
}

export function taskActions(
  task: Task,
  selection: ReadonlySet<number>,
  lang: UiLanguage,
): TaskAction[] {
  const actions: TaskAction[] = [
    { kind: 'edit', label: translate('task.edit', lang), command: 'edit', unavailable: false },
    {
      kind: 'schedule',
      label: translate('task.schedule', lang),
      command: 'schedule',
      unavailable: false,
    },
  ];
  actions.push(
    task.latestRunId
      ? {
          kind: 'retry',
          label: translate('task.retry', lang),
          command: 'taskRetry',
          unavailable: false,
        }
      : {
          kind: 'start',
          label: translate('task.start', lang),
          command: 'taskStart',
          unavailable: false,
        },
    {
      kind: 'propose',
      label: translate('task.propose', lang),
      command: 'taskPropose',
      unavailable: false,
    },
    {
      kind: 'verify',
      label: translate('task.verify', lang),
      command: 'taskVerify',
      unavailable: !task.latestRunId,
    },
  );
  if (task.acceptance.some((item) => !item.check) && taskCanConfirm(task))
    actions.push({
      kind: 'confirm',
      label: translate('task.confirm', lang),
      command: 'taskConfirm',
      unavailable: selection.size === 0,
    });
  actions.push({
    kind: 'history',
    label: translate('task.history', lang),
    command: 'taskHistory',
    unavailable: false,
  });
  return actions;
}

export interface AttemptReading {
  text: string;
  evidence: EvidenceReading | null;
}

export function taskAttemptsReading(
  attempts: {
    kind: string;
    status: string;
    startedAt: string;
    trigger?: string;
    resume?: boolean;
    error?: string;
    verification?: AcceptanceEvidence;
  }[],
  lang: UiLanguage,
): { visible: boolean; title: string; rows: AttemptReading[] } {
  return {
    visible: attempts.length > 0,
    title: `${translate('task.attempts', lang)} (${attempts.length})`,
    rows: attempts.map((attempt) => ({
      text:
        `${attempt.kind} · ${attempt.status} · ${attempt.startedAt}` +
        `${attempt.trigger && attempt.trigger !== 'manual' ? ` · ${attempt.trigger}` : ''}` +
        `${attempt.resume ? ` · ${translate('task.resumed', lang)}` : ''}` +
        `${attempt.error ? ` · ${attempt.error}` : ''}`,
      evidence: evidenceReading(attempt.verification, lang),
    })),
  };
}
