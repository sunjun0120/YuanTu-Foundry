/**
 * Where the interface is composed from, instead of by editing the renderer.
 *
 * The desktop's panels already live in their own modules, but *composition* did not: `renderer.ts` called each
 * one by name, in the order its author happened to type, so a second carrier or an extension had exactly one
 * way to add a view — edit the renderer. This module is the missing combination point. A slot is a named
 * position in the window; a contribution is a view that renders into it; and the built-in panels register
 * through the same call a contributed view would use, because a slot the built-ins bypass is a decoration and
 * a second path that can drift from the first.
 *
 * Two properties are the whole point, and both are pinned by `tests/slots.test.ts`:
 *
 * - **Registration ordering is explicit.** `order` decides, ties keep arrival order, and a re-render puts the
 *   contributions in the registry's current order — never in whatever order the container happens to hold.
 * - **Registration is reversible.** `register` returns the disposer that removes exactly that contribution,
 *   which is what makes a plugin unloadable rather than permanent.
 *
 * The registry itself is DOM-free on purpose: what is testable without a browser is the ordering and the
 * lifecycle, and a unit test that owns a fake document should not also be in the business of implementing one.
 * `mountSlot` is the only part that touches elements, and it touches a deliberately small surface — create a
 * frame per contribution, append it to the container, call `render`, and remove the frames on dispose.
 */
/** The positions the window offers today. Adding one is a deliberate act: an unknown name is refused. */
export const SLOT_NAMES = [
  'composer.above',
  'message.actions',
  'message.footer',
  'sidebar.right',
  'tool.result.extra',
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];
/**
 * What every slot hands its contributions.
 *
 * A slot is only as good as the context it promises: a contribution to `sidebar.right` draws from the carrier
 * snapshot, while one in `message.actions` draws from the message it sits on. Declaring that as a map — one
 * entry per slot name — is what makes registering a contribution into the wrong slot a type error rather than a
 * panel that receives something it cannot read.
 */
export type SlotContexts = Record<SlotName, unknown>;
export interface SlotContribution<Context> {
  /**
   * Where this contribution sits relative to the others: lower first. Ties keep registration order, so a set of
   * panels that never set it still renders in the order they were registered.
   */
  readonly order?: number;
  /**
   * Render (or re-render) into the frame this contribution owns.
   *
   * Called again on every `SlotMount.render`, so it must replace what it drew rather than append to it. The
   * frame is stable across renders — an input the user is typing into keeps its focus.
   */
  readonly render: (frame: HTMLElement, context: Context) => void;
}
export class SlotRegistry<Contexts extends SlotContexts> {
  /**
   * Homogeneous per slot by construction: `register` is the only writer and it is keyed by `K`, so the entry
   * stored at `slot` always has the context type that name declares. The cast is the price of one map holding
   * five differently-typed lists; the alternative is five maps that can drift apart.
   */
  private readonly slots = new Map<SlotName, SlotContribution<unknown>[]>();
  /**
   * Add one contribution to a slot.
   *
   * @returns The disposer that removes it — idempotent, and it removes only this contribution.
   */
  register<K extends SlotName>(slot: K, contribution: SlotContribution<Contexts[K]>): () => void {
    if (!SLOT_NAMES.includes(slot))
      throw new Error(`Unknown slot: ${String(slot)}; known slots are ${SLOT_NAMES.join(', ')}`);
    const current = this.slots.get(slot) ?? [];
    // A new array rather than a push: a reader holding `contributions()` keeps the snapshot it asked for.
    this.slots.set(slot, [...current, contribution as unknown as SlotContribution<unknown>]);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const entries = this.slots.get(slot) ?? [];
      this.slots.set(
        slot,
        entries.filter((entry) => entry !== (contribution as unknown as SlotContribution<unknown>)),
      );
    };
  }
  /** The contributions of one slot, in render order, as a frozen snapshot. */
  contributions<K extends SlotName>(slot: K): readonly SlotContribution<Contexts[K]>[] {
    const entries = this.slots.get(slot) ?? [];
    // Sorted by the explicit order, stable for ties (`Array.prototype.sort` is stable), then frozen so a caller
    // cannot reorder what the next render will use.
    return Object.freeze(
      [...entries].sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
    ) as unknown as readonly SlotContribution<Contexts[K]>[];
  }
  /** How many contributions a slot has. Named for what it answers, not for the map behind it. */
  size(slot: SlotName): number {
    return this.slots.get(slot)?.length ?? 0;
  }
}
/**
 * One slot mounted in one container.
 *
 * `render` may be called as often as the window re-renders; frames are created once per contribution (and
 * rebuilt only when the set of contributions changed), so re-rendering cannot duplicate the panel above the
 * composer into a stack of copies.
 */
export class SlotMount<Context> {
  private frames: { contribution: SlotContribution<Context>; frame: HTMLElement }[] = [];
  private readonly document: Document;
  private readonly container: HTMLElement;
  /** Read on every render rather than captured, so a registration made later takes effect on the next one. */
  private readonly read: () => readonly SlotContribution<Context>[];
  private readonly slot: SlotName;
  constructor(
    document: Document,
    container: HTMLElement,
    read: () => readonly SlotContribution<Context>[],
    slot: SlotName,
  ) {
    this.document = document;
    this.container = container;
    this.read = read;
    this.slot = slot;
  }
  render(context: Context): void {
    const contributions = this.read();
    const current = this.frames.map((entry) => entry.contribution);
    if (current.length !== contributions.length || current.some((c, i) => c !== contributions[i])) {
      this.dispose();
      for (const contribution of contributions) {
        const frame = this.document.createElement('div');
        frame.className = `slot slot-${this.slot.replace(/\./g, '-')}`;
        this.container.append(frame);
        this.frames.push({ contribution, frame });
      }
    }
    for (const { contribution, frame } of this.frames) contribution.render(frame, context);
  }
  /** Remove every frame this mount added, leaving the container as it was found. */
  dispose(): void {
    for (const { frame } of this.frames) frame.remove();
    this.frames = [];
  }
}
export function mountSlot<K extends SlotName, Contexts extends SlotContexts>(
  document: Document,
  container: HTMLElement,
  registry: SlotRegistry<Contexts>,
  slot: K,
): SlotMount<Contexts[K]> {
  return new SlotMount(document, container, () => registry.contributions(slot), slot);
}
