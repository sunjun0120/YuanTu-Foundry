/**
 * Mount the React background popover into the header and answer the renderer's three calls.
 *
 * The snapshot is pushed in (`render`), because the window's render loop owns the carrier state; the popover's own
 * open/closed state lives beside it in the same small store, and `close()` is what the renderer calls on a session
 * switch or a settings page opening.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { createStore } from '../stores.ts';
import { registerView } from '../views.tsx';
import { BackgroundPanel, type BackgroundState } from './BackgroundPanel.tsx';

export interface BackgroundHandle {
  render(): void;
  close(): void;
  dispose(): void;
}

export function mountBackground(deps: {
  getState(): CarrierSnapshot | null;
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
}): BackgroundHandle {
  const store = createStore<BackgroundState>({ snapshot: null, open: false });
  const setOpen = (open: boolean): void => {
    const current = store.getSnapshot();
    if (current.open !== open) store.set({ ...current, open });
  };
  const host = document.getElementById('background-root');
  const disposeRegion = host
    ? registerView(
        'background',
        <BackgroundPanel store={store} invoke={deps.invoke} setOpen={setOpen} />,
      )
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
