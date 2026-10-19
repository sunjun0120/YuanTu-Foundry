/**
 * The carrier snapshot as it crosses from the main process to the window: only the sections that changed.
 *
 * A publish used to send the whole `CarrierSnapshot` — every message of the open session, base64 images
 * included — although most publishes change one small section (the background panel, the task list, the audit
 * record). The main process now keeps what it last sent and sends only sections that differ; the preload keeps
 * the mirror and hands the window the merged snapshot, so the bridge contract (`subscribe` gets a whole snapshot,
 * `invoke` answers with one) is unchanged for every caller, the desktop smoke suites included.
 *
 * `session` and `audit` are compared by reference: the carrier reuses one frozen view of each until it changes
 * (`CarrierService.currentSessionView`, `refreshAudit`), so "same object" is exactly "nothing to send", and
 * serializing them to compare would cost what sending them costs. The other sections are small and rebuilt per
 * snapshot, so they are compared by their serialized form.
 *
 * A changed `session` usually differs from the last one sent by a message or two at the end: the carrier's view
 * shares every earlier message by reference (`SessionController.frozenSnapshot`). So it travels as the fields
 * without the transcript plus the messages past the shared prefix (`SessionMessages`), and the preload rebuilds the
 * transcript from the one it holds. Without this, each tool call in a long session sent the whole transcript,
 * images included, across IPC.
 *
 * Every section carries its own version. A command's reply and a pushed publish travel on different channels, so
 * the preload may see them out of order; a section is only ever replaced by a newer one.
 */
import type { CarrierSnapshot } from '../../packages/carrier/contract.ts';

export type SnapshotSection = keyof CarrierSnapshot;
/**
 * The transcript of a `session` entry as a change to the one sent at `base`: its first `keep` messages, then `tail`.
 * The entry's `value` then carries `messages: []`.
 */
export interface SessionMessages {
  base: number;
  keep: number;
  tail: CarrierSnapshot['session']['messages'];
}
export interface SnapshotEntry {
  version: number;
  value: unknown;
  messages?: SessionMessages;
}
export interface SnapshotPatch {
  sections: Partial<Record<SnapshotSection, SnapshotEntry>>;
}
/** Sections the carrier hands out frozen and shared while unchanged; a new reference is a change. */
const BY_REFERENCE = new Set<SnapshotSection>(['session', 'audit']);
type Messages = CarrierSnapshot['session']['messages'];

/** The main-process side: what was last sent, and the next patch against it. */
export class SnapshotSender {
  private version = 0;
  private sent = new Map<
    SnapshotSection,
    { reference: unknown; text: string | null; version: number }
  >();
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
      const text = BY_REFERENCE.has(key) ? null : JSON.stringify(value ?? null);
      if (previous && text !== null && previous.text === text) {
        previous.reference = value;
        continue;
      }
      this.sent.set(key, { reference: value, text, version: ++this.version });
      sections[key] =
        key === 'session' && previous
          ? this.sessionEntry(value as CarrierSnapshot['session'], previous)
          : { version: this.version, value };
    }
    for (const key of [...this.sent.keys()])
      if (!(key in state)) {
        this.sent.delete(key);
        sections[key] = { version: ++this.version, value: undefined };
      }
    return { sections };
  }
  /** `session` against the one last sent: only the messages past the prefix both share, when they share one. */
  private sessionEntry(
    session: CarrierSnapshot['session'],
    previous: { reference: unknown; version: number },
  ): SnapshotEntry {
    const before = (previous.reference as CarrierSnapshot['session'] | null)?.messages ?? [];
    const messages = session?.messages ?? [];
    let keep = 0;
    const limit = Math.min(before.length, messages.length);
    while (keep < limit && before[keep] === messages[keep]) keep++;
    // Nothing shared — another session, older history put in front, a bridge that does not share — goes whole.
    if (!keep) return { version: this.version, value: session };
    return {
      version: this.version,
      value: { ...session, messages: [] },
      messages: { base: previous.version, keep, tail: messages.slice(keep) },
    };
  }
}

/** The preload side: the merged snapshot, and which sections the last patch actually replaced. */
export class SnapshotMirror {
  private state: Partial<Record<SnapshotSection, unknown>> = {};
  private versions = new Map<SnapshotSection, number>();
  /**
   * `session` entries that arrived before the one they were cut against, keyed by that one's version.
   *
   * A reply and a push travel on different channels, so the session a tail is relative to can still be on its way;
   * the tail waits for it here and is applied when it lands. One that a newer whole session overtakes is dropped.
   */
  private waiting = new Map<number, SnapshotEntry>();
  apply(patch: SnapshotPatch): { state: CarrierSnapshot; changed: SnapshotSection[] } {
    const changed: SnapshotSection[] = [];
    for (const [key, entry] of Object.entries(patch.sections) as [
      SnapshotSection,
      SnapshotEntry,
    ][]) {
      if ((this.versions.get(key) ?? 0) >= entry.version) continue;
      if (entry.messages && this.versions.get(key) !== entry.messages.base) {
        // Bounded: a tail whose base never arrives must not accumulate for the life of the window.
        if (this.waiting.size >= 16) this.waiting.delete(this.waiting.keys().next().value!);
        this.waiting.set(entry.messages.base, entry);
        continue;
      }
      this.put(key, entry);
      changed.push(key);
    }
    for (let next; (next = this.waiting.get(this.versions.get('session') ?? 0));) {
      this.waiting.delete(next.messages!.base);
      this.put('session', next);
      if (!changed.includes('session')) changed.push('session');
    }
    const current = this.versions.get('session') ?? 0;
    for (const [base, entry] of this.waiting)
      // A tail cut against a session older than the one already mirrored can never be applied; one overtaken by a
      // newer whole session is equally dead. Both are removed rather than left waiting for a base that is gone.
      if (base < current || entry.version <= current) this.waiting.delete(base);
    return { state: this.state as unknown as CarrierSnapshot, changed };
  }
  private put(key: SnapshotSection, entry: SnapshotEntry): void {
    this.versions.set(key, entry.version);
    if (entry.value === undefined) delete this.state[key];
    else if (entry.messages) {
      const held = (this.state.session as CarrierSnapshot['session'] | undefined)?.messages ?? [];
      const messages: Messages = [...held.slice(0, entry.messages.keep), ...entry.messages.tail];
      this.state[key] = { ...(entry.value as CarrierSnapshot['session']), messages };
    } else this.state[key] = entry.value;
  }
}
