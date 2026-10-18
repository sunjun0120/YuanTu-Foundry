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
 * Naming the four reads rather than importing `SessionStore` keeps `storage` from depending on its own
 * reader class from two directions at once, and it says out loud what the promise is about: the log, the
 * transcript, the write-through rows and the child sessions a run also wrote.
 */
export interface LogTableReader {
  events(sessionId: string): SessionEvent[];
  messages(sessionId: string): Message[];
  /** The `messages` rows as another connection would see them, not the log fold. */
  messagesFromTable(sessionId: string): Message[];
  childSessions(sessionId: string): { id: string }[];
}
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
 */
export function logTablesAgreeInvariant(store: LogTableReader): Invariant {
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
        const events = store.events(id);
        const folded = foldMessages(events);
        const read = store.messages(id);
        const rows = store.messagesFromTable(id);
        const messageEvents = events.filter((event) => event.type.startsWith('message.')).length;
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
      }
      if (problems.length) throw new Error(problems.join('; '));
    },
  };
}
