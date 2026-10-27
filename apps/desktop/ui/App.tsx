/**
 * The window's one React root and provider tree. Controller initialization runs after the product hosts commit;
 * its cleanup runs on unmount and on error-boundary retry, so a retry cannot retain the previous window bindings.
 */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useLayoutEffect, type ReactNode } from 'react';
import type { DesktopActions } from './actions.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { desktopViews } from './views.tsx';
import { DesktopProviders } from './providers.tsx';
import type { DesktopRuntime } from './runtime.ts';
import { ProductShell } from './layout/ProductShell.tsx';

type Initialize = () => void | (() => void);

function ApplicationLifetime({ initialize }: { initialize?: Initialize }): ReactNode {
  useLayoutEffect(() => initialize?.(), [initialize]);
  return null;
}

export function App({
  children,
  initialize,
}: {
  children?: ReactNode;
  initialize?: Initialize;
}): ReactNode {
  return (
    <ErrorBoundary>
      {children ?? <ProductShell />}
      <ApplicationLifetime initialize={initialize} />
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
  children?: ReactNode;
  initialize?: Initialize;
}): () => void {
  const container = document.getElementById('desktop-root');
  if (!container) throw new Error('the desktop document has no #desktop-root');
  container.dataset.reactOwned = '';
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <DesktopProviders runtime={options.runtime} actions={options.actions}>
        <App initialize={options.initialize}>{options.children}</App>
      </DesktopProviders>,
    ),
  );
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      root.unmount();
    } finally {
      desktopViews.clear();
      delete container.dataset.reactOwned;
    }
  };
}
