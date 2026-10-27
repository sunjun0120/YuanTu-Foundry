import { createStore, type ReadableStore, type WritableStore } from './stores.ts';

/** Controller-owned view values, observed independently by ordinary children of the application tree. */
export function createViewRegistry<T>() {
  const entries = new Map<string, { store: WritableStore<T | null>; owner: symbol | null }>();
  const entry = (name: string) => {
    let value = entries.get(name);
    if (!value) {
      value = { store: createStore<T | null>(null), owner: null };
      entries.set(name, value);
    }
    return value;
  };
  return {
    view(name: string): ReadableStore<T | null> {
      return entry(name).store;
    },
    register(name: string, value: T): () => void {
      const current = entry(name);
      const owner = Symbol(name);
      current.owner = owner;
      current.store.set(value);
      return () => {
        if (current.owner !== owner) return;
        current.owner = null;
        current.store.set(null);
      };
    },
    clear(): void {
      for (const value of entries.values()) {
        value.owner = null;
        value.store.set(null);
      }
    },
  };
}
