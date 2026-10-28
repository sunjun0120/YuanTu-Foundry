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
 * The inputs a person sends to a session, whether or not a run is holding it.
 *
 * Two places can hold an inbox: the live queue of the run that owns the session, and the log once nothing does.
 * Every operation here answers from the right one — and writes to the log either way — so a client sees one list
 * across a run's start, its end and a process that died holding it.
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
   * Queue an input for a running session.
   *
   * `id` is passed through by the one caller that already named the message — a parent correcting a child — so
   * that the child's receipt and the parent's record are about one id (see `RunQueue.add`).
   *
   * The acceptance is durable *before* the input can be folded into a turn, on the same argument the sub-agent
   * inbox follows: the queue is memory, the fact that somebody queued this is not. `input.queued` is written
   * first, so a process that dies holding it leaves "queued and never delivered" readable rather than leaving
   * a conversation that merely ended (see `packages/storage/events.ts`).
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
   * The session's inbox as a client reads it, live or after the fact.
   *
   * While a run holds the queue, the queue is the answer: it is what the person can still act on (steer it,
   * clear it). Once nothing holds it, the *log* is the answer, and what it says is what nobody ever delivered —
   * a follow-up the process died holding, or the tail of a run that ended with input still waiting. That second
   * case is the one nothing used to be able to show, and it is the whole reason this seam exists.
   */
  inboxOf(sessionId: string): { running: boolean; items: QueuedInput[] } {
    const active = this.runs.get(sessionId);
    if (active) return { running: true, items: active.queue.items };
    return { running: false, items: this.store.pendingInputs(sessionId) };
  }

  /**
   * Drop the session's inbox and record that it will never be delivered.
   *
   * Deliberately allowed while no run holds the session: the entries this settles are mostly *leftovers* from
   * a run that ended or died, and a clear that only worked during a run would leave them to reappear after every
   * reload. The log is what is settled rather than the array, so the live queue and the leftovers are one list
   * to this call — which is what a person pressing "clear" means.
   */
  clear(sessionId: string): void {
    const active = this.runs.get(sessionId);
    active?.queue.clear();
    this.store.discardPendingInputs(sessionId, 'user');
    active?.emit('queue.changed', { queue: [] });
  }

  /**
   * Record that inputs will never be delivered, and why.
   *
   * One record for the batch rather than one per input, because the reason is the same fact about all of them
   * and the reader asks it once: `ids` names exactly the inputs it covers, so the fold settles all of them.
   */
  discard(ids: readonly string[], sessionId: string, reason: string): void {
    if (!ids.length) return;
    this.store.recordEvent(sessionId, 'input.discarded', { ids: [...ids], reason });
  }
}
