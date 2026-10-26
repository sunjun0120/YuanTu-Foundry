/**
 * The window's shell: one Mantine `AppShell` with the three regions the migration needs.
 *
 * The old window is a CSS grid on `body`; the shell has to replace that grid without introducing a second one.
 * `Navbar` is the session/settings navigation, `Main` is the current page and owns the only scroll container, and
 * `Aside` is the workspace panel. The composer is part of `Main`, not a window-wide footer: a footer would cover
 * the transcript and the old layout never did.
 *
 * The component holds no snapshot and no business state. A shell that read the carrier would re-render on every
 * token; it receives already-rendered nodes and the two visibility flags the old layout already had.
 */
import { AppShell } from '@mantine/core';
import type { ReactNode } from 'react';
import { EASING_CSS, MOTION } from '../motion-tokens.ts';
import { usePrefersReducedMotion } from '../reduced-motion.ts';

export interface DesktopShellProps {
  navbar: ReactNode;
  main: ReactNode;
  aside?: ReactNode;
  /** Desktop widths; the window's minimum size keeps the shell in its desktop layout. */
  navbarWidth?: number;
  asideWidth?: number;
  navbarVisible?: boolean;
  asideVisible?: boolean;
}

export function DesktopShell({
  navbar,
  main,
  aside,
  navbarWidth = 264,
  asideWidth = 360,
  navbarVisible = true,
  asideVisible = false,
}: DesktopShellProps): ReactNode {
  // The sidebar offset is AppShell's own transition; the shell only supplies the duration, and zero under reduce.
  const reduced = usePrefersReducedMotion();
  return (
    <AppShell
      className="desktop-shell"
      padding={0}
      transitionDuration={reduced ? 0 : MOTION.sidebar}
      transitionTimingFunction={EASING_CSS}
      // `xs` so the desktop layout never collapses inside the window's allowed sizes; the window is not a phone.
      navbar={{ width: navbarWidth, breakpoint: 'xs', collapsed: { desktop: !navbarVisible } }}
      aside={{ width: asideWidth, breakpoint: 'xs', collapsed: { desktop: !asideVisible } }}
    >
      <AppShell.Navbar className="desktop-shell-navbar">{navbar}</AppShell.Navbar>
      <AppShell.Main className="desktop-shell-main">
        <div className="desktop-shell-content">{main}</div>
      </AppShell.Main>
      {aside && asideVisible ? (
        <AppShell.Aside className="desktop-shell-aside">{aside}</AppShell.Aside>
      ) : null}
    </AppShell>
  );
}
