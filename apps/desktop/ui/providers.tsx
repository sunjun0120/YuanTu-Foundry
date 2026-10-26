/**
 * The one provider tree for the window: Mantine, motion, and the desktop runtime/actions.
 *
 * Everything React renders lives under this, including the portal regions, which is why there is exactly one
 * instance here rather than one per island. A second provider would mean a second theme and a second motion
 * configuration, and the two would drift the moment one of them was edited.
 *
 * Appearance and text size are read from the same document attributes the legacy settings controller writes.
 * Subscribing to those attributes is what keeps the React layer free of a second settings store: no extra
 * `uiSettings` request, no `localStorage` colour scheme, no copy of the preference that can disagree with the one
 * the rest of the window already uses.
 *
 * `getStyleNonce` hands Mantine the nonce the document's CSP authorises (`ui/nonce.ts` owns the value and the
 * reasoning). Without it Mantine's runtime `<style>` elements — CSS variables, breakpoint classes, responsive rules
 * — are refused by the product CSP and the page renders unstyled rather than failing loudly.
 */
import { MantineProvider } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { MotionConfig } from 'motion/react';
import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { DesktopProvider } from './context.tsx';
import { UI_STYLE_NONCE } from './nonce.ts';
import {
  appearanceFromDocument,
  createDesktopTheme,
  desktopCssVariablesResolver,
  fontSizeFromDocument,
  resolveColorScheme,
  resolveFontSize,
  type Appearance,
  type FontSizeName,
} from './theme.ts';
import type { DesktopActions } from './actions.ts';
import type { DesktopRuntime } from './runtime.ts';

/** Subscribe to one attribute on the document element; the settings controller writes exactly these. */
function subscribeAttribute(attribute: string, listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [attribute] });
  return () => observer.disconnect();
}

function useAppearance(): Appearance {
  return useSyncExternalStore(
    (listener) => subscribeAttribute('data-theme', listener),
    () => appearanceFromDocument(document),
  );
}

function useFontSizeName(): FontSizeName {
  return useSyncExternalStore(
    (listener) => subscribeAttribute('data-font-size', listener),
    () => fontSizeFromDocument(document),
  );
}

export function DesktopProviders({
  runtime,
  actions,
  children,
}: {
  runtime: DesktopRuntime;
  actions: DesktopActions;
  children: ReactNode;
}): ReactNode {
  const appearance = useAppearance();
  const fontSizeName = useFontSizeName();
  const base = resolveFontSize(fontSizeName);
  // `false` until the media query has an answer: an explicit light/dark choice does not consult it at all.
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)') ?? false;
  const colorScheme = resolveColorScheme(appearance, systemDark);
  const theme = useMemo(() => createDesktopTheme(base), [base]);
  return (
    <MantineProvider
      getStyleNonce={() => UI_STYLE_NONCE}
      forceColorScheme={colorScheme}
      theme={theme}
      cssVariablesResolver={desktopCssVariablesResolver}
    >
      <MotionConfig reducedMotion="user">
        <DesktopProvider runtime={runtime} actions={actions}>
          {children}
        </DesktopProvider>
      </MotionConfig>
    </MantineProvider>
  );
}
