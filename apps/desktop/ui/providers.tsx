/**
 * The one provider tree for the window: Mantine, motion, and the desktop runtime/actions.
 *
 * Everything React renders lives under this, including the portal regions, which is why there is exactly one
 * instance here rather than one per island. A second provider would mean a second theme and a second motion
 * configuration, and the two would drift the moment one of them was edited.
 *
 * `getStyleNonce` hands Mantine the nonce the document's CSP authorises (`ui/nonce.ts` owns the value and the
 * reasoning). Without it Mantine's runtime `<style>` elements — CSS variables, breakpoint classes, responsive rules
 * — are refused by the product CSP and the page renders unstyled rather than failing loudly.
 */
import { MantineProvider } from '@mantine/core';
import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { DesktopProvider } from './context.tsx';
import { UI_STYLE_NONCE } from './nonce.ts';
import type { DesktopActions } from './actions.ts';
import type { DesktopRuntime } from './runtime.ts';

export function DesktopProviders({
  runtime,
  actions,
  children,
}: {
  runtime: DesktopRuntime;
  actions: DesktopActions;
  children: ReactNode;
}): ReactNode {
  return (
    <MantineProvider getStyleNonce={() => UI_STYLE_NONCE}>
      <MotionConfig reducedMotion="user">
        <DesktopProvider runtime={runtime} actions={actions}>
          {children}
        </DesktopProvider>
      </MotionConfig>
    </MantineProvider>
  );
}
