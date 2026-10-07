import type { CommandRecord, JobControl, JobSnapshot } from '../protocol/jobs.ts';
import type { Tool, ToolContext } from '../protocol/index.ts';
import { TOOL_DEADLINE_DEFAULTS, resolveToolDeadline, toolDeadlinePolicy } from './timeouts.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * They only read — a path argument chooses what is read, never whether anything is written — so the promise
 * is the same for every argument and is stated once here instead of once per tool. A tool that can write, or
 * that mutates state this run owns (the checklist, a job, the language server session), does not get this
 * name: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;
/**
 * The three job tools, and the reason there are three rather than one per kind.
 *
 * Commands and sub-agents answer the same three questions — which ones exist, what has it produced, stop it
 * — so they share one vocabulary. A third kind of long-running work becomes a producer behind these tools
 * instead of another pair of names the model has to learn.
 */
const ID = { type: 'string', minLength: 1, maxLength: 128 };
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
/**
 * How long `job_output` may wait: as long as this call is allowed to take.
 *
 * The wait used to be capped at five seconds — a constant, written in this schema and again in the Host's RPC — so
 * a model waiting for a build had to ask over and over, and "wait up to wait_ms" was a promise the tool could not
 * keep past that number. The honest bound is the call's own budget, which the registry already enforces and the
 * operator already configures (`YUANTU_TOOL_TIMEOUT_MS`; ten minutes when unset), so the schema states exactly
 * that: a wait it advertises is a wait the call may take, and a value past it is refused by the schema rather than
 * accepted and cut. Zero still means "answer with what you have now", which is what a model that is not waiting
 * asks for.
 *
 * `collect_subagents` keeps its own `SUBAGENT_CEILINGS.collectWaitMs`: that wait is bounded by *other agents*, and
 * how long they take is not a property of the call doing the asking.
 */
function jobWaitCeilingMs(): number {
  return (
    resolveToolDeadline('job_output', toolDeadlinePolicy()) ?? TOOL_DEADLINE_DEFAULTS.defaultMs!
  );
}
/** One line per job: what it is, what state it is in, and the facts that decide whether to look closer. */
function line(job: JobSnapshot): string {
  const facts: string[] = [];
  if (job.pid !== undefined) facts.push(`pid ${job.pid}`);
  if (job.exitCode !== undefined && job.exitCode !== null) facts.push(`exit ${job.exitCode}`);
  if (typeof job.detail?.turns === 'number') facts.push(`${job.detail.turns} turn(s)`);
  // A job the process no longer holds is listed from the session's own record, and saying so is the difference
  // between "this is running" and "this ended before the process that ran it".
  if (job.detail?.recalled === true) facts.push('from the log');
  const label = job.label.length > 120 ? `${job.label.slice(0, 120)}…` : job.label;
  return `- ${job.id} [${job.kind}] [${job.status}] ${label}${facts.length ? ` (${facts.join(', ')})` : ''}`;
}
/** Statuses that mean the command is over, which is when reading it counts as having read the outcome. */
const SETTLED_STATUS = new Set(['completed', 'failed', 'cancelled']);
/**
 * A command's durable record as a job snapshot, for a process that no longer holds the job.
 *
 * A background command outlives turns, and a Host restart ends every one of them: the ring, the pid and the
 * manager's memory go with it. What is left is the record written when it settled, and answering from it is the
 * difference between "the command you are being reminded about cannot be read" and reading the tail of what it
 * printed. `truncated` keeps its live meaning — the part of the output the caller asked for is not here — and the
 * cursor stays honest by counting characters of the command's *whole* output rather than of the tail.
 *
 * `cursor` absent is the listing shape, the same one the sub-agent producer uses: "tell me what this job is, not
 * what is new", so a `job_list` line costs no output text.
 */
function recallCommand(record: CommandRecord, cursor?: number): JobSnapshot {
  const total = Math.max(record.outputChars, record.output.length);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > total))
    throw new Error('Invalid output cursor');
  const tailStart = total - record.output.length;
  const start = cursor === undefined ? total : Math.max(cursor, tailStart);
  const output = cursor === undefined ? '' : record.output.slice(start - tailStart);
  return {
    id: record.id,
    kind: 'command',
    sessionId: record.sessionId,
    label: record.command,
    // A record with no outcome is a command whose process died without recording one — a crash, not a result —
    // and saying "unknown" is the honest answer where "completed" would be an invention.
    status: record.status ?? 'unknown',
    createdAt: record.createdAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    exitCode: record.exitCode ?? null,
    output,
    nextCursor: start + output.length,
    // Same meaning the live path gives it: the answer begins later than the caller asked from, because what came
    // before is not here — in the ring it was dropped, in the record it was never written. A listing asks for
    // nothing, so nothing is missing from it.
    truncated: cursor !== undefined && start > cursor,
    detail: {
      cwd: record.cwd,
      recalled: true,
      outputChars: total,
      note: record.status
        ? 'read from this session’s log: the process that ran this command is gone, so this is the tail recorded when it settled'
        : 'read from this session’s log: the process that ran this command is gone and it never recorded an outcome',
    },
  };
}
export function jobTools(scope: string): Tool[] {
  const control = (context: ToolContext): JobControl => {
    if (!context.jobs)
      throw new Error(
        'No job registry is wired into this run, so background jobs cannot be controlled here',
      );
    return context.jobs;
  };
  return [
    {
      name: 'job_list',
      isConcurrencySafe: parallelRead,
      description:
        'List every long-running job this session started — background commands and sub-agents in one list — with the id used to read or stop each one. Use it before job_output or job_kill when you do not already have an id.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_args, context) => {
        try {
          const jobs = control(context).list(scope);
          /**
           * Plus the commands this session recorded that the process no longer holds.
           *
           * The registry answers for the jobs it owns, which is memory: after a restart it owns nothing, and the
           * listing said "this session has no jobs" about a session whose log names several. The durable records
           * are the other half, and an id that appears in both is listed once — the live one, because a running
           * job is the more useful answer about it.
           */
          const live = new Set(jobs.map((job) => job.id));
          const recalled = (context.commandJournal?.records() ?? [])
            .filter((record) => !live.has(record.id))
            .map((record) => recallCommand(record));
          const listed = [...jobs, ...recalled];
          return {
            isError: false,
            content: listed.length
              ? listed.map(line).join('\n')
              : 'This session has no jobs. Commands started with start_command and sub-agents delegated with delegate_task both appear here.',
          };
        } catch (error) {
          return { isError: true, content: failure(error) };
        }
      },
    },
    {
      name: 'job_output',
      isConcurrencySafe: parallelRead,
      description:
        'Read one job by id and get its new output since cursor, or wait up to wait_ms for some. A command reports its output ring; a sub-agent reports its own transcript, so a child left behind by an earlier process still answers.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID,
          cursor: { type: 'integer', minimum: 0 },
          wait_ms: { type: 'integer', minimum: 0, maximum: jobWaitCeilingMs() },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        try {
          const id = String(args.id);
          const cursor = Number(args.cursor ?? 0);
          let job: JobSnapshot;
          try {
            job = await control(context).output({
              id,
              scope,
              cursor,
              waitMs: Number(args.wait_ms ?? 0),
              signal: context.signal,
            });
          } catch (error) {
            /**
             * A command the process no longer holds is still a command this session ran.
             *
             * The manager's answer is memory, so after a restart every id it once knew becomes "unknown" — and
             * for a command that is exactly the moment the session's own record is worth reading. The fallback
             * is deliberately narrow: it answers only for an id this session's log recorded, so an id from
             * somewhere else still fails with the registry's own error instead of a fabricated snapshot.
             */
            const recorded = context.commandJournal?.record(id);
            if (!recorded) throw error;
            job = recallCommand(recorded, cursor);
          }
          /**
           * Reading a *settled* command is taking delivery of its outcome.
           *
           * Only a settled one: a peek at a running build says nothing about how it ended, and treating it as
           * delivery would let the model silence the notice for a command it never saw the result of — which is
           * the failure the notice exists to prevent. `subagent.collected` makes the same distinction from the
           * other side, where the child's transcript *is* the result whatever state it is in.
           */
          if (job.kind === 'command' && SETTLED_STATUS.has(job.status))
            context.commandJournal?.read([job.id]);
          return { isError: false, content: JSON.stringify(job) };
        } catch (error) {
          return { isError: true, content: failure(error) };
        }
      },
    },
    {
      name: 'job_kill',
      description:
        'Stop one job by id: a command and its process tree, or what a sub-agent is doing right now. A job that already finished is not an error — its final state is reported instead — and a command started by a process that is gone is answered from this session’s own record rather than called unknown. An interrupted sub-agent stays available to message again.',
      inputSchema: {
        type: 'object',
        properties: { id: ID },
        required: ['id'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        try {
          const id = String(args.id);
          let job: JobSnapshot;
          try {
            job = await control(context).kill({ id, scope, signal: context.signal });
          } catch (error) {
            /**
             * A command the process no longer holds cannot be stopped, and "no such job" is not the truth about it.
             *
             * The registry answers from memory, so after a restart every id it once knew becomes unknown — and an
             * id this session's own log records is not unknown: it is a command that was started, and whose
             * process this runtime is no longer the parent of. Answering from the record says which of the two
             * situations the caller is in: it ended (then there is nothing to stop, and how it ended is the
             * answer), or nothing recorded an outcome (then nothing here can stop it and whether it finished is
             * unknown, which is not the same as stopped).
             *
             * The recorded pid is deliberately not used to kill anything: a pid outlives its process, and pids are
             * reused, so signalling one from a log is how a stop request kills something unrelated.
             *
             * The fallback is as narrow as `job_output`'s: an id this session never recorded still fails with the
             * registry's own error.
             */
            const recorded = context.commandJournal?.record(id);
            if (!recorded) throw error;
            const recalled = recallCommand(recorded);
            const ended = SETTLED_STATUS.has(recalled.status);
            return {
              isError: false,
              content: ended
                ? `${recalled.id} already ended (${recalled.status}${recalled.exitCode === null || recalled.exitCode === undefined ? '' : `, exit ${recalled.exitCode}`}), and the process that ran it is gone: there is nothing left to stop.\n${JSON.stringify(recalled)}`
                : `${recalled.id} was started by a process that is gone and its record has no outcome: nothing here can stop it, and whether it finished is unknown — treat its effects as uncertain.\n${JSON.stringify(recalled)}`,
            };
          }
          const did = job.kind === 'subagent' ? 'Interrupted' : 'Stopped';
          return {
            isError: false,
            content: `${did} ${job.id} (${job.label}); it is now ${job.status}.\n${JSON.stringify(job)}`,
          };
        } catch (error) {
          return { isError: true, content: failure(error) };
        }
      },
    },
  ];
}
