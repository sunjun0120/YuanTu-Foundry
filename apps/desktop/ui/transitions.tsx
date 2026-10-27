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
import { useState, type ReactNode } from 'react';
import { EASING, EASING_CSS, MOTION, OFFSET_PX, seconds } from './motion-tokens.ts';

export interface PageTransitionProps {
  /** The page's identity: a settings category, `chat`, `settings`. Never a token or a message revision. */
  viewKey: string;
  kind: 'page' | 'settings';
  children: ReactNode;
  /** Persistent product pages keep drafts, focusable controls and history nodes mounted. */
  active?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
  focusId?: string;
}

function PersistentPage({
  active = true,
  kind,
  viewKey,
  children,
  focusId,
  ...attributes
}: PageTransitionProps): ReactNode {
  const reduced = usePrefersReducedMotion();
  const timing = kind === 'settings' ? MOTION.settings : MOTION.page;
  const [presence, setPresence] = useState({ target: active, mounted: active });
  // Derive presence from a new target without an effect or an asynchronous callback deciding navigation.
  if (presence.target !== active)
    setPresence({ target: active, mounted: active || presence.mounted });
  return (
    <motion.section
      {...attributes}
      data-page-pane=""
      data-page-view={viewKey}
      data-page-active={String(active)}
      hidden={!active && (reduced || !presence.mounted)}
      inert={!active}
      aria-hidden={!active}
      initial={false}
      animate={{ opacity: active ? 1 : 0, y: active || reduced ? 0 : OFFSET_PX }}
      transition={{
        duration: reduced ? 0 : seconds(active ? timing.enter : timing.exit),
        delay: !reduced && active ? seconds(timing.exit) : 0,
        ease: EASING,
      }}
      onAnimationComplete={() => {
        if (!active)
          setPresence((current) =>
            current.target || !current.mounted ? current : { target: false, mounted: false },
          );
        else if (focusId) {
          const focused = document.activeElement;
          // A person may already be using a field or its popup during entry. Never steal that focus later.
          if (
            !focused ||
            focused === document.body ||
            focused.closest('[hidden], [inert], [aria-hidden="true"]')
          )
            document.getElementById(focusId)?.focus({ preventScroll: true });
        }
      }}
    >
      {children}
    </motion.section>
  );
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
export function PageTransition(props: PageTransitionProps): ReactNode {
  if (props.active !== undefined) return <PersistentPage {...props} />;
  return <TransientPage {...props} />;
}

function TransientPage({ viewKey, kind, children }: PageTransitionProps): ReactNode {
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
  /** Runs when the height transition finishes, whatever its direction. */
  onTransitionEnd?(): void;
}

/**
 * Height animation for thinking blocks, tool details and verification evidence.
 *
 * `keepMountedMode` is `display-none`, not Mantine's default `activity`: the transcript adapter moves the live thought
 * into a collapsed fold's `.process-steps` synchronously inside the commit, and React 19 `Activity` does not render
 * hidden children during that commit — the thought would be dropped and the fold's summary left blank.
 */
export function PanelTransition({
  opened,
  children,
  onTransitionEnd,
}: PanelTransitionProps): ReactNode {
  const reduced = usePrefersReducedMotion();
  return (
    <Collapse
      expanded={opened}
      transitionDuration={reduced ? 0 : MOTION.panel}
      transitionTimingFunction={EASING_CSS}
      keepMounted
      keepMountedMode="display-none"
      onTransitionEnd={onTransitionEnd}
    >
      {children}
    </Collapse>
  );
}
