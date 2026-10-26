/**
 * The React entry the legacy renderer calls once: create the root, wrap it in the single provider tree, draw the
 * regions that have been handed over.
 *
 * `App` stays this small on purpose. The migration's whole shape is "legacy DOM with React regions until nothing
 * legacy is left", so the app is the region host plus the error boundary that catches a region's failure without
 * unmounting the rest of the window. The shell (`DesktopShell`/`AppShell`) replaces this at T24.
 */
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { DesktopActions } from './actions.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { RegionHost } from './legacy/mount-region.tsx';
import { DesktopProviders } from './providers.tsx';
import type { DesktopRuntime } from './runtime.ts';

export function App(): ReactNode {
  return (
    <ErrorBoundary>
      <RegionHost />
    </ErrorBoundary>
  );
}

/**
 * Mount the React root into `#desktop-root`; the returned disposer unmounts and clears the React-owned marker.
 *
 * The container is part of the product document (T6), so a missing one means the HTML and the bundle disagree —
 * throwing here is better than rendering into a detached node nobody can see.
 */
export function mountDesktopApp(options: {
  runtime: DesktopRuntime;
  actions: DesktopActions;
}): () => void {
  const container = document.getElementById('desktop-root');
  if (!container) throw new Error('the desktop document has no #desktop-root');
  container.dataset.reactOwned = '';
  const root = createRoot(container);
  root.render(
    <DesktopProviders runtime={options.runtime} actions={options.actions}>
      <App />
    </DesktopProviders>,
  );
  return () => {
    root.unmount();
    delete container.dataset.reactOwned;
  };
}
