import type { TodoItem } from './index.ts';
/** The facts about an item that a reader cares about: a plan line is its text and where it stands. */
export interface TodoLine {
  id: string;
  content: string;
  status: TodoItem['status'];
}
export interface TodoEdit {
  id: string;
  content: string;
  from: { content: string; status: TodoItem['status'] };
  to: { content: string; status: TodoItem['status'] };
}
export interface TodoMove {
  id: string;
  content: string;
  /** Position in the list it left and in the list it arrived in, both zero-based. */
  from: number;
  to: number;
}
/**
 * What one `todo_write` did to the list it replaced.
 *
 * The model replaces the whole checklist on every call, so "the current list" is never the interesting
 * question on its own: a plan that is being followed changes item by item — something is added, something is
 * dropped, an item is reworded or completed — and a reader who only sees the new list has to diff two versions
 * in their head. This is that diff, computed once, in one place, so the panel, the CLI and any future carrier
 * describe a plan change the same way.
 */
export interface TodoChange {
  added: TodoLine[];
  removed: TodoLine[];
  updated: TodoEdit[];
  moved: TodoMove[];
}
const line = (todo: TodoItem): TodoLine => ({
  id: todo.id,
  content: todo.content,
  status: todo.status,
});
/**
 * The longest common subsequence of two id lists, as a set.
 *
 * Used for `moved`, and the reason is worth stating: comparing positions directly reports a move for every
 * item *after* a deletion, which is noise — deleting item 2 of 10 did not move items 3–10, it shortened the
 * list. Items that keep their order relative to each other are therefore stable, and only the ones that do not
 * are moves. That is the minimal set a reader can act on, at the cost of describing a swap as one move rather
 * than two.
 */
/**
 * The position of each surviving item *among the surviving items*, keyed by id.
 *
 * Comparing raw list indices reports a move for everything after a deletion — deleting item 2 of 10 did not
 * move items 3–10, it shortened the list — so positions are counted with the added and removed items taken
 * out. What is left is a reordering, reported for every item whose place in it changed: a swap is "both
 * moved", which is what a reader sees, rather than a minimal set that would have to pick one of the two and
 * stay silent about the other.
 */
function ranks(ids: string[], present: Set<string>): Map<string, number> {
  const ranks = new Map<string, number>();
  let rank = 0;
  for (const id of ids) if (present.has(id)) ranks.set(id, rank++);
  return ranks;
}
/**
 * What changed between two versions of the checklist.
 *
 * In the list world an item is its `id`, so an id that survives is the same line of the plan however its text
 * or status changed; a reworded item is an update rather than a removal plus an addition. Order is stable and
 * meaningful for a reader: additions and updates come back in the new list's order, removals in the old one's.
 */
export function todoDiff(previous: TodoItem[], next: TodoItem[]): TodoChange {
  const before = new Map(previous.map((todo) => [todo.id, todo]));
  const after = new Map(next.map((todo) => [todo.id, todo]));
  const survivors = new Set([...before.keys()].filter((id) => after.has(id)));
  const was = ranks(
    previous.map((todo) => todo.id),
    survivors,
  );
  const now = ranks(
    next.map((todo) => todo.id),
    survivors,
  );
  return {
    added: next.filter((todo) => !before.has(todo.id)).map(line),
    removed: previous.filter((todo) => !after.has(todo.id)).map(line),
    updated: next
      .filter((todo) => {
        const was = before.get(todo.id);
        return was && (was.content !== todo.content || was.status !== todo.status);
      })
      .map((todo) => {
        const was = before.get(todo.id)!;
        return {
          id: todo.id,
          content: todo.content,
          from: { content: was.content, status: was.status },
          to: { content: todo.content, status: todo.status },
        };
      }),
    moved: next
      .filter((todo) => survivors.has(todo.id) && was.get(todo.id) !== now.get(todo.id))
      .map((todo) => ({
        id: todo.id,
        content: todo.content,
        from: previous.findIndex((entry) => entry.id === todo.id),
        to: next.findIndex((entry) => entry.id === todo.id),
      })),
  };
}
export function isEmptyTodoChange(change: TodoChange): boolean {
  return (
    !change.added.length && !change.removed.length && !change.updated.length && !change.moved.length
  );
}
/**
 * The change as one line, or `null` when the write changed nothing.
 *
 * Deliberately counts-only: this is the notice a carrier prints next to the checklist, and the checklist
 * itself is one line below it. The empty result is not an empty string, because "the plan changed in no way"
 * and "there is nothing to say" have to be distinguishable by a caller that only prints when there is
 * something to print.
 */
export function describeTodoChange(change: TodoChange): string | null {
  if (isEmptyTodoChange(change)) return null;
  const parts: string[] = [];
  if (change.added.length) parts.push(`+${change.added.length} added`);
  if (change.removed.length) parts.push(`-${change.removed.length} removed`);
  if (change.updated.length) parts.push(`~${change.updated.length} updated`);
  if (change.moved.length) parts.push(`>${change.moved.length} moved`);
  return parts.join(', ');
}
