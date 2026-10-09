/**
 * The plan panel and its approval gate.
 *
 * Approve is the only path to execution, and it sends back the plan's digest: the host re-checks that
 * digest when execution starts, so a plan edited between the two steps cannot run unreviewed.
 *
 * The panel is repainted from a key rather than rebuilt, and the key carries the locale as well as the plan:
 * a language change leaves the plan identical, and without the locale the guard treated an unchanged plan as
 * an unchanged panel. What the key holds is fixed by what it held before this module was extracted — the
 * window's own in-flight command — while what disables the buttons is the wider "the window is busy" question.
 */
import type { CarrierCommand } from '../../packages/carrier/contract.ts';
import type { Plan } from '../../packages/protocol/index.ts';
import { locale, t } from './i18n.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

export function setupPlanPanel(actions: {
  /** Whether a command this window issued is still in flight; part of the panel's key, not of its gate. */
  isOperating(): boolean;
  /** Whether the gate's buttons are refused: the session is running, or a command of this window is. */
  isBusy(): boolean;
  select(command: CarrierCommand): void;
}): { render(plan: Plan | null): void } {
  let planKey = '';
  function render(plan: Plan | null): void {
    const panel = required('plan-panel');
    panel.hidden = !plan;
    if (!plan) return;
    const key = JSON.stringify([
      plan.id,
      plan.status,
      plan.hash,
      plan.title,
      plan.steps,
      plan.reason ?? '',
      actions.isOperating(),
      // The locale is part of the key: without it a language change left the panel in the old language,
      // because the guard treated an unchanged plan as an unchanged panel.
      locale(),
    ]);
    if (key === planKey) return;
    planKey = key;
    required('plan-title').textContent = plan.title || t('plan.title');
    required('plan-status').textContent = t(`plan.status.${plan.status}`);
    required('plan-summary').textContent = plan.summary;
    required('plan-summary').hidden = !plan.summary;
    required('plan-steps').replaceChildren(
      ...plan.steps.map((step) => node('li', step.description)),
    );
    const reason = required('plan-reason');
    reason.textContent = plan.reason ?? '';
    reason.hidden = !plan.reason;
    const actionsElement = required('plan-actions');
    actionsElement.replaceChildren();
    const busy = actions.isBusy();
    if (plan.status === 'proposed') {
      const approve = node('button', t('plan.approve'), 'plan-approve');
      approve.disabled = busy;
      approve.addEventListener(
        'click',
        () => void actions.select({ type: 'planApprove', planId: plan.id, hash: plan.hash }),
      );
      const reject = node('button', t('plan.reject'), 'plan-reject');
      reject.disabled = busy;
      reject.addEventListener(
        'click',
        () => void actions.select({ type: 'planReject', planId: plan.id }),
      );
      actionsElement.append(approve, reject, node('span', t('plan.gateHint'), 'plan-hint'));
    } else if (plan.status === 'approved') {
      const execute = node('button', t('plan.execute'), 'plan-execute');
      execute.disabled = busy;
      execute.addEventListener(
        'click',
        () => void actions.select({ type: 'planExecute', planId: plan.id }),
      );
      actionsElement.append(execute, node('span', t('plan.approvedHint'), 'plan-hint'));
    } else if (plan.status === 'rejected') {
      actionsElement.append(node('span', t('plan.rejectedHint'), 'plan-hint'));
    } else if (plan.status === 'abandoned') {
      // The run that was filling this plan is gone, so nothing is in progress: saying "planning" here was the one
      // reading a person could not act on, because there is no plan to wait for and no run to stop.
      actionsElement.append(node('span', t('plan.abandonedHint'), 'plan-hint'));
    } else {
      /**
       * A plan still being written keeps the session in plan mode, so it needs the one action that leaves it.
       *
       * The host continues planning for a session whose newest plan is `planning` — that is what the row means, and
       * it is the same rule the CLI's `resume` follows — so a person who changed their mind would otherwise be
       * pinned to a read-only session with nothing to click. Discarding is a rejection with a different label: the
       * row never carried a body to approve, so there is nothing to keep.
       */
      const discard = node('button', t('plan.discard'), 'plan-discard');
      discard.disabled = busy;
      discard.addEventListener(
        'click',
        () => void actions.select({ type: 'planReject', planId: plan.id }),
      );
      actionsElement.append(discard, node('span', t('plan.discardHint'), 'plan-hint'));
    }
  }
  return { render };
}
