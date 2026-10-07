import { randomUUID } from 'node:crypto';
import type { UserInput } from '../protocol/index.ts';

export type InputMode = 'steer' | 'follow-up';
/**
 * The queue is full, and that is not the same thing as "there is no turn to fold into".
 *
 * The two used to arrive as one: `add` threw a plain `Error`, the caller that attached this queue to a child
 * caught everything, and answered "no live turn" — so the caller started a *second* turn on a child that was
 * already running (which the store's run lock refuses) and then recorded the message as handed over. Giving the
 * refusal its own type is what lets that caller tell the two apart and let this one out.
 */
export class RunQueueFull extends Error {
  constructor(limit: number) {
    super(`Run queue is full (${limit} inputs)`);
    this.name = 'RunQueueFull';
  }
}
/** How many inputs one queue holds before it refuses more. */
export const MAX_QUEUED_INPUTS = 16;
export interface QueuedInput {
  id: string;
  mode: InputMode;
  prompt: string;
  imageCount: number;
  createdAt: string;
}
/**
 * A queued input as the queue holds it, which is more than the live event needs.
 *
 * `QueuedInput` is what a client is shown: identity, mode, text, how many pictures. This is the same thing
 * plus the pictures themselves and the submission time, and it is what the durable `input.queued` record is
 * built from — the prompt and the count, deliberately not the pictures (see the note on that event type).
 */
export type PendingInput = UserInput & { id: string; mode: InputMode; createdAt: string };
/** What a client is shown for one queued input, without the picture bytes. */
export function queuedInput(item: PendingInput): QueuedInput {
  return {
    id: item.id,
    mode: item.mode,
    prompt: item.prompt,
    imageCount: item.images?.length ?? 0,
    createdAt: item.createdAt,
  };
}
export class RunQueue {
  private entries: PendingInput[] = [];
  steering = new AbortController();
  get items(): QueuedInput[] {
    return this.entries.map(queuedInput);
  }
  get hasSteer(): boolean {
    return this.entries.some((e) => e.mode === 'steer');
  }
  /**
   * Queue one input.
   *
   * `id` is for the one caller that already has an identity for this message: a parent handing a correction to a
   * child names it in *its* log, and the child's receipt has to be the same string for the two records to be
   * about one message. Generating a second id here and threading it back as a token would buy the same thing for
   * one more field, so the parent's id is the item's id. Everyone else lets it be generated.
   *
   * The whole item comes back, not the client-facing summary: the caller records the acceptance durably before
   * the input can be folded into a turn, and the record has to be made from the thing that was queued.
   */
  add(input: UserInput, mode: InputMode, id?: string): PendingInput {
    if (mode !== 'steer' && mode !== 'follow-up') throw new Error('Invalid input mode');
    if (!input.prompt.trim() || input.prompt.length > 100_000)
      throw new Error('Prompt must contain 1 to 100000 characters');
    if (this.entries.length >= MAX_QUEUED_INPUTS) throw new RunQueueFull(MAX_QUEUED_INPUTS);
    const item = {
      ...structuredClone(input),
      id: id ?? randomUUID(),
      mode,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(item);
    if (mode === 'steer') this.steering.abort();
    return item;
  }
  take(mode: InputMode): PendingInput | undefined {
    const index = this.entries.findIndex((e) => e.mode === mode);
    if (index < 0) return;
    const item = this.entries.splice(index, 1)[0];
    if (!this.hasSteer) this.steering = new AbortController();
    return item;
  }
  /**
   * Drop everything still queued, and hand it back so the caller can record what happened to it.
   *
   * The return value is the point: a queue that empties itself silently is the defect this shape exists to
   * make impossible — every input that leaves without being consumed has to be named in the log.
   */
  clear(): PendingInput[] {
    const dropped = this.entries;
    this.entries = [];
    this.steering = new AbortController();
    return dropped;
  }
}
