/**
 * The checklist, the goal banner and the presented files.
 *
 * Each panel is hidden rather than emptied when it has nothing to show. The checklist folds on a session switch so
 * every session starts from the requested collapsed state.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { TodoItem } from '../../../../packages/protocol/index.ts';
import type { Goal } from '../../../../packages/protocol/goals.ts';
import type { PresentedFile } from '../../../../packages/protocol/deliverables.ts';
import { t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import { deliverablesView, goalView, todosView } from './session-panels-model.ts';
import { ProgressMark } from './ProgressMark.tsx';

export function TodosPanel({
  snapshot,
  todos,
}: {
  snapshot: CarrierSnapshot | null;
  todos: TodoItem[];
}): ReactNode {
  const lang = useLocale();
  const view = todosView(snapshot, todos, lang);
  const [open, setOpen] = useState(false);
  const sessionId = snapshot?.session.sessionId ?? '';
  // A list belongs to one session; a switch starts folded, as the details element used to be reset to.
  useEffect(() => setOpen(false), [sessionId]);
  if (!view.visible)
    return <details id="todos-panel" className="todos-panel" aria-label={t('ui.todos')} hidden />;
  return (
    <details
      id="todos-panel"
      className="todos-panel"
      aria-label={t('ui.todos')}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong id="todos-title">{t('ui.todosTitle')}</strong>
        <span id="todos-summary" className="todos-summary">
          {view.summary}
        </span>
        <span className="todos-progress" aria-hidden="true">
          {view.counts.completed}/{view.total}
        </span>
        <span className="todos-chevron" aria-hidden="true" />
      </summary>
      <div className="todos-body">
        <ul id="todos" className="todos">
          {view.rows.map((row, index) => (
            <li key={index} className={row.className}>
              <ProgressMark
                completed={todos[index]?.status === 'completed'}
                label={t(`ui.todoStatus.${todos[index]!.status}`)}
              />
              <span className="todo-content">{row.content}</span>
              {todos[index]?.status === 'in_progress' ? (
                <span className="progress-note">{t('ui.todoStatus.in_progress')}</span>
              ) : null}
            </li>
          ))}
          <li className="todo-count">{view.countText}</li>
        </ul>
      </div>
    </details>
  );
}

export function GoalPanel({ goal }: { goal: Goal | null }): ReactNode {
  const lang = useLocale();
  const current = goalView(goal, lang);
  if (!current.visible)
    return <section id="goal-panel" className="goal-panel" aria-label={t('ui.goalTitle')} hidden />;
  return (
    <section id="goal-panel" className="goal-panel" aria-label={t('ui.goalTitle')}>
      <div className="goal-panel-header">
        <h2 id="goal-title">{t('ui.goalTitle')}</h2>
        <span id="goal-status" className={current.statusClass}>
          {current.statusText}
        </span>
      </div>
      <p id="goal-objective" className="goal-objective" translate="no">
        {current.objective}
      </p>
      <p id="goal-meta" className="goal-meta">
        {current.meta}
      </p>
    </section>
  );
}

export interface DeliverableActions {
  open?: (path: string) => void;
  shell?: { open(path: string): void; reveal(path: string): void };
}

export function DeliverablesPanel({
  files,
  open,
  shell,
  turnKey,
}: {
  files: PresentedFile[];
  turnKey?: string;
} & DeliverableActions): ReactNode {
  useLocale();
  const view = deliverablesView(files);
  const title = t(turnKey ? 'ui.turnDeliverablesTitle' : 'ui.deliverablesTitle');
  if (!view.visible)
    return (
      <section
        id={turnKey ? undefined : 'deliverables-panel'}
        className="deliverables-panel"
        aria-label={title}
        hidden
      />
    );
  return (
    <section
      id={turnKey ? undefined : 'deliverables-panel'}
      className="deliverables-panel"
      aria-label={title}
      data-deliverables-turn={turnKey}
    >
      <div className="deliverables-panel-header">
        <h2 id={turnKey ? undefined : 'deliverables-title'}>{title}</h2>
      </div>
      <ul id={turnKey ? undefined : 'deliverables'} className="deliverables">
        {view.rows.map((row) => (
          <li key={row.path} className="deliverable" title={row.title}>
            {open ? (
              <button
                type="button"
                className="deliverable-path deliverable-open"
                translate="no"
                title={t('ui.openDeliverable')}
                aria-label={`${t('ui.openDeliverable')}: ${row.path}`}
                onClick={() => open(row.path)}
              >
                {row.path}
              </button>
            ) : (
              <span className="deliverable-path" translate="no">
                {row.path}
              </span>
            )}
            {shell ? (
              <span className="deliverable-actions">
                <button
                  type="button"
                  className="deliverable-action"
                  onClick={() => shell.open(row.path)}
                >
                  {t('ui.openWithDefaultApp')}
                </button>
                <button
                  type="button"
                  className="deliverable-action"
                  onClick={() => shell.reveal(row.path)}
                >
                  {t('ui.revealInFolder')}
                </button>
              </span>
            ) : null}
            {row.description ? (
              <>
                {' — '}
                <span className="deliverable-description" translate="no">
                  {row.description}
                </span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
