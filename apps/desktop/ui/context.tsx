/**
 * The React seam onto the runtime and its actions.
 *
 * The context carries instances only — never snapshot data. A provider value that held the snapshot would
 * re-render every consumer on every push, which is the thing the per-section stores exist to avoid. Components read
 * the slice they need with `useSection`, so a statistics delta that changes `session` does not touch the session
 * list, and a new message does not touch the settings page.
 *
 * `useReadable`/`useSection` go through `useSyncExternalStore` for the reason its documentation gives: it is the
 * one hook that reads an external value without tearing, and it re-reads the store when React decides to render
 * rather than during the push.
 */
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { CarrierSnapshot } from '../../../packages/carrier/contract.ts';
import type { DesktopActions } from './actions.ts';
import type { DesktopRuntime } from './runtime.ts';
import type { ReadableStore } from './stores.ts';

export interface DesktopContextValue {
  runtime: DesktopRuntime;
  actions: DesktopActions;
}

const DesktopContext = createContext<DesktopContextValue | null>(null);

export function DesktopProvider({
  runtime,
  actions,
  children,
}: DesktopContextValue & { children: ReactNode }): ReactNode {
  const value = useMemo(() => ({ runtime, actions }), [runtime, actions]);
  return <DesktopContext.Provider value={value}>{children}</DesktopContext.Provider>;
}

export function useDesktop(): DesktopContextValue {
  const value = useContext(DesktopContext);
  if (!value) throw new Error('useDesktop must be used inside <DesktopProvider>');
  return value;
}

export function useReadable<T>(store: ReadableStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useSection<K extends keyof CarrierSnapshot>(
  key: K,
): CarrierSnapshot[K] | undefined {
  const { runtime } = useDesktop();
  return useReadable(runtime.section(key));
}
