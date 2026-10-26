/**
 * The two transition owners: page swaps and expanding panels.
 *
 * They exist so no caller writes its own durations. `PageTransition` owns the exit/enter sequence with
 * `AnimatePresence` (sequential, so two settings panels are never both on screen); `PanelTransition` wraps Mantine's
 * `Collapse` for heights. Motion's `AnimatePresence`, Mantine's `Collapse` and CSS must not animate the same property
 * twice — that is how a 60ms exit becomes 180ms of lag.
 *
 * Two behaviours are deliberate:
 *
 * - **The outgoing pane is inert at once.** A child of the animated pane calls `usePresence()`; while the pane is
 *   leaving it sets `inert` and `aria-hidden` on a wrapper, so a click during the fade cannot reach a page on its way
 *   out and a screen reader is not offered both. The `inert` lives on an inner wrapper because `AnimatePresence`
 *   animates its direct child: an exit animation belongs to the `motion.div` the presence system sees.
 * - **Reduced motion is zero, not merely short.** `useReducedMotion` is read here and at the primitive that owns a
 *   Mantine overlay, so a person who asked for no motion gets the final state in the same paint.
 */
import { Collapse } from '@mantine/core';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { usePrefersReducedMotion } from './reduced-motion.ts';
import type { ReactNode } from 'react';
import { EASING, EASING_CSS, MOTION, OFFSET_PX, seconds } from './motion-tokens.ts';

export interface PageTransitionProps {
  /** The page's identity: a settings category, `chat`, `settings`. Never a token or a message revision. */
  viewKey: string;
  kind: 'page' | 'settings';
  children: ReactNode;
}

/** Inert while leaving; `display: contents` keeps the wrapper out of the page's layout. */
function PresenceWrapper({ children }: { children: ReactNode }): ReactNode {
  // `useIsPresent`, not `usePresence`: the latter registers a removal barrier that only `safeToRemove` releases,
  // and a barrier that never releases keeps the outgoing pane on screen forever (and the incoming one from mounting).
  const present = useIsPresent();
  return (
    <div inert={!present} aria-hidden={!present} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

/**
 * One page at a time, with the outgoing one inert until its exit finishes.
 *
 * `mode="wait"` sequences exit before enter. Rapid A→B→C switches still end on C: AnimatePresence keys the child,
 * drops the intermediate target and exits whatever is present before entering the latest key.
 */
export function PageTransition({ viewKey, kind, children }: PageTransitionProps): ReactNode {
  const reduced = usePrefersReducedMotion();
  const timing = kind === 'settings' ? MOTION.settings : MOTION.page;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={viewKey}
        className="desktop-page"
        data-page-pane=""
        initial={{ opacity: 0, y: reduced ? 0 : OFFSET_PX }}
        animate={{
          opacity: 1,
          y: 0,
          transition: { duration: reduced ? 0 : seconds(timing.enter), ease: EASING },
        }}
        exit={{
          opacity: 0,
          y: 0,
          transition: { duration: reduced ? 0 : seconds(timing.exit), ease: EASING },
        }}
      >
        <PresenceWrapper>{children}</PresenceWrapper>
      </motion.div>
    </AnimatePresence>
  );
}

export interface PanelTransitionProps {
  opened: boolean;
  children: ReactNode;
}

/** Height animation for thinking blocks, tool details and verification evidence. */
export function PanelTransition({ opened, children }: PanelTransitionProps): ReactNode {
  const reduced = usePrefersReducedMotion();
  return (
    <Collapse
      expanded={opened}
      transitionDuration={reduced ? 0 : MOTION.panel}
      transitionTimingFunction={EASING_CSS}
    >
      {children}
    </Collapse>
  );
}
