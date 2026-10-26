/**
 * The runtime owns the bridge: one set of subscriptions, one projected snapshot, per-section stores for React.
 *
 * Three things about the bridge shape drove this file.
 *
 * **The preload mirror hands out the same object.** `SnapshotMirror.apply` keeps one `state` object and replaces
 * only the sections a patch touched, so the object a subscriber receives is *the same object* on every publish. If
 * the runtime passed that object through, `getSnapshot()` would keep returning one identity and React would never
 * re-render, while the legacy renderer's "did anything change" checks would compare an object with itself. So a
 * publish is projected onto a fresh object here, and the previous one is left untouched — a snapshot another
 * consumer kept stays what it was.
 *
 * **`changed` is a promise, not a hint.** Sections not named in `changed` keep their previous reference, which is
 * what keeps `useSection('sessions')` from re-rendering when a token arrives. A bridge that sends no `changed` (an
 * older preload, a test double) means "anything may have changed" and is treated as a full refresh, including
 * sections the new snapshot no longer has.
 *
 * **The initial snapshot races the pushes.** The runtime subscribes first and then asks for `{ type: 'snapshot' }`.
 * A publish that arrives while that request is in flight already describes a newer state; the reply is older and
 * must not move the view backwards, so it fills only when nothing has arrived yet. A failed initial request is
 * recorded as a rejection the caller can show and retry, and the subscription stays single across retries.
 */
import type { CarrierSnapshot } from '../../../packages/carrier/contract.ts';
import type { DesktopBridge } from '../contract.ts';
import { createStore, type ReadableStore, type WritableStore } from './stores.ts';

export type SnapshotSection = keyof CarrierSnapshot;
export type SnapshotListener = (
  state: CarrierSnapshot,
  changed: readonly SnapshotSection[],
) => void;
export type Dispose = () => void;

export interface DesktopRuntime {
  getSnapshot(): CarrierSnapshot | null;
  section<K extends SnapshotSection>(key: K): ReadableStore<CarrierSnapshot[K] | undefined>;
  /** The legacy renderer's seam: the projected snapshot plus the sections that actually changed. */
  onSnapshot(listener: SnapshotListener): Dispose;
  /** Establish the subscription and ask for the initial snapshot; repeated calls share one subscription. */
  start(): Promise<void>;
  dispose(): void;
}

type AnyStore = WritableStore<unknown>;

export function createDesktopRuntime(bridge: DesktopBridge): DesktopRuntime {
  let state: CarrierSnapshot | null = null;
  let subscription: Dispose | undefined;
  let started: Promise<void> | undefined;
  let failed = false;
  let disposed = false;
  const sections = new Map<SnapshotSection, AnyStore>();
  const listeners = new Set<SnapshotListener>();

  function section<K extends SnapshotSection>(
    key: K,
  ): ReadableStore<CarrierSnapshot[K] | undefined> {
    const held = sections.get(key);
    if (held) return held as unknown as ReadableStore<CarrierSnapshot[K] | undefined>;
    const created = createStore<CarrierSnapshot[K] | undefined>(state?.[key]);
    sections.set(key, created as AnyStore);
    return created;
  }

  /**
   * Project one published snapshot and tell the stores which sections moved.
   *
   * The keys to consider are the ones the bridge named, or every key in the snapshot for a full refresh; the
   * comparison is by reference against the previous projection, because that is the equality React renders with.
   */
  function receive(next: CarrierSnapshot, changed?: readonly SnapshotSection[]): void {
    if (disposed) return;
    const previous = state;
    const projected: Record<string, unknown> = { ...(previous ?? {}) };
    const named = changed?.length ? changed : (Object.keys(next) as SnapshotSection[]);
    for (const key of named) {
      const value = next[key];
      if (value === undefined) delete projected[key];
      else projected[key] = value;
    }
    // A full refresh also drops sections the published snapshot no longer carries at all.
    if (!changed?.length)
      for (const key of Object.keys(projected))
        if (!Object.hasOwn(next, key)) delete projected[key];
    const present = new Set([...Object.keys(previous ?? {}), ...Object.keys(projected)]);
    const moved = [...present].filter((key) => {
      const before = (previous as Record<string, unknown> | null)?.[key];
      return !Object.is(before, projected[key]);
    }) as SnapshotSection[];
    if (!moved.length) return;
    state = projected as unknown as CarrierSnapshot;
    for (const key of moved) sections.get(key)?.set(projected[key]);
    for (const listener of [...listeners]) listener(state, moved);
  }

  function start(): Promise<void> {
    if (disposed) return Promise.reject(new Error('the desktop runtime was disposed'));
    // One subscription for the life of the runtime; a failed initial request may be retried while nothing has
    // arrived, which re-asks for the snapshot instead of subscribing a second time.
    if (started && !(failed && !state)) return started;
    subscription ??= bridge.subscribe(receive);
    failed = false;
    started = (async () => {
      const reply = await bridge.invoke({ type: 'snapshot' });
      if (disposed) return;
      if (!reply.ok) {
        failed = true;
        // The reply is thrown as it is: the caller already knows how to show its error and detail.
        throw reply;
      }
      // A push that landed while this request was in flight is newer than the reply it raced.
      if (!state) receive(reply.state);
    })().catch((error: unknown) => {
      failed = true;
      throw error;
    });
    return started;
  }

  return {
    getSnapshot: () => state,
    section,
    onSnapshot(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    dispose() {
      if (disposed) return;
      disposed = true;
      subscription?.();
      subscription = undefined;
      listeners.clear();
    },
  };
}
