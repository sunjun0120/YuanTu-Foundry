/**
 * Transitional view state, shared between the old DOM renderer and the React layer.
 *
 * T5 needs one piece of it: the in-flight command counter. The old renderer had a single `operation` boolean, so a
 * second command that finished could clear the flag while a first was still running and the UI would offer buttons
 * it must not. The counter makes "is anything in flight" the question, and every command owns exactly one id —
 * `end()` of an id that was never begun is a no-op rather than a way to unlock somebody else's operation.
 *
 * Page selection, composer drafts and expansion state are added here by the regions that own them (T10 onwards);
 * they are deliberately not guessed at now, because a draft belongs to a session and a page belongs to the shell,
 * and inventing a shape before either exists is how two owners end up with two copies.
 */
export interface PendingOperations {
  /** Mark one operation in flight; the id belongs to this operation alone. */
  begin(): string;
  /** End exactly that operation; ids that already ended are ignored. */
  end(id: string): void;
  /** Whether any operation is still in flight. */
  isOperating(): boolean;
  /** How many are in flight, for tests and diagnostics. */
  size(): number;
}

export function createPendingOperations(): PendingOperations {
  let next = 0;
  const pending = new Set<string>();
  return {
    begin() {
      next += 1;
      const id = `operation-${next}`;
      pending.add(id);
      return id;
    },
    end(id) {
      pending.delete(id);
    },
    isOperating: () => pending.size > 0,
    size: () => pending.size,
  };
}
