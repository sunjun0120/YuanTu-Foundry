/**
 * Mount the React plan panel and answer the renderer's `render(plan)` call.
 *
 * The panel's key is the one the legacy module used — the plan, the waiting question, whether a command is in flight,
 * whether the gate is refused, and the locale — so a repaint that changes nothing still does nothing.
 */
import type { ReactNode } from 'react';
import type { CarrierCommand } from '../../../../packages/carrier/contract.ts';
import type { Plan } from '../../../../packages/protocol/index.ts';
import { locale } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { createStore, type ReadableStore } from '../stores.ts';
import { mountRegion } from '../legacy/mount-region.tsx';
import { PlanPanel } from './PlanPanel.tsx';
import { planView } from './plan-view.ts';

export interface PlanState {
  plan: Plan | null;
  busy: boolean;
  waiting: string | null;
}

export interface PlanHandle {
  render(plan: Plan | null): void;
  dispose(): void;
}

function PlanPanelHost({
  store,
  onAction,
}: {
  store: ReadableStore<PlanState>;
  onAction(kind: string, questionId?: string): void;
}): ReactNode {
  const state = useReadable(store);
  const lang = useLocale();
  return (
    <PlanPanel view={planView(state.plan, state.busy, state.waiting, lang)} onAction={onAction} />
  );
}

export function mountPlanPanel(actions: {
  isOperating(): boolean;
  isBusy(): boolean;
  waitingQuestion?(): string | null;
  showQuestion?(id: string): void;
  select(command: CarrierCommand): Promise<unknown>;
  setError(message: string | null): void;
}): PlanHandle {
  const store = createStore<PlanState>({ plan: null, busy: false, waiting: null });
  let key = '';
  const dispatch = (kind: string, questionId?: string): void => {
    const { plan } = store.getSnapshot();
    if (!plan) return;
    if (kind === 'question') {
      if (questionId) actions.showQuestion?.(questionId);
      return;
    }
    if (kind === 'approve') {
      void actions.select({ type: 'planApprove', planId: plan.id, hash: plan.hash });
      return;
    }
    if (kind === 'execute') {
      actions.setError(null);
      void actions.select({ type: 'planExecute', planId: plan.id });
      return;
    }
    // reject and discard are the same command; discard only has a different label.
    void actions.select({ type: 'planReject', planId: plan.id });
  };
  const host = document.getElementById('plan-root');
  const disposeRegion = host
    ? mountRegion('plan', host, <PlanPanelHost store={store} onAction={dispatch} />)
    : () => {};
  return {
    render(plan) {
      const waiting = actions.waitingQuestion?.() ?? null;
      const busy = actions.isBusy();
      const nextKey = JSON.stringify([
        waiting,
        plan?.id ?? null,
        plan?.status ?? null,
        plan?.hash ?? null,
        plan?.title ?? '',
        plan?.steps ?? [],
        plan?.reason ?? '',
        actions.isOperating(),
        busy,
        locale(),
      ]);
      if (nextKey === key) return;
      key = nextKey;
      store.set({ plan, busy, waiting });
    },
    dispose() {
      disposeRegion();
    },
  };
}
