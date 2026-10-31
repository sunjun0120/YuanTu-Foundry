import type { AgentEvent, UserInput } from '../../protocol/index.ts';
import { validateUserInput } from '../../protocol/images.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { queuedInput, type InputMode, type QueuedInput, type RunQueue } from './queue.ts';

/** The live half of a running session: its queue, and the emitter its frames go out through. */
export interface ActiveRun {
  runId: string;
  queue: RunQueue;
  emit: (type: AgentEvent['type'], data: Record<string, unknown>) => void;
}

/**
 * The inputs a person sends to a session, whether or not a run holds it. Answers from the live
 * queue or the log as appropriate, and always writes to the log, so clients see one list across run
 * boundaries and crashes.
 */
export class RunInbox {
  private readonly store: SessionStore;
  private readonly runs = new Map<string, ActiveRun>();

  constructor(store: SessionStore) {
    this.store = store;
  }

  /** Make `run` the session's live inbox. */
  open(sessionId: string, run: ActiveRun): void {
    this.runs.set(sessionId, run);
  }

  /** Release the session's live inbox, but only while it is still this run's: a later run may already own it. */
  release(sessionId: string, runId: string): void {
    if (this.runs.get(sessionId)?.runId === runId) this.runs.delete(sessionId);
  }

  /**
   * Queue an input for a running session. `id` is passed by a parent correcting a child so both
   * records share it (see `RunQueue.add`). `input.queued` is written first, so a crash leaves
   * "queued and never delivered" readable.
   */
  enqueue(sessionId: string, input: UserInput, mode: InputMode, id?: string): QueuedInput {
    const active = this.runs.get(sessionId);
    if (!active) throw new Error('Session is not running');
    const pending = active.queue.add(validateUserInput(input), mode, id);
    this.store.recordEvent(sessionId, 'input.queued', {
      item: {
        id: pending.id,
        mode: pending.mode,
        prompt: pending.prompt,
        createdAt: pending.createdAt,
        imageCount: pending.images?.length ?? 0,
      },
    });
    const item = queuedInput(pending);
    active.emit('input.queued', { item, queue: active.queue.items });
    return item;
  }

  queue(sessionId: string): QueuedInput[] {
    return this.runs.get(sessionId)?.queue.items ?? [];
  }

  /**
   * The session's inbox: the live queue while a run holds it, otherwise what the log says was never
   * delivered.
   */
  inboxOf(sessionId: string): { running: boolean; items: QueuedInput[] } {
    const active = this.runs.get(sessionId);
    if (active) return { running: true, items: active.queue.items };
    return { running: false, items: this.store.pendingInputs(sessionId) };
  }

  /**
   * Drop the inbox and record it as never delivered. Allowed without a run, since most entries are
   * leftovers; the log is settled, so live items and leftovers clear together.
   */
  clear(sessionId: string): void {
    const active = this.runs.get(sessionId);
    active?.queue.clear();
    this.store.discardPendingInputs(sessionId, 'user');
    active?.emit('queue.changed', { queue: [] });
  }

  /**
   * Record that inputs will never be delivered, with one reason for the batch; `ids` names exactly
   * what it covers.
   */
  discard(ids: readonly string[], sessionId: string, reason: string): void {
    if (!ids.length) return;
    this.store.recordEvent(sessionId, 'input.discarded', { ids: [...ids], reason });
  }
}
