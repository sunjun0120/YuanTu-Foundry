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
 * What one `todo_write` did to the list it replaced, computed once so every carrier describes plan
 * changes the same way.
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
 * Each surviving item's position among the surviving items, so a deletion does not report every
 * later item as moved. A swap reports both items.
 */
function ranks(ids: string[], present: Set<string>): Map<string, number> {
  const ranks = new Map<string, number>();
  let rank = 0;
  for (const id of ids) if (present.has(id)) ranks.set(id, rank++);
  return ranks;
}
/**
 * What changed between two checklist versions. An item is its `id`, so rewording is an update.
 * Additions and updates follow the new order, removals the old.
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
/** The change as one counts-only line, or `null` when nothing changed. */
export function describeTodoChange(change: TodoChange): string | null {
  if (isEmptyTodoChange(change)) return null;
  const parts: string[] = [];
  if (change.added.length) parts.push(`+${change.added.length} added`);
  if (change.removed.length) parts.push(`-${change.removed.length} removed`);
  if (change.updated.length) parts.push(`~${change.updated.length} updated`);
  if (change.moved.length) parts.push(`>${change.moved.length} moved`);
  return parts.join(', ');
}
