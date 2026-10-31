import type { SessionEvent } from '../storage/events.ts';
import type { SessionStore } from '../storage/sqlite.ts';

/**
 * A fold over a session's log, cached per store and continued from the last seq seen, so frequent
 * readers pay for what changed rather than the session's age. Valid because the log is append-only;
 * `firstSeq` detects a replaced log and restarts the fold.
 */
interface Projection<T> {
  firstSeq: number;
  seq: number;
  state: T;
}

/** Sessions kept per store and per fold; the least recently read is dropped first. */
const PROJECTED_SESSIONS = 32;

export interface LogProjection<T> {
  /** The fold up to the newest event. The state is the projection's own: callers copy what they hand out. */
  read(store: SessionStore, sessionId: string): T;
}

export function logProjection<T>(
  init: () => T,
  fold: (state: T, event: SessionEvent) => void,
): LogProjection<T> {
  const stores = new WeakMap<SessionStore, Map<string, Projection<T>>>();
  return {
    read(store, sessionId) {
      // Inside a transaction the tail may still be rolled back, and a rolled-back seq can be issued again: fold from
      // scratch and keep nothing, exactly as the journal keeps no log cache while one is open.
      if (store.inTransaction) {
        const state = init();
        for (const event of store.events(sessionId)) fold(state, event);
        return state;
      }
      let sessions = stores.get(store);
      if (!sessions) stores.set(store, (sessions = new Map()));
      const firstSeq = store.events(sessionId, 0, 1)[0]?.seq ?? 0;
      let projection = sessions.get(sessionId);
      if (!projection || projection.firstSeq !== firstSeq)
        projection = { firstSeq, seq: 0, state: init() };
      for (const event of store.events(sessionId, projection.seq)) {
        fold(projection.state, event);
        projection.seq = event.seq;
      }
      // Re-inserted so the map's order is recency, and the oldest entry is the one evicted.
      sessions.delete(sessionId);
      sessions.set(sessionId, projection);
      while (sessions.size > PROJECTED_SESSIONS) sessions.delete(sessions.keys().next().value!);
      return projection.state;
    },
  };
}
