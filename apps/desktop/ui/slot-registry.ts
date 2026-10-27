export const SLOT_NAMES = [
  'composer.above',
  'message.actions',
  'message.footer',
  'sidebar.right',
  'tool.result.extra',
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];
export type SlotContexts = Record<SlotName, unknown>;

export interface SlotContribution<Context, View> {
  readonly id: string;
  readonly order?: number;
  readonly render: (context: Context) => View;
}

/** DOM-free subscription and registration lifetime, shared by every outlet in one window. */
export class SlotRegistry<Contexts extends SlotContexts, View = unknown> {
  private readonly slots = new Map<SlotName, SlotContribution<unknown, View>[]>();
  private readonly listeners = new Map<SlotName, Set<() => void>>();
  private readonly revisions = new Map<SlotName, number>();

  subscribe(slot: SlotName, listener: () => void): () => void {
    let listeners = this.listeners.get(slot);
    if (!listeners) this.listeners.set(slot, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  revision(slot: SlotName): number {
    return this.revisions.get(slot) ?? 0;
  }

  private publish(slot: SlotName): void {
    this.revisions.set(slot, this.revision(slot) + 1);
    for (const listener of this.listeners.get(slot) ?? []) listener();
  }

  register<K extends SlotName>(
    slot: K,
    contribution: SlotContribution<Contexts[K], View>,
  ): () => void {
    if (!SLOT_NAMES.includes(slot)) throw new Error(`Unknown slot: ${String(slot)}`);
    const current = this.slots.get(slot) ?? [];
    if (!contribution.id || current.some((entry) => entry.id === contribution.id))
      throw new Error(`Duplicate or empty contribution id in ${slot}: ${contribution.id}`);
    const registration = Object.freeze({ ...contribution }) as SlotContribution<unknown, View>;
    this.slots.set(slot, [...current, registration]);
    this.publish(slot);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.slots.set(
        slot,
        (this.slots.get(slot) ?? []).filter((entry) => entry !== registration),
      );
      this.publish(slot);
    };
  }

  contributions<K extends SlotName>(slot: K): readonly SlotContribution<Contexts[K], View>[] {
    return Object.freeze(
      [...(this.slots.get(slot) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    );
  }

  size(slot: SlotName): number {
    return this.slots.get(slot)?.length ?? 0;
  }
}
