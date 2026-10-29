/**
 * Every duration and curve the React layer animates with, in one table.
 *
 * Two units live here because two systems animate: Motion takes seconds, CSS/Mantine take milliseconds. Keeping
 * both next to the intent — a page exit is shorter than its enter, an overlay enters slower than it leaves — is
 * what stops every call site from inventing its own number. A wrapper converts; no component does the arithmetic.
 *
 * Nothing here is a business signal: navigation, sending and busy state change immediately, and an animation that
 * ends late must never decide them.
 */
export const MOTION = {
  /** Chat page ↔ settings page: the outgoing view leaves fast, the incoming one settles more slowly. */
  page: { exit: 60, enter: 120 },
  /** Switching a settings category: the same shape, tighter. */
  settings: { exit: 50, enter: 100 },
  /** Session sidebar width and its content offset, matching the reference's compact rail transition. */
  sidebar: 280,
  /** Workspace open/close and enlarge/restore, matching the reference window's width transition. */
  workspace: 480,
  /** Menus, popovers, tooltips. */
  overlay: { enter: 140, exit: 120 },
  /** Dialogs and drawers. */
  modal: { enter: 160, exit: 120 },
  /** Thinking, tool details and verification evidence expanding. */
  panel: 180,
  /** Button colour changes. */
  hover: 100,
  /** A message container's first appearance. */
  message: 120,
  /** Content fading in when the session changes; the transcript itself does not animate. */
  session: 120,
} as const;

/** Shared easing: a slight ease-out that reads as "settled" without overshoot. */
export const EASING = [0.2, 0, 0, 1] as const;
/** The same curve for CSS, where a cubic-bezier string is what a transition needs. */
export const EASING_CSS = 'cubic-bezier(0.2, 0, 0, 1)';
/** Page content moves up to this many pixels on entry; more would read as a slide. */
export const OFFSET_PX = 4;
/** Overlay content starts at this scale; 0.98 is visible as a settle, 0.9 would read as a bounce. */
export const SCALE_FROM = 0.98;

/** Motion's unit is seconds. */
export function seconds(milliseconds: number): number {
  return milliseconds / 1000;
}

/**
 * The props a Mantine overlay takes so its built-in transition matches the table and honours reduced motion.
 *
 * A caller with `useReducedMotion()` passes the result straight through: zero when the person asked for no motion,
 * the shared curve otherwise.
 */
export function overlayTransition(reduced: boolean): {
  transitionDuration: number;
  transitionTimingFunction: string;
} {
  return {
    transitionDuration: reduced ? 0 : MOTION.overlay.enter,
    transitionTimingFunction: EASING_CSS,
  };
}
