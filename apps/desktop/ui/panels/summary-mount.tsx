/**
 * Mount the summary popover into the header and answer the renderer's calls, the same shape as the background list:
 * the snapshot is pushed in by the window's render loop, and `close()` runs on a session switch or settings opening.
 */
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { createStore } from '../stores.ts';
import { registerView } from '../views.tsx';
import { SummaryPanel, type SummaryState } from './SummaryPanel.tsx';

export interface SummaryHandle {
  render(): void;
  close(): void;
  dispose(): void;
}

export function mountSummary(deps: { getState(): CarrierSnapshot | null }): SummaryHandle {
  const store = createStore<SummaryState>({ snapshot: null, open: false });
  const setOpen = (open: boolean): void => {
    const current = store.getSnapshot();
    if (current.open !== open) store.set({ ...current, open });
  };
  const host = document.getElementById('summary-root');
  const disposeRegion = host
    ? registerView('summary', <SummaryPanel store={store} setOpen={setOpen} />)
    : () => {};
  return {
    render() {
      const current = store.getSnapshot();
      const snapshot = deps.getState();
      if (current.snapshot !== snapshot) store.set({ ...current, snapshot });
    },
    close() {
      setOpen(false);
    },
    dispose() {
      disposeRegion();
    },
  };
}
