/**
 * The trigger editor.
 *
 * Scheduled work runs unattended, so the controls spell out exactly when a run will start rather than hiding it
 * behind a cron expression. Every field stays on screen and is disabled when the chosen cadence does not use it:
 * changing the kind must not move the form under a person's cursor, which is also what keeps the draft reconstructible
 * from the fields alone.
 *
 * The draft, the trigger it builds and the disabled rules live in `schedule-draft.ts` so they can be tested without a
 * window; this file owns only the controls, the localized preview and the submit guard.
 */
import { useState, type ReactNode } from 'react';
import type { CarrierCommand } from '../../../../packages/carrier/contract.ts';
import type { Task, TaskEventName } from '../../../../packages/protocol/index.ts';
import { initialRunAt, normalizeTaskTrigger } from '../../../../packages/protocol/task-trigger.ts';
import { t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import { Button, Checkbox, Select, TextInput } from '../primitives.tsx';
import { clockReading, taskEventReading } from './task-view.ts';
import {
  buildScheduleTrigger,
  initialScheduleDraft,
  scheduleControls,
  type ScheduleDraft,
} from './schedule-draft.ts';

export interface ScheduleEditorProps {
  task: Task;
  /** The snapshot's tasks: the source-task field may name any other task, never this one. */
  tasks: readonly Task[];
  busy: boolean;
  stale: boolean;
  onSave(command: CarrierCommand): Promise<void>;
  onCancel(): void;
}

const KIND_KEYS: Record<ScheduleDraft['kind'], string> = {
  none: 'task.schedule.kind.none',
  interval: 'task.schedule.kind.interval',
  daily: 'task.schedule.kind.daily',
  weekly: 'task.schedule.kind.weekly',
  cron: 'task.schedule.kind.cron',
  at: 'task.schedule.kind.at',
  after: 'task.schedule.kind.after',
  event: 'task.schedule.kind.event',
};
const KINDS = Object.keys(KIND_KEYS) as ScheduleDraft['kind'][];
const MISFIRE_KEYS: Record<ScheduleDraft['misfire'], string> = {
  legacy: 'task.schedule.misfire.legacy',
  skip: 'task.schedule.misfire.skip',
  latest: 'task.schedule.misfire.latest',
};
const MISFIRE = Object.keys(MISFIRE_KEYS) as ScheduleDraft['misfire'][];
const EVENT_NAMES: TaskEventName[] = ['run.finished', 'task.completed', 'session.created'];
const DAY_KEYS: Record<number, string> = {
  0: 'task.schedule.day.sun',
  1: 'task.schedule.day.mon',
  2: 'task.schedule.day.tue',
  3: 'task.schedule.day.wed',
  4: 'task.schedule.day.thu',
  5: 'task.schedule.day.fri',
  6: 'task.schedule.day.sat',
};
/** Monday first: the working week is what an operator usually schedules against. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

type Reading = { text: string } | { failure: string };

/** What the schedule will do next, or why the current draft cannot be scheduled at all. */
function previewReading(draft: ScheduleDraft, current: Task['trigger']): Reading {
  try {
    const trigger = normalizeTaskTrigger(buildScheduleTrigger(draft, current), new Date());
    const next = trigger?.enabled ? initialRunAt(trigger, new Date()) : undefined;
    return { text: next ? t('task.schedule.next') + next : t('task.schedule.noDelivery') };
  } catch (cause) {
    return { failure: cause instanceof Error ? cause.message : String(cause) };
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ScheduleEditor({
  task,
  tasks,
  busy,
  stale,
  onSave,
  onCancel,
}: ScheduleEditorProps): ReactNode {
  const lang = useLocale();
  const [draft, setDraft] = useState(() => initialScheduleDraft(task.trigger));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const edit = (change: Partial<ScheduleDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  const kind = draft.kind;
  const cron = kind === 'cron';
  // A cron rule always has a misfire policy: `legacy` cannot be stored for it, so the control shows the one that will
  // be saved rather than a value the protocol rejects.
  const misfire: ScheduleDraft['misfire'] =
    cron && draft.misfire === 'legacy' ? 'latest' : draft.misfire;
  const effective: ScheduleDraft = { ...draft, misfire };
  const usable = scheduleControls(effective);
  const preview = previewReading(effective, task.trigger);
  const sourceTasks = tasks.filter((entry) => entry.id !== task.id);

  const submit = async () => {
    if (locked || stale) return;
    if (
      kind === 'interval' &&
      !(
        Number.isInteger(draft.everyMinutes) &&
        draft.everyMinutes >= 1 &&
        draft.everyMinutes <= 10080
      )
    ) {
      setError(t('task.schedule.intervalInvalid'));
      return;
    }
    const trigger = buildScheduleTrigger(effective, task.trigger);
    try {
      normalizeTaskTrigger(trigger);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave({ type: 'taskTrigger', taskId: task.id, trigger });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="task-schedule"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset className="task-schedule-fields" disabled={locked}>
        <Select
          label={t('task.schedule.kind')}
          value={kind}
          allowDeselect={false}
          data={KINDS.map((value) => ({ value, label: t(KIND_KEYS[value]) }))}
          onChange={(value) => {
            if (!value) return;
            const next = value as ScheduleDraft['kind'];
            edit({
              kind: next,
              // A calendar rule cannot run without a zone, so the field starts at the machine's instead of empty.
              ...((next === 'weekly' || next === 'cron') && !draft.timeZone
                ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                : {}),
            });
          }}
        />
        <Checkbox
          label={t('task.schedule.enabled')}
          checked={draft.enabled}
          disabled={!usable.enabled}
          onChange={(event) => edit({ enabled: event.currentTarget.checked })}
        />
        <TextInput
          type="number"
          label={t('task.schedule.interval')}
          min={1}
          max={7 * 24 * 60}
          value={String(draft.everyMinutes)}
          disabled={!usable.everyMinutes}
          onChange={(event) => edit({ everyMinutes: Number(event.currentTarget.value) })}
        />
        <TextInput
          type="time"
          label={t('task.schedule.calendarTime')}
          value={clockReading(draft.atMinutes)}
          disabled={!usable.atMinutes}
          onChange={(event) => {
            const [hours = '0', minutes = '0'] = event.currentTarget.value.split(':');
            edit({ atMinutes: Number(hours) * 60 + Number(minutes) });
          }}
        />
        <TextInput
          label={t('task.schedule.zone')}
          value={draft.timeZone}
          placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
          disabled={!usable.timeZone}
          onChange={(event) => edit({ timeZone: event.currentTarget.value.trim() })}
        />
        <div className="task-weekdays">
          {WEEKDAYS.map((day) => (
            <Checkbox
              key={day}
              label={t(DAY_KEYS[day]!)}
              checked={draft.weekdays.includes(day)}
              disabled={!usable.weekdays}
              onChange={(event) =>
                edit({
                  weekdays: event.currentTarget.checked
                    ? [...draft.weekdays, day]
                    : draft.weekdays.filter((entry) => entry !== day),
                })
              }
            />
          ))}
        </div>
        <TextInput
          label={t('task.schedule.timestamp')}
          value={draft.instant}
          placeholder="2026-10-07T09:00:00+08:00"
          disabled={!usable.instant}
          onChange={(event) => edit({ instant: event.currentTarget.value.trim() })}
        />
        <TextInput
          type="number"
          label={t('task.schedule.delay')}
          min={1}
          max={525600}
          value={String(draft.afterMinutes)}
          disabled={!usable.afterMinutes}
          onChange={(event) => edit({ afterMinutes: Number(event.currentTarget.value) })}
        />
        <TextInput
          label={t('task.schedule.cron')}
          value={draft.expression}
          disabled={!usable.expression}
          onChange={(event) => edit({ expression: event.currentTarget.value })}
        />
        <Select
          label={t('task.schedule.misfire')}
          value={misfire}
          allowDeselect={false}
          disabled={!usable.misfire}
          data={MISFIRE.map((value) => ({
            value,
            label: t(MISFIRE_KEYS[value]),
            disabled: value === 'legacy' && cron,
          }))}
          onChange={(value) => {
            if (value) edit({ misfire: value as ScheduleDraft['misfire'] });
          }}
        />
        <small>{t('task.schedule.cronHint')}</small>
        <p className="task-schedule-preview">
          {'text' in preview ? preview.text : preview.failure}
        </p>
        <small>{t('task.schedule.hostHint')}</small>
        <Select
          label={t('task.schedule.listen')}
          value={draft.on}
          allowDeselect={false}
          disabled={!usable.on}
          data={EVENT_NAMES.map((name) => ({ value: name, label: taskEventReading(name, lang) }))}
          onChange={(value) => {
            if (value) edit({ on: value as TaskEventName });
          }}
        />
        <Select
          label={t('task.schedule.source')}
          value={draft.taskId || null}
          allowDeselect={false}
          placeholder={t('task.schedule.anyTask')}
          disabled={!usable.taskId}
          data={[
            { value: '', label: t('task.schedule.anyTask') },
            ...sourceTasks.map((entry) => ({ value: entry.id, label: entry.title })),
          ]}
          onChange={(value) => edit({ taskId: value ?? '' })}
        />
        <div className="task-actions">
          <Button type="submit" disabled={locked || stale}>
            {t('task.schedule.save')}
          </Button>
          <Button variant="default" onClick={onCancel}>
            {t('task.editor.cancel')}
          </Button>
        </div>
      </fieldset>
      <p className="task-edit-warning" role="status">
        {error || (stale ? t('task.staleWarning') : '')}
      </p>
    </form>
  );
}
