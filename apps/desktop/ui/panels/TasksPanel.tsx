/**
 * The task list: one card per task, its schedule, approval, steps, acceptance rows and actions.
 *
 * The card reads from `task-view.ts`; the editor forms are still the legacy DOM builders, hosted inside the card
 * they belong to. While a form is open the list is frozen — a progress publish updates the form's disabled/stale
 * state instead of rebuilding it, which is what keeps a half-typed title or a ticked acceptance row from being
 * thrown away by the next task update.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { Task } from '../../../../packages/protocol/index.ts';
import { t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import { TaskEditor } from './TaskEditor.tsx';
import {
  acceptanceRows,
  evidenceReading,
  stepJournalReading,
  taskActions,
  taskApprovalView,
  taskAttemptsReading,
  taskScheduleReading,
  taskStatusReading,
} from './task-view.ts';

export interface TaskEditing {
  taskId: string;
  form?: HTMLFormElement;
  task: Task;
  token: number;
  revision: string;
  stale: boolean;
}

export interface TaskCardActions {
  send(command: CarrierCommand): void;
  edit(task: Task): void;
  schedule(task: Task): void;
  confirm(task: Task, indices: number[]): void;
  selection(task: Task): Set<number>;
  selectionChanged(): void;
  save(command: CarrierCommand, editing: TaskEditing): Promise<void>;
  cancel(): void;
}

function FormHost({ editing, busy }: { editing: TaskEditing; busy: boolean }): ReactNode {
  const form = editing.form!;
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    if (form.parentElement !== container) container.replaceChildren(form);
  }, [form]);
  useEffect(() => {
    const fieldset = form.querySelector('fieldset');
    if (fieldset) fieldset.disabled = busy;
    const save = form.querySelector<HTMLButtonElement>('button[type=submit]');
    if (save) save.disabled = busy || editing.stale;
    const warning = form.querySelector<HTMLElement>('.task-edit-warning');
    if (warning) warning.textContent = editing.stale ? t('task.staleWarning') : '';
  }, [editing, busy, form]);
  return <div ref={host} />;
}

function Evidence({
  reading,
  className,
}: {
  reading: NonNullable<ReturnType<typeof evidenceReading>>;
  className: string;
}): ReactNode {
  return (
    <details className={className}>
      <summary>{reading.summary}</summary>
      {reading.checks.map((check, index) => (
        <div key={`${check.id}-${index}`}>
          <strong>{`${check.mark} ${check.id} · ${check.kind}`}</strong>
          <pre>{check.detail}</pre>
          {check.command ? <pre>{check.command}</pre> : null}
        </div>
      ))}
    </details>
  );
}

function TaskCard({
  task,
  snapshot,
  busy,
  actions,
  editing,
}: {
  task: Task;
  snapshot: CarrierSnapshot;
  busy: boolean;
  actions: TaskCardActions;
  editing: TaskEditing | null;
}): ReactNode {
  const lang = useLocale();
  const approval = taskApprovalView(task, lang);
  if (editing)
    return (
      <article className="task-card" data-task-id={task.id}>
        <div className="task-card-header">
          <h3>{task.title}</h3>
          <span className={`task-status ${task.status}`}>
            {taskStatusReading(task.status, lang)}
          </span>
        </div>
        {editing.form ? (
          <FormHost editing={editing} busy={busy} />
        ) : (
          <TaskEditor
            key={editing.token}
            task={editing.task}
            revision={editing.revision}
            busy={busy}
            stale={editing.stale}
            onSave={(command) => actions.save(command, editing)}
            onCancel={actions.cancel}
          />
        )}
      </article>
    );
  const selection = actions.selection(task);
  const rows = acceptanceRows(task, selection);
  const canConfirm =
    !!task.latestRunId && !!task.verification && !['pending', 'in_progress'].includes(task.status);
  const evidence = evidenceReading(task.verification, lang);
  const journal = stepJournalReading(snapshot.taskSteps[task.id] ?? [], lang);
  const attempts = taskAttemptsReading((snapshot.taskAttempts[task.id] ?? []) as never, lang);
  let confirmDisabled = selection.size === 0;
  return (
    <article className="task-card" data-task-id={task.id}>
      <div className="task-card-header">
        <h3>{task.title}</h3>
        <span className={`task-status ${task.status}`}>{taskStatusReading(task.status, lang)}</span>
      </div>
      <p className="task-description">{task.description}</p>
      <p className="task-schedule-summary">{taskScheduleReading(task, lang)}</p>
      {task.waiting ? (
        <p className="task-waiting">
          {`${t('task.waiting')} · ${task.waiting.reason} · ${new Date(
            task.waiting.since,
          ).toLocaleString(lang === 'en-US' ? 'en-US' : 'zh-CN')}`}
        </p>
      ) : null}
      {task.lastTriggerError ? (
        <p className="task-schedule-error">{task.lastTriggerError}</p>
      ) : null}
      {approval.visible ? (
        <section className="task-approval">
          <strong>{approval.label}</strong>
          <p>{approval.detail}</p>
          <pre>{approval.description}</pre>
          {approval.canRespond ? (
            <div className="task-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  actions.send({
                    type: 'taskApproval',
                    taskId: task.id,
                    approvalId: task.pendingApproval!.id,
                    allow: false,
                  })
                }
              >
                {t('task.approval.reject')}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  actions.send({
                    type: 'taskApproval',
                    taskId: task.id,
                    approvalId: task.pendingApproval!.id,
                    allow: true,
                  })
                }
              >
                {t('task.approval.approve')}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      <ol className="task-steps">
        {task.steps.map((step, index) => (
          <li key={index}>{`${step.status} · ${step.description}`}</li>
        ))}
      </ol>
      {rows.map((row) => (
        <label key={row.index} className="task-acceptance-row">
          {!task.acceptance[row.index]?.check && canConfirm && !row.met ? (
            <input
              type="checkbox"
              disabled={busy}
              checked={row.selected}
              onChange={(event) => {
                const current = actions.selection(task);
                if (event.currentTarget.checked) current.add(row.index);
                else current.delete(row.index);
                confirmDisabled = current.size === 0;
                actions.selectionChanged();
              }}
            />
          ) : null}
          <span>
            {`${row.met ? '✓' : '○'} ${row.description} · ${
              task.acceptance[row.index]?.check?.kind ?? t('task.manual')
            }`}
          </span>
        </label>
      ))}
      {evidence ? <Evidence reading={evidence} className="task-evidence" /> : null}
      <div className="task-actions">
        {taskActions(task, selection, lang).map((action) => {
          if (action.kind === 'edit')
            return (
              <button
                key={action.kind}
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => actions.edit(task)}
              >
                {action.label}
              </button>
            );
          if (action.kind === 'schedule')
            return (
              <button
                key={action.kind}
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => actions.schedule(task)}
              >
                {action.label}
              </button>
            );
          if (action.kind === 'confirm')
            return (
              <button
                key={action.kind}
                type="button"
                className="secondary"
                disabled={busy || confirmDisabled}
                data-unavailable={String(confirmDisabled)}
                onClick={() => {
                  if (!selection.size) return;
                  actions.confirm(task, [...selection]);
                }}
              >
                {action.label}
              </button>
            );
          const command =
            action.command === 'taskStart'
              ? ({ type: 'taskStart', taskId: task.id } as CarrierCommand)
              : action.command === 'taskRetry'
                ? ({ type: 'taskRetry', taskId: task.id } as CarrierCommand)
                : action.command === 'taskPropose'
                  ? ({ type: 'taskPropose', taskId: task.id } as CarrierCommand)
                  : action.command === 'taskVerify'
                    ? ({ type: 'taskVerify', taskId: task.id } as CarrierCommand)
                    : ({ type: 'taskHistory', taskId: task.id } as CarrierCommand);
          return (
            <button
              key={action.kind}
              type="button"
              className="secondary"
              disabled={busy || action.unavailable}
              data-unavailable={String(action.unavailable)}
              onClick={() => actions.send(command)}
            >
              {action.label}
            </button>
          );
        })}
      </div>
      {journal ? (
        <details className="task-step-journal">
          <summary>{journal.summary}</summary>
          {journal.entries.map((entry) => (
            <p key={entry}>{entry}</p>
          ))}
        </details>
      ) : null}
      {attempts.visible ? (
        <details className="task-history">
          <summary>{attempts.title}</summary>
          {attempts.rows.map((row, index) => (
            <div key={index}>
              <p>{row.text}</p>
              {row.evidence ? <Evidence reading={row.evidence} className="task-evidence" /> : null}
            </div>
          ))}
        </details>
      ) : null}
    </article>
  );
}

export function TaskCards({
  snapshot,
  busy,
  actions,
  editing,
}: {
  snapshot: CarrierSnapshot;
  busy: boolean;
  actions: TaskCardActions;
  editing: TaskEditing | null;
}): ReactNode {
  useLocale();
  return (
    <>
      {snapshot.tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          snapshot={snapshot}
          busy={busy}
          actions={actions}
          editing={editing?.taskId === task.id ? editing : null}
        />
      ))}
    </>
  );
}
