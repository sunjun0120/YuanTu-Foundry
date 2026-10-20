import { createHash } from 'node:crypto';
import type { Message } from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { contextTail } from '../protocol/context.ts';

interface ToolResultView {
  index: number;
  sourceHash: string;
  content: string;
}

const sourceHash = (message: Message): string =>
  createHash('sha256').update(JSON.stringify(message)).digest('hex');

/** Keep the model's shortened view durable without changing the original transcript. */
export function projectToolResults(
  store: SessionStore,
  sessionId: string,
  history: readonly Message[],
  covered: number,
  runId?: string,
) {
  const saved = store.newestPayload(sessionId, 'context.tool-results.projected');
  let previous = saved?.views;
  if (saved && (!Array.isArray(previous) || saved.version !== 1))
    throw new Error('Invalid tool result projection checkpoint');
  const views = new Map<number, ToolResultView>();
  for (const raw of (previous ?? []) as ToolResultView[]) {
    if (
      !raw ||
      !Number.isSafeInteger(raw.index) ||
      raw.index < 0 ||
      typeof raw.sourceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.sourceHash) ||
      typeof raw.content !== 'string'
    )
      throw new Error('Invalid tool result projection checkpoint');
    const message = history[raw.index];
    if (raw.index < covered || message?.role !== 'tool' || sourceHash(message) !== raw.sourceHash)
      continue;
    views.set(raw.index, raw);
  }
  const preserved = new Set<Message>();
  const indices = new WeakMap<Message, number>();
  const projectedHistory = history.map((message, index) => {
    indices.set(message, index);
    const view = views.get(index);
    if (!view) return message;
    const projected = { ...message, content: view.content };
    indices.set(projected, index);
    preserved.add(projected);
    return projected;
  });
  const messages = contextTail(projectedHistory, covered);
  return {
    messages,
    preserved,
    tail: (cut: number): Message[] => contextTail(projectedHistory, cut),
    remember(projected: readonly Message[], before: readonly Message[] = messages): void {
      for (const [offset, message] of projected.entries()) {
        const index = indices.get(before[offset]!);
        if (index === undefined) continue;
        const original = history[index];
        if (
          message.role !== 'tool' ||
          original?.role !== 'tool' ||
          message.content === original.content
        )
          continue;
        views.set(index, { index, sourceHash: sourceHash(original), content: message.content });
        projectedHistory[index] = message;
        indices.set(message, index);
        preserved.add(message);
      }
      // Only the retained tail is checkpointed, and only when it changes. Old snapshots remain in the audit log.
      const next = [...views.values()].sort((a, b) => a.index - b.index);
      if (JSON.stringify(next) !== JSON.stringify(previous ?? [])) {
        const lease = store.leaseOf(sessionId);
        if (lease && lease.runId !== runId)
          throw new Error(
            'Another run is writing this session; tool result views were not changed.',
          );
        store.recordEvent(sessionId, 'context.tool-results.projected', { version: 1, views: next });
        previous = next;
      }
    },
  };
}
