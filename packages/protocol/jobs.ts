/**
 * The model-facing shape of long-running work of any kind. One list/read/stop vocabulary; producers
 * supply the answers and the registry dispatches by which producer owns an id.
 */
export type JobKind = 'command' | 'subagent' | 'analysis';
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
 * A background command as the session log records it: the durable half that a later run can read.
 * `output` is the tail captured at settlement, not the whole ring.
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
 * The session's durable command record. `started` is written in the tool call, `settled` when the
 * process exits (possibly after the run), and `read` when the model looks at the result. Optional
 * like `todos`.
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
   * Every command this session recorded, oldest first, so a restarted process can still list them.
   */
  records(): CommandRecord[];
}
/**
 * The one place that answers list/read/stop for every kind of long-running work. Kind-agnostic, so
 * a new kind is a producer rather than new tools. Lives in `protocol` because both the kernel and
 * each tool registry own one: a child's registry answers for the child's jobs.
 */
/**
 * No producer in this process owns that job id. A type so callers can tell it from a failed stop
 * without matching prose.
 */
export class UnknownJobError extends Error {
  constructor(id: string) {
    super(`Unknown job "${id}"; call job_list to see this session's jobs`);
    this.name = 'UnknownJobError';
  }
}
export class JobRegistry implements JobControl {
  private producers: JobProducer[] = [];
  /**
   * Adds a producer and returns the disposer that withdraws it, so per-run producers do not leak
   * into the next run.
   */
  register(producer: JobProducer): () => void {
    // One producer per kind, so ownership of an id is always answerable.
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
    // An id owned twice would make `job_output` read a different job than `job_list` showed.
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
    if (!owners.length) throw new UnknownJobError(id);
    return owners[0]!;
  }
  output(job: JobScope & { cursor: number; waitMs: number }): Promise<JobSnapshot> {
    return this.owner(job.id, job.scope).output(job);
  }
  kill(job: JobScope): Promise<JobSnapshot> {
    return this.owner(job.id, job.scope).kill(job);
  }
}
