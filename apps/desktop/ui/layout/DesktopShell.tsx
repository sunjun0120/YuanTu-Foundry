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
  asideExpanded?: boolean;
}

export function DesktopShell({
  navbar,
  main,
  aside,
  navbarWidth = 264,
  asideWidth = 360,
  navbarVisible = true,
  asideVisible = false,
  asideExpanded = false,
}: DesktopShellProps): ReactNode {
  // Registered lengths animate the regions and their AppShell offsets together, including an interrupted reversal.
  const reduced = usePrefersReducedMotion();
  return (
    <AppShell
      className="desktop-shell"
      style={{
        '--desktop-navbar-width': `${navbarVisible ? navbarWidth : 0}px`,
        '--desktop-aside-width': !asideVisible
          ? '0px'
          : asideExpanded
            ? 'calc(100vw - var(--desktop-navbar-width))'
            : `${asideWidth}px`,
        // AppShell's generated variables live on :root; bind the offsets here so they read the animated local sizes.
        '--app-shell-navbar-width': 'var(--desktop-navbar-width)',
        '--app-shell-navbar-offset': 'var(--desktop-navbar-width)',
        '--app-shell-aside-width':
          'min(var(--desktop-aside-width), calc(100vw - var(--desktop-navbar-width)))',
        '--app-shell-aside-offset': 'var(--app-shell-aside-width)',
        transitionProperty: '--desktop-navbar-width, --desktop-aside-width',
        transitionDuration: reduced ? '0ms' : `${MOTION.sidebar}ms, ${MOTION.workspace}ms`,
        transitionTimingFunction: EASING_CSS,
      }}
      padding={0}
      transitionDuration={reduced ? 0 : MOTION.sidebar}
      transitionTimingFunction={EASING_CSS}
      // `xs` so the desktop layout never collapses inside the window's allowed sizes; the window is not a phone.
      navbar={{
        width: 'var(--desktop-navbar-width)',
        breakpoint: 'xs',
        collapsed: { desktop: !navbarVisible },
      }}
      aside={{
        width: 'min(var(--desktop-aside-width), calc(100vw - var(--desktop-navbar-width)))',
        breakpoint: 'xs',
        collapsed: { desktop: false },
      }}
    >
      <AppShell.Navbar className="desktop-shell-navbar">{navbar}</AppShell.Navbar>
      <AppShell.Main className="desktop-shell-main" style={{ transitionProperty: 'none' }}>
        <div className="desktop-shell-content">{main}</div>
      </AppShell.Main>
      {aside ? (
        <AppShell.Aside
          className="desktop-shell-aside"
          aria-hidden={!asideVisible}
          inert={!asideVisible}
          style={{
            overflow: 'hidden',
            visibility: asideVisible ? 'visible' : 'hidden',
            transitionProperty: 'visibility',
            transitionDuration: '0ms',
            transitionDelay: asideVisible || reduced ? '0ms' : `${MOTION.workspace}ms`,
          }}
        >
          {aside}
        </AppShell.Aside>
      ) : null}
    </AppShell>
  );
}
