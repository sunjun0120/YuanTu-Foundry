/**
 * The carrier snapshot as it crosses from the main process to the window: only the sections that changed.
 *
 * A publish used to send the whole `CarrierSnapshot` — every message of the open session, base64 images
 * included — although most publishes change one small section (the background panel, the task list, the audit
 * record). The main process now keeps what it last sent and sends only sections that differ; the preload keeps
 * the mirror and hands the window the merged snapshot, so the bridge contract (`subscribe` gets a whole snapshot,
 * `invoke` answers with one) is unchanged for every caller, the desktop smoke suites included.
 *
 * `session` is compared by reference: the carrier reuses one frozen session view until the controller reports a
 * change (`CarrierService.currentSessionView`), so "same object" is exactly "nothing to send". The other sections
 * are small and rebuilt per snapshot, so they are compared by their serialized form.
 *
 * Every section carries its own version. A command's reply and a pushed publish travel on different channels, so
 * the preload may see them out of order; a section is only ever replaced by a newer one.
 */
import type { CarrierSnapshot } from '../../packages/carrier/contract.ts';

export type SnapshotSection = keyof CarrierSnapshot;
export interface SnapshotPatch {
  sections: Partial<Record<SnapshotSection, { version: number; value: unknown }>>;
}

/** The main-process side: what was last sent, and the next patch against it. */
export class SnapshotSender {
  private version = 0;
  private sent = new Map<SnapshotSection, { reference: unknown; text: string | null }>();
  /** Forget everything sent: the window reloaded and its mirror is empty. */
  reset(): void {
    this.sent.clear();
  }
  /** The sections of `state` that differ from what was last sent; empty when nothing does. */
  diff(state: CarrierSnapshot): SnapshotPatch {
    const sections: SnapshotPatch['sections'] = {};
    for (const key of Object.keys(state) as SnapshotSection[]) {
      const value = state[key];
      const previous = this.sent.get(key);
      if (previous && previous.reference === value) continue;
      // `session` is the large one and is shared while unchanged; serializing it to compare would cost what
      // sending it costs. A new reference there is a change.
      const text = key === 'session' ? null : JSON.stringify(value ?? null);
      if (previous && text !== null && previous.text === text) {
        previous.reference = value;
        continue;
      }
      this.sent.set(key, { reference: value, text });
      sections[key] = { version: ++this.version, value };
    }
    for (const key of [...this.sent.keys()])
      if (!(key in state)) {
        this.sent.delete(key);
        sections[key] = { version: ++this.version, value: undefined };
      }
    return { sections };
  }
}

/** The preload side: the merged snapshot, and which sections the last patch actually replaced. */
export class SnapshotMirror {
  private state: Partial<Record<SnapshotSection, unknown>> = {};
  private versions = new Map<SnapshotSection, number>();
  apply(patch: SnapshotPatch): { state: CarrierSnapshot; changed: SnapshotSection[] } {
    const changed: SnapshotSection[] = [];
    for (const [key, entry] of Object.entries(patch.sections) as [
      SnapshotSection,
      { version: number; value: unknown },
    ][]) {
      if ((this.versions.get(key) ?? 0) >= entry.version) continue;
      this.versions.set(key, entry.version);
      if (entry.value === undefined) delete this.state[key];
      else this.state[key] = entry.value;
      changed.push(key);
    }
    return { state: this.state as unknown as CarrierSnapshot, changed };
  }
}
