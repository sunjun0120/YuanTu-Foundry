import type { CommandJournal, CommandRecord } from '../protocol/jobs.ts';
import { logProjection } from './log-projection.ts';
import type { SessionStore } from '../storage/sqlite.ts';
/**
 * The session's durable record of the background commands it started.
 *
 * `packages/tools/background.ts` owns the processes: it holds the ring, the pid and the exit code, and every one
 * of those dies with the process. What has to outlive them is smaller and answers the question a *later* run
 * asks — which commands this session started, how they ended, and whether anybody has read the result — so it is
 * recorded here, in the session's own log, through the same `recordEvent` every other durable fact uses.
 *
 * Three records, and the third is the reason the first two are worth writing:
 *
 * - `command.started` — written inside the tool call, before the process is spawned far enough to matter.
 * - `command.settled` — written from the worker's exit handler, which is a callback in a process that may by then
 *   be serving a later turn. It carries the tail of the output, because the ring is gone the moment the process
 *   is; the total is recorded with it so the tail can be read as a tail rather than as the whole answer.
 * - `command.collected` — written when the model reads a *settled* command's output. This is the cursor: the
 *   notice repeats until it appears, exactly as `subagent.collected` makes the sub-agent notice repeat.
 *
 * Nothing here is in memory, so a Host that restarts still knows what its sessions started and what nobody has
 * read — which is the whole difference between "the command finished" and "somebody can find out that it did".
 */
export function commandJournal(store: SessionStore, sessionId: string): CommandJournal {
  return {
    started: ({ id, command, cwd, createdAt }) =>
      store.recordEvent(sessionId, 'command.started', { id, command, cwd, createdAt }),
    settled: ({ id, status, exitCode, finishedAt, output, outputChars, cleanupConfirmed }) =>
      store.recordEvent(sessionId, 'command.settled', {
        id,
        status,
        exitCode,
        finishedAt,
        output,
        outputChars,
        ...(cleanupConfirmed === undefined ? {} : { cleanupConfirmed }),
      }),
    read: (ids) => store.recordEvent(sessionId, 'command.collected', { ids: [...ids] }),
    record: (id) => commandRecords(store, sessionId).get(id),
    records: () => [...commandRecords(store, sessionId).values()],
  };
}
/** What the command fold keeps: the records, and the ids a client hid or the model read. */
interface CommandState {
  records: Map<string, CommandRecord>;
  /** Ids a client hid with `background.hidden`. */
  hidden: Set<string>;
  /** Ids the model has read with `command.collected`. */
  collected: Set<string>;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Every reader used to fold the whole log per call; this fold is kept and continued (see `logProjection`). */
const commands = logProjection<CommandState>(
  () => ({ records: new Map(), hidden: new Set(), collected: new Set() }),
  (state, event) => {
    const { records } = state;
    switch (event.type) {
      case 'command.started': {
        const id = String(event.data.id ?? '');
        if (!id || records.has(id)) break;
        records.set(id, {
          id,
          sessionId: event.sessionId,
          command: String(event.data.command ?? ''),
          cwd: String(event.data.cwd ?? ''),
          createdAt: String(event.data.createdAt ?? event.at),
          output: '',
          outputChars: 0,
        });
        break;
      }
      case 'command.settled': {
        const id = String(event.data.id ?? '');
        const record = id ? records.get(id) : undefined;
        if (!record) break;
        const output = String(event.data.output ?? '');
        // Replaced rather than mutated: a reader may still hold the record it was handed before this settle.
        records.set(id, {
          ...record,
          status: String(event.data.status ?? 'completed'),
          finishedAt: String(event.data.finishedAt ?? event.at),
          exitCode:
            typeof event.data.exitCode === 'number' || event.data.exitCode === null
              ? (event.data.exitCode as number | null)
              : null,
          output,
          outputChars:
            typeof event.data.outputChars === 'number' ? event.data.outputChars : output.length,
        });
        break;
      }
      case 'background.hidden':
        for (const id of ids(event.data.ids)) state.hidden.add(id);
        break;
      case 'command.collected':
        for (const id of ids(event.data.ids)) state.collected.add(id);
        break;
    }
  },
);

/**
 * Every command this session recorded, folded from its log, oldest first.
 *
 * A map rather than a list because that is how it is read: the notice walks the record to find what settled and
 * was never read, and `job_output` asks for one id when the process that ran it no longer exists. A `settled`
 * for a command this log never saw start is ignored rather than invented — the same rule the sub-agent fold
 * follows, and for the same reason: an id nobody can look up is not a record of work.
 *
 * The map is the caller's own copy; the fold behind it is kept and continued (see `logProjection`).
 */
export function commandRecords(store: SessionStore, sessionId: string): Map<string, CommandRecord> {
  return new Map(commands.read(store, sessionId).records);
}

/** The ids a client hid from the background panel with `background.hidden`. */
export function hiddenCommandIds(store: SessionStore, sessionId: string): ReadonlySet<string> {
  return new Set(commands.read(store, sessionId).hidden);
}

/**
 * The commands this session settled and nobody has read, oldest first.
 *
 * A command that is still running is deliberately absent: it is not a result the model is missing, and listing it
 * would put "here is something that has not happened yet" into every request. What is listed is the exact gap
 * this record exists to close — the work finished, and the turn that started it is over.
 */
export function unsettledCommands(
  store: SessionStore,
  sessionId: string,
  limit = 8,
): CommandRecord[] {
  const { records, collected } = commands.read(store, sessionId);
  const pending: CommandRecord[] = [];
  for (const record of records.values()) {
    if (!record.status || collected.has(record.id)) continue;
    pending.push(record);
    if (pending.length >= limit) break;
  }
  return pending;
}
