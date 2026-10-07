import type { Message } from '../../packages/protocol/index.ts';

/** Compare JSON message values without allocating another copy of long text or image data. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}

/** Holds only the currently displayed window, and drops all views on session or locale changes. */
export class TranscriptCache<T> {
  private identity = '';
  private entries = new Map<number, { message: Message; view: T }>();
  views(
    identity: string,
    messages: { index: number; message: Message }[],
    build: (message: Message) => T,
  ): T[] {
    if (identity !== this.identity) this.entries.clear();
    this.identity = identity;
    const next = new Map<number, { message: Message; view: T }>();
    const views = messages.map(({ index, message }) => {
      const previous = this.entries.get(index);
      const entry =
        previous && equal(previous.message, message) ? previous : { message, view: build(message) };
      next.set(index, entry);
      return entry.view;
    });
    this.entries = next;
    return views;
  }
}

/** Move only changed positions; untouched nodes retain selection, focus and open folds. */
export function reconcileChildren(parent: HTMLElement, children: HTMLElement[]): void {
  let current = parent.firstChild;
  for (const child of children) {
    if (current !== child) parent.insertBefore(child, current);
    current = child.nextSibling;
  }
  while (current) {
    const next = current.nextSibling;
    parent.removeChild(current);
    current = next;
  }
}
