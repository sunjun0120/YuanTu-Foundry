import type { SessionStore } from '../storage/sqlite.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { GOAL_UPDATE, loadedTools } from '../tools/deferred-tools.ts';

/**
 * Which deferred tools this run's next request carries (`../tools/deferred-tools.ts`), or `undefined` when the
 * registry does not defer at all.
 *
 * Read back from the session rather than kept in memory, so a resumed run or a restarted Host sends the catalog
 * the model last saw: the transcript's loads and direct calls, plus `update_goal` while the session has an
 * unfinished goal — progress, pause and resume all go through it, and a session with no such goal does not pay
 * for its schema.
 */
export function loadedDeferredTools(
  store: Pick<SessionStore, 'messages' | 'goal'>,
  sessionId: string,
  tools: Pick<ToolRegistry, 'toolMode' | 'deferrable'>,
): Set<string> | undefined {
  if (tools.toolMode !== 'deferred') return undefined;
  const loaded = loadedTools(store.messages(sessionId), tools.deferrable);
  const goal = store.goal(sessionId);
  if (goal && goal.status !== 'completed') loaded.add(GOAL_UPDATE);
  return loaded;
}

/** Whether two loaded sets name the same tools, i.e. whether the catalog has to be rebuilt. */
export function sameToolSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((name) => b.has(name));
}
