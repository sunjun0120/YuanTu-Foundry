import type { SessionStore } from '../../storage/sqlite.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import { addLoadedTools, GOAL_UPDATE, loadedTools } from '../../tools/deferred-tools.ts';

/**
 * Which deferred tools this run's next request carries (`../tools/deferred-tools.ts`), or
 * `undefined` when nothing is deferred. Read from the session so resumed runs send what the model
 * last saw: the transcript's loads and direct calls, plus `update_goal` while a goal is unfinished.
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

/**
 * `loadedDeferredTools` for one run, reading only the transcript added since the last call. A
 * transcript that shrank is re-read from the start.
 */
export class LoadedDeferredTools {
  private scanned = 0;
  private readonly fromTranscript = new Set<string>();
  private readonly store: Pick<SessionStore, 'messages' | 'goal'>;
  private readonly sessionId: string;
  private readonly tools: Pick<ToolRegistry, 'toolMode' | 'deferrable'>;
  constructor(
    store: Pick<SessionStore, 'messages' | 'goal'>,
    sessionId: string,
    tools: Pick<ToolRegistry, 'toolMode' | 'deferrable'>,
  ) {
    this.store = store;
    this.sessionId = sessionId;
    this.tools = tools;
  }
  current(): Set<string> | undefined {
    if (this.tools.toolMode !== 'deferred') return undefined;
    const messages = this.store.messages(this.sessionId);
    if (messages.length < this.scanned) {
      this.scanned = 0;
      this.fromTranscript.clear();
    }
    addLoadedTools(messages, this.tools.deferrable, this.fromTranscript, this.scanned);
    this.scanned = messages.length;
    const loaded = new Set(this.fromTranscript);
    const goal = this.store.goal(this.sessionId);
    if (goal && goal.status !== 'completed') loaded.add(GOAL_UPDATE);
    return loaded;
  }
}

/** Whether two loaded sets name the same tools, i.e. whether the catalog has to be rebuilt. */
export function sameToolSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((name) => b.has(name));
}
