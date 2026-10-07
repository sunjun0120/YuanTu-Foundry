import type { Message } from '../protocol/index.ts';
import type { Invariant } from '../protocol/invariants.ts';
import { foldMessages } from './events.ts';
import type { SessionEvent } from './events.ts';
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
        if (JSON.stringify(folded) !== JSON.stringify(read))
          problems.push(`${id}: the transcript read is not the fold of the log`);
        if (JSON.stringify(folded) !== JSON.stringify(rows))
          problems.push(`${id}: the write-through rows are not the fold of the log`);
        if (messageEvents !== read.length)
          problems.push(`${id}: ${read.length} messages from ${messageEvents} message events`);
      }
      if (problems.length) throw new Error(problems.join('; '));
    },
  };
}
