/**
 * The reduced-motion preference as a subscription.
 *
 * Motion's own `useReducedMotion` reads `prefers-reduced-motion` once, at first render (its implementation keeps the
 * initial value in `useState` and does not subscribe). A person who turns the setting on while the window is open
 * would then keep seeing full motion until a reload — which is exactly the case the migration's reduced-motion
 * requirement names. This hook subscribes to the media query instead, so a change re-renders the owners of the
 * animation (page transitions, overlays, the shell) with a zero duration in the same frame.
 *
 * `MotionConfig reducedMotion="user"` stays in the provider for Motion's own internals; project animations read this
 * hook, because it is the one that can change at run time.
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function snapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}
