/**
 * The plan panel's reading: which sentence the status line carries, which action the gate offers, and what the hint
 * beside it says. The panel itself is a projection; this is the part with rules.
 *
 * A waiting question outranks the plan's own status: the plan is not blocked on approval while the run is waiting on
 * an answer, and the one useful action is to go to that question. A plan still being written keeps the action that
 * leaves plan mode, labelled "exit" while nothing is running and "discard" while it is.
 */
import type { Plan } from '../../../../packages/protocol/index.ts';
import { translate } from '../../i18n.ts';
import type { UiLanguage } from '../../ui-settings.ts';

export interface PlanAction {
  kind: 'question' | 'approve' | 'reject' | 'execute' | 'discard';
  label: string;
  disabled: boolean;
  questionId?: string;
}

export interface PlanView {
  visible: boolean;
  title: string;
  status: string;
  summary: string;
  steps: string[];
  reason: string;
  actions: PlanAction[];
  hint: string | null;
}

export function planView(
  plan: Plan | null,
  busy: boolean,
  waiting: string | null,
  lang: UiLanguage,
): PlanView {
  if (!plan)
    return {
      visible: false,
      title: '',
      status: '',
      summary: '',
      steps: [],
      reason: '',
      actions: [],
      hint: null,
    };
  const waitingHere =
    waiting !== null && ['planning', 'proposed'].includes(plan.status) ? waiting : null;
  const status = waitingHere
    ? translate('plan.waitingAnswer', lang)
    : translate(
        plan.status === 'planning' && !busy
          ? 'plan.status.planningIdle'
          : `plan.status.${plan.status}`,
        lang,
      );
  const base = {
    visible: true,
    title: plan.title || translate('plan.title', lang),
    status,
    summary: plan.summary,
    steps: plan.steps.map((step) => step.description),
    reason: plan.reason ?? '',
  };
  if (waitingHere)
    return {
      ...base,
      actions: [
        {
          kind: 'question',
          label: translate('plan.showQuestion', lang),
          disabled: false,
          questionId: waitingHere,
        },
      ],
      hint: translate('plan.waitingAnswer', lang),
    };
  if (plan.status === 'proposed')
    return {
      ...base,
      actions: [
        { kind: 'approve', label: translate('plan.approve', lang), disabled: busy },
        { kind: 'reject', label: translate('plan.reject', lang), disabled: busy },
      ],
      hint: translate('plan.gateHint', lang),
    };
  if (plan.status === 'approved')
    return {
      ...base,
      actions: [{ kind: 'execute', label: translate('plan.execute', lang), disabled: busy }],
      hint: translate('plan.approvedHint', lang),
    };
  if (plan.status === 'rejected')
    return { ...base, actions: [], hint: translate('plan.rejectedHint', lang) };
  if (plan.status === 'abandoned')
    return { ...base, actions: [], hint: translate('plan.abandonedHint', lang) };
  return {
    ...base,
    actions: [
      {
        kind: 'discard',
        label: translate(busy ? 'plan.discard' : 'plan.exitMode', lang),
        disabled: busy,
      },
    ],
    hint: translate(busy ? 'plan.discardHint' : 'plan.idleHint', lang),
  };
}
