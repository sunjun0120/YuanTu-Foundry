import type { CommandJournal, CommandRecord } from '../protocol/jobs.ts';
import { logProjection } from './log-projection.ts';
import type { SessionStore } from '../storage/sqlite.ts';
/**
 * The session's durable record of background commands. `packages/tools/background.ts` owns the
 * processes; this records what a later run needs:
 *
 * - `command.started`, inside the tool call;
 * - `command.settled`, from the exit handler, with the output tail and total size;
 * - `command.collected`, when the model reads a settled command's output, which stops the notice.
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
    record: (id) => commandRecord(store, sessionId, id),
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
 * Every recorded command, folded from the log, oldest first. A `settled` without a `started` is
 * ignored. Returns a copy; the fold is cached (see `logProjection`).
 */
export function commandRecords(store: SessionStore, sessionId: string): Map<string, CommandRecord> {
  return new Map(commands.read(store, sessionId).records);
}

/** One command by id from the cached fold, without copying the rest. */
export function commandRecord(
  store: SessionStore,
  sessionId: string,
  id: string,
): CommandRecord | undefined {
  return commands.read(store, sessionId).records.get(id);
}

/** Every command this session recorded, newest last, as the kept fold holds them: read it, do not keep it. */
export function commandRecordsView(
  store: SessionStore,
  sessionId: string,
): ReadonlyMap<string, CommandRecord> {
  return commands.read(store, sessionId).records;
}

/** The ids a client hid from the background panel with `background.hidden`. */
export function hiddenCommandIds(store: SessionStore, sessionId: string): ReadonlySet<string> {
  return new Set(commands.read(store, sessionId).hidden);
}

/** Settled commands nobody has read, oldest first. Running commands are absent. */
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
