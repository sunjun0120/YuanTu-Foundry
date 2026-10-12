import { rm } from 'node:fs/promises';

/** Resource ownership stays with the preparing provider, never mutable or serialized plan fields. */
export class SeatbeltScratchRegistry {
  private readonly plans = new WeakMap<
    object,
    { directory: string; started: boolean; releasing?: Promise<void> }
  >();

  register(plan: object, directory: string): void {
    if (this.plans.has(plan)) throw new Error('Seatbelt plan is already registered');
    this.plans.set(plan, { directory, started: false });
  }

  started(plan: object): void {
    const owned = this.plans.get(plan);
    if (owned?.releasing)
      throw new Error('Seatbelt scratch is being released or was already released');
    if (owned) owned.started = true;
  }

  async cleanup(plan: object): Promise<void> {
    const owned = this.plans.get(plan);
    if (!owned || owned.started) return;
    // Keep a weak tombstone: the same plan must never launch after releasing its
    // scratch, including while asynchronous recursive removal is in flight.
    owned.releasing ??= rm(owned.directory, { recursive: true, force: true });
    await owned.releasing;
  }
}
