import { randomUUID } from 'node:crypto';
import type { UserInput } from '../../protocol/index.ts';
import type { InputMode, QueuedInput } from '../../protocol/inputs.ts';

export type { InputMode, QueuedInput } from '../../protocol/inputs.ts';
/**
 * The queue is full, distinct from "no turn to fold into", so a caller does not start a second turn
 * on a running child.
 */
export class RunQueueFull extends Error {
  constructor(limit: number) {
    super(`Run queue is full (${limit} inputs)`);
    this.name = 'RunQueueFull';
  }
}
/** How many inputs one queue holds before it refuses more. */
export const MAX_QUEUED_INPUTS = 16;
/**
 * A queued input as held: the client-facing fields plus the images and submission time. The durable
 * `input.queued` record omits the images.
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
   * Queue one input. `id` is supplied by a parent correcting a child so both records name the same
   * message; otherwise it is generated. Returns the whole item so the caller can record acceptance
   * durably.
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
  /** Drop everything queued and return it, so every unconsumed input is named in the log. */
  clear(): PendingInput[] {
    const dropped = this.entries;
    this.entries = [];
    this.steering = new AbortController();
    return dropped;
  }
}
