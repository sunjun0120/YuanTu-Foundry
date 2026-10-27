/**
 * Mount the approval cards and answer the renderer's `render(approvals)` call.
 *
 * A card's id stands for it — an approval does not change once raised — so the key is the ids, the busy set and the
 * language, exactly the legacy one. The busy set is the pending re-entry guard: a decision already in flight disables
 * every button on that card until the command settles.
 */
import { useEffect, type ReactNode } from 'react';
import type { Approval } from '../../../../packages/protocol/index.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { locale, t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import { useReadable } from '../context.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import { registerView } from '../views.tsx';
import { ApprovalCard } from './Approvals.tsx';
import { approvalEntries } from './approval-model.ts';

export interface ApprovalsState {
  approvals: readonly { id: string; approval: Approval }[];
  busy: ReadonlySet<string>;
}

export interface ApprovalsHandle {
  render(approvals: readonly { id: string; approval: Approval }[]): void;
  dispose(): void;
}

function ApprovalsHost({
  store,
  decide,
}: {
  store: ReadableStore<ApprovalsState>;
  decide(id: string, allow: boolean, remember: boolean): void;
}): ReactNode {
  const state = useReadable(store);
  const lang = useLocale();
  // The container is outside this portal: its accessible name follows the language like the rest of the page.
  useEffect(() => {
    document.getElementById('approvals')?.setAttribute('aria-label', t('approval.sectionLabel'));
  }, [lang]);
  return (
    <>
      {approvalEntries(state.approvals).map((entry) => (
        <ApprovalCard
          key={entry.id}
          entry={entry}
          busy={state.busy.has(entry.id)}
          onDecision={decide}
        />
      ))}
    </>
  );
}

export function mountApprovals(deps: {
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  setError(message: string | null): void;
}): ApprovalsHandle {
  const store = createStore<ApprovalsState>({ approvals: [], busy: new Set() });
  let busy = new Set<string>();
  let key = '';
  const decide = (id: string, allow: boolean, remember: boolean): void => {
    if (busy.has(id)) return;
    busy = new Set(busy).add(id);
    deps.setError(null);
    store.set({ ...store.getSnapshot(), busy });
    void deps
      .invoke({ type: 'approve', id, allow, ...(remember ? { remember: true } : {}) })
      .finally(() => {
        busy = new Set(busy);
        busy.delete(id);
        store.set({ ...store.getSnapshot(), busy });
      });
  };
  const host = document.getElementById('approvals');
  const disposeRegion = host
    ? registerView('approvals', <ApprovalsHost store={store} decide={decide} />)
    : () => {};
  return {
    render(approvals) {
      const nextKey = JSON.stringify([approvals.map((item) => item.id), [...busy], locale()]);
      if (nextKey === key) return;
      key = nextKey;
      store.set({ approvals, busy });
    },
    dispose() {
      disposeRegion();
    },
  };
}
