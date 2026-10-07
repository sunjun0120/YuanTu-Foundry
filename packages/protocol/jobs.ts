/**
 * The model-facing shape of long-running work, whichever kind it is.
 *
 * Commands and sub-agents used to be two vocabularies for the same three questions — list, read, stop — so
 * the model had to remember which pair of tool names applied to which kind, and a third kind would have
 * meant a third pair. These types describe the answers, not the kinds: a producer supplies them and the
 * registry dispatches on which producer owns an id.
 */
export type JobKind = 'command' | 'subagent';
/** One job as every consumer sees it, whichever producer owns it. */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  sessionId: string;
  /** One line a human and the model can identify the job by: the command, or the objective. */
  label: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  /** Incremental output since `cursor`. Commands: the output ring. Sub-agents: their durable transcript. */
  output: string;
  nextCursor: number;
  truncated: boolean;
  /** Kind-specific facts worth showing: a command's cwd, a child's rounds and token spend. */
  detail?: Record<string, unknown>;
}
export interface JobScope {
  id: string;
  /** The session the caller is acting for. A job is only reachable from the session that owns it. */
  scope: string;
  signal?: AbortSignal;
}
export interface JobProducer {
  kind: JobKind;
  /** Whether this producer is the one that owns `id` in `scope`. */
  owns(job: { id: string; scope: string }): boolean;
  list(scope: string): JobSnapshot[];
  output(job: JobScope & { cursor: number; waitMs: number }): Promise<JobSnapshot>;
  kill(job: JobScope): Promise<JobSnapshot>;
}
/** What a tool sees: the read side of the registry, without the ability to register a producer. */
export interface JobControl {
  list(scope: string): JobSnapshot[];
  output(job: JobScope & { cursor: number; waitMs: number }): Promise<JobSnapshot>;
  kill(job: JobScope): Promise<JobSnapshot>;
}
/**
 * A background command as the session's own log records it.
 *
 * The registry's job is memory: it holds the process, the ring and the exit code, and it dies with the process.
 * This is the durable half — what the session started and how it ended — which is the only thing a *later* run
 * can read. `output` is the tail captured at settlement rather than the ring itself: recording every byte a
 * command prints would make the log a second copy of the ring, and a bounded tail is what keeps "here is what it
 * said last" answerable after the process that knew the rest is gone.
 */
export interface CommandRecord {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  createdAt: string;
  /** Absent while it is still running, which is what `command.started` without `command.settled` means. */
  status?: string;
  finishedAt?: string;
  exitCode?: number | null;
  /** The tail of what it printed, as recorded when it settled. Empty when it printed nothing. */
  output: string;
  /** How many characters it printed in total, so a reader can say what the tail is a tail of. */
  outputChars: number;
}
/**
 * The session's durable command record, supplied to a run by whoever owns the session.
 *
 * A command outlives the call that started it, so the write has to outlive that call too: `started` happens
 * inside the tool call, `settled` happens when the process exits — possibly in a later turn, possibly after the
 * run that started it is over — and `read` happens when the model finally looks at the result. Optional for the
 * same reason `todos` is: an embedder with no session has nowhere to record any of it, and the tools then behave
 * exactly as they did before this seam existed.
 */
export interface CommandJournal {
  started(record: {
    id: string;
    sessionId: string;
    command: string;
    cwd: string;
    createdAt: string;
  }): void;
  settled(record: {
    cleanupConfirmed?: boolean;
    id: string;
    sessionId: string;
    status: string;
    exitCode: number | null;
    finishedAt: string;
    output: string;
    outputChars: number;
  }): void;
  /** The model read the finished command's output: it has been delivered, so the notice can stop. */
  read(ids: readonly string[]): void;
  /** One command's durable record, for a job the process no longer holds. */
  record(id: string): CommandRecord | undefined;
  /**
   * Every command this session recorded, oldest first.
   *
   * The listing half of the same answer: a reader that has the id can already read a finished command after a
   * restart, but "which commands did this session start?" was unanswerable — the registry lists what the process
   * holds, and a restarted process holds nothing. A session's own log is where that question belongs.
   */
  records(): CommandRecord[];
}
/**
 * The one place that answers "list / read / stop" for every kind of long-running work.
 *
 * It is deliberately kind-agnostic — it knows producers, not commands or children — so that adding a third
 * kind of job is a producer, not another pair of tools the model has to learn. It lives here rather than in
 * `packages/core` because both the kernel and the tool registry own one: the registry that runs a child's
 * tools has to answer for that child's own jobs, not the parent's.
 */
export class JobRegistry implements JobControl {
  private producers: JobProducer[] = [];
  /**
   * Adds a producer and returns the disposer that withdraws it.
   *
   * The disposer matters for producers whose state is per-run: without it a second run would either
   * double-register or keep reading the first run's closures.
   */
  register(producer: JobProducer): () => void {
    // One producer per kind. Two would make "who owns this id" unanswerable at registration, which is
    // exactly the silence this registry exists to remove.
    if (this.producers.some((entry) => entry.kind === producer.kind))
      throw new Error(`A ${producer.kind} job producer is already registered`);
    this.producers.push(producer);
    return () => {
      const index = this.producers.indexOf(producer);
      if (index >= 0) this.producers.splice(index, 1);
    };
  }
  list(scope: string): JobSnapshot[] {
    const jobs = this.producers.flatMap((producer) => producer.list(scope));
    // An id owned twice would make `job_output` read a different job than `job_list` showed. Producers only
    // learn their ids when jobs are created, so this is the earliest honest place to catch it.
    const seen = new Set<string>();
    for (const job of jobs) {
      if (seen.has(job.id))
        throw new Error(`Job id "${job.id}" is claimed by more than one producer`);
      seen.add(job.id);
    }
    return jobs;
  }
  private owner(id: string, scope: string): JobProducer {
    const owners = this.producers.filter((producer) => producer.owns({ id, scope }));
    if (owners.length > 1) throw new Error(`Job id "${id}" is claimed by more than one producer`);
    if (!owners.length)
      throw new Error(`Unknown job "${id}"; call job_list to see this session's jobs`);
    return owners[0]!;
  }
  output(job: JobScope & { cursor: number; waitMs: number }): Promise<JobSnapshot> {
    return this.owner(job.id, job.scope).output(job);
  }
  kill(job: JobScope): Promise<JobSnapshot> {
    return this.owner(job.id, job.scope).kill(job);
  }
}
