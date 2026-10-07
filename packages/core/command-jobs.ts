import type { CommandJournal, CommandRecord } from '../protocol/jobs.ts';
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
/**
 * Every command this session recorded, folded from its log, oldest first.
 *
 * A map rather than a list because that is how it is read: the notice walks the record to find what settled and
 * was never read, and `job_output` asks for one id when the process that ran it no longer exists. A `settled`
 * for a command this log never saw start is ignored rather than invented — the same rule the sub-agent fold
 * follows, and for the same reason: an id nobody can look up is not a record of work.
 */
export function commandRecords(store: SessionStore, sessionId: string): Map<string, CommandRecord> {
  const records = new Map<string, CommandRecord>();
  for (const event of store.events(sessionId)) {
    if (event.type === 'command.started') {
      const id = String(event.data.id ?? '');
      if (!id || records.has(id)) continue;
      records.set(id, {
        id,
        sessionId,
        command: String(event.data.command ?? ''),
        cwd: String(event.data.cwd ?? ''),
        createdAt: String(event.data.createdAt ?? event.at),
        output: '',
        outputChars: 0,
      });
      continue;
    }
    if (event.type === 'command.settled') {
      const id = String(event.data.id ?? '');
      const record = id ? records.get(id) : undefined;
      if (!record) continue;
      record.status = String(event.data.status ?? 'completed');
      record.finishedAt = String(event.data.finishedAt ?? event.at);
      record.exitCode =
        typeof event.data.exitCode === 'number' || event.data.exitCode === null
          ? (event.data.exitCode as number | null)
          : null;
      record.output = String(event.data.output ?? '');
      record.outputChars =
        typeof event.data.outputChars === 'number' ? event.data.outputChars : record.output.length;
    }
  }
  return records;
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
  const read = new Set<string>();
  for (const event of store.events(sessionId))
    if (event.type === 'command.collected')
      for (const id of Array.isArray(event.data.ids) ? event.data.ids : []) read.add(String(id));
  const pending: CommandRecord[] = [];
  for (const record of commandRecords(store, sessionId).values()) {
    if (!record.status || read.has(record.id)) continue;
    pending.push(record);
    if (pending.length >= limit) break;
  }
  return pending;
}
