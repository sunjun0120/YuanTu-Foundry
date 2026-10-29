/**
 * The plan panel and its approval gate, as a projection of `plan-view.ts`.
 *
 * Approve is the only path to execution and it sends the plan's digest back; the model decides which actions exist,
 * this component only draws them and forwards the click.
 */
import type { ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import type { PlanView } from './plan-view.ts';
import { ProgressMark } from './ProgressMark.tsx';

export function PlanPanel({
  view,
  onAction,
}: {
  view: PlanView;
  onAction(kind: string, questionId?: string): void;
}): ReactNode {
  useLocale();
  const label = t('plan.title');
  if (!view.visible)
    return <section id="plan-panel" className="plan-panel" aria-label={label} hidden />;
  const buttons = view.actions.map((action) => (
    <button
      key={action.kind}
      type="button"
      className={`plan-${action.kind}`}
      disabled={action.disabled}
      onClick={() => onAction(action.kind, action.questionId)}
    >
      {action.label}
    </button>
  ));
  const waiting = view.actions.some((action) => action.kind === 'question');
  return (
    <section id="plan-panel" className="plan-panel" aria-label={label}>
      <header className="plan-head">
        <strong id="plan-title" translate="no">
          {view.title}
        </strong>
        <span id="plan-status" className="plan-status">
          {view.status}
        </span>
      </header>
      <p id="plan-summary" className="plan-summary" translate="no" hidden={!view.summary}>
        {view.summary}
      </p>
      <ol id="plan-steps" className="plan-steps" translate="no">
        {view.steps.map((step, index) => (
          <li key={index} className="progress-row">
            <ProgressMark />
            <span className="progress-label">{step}</span>
          </li>
        ))}
      </ol>
      <p id="plan-reason" className="plan-reason" translate="no" hidden={!view.reason}>
        {view.reason}
      </p>
      <div id="plan-actions" className="plan-actions">
        {waiting ? <span className="plan-hint">{view.hint}</span> : null}
        {buttons}
        {waiting ? null : <span className="plan-hint">{view.hint ?? ''}</span>}
      </div>
    </section>
  );
}
