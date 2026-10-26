/**
 * The one external-store shape the React layer subscribes to.
 *
 * `useSyncExternalStore` asks for a stable `subscribe` function and a `getSnapshot` that returns the *same*
 * reference until the value changes — anything else turns every render into a re-read, or every push into an
 * infinite loop. `createStore` is small enough to be obviously correct about both: the value is replaced only by
 * `set`, and `Object.is` is the equality, so a section that did not change keeps its reference.
 *
 * React is not imported here: these stores are also constructed by the runtime outside a React tree (and by the
 * Node tests), which is the point of keeping the state layer separate from the view layer.
 */
export type Dispose = () => void;

export interface ReadableStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): Dispose;
}

export interface WritableStore<T> extends ReadableStore<T> {
  set(value: T): void;
}

export function createStore<T>(initial: T): WritableStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      // A listener may unsubscribe while it runs; iterate over the set as it was when the value changed.
      for (const listener of [...listeners]) listener();
    },
  };
}
