import { createHash } from 'node:crypto';
import type { Message } from '../protocol/index.ts';
import type { Invariant } from '../protocol/invariants.ts';
import { foldMessages } from './events.ts';
import type { SessionEvent } from './events.ts';

/**
 * A history's digest, one message at a time.
 *
 * The check used to build whole-transcript JSON strings and compare them: three serialisations of every message,
 * including base64 screenshots, at the end of every run — and a divergence could only be reported as "not the
 * fold", with no idea which message. Hashing each message keeps peak memory at one message, and a mismatch can
 * name the first message that differs.
 */
function digestHistory(messages: readonly Message[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(JSON.stringify(message));
    // A separator, so `["ab"]` and `["a","b"]` cannot hash the same.
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/** The first index at which two histories differ — `min(lengths)` when only their lengths do. */
function firstDifference(left: readonly Message[], right: readonly Message[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++)
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return index;
  return shared;
}

/** Where a pair disagreed, in the words of the report. */
function differenceOf(left: readonly Message[], right: readonly Message[]): string {
  return `first difference at message ${firstDifference(left, right)}`;
}
/**
 * The part of a store this check needs, stated structurally.
 *
 * Naming the reads rather than importing `SessionStore` keeps `storage` from depending on its own
 * reader class from two directions at once, and it says out loud what the promise is about: the log, the
 * transcript, the write-through rows and the child sessions a run also wrote.
 *
 * The `afterSeq` and `offset` arguments and `messageRowCount` are what make the check incremental. A reader
 * that ignores them (a test double) still gets a correct answer: what it returns does not line up with the part
 * being checked, and the check falls back to reading everything.
 */
export interface LogTableReader {
  /** The durable log, oldest first; with `afterSeq`, only the events after it. */
  events(sessionId: string, afterSeq?: number): SessionEvent[];
  messages(sessionId: string): Message[];
  /** The `messages` rows as another connection would see them, not the log fold; `offset` skips the first ones. */
  messagesFromTable(sessionId: string, offset?: number): Message[];
  /** How many `messages` rows there are, without reading them. */
  messageRowCount?(sessionId: string): number;
  childSessions(sessionId: string): { id: string }[];
}
/** How far one session has been checked: the last event seq read, and how many messages that log folds to. */
interface Checked {
  seq: number;
  count: number;
}
const UNCHECKED: Checked = { seq: 0, count: 0 };
/**
 * The log, the transcript read and the write-through rows are the same history.
 *
 * `tests/invariants.test.ts` asserts this as I8 against a second SQLite connection, which is the strongest
 * form — but only for the sessions that test happens to create. As a runtime check it covers every session a
 * deployment ever runs, including the ones nobody wrote a fixture for.
 *
 * The three views are written from a single call, so a divergence means that call stopped keeping its
 * property: a durable fact recorded in one place and not the other, after which the transcript the model is
 * given, the transcript the UI renders and the rows on disk are no longer the same history. Nothing else in
 * the system notices that, because every reader is individually consistent.
 *
 * The first check of a session in a process reads all of it; later ones read only what was appended since the
 * last check passed. The fold is append-only (`appendFoldedMessages`), so a passed prefix stays the fold of the
 * same log prefix; the totals — the transcript's length, the row count — are still compared whole, so a history
 * that shrank or grew outside the appended part does not pass as a short one. Whatever does not line up, and
 * every problem found, is decided by a full read, which is also what names the first differing message. Reading
 * the whole history at every run end made each run's end cost grow with the session and all of its children,
 * three serialisations of every message included.
 */
export function logTablesAgreeInvariant(store: LogTableReader): Invariant {
  const checked = new Map<string, Checked>();
  /** One session's problems, read from `from` on; `undefined` when that read cannot decide. */
  const inspect = (
    id: string,
    from: Checked,
  ): { problems: string[]; next: Checked } | undefined => {
    const incremental = from.count > 0 || from.seq > 0;
    const events = store.events(id, from.seq);
    const folded = foldMessages(events);
    const transcript = store.messages(id);
    const read = incremental ? transcript.slice(from.count) : transcript;
    const rows = store.messagesFromTable(id, from.count);
    const total = from.count + folded.length;
    if (
      incremental &&
      (transcript.length !== total ||
        rows.length !== folded.length ||
        (events.length > 0 && events[0]!.seq <= from.seq) ||
        (store.messageRowCount !== undefined && store.messageRowCount(id) !== total))
    )
      return undefined;
    const messageEvents = events.filter((event) => event.type.startsWith('message.')).length;
    const problems: string[] = [];
    const foldedDigest = digestHistory(folded);
    if (foldedDigest !== digestHistory(read))
      problems.push(
        `${id}: the transcript read is not the fold of the log (${differenceOf(folded, read)})`,
      );
    if (foldedDigest !== digestHistory(rows))
      problems.push(
        `${id}: the write-through rows are not the fold of the log (${differenceOf(folded, rows)})`,
      );
    if (messageEvents !== read.length)
      problems.push(`${id}: ${read.length} messages from ${messageEvents} message events`);
    return { problems, next: { seq: events.at(-1)?.seq ?? from.seq, count: total } };
  };
  return {
    name: 'storage.log-tables-agree',
    owner: 'packages/storage',
    description: 'The log fold, the transcript read and the write-through rows are one history.',
    scope: 'run-end',
    check: ({ sessionId }) => {
      // A check that cannot see its subject must not report success.
      if (!sessionId) throw new Error('the log/tables check needs a session to inspect');
      const problems: string[] = [];
      // The children too: a delegated child's transcript is written by the same run through the same path.
      for (const id of [sessionId, ...store.childSessions(sessionId).map((child) => child.id)]) {
        const from = checked.get(id);
        let result = from ? inspect(id, from) : undefined;
        if (!result || result.problems.length) result = inspect(id, UNCHECKED)!;
        if (result.problems.length) {
          checked.delete(id);
          problems.push(...result.problems);
        } else checked.set(id, result.next);
      }
      if (problems.length) throw new Error(problems.join('; '));
    },
  };
}
