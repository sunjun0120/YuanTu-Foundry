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
      // A bridge may retain its outer snapshot object while replacing sections. Publish a fresh reading on
      // every render so an open popover follows the new turn and live tool results in that case as well.
      store.set({ ...current, snapshot: snapshot ? { ...snapshot } : null });
    },
    close() {
      setOpen(false);
    },
    dispose() {
      disposeRegion();
    },
  };
}
