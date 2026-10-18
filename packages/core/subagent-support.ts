/** Sub-agent options and ceilings, the scheduling records, and the notices a parent reads about its children. */
import type {
  AgentEventType,
  SubAgentRole,
  SubAgentSummary,
  SubAgentTaskStatus,
  Usage,
} from '../protocol/index.ts';
import type { WorkspaceBinding, WorkspaceMode } from '../protocol/workspaces.ts';
import type { PendingSubagentMessage } from '../storage/projections.ts';
import type { SettlementNotice } from './settlements.ts';
import type {
  SubAgentParent,
  SubAgentProvider,
  SubAgentProviderRegistry,
  SubAgentRequestOptions,
  SubAgentSeed,
} from './subagent-providers.ts';

export interface SubAgentOptions {
  enabled?: boolean;
  /** How deep delegation may nest. 1 means sub-agents cannot delegate further. */
  maxDepth?: number;
  /** Tasks accepted in a single `delegate_task` call. */
  maxFanout?: number;
  /** Sub-agents running at once. */
  maxConcurrency?: number;
  /** Sub-agents a single parent run may start in total. */
  maxPerRun?: number;
  /**
   * How long a sub-agent may make **no progress** before it is stopped, or `0` for no watchdog at all.
   *
   * This was a deadline on the child's whole life, and a deadline is the wrong instrument for a child: it cannot
   * tell a stuck child from a slow one. A fixed budget above the real half-life of a long investigation (ten
   * minutes) failed exactly the delegations worth paying for — the parent was told its child "timed out", the
   * child's partial work was discarded, and the same ground had to be delegated again. That is what happened to
   * the four parallel repository scans this option was changed for.
   *
   * The watchdog that replaces it is re-armed by the child's own visible progress: a message delta, a tool call
   * starting or finishing, or an output token count that grew. A child that keeps working is never stopped,
   * however long it takes; a child that has gone silent — a stalled stream, a tool that never answers, a loop
   * that produces nothing — is stopped after this long. So the option now bounds *stall*, which is the thing
   * worth bounding, instead of bounding *duration*, which was only ever a proxy for it.
   *
   * Which frames count is decided in the parent loop's `emit` (`packages/core/agent.ts`), because that is the
   * only seam both of a child's frame paths pass through. The list there is the authority; this sentence is a
   * summary of it, and it used to disagree with it: only message deltas re-armed the timer at first, so a child
   * that worked through tools without talking was stopped and had its finished work discarded.
   *
   * The bound still has to exist, and removing it entirely would be a defect rather than a simplification: this
   * coordinator's `settle()` runs in the parent run's `finally`, so a child that never settles holds the parent
   * run open — its session stays locked and no later turn can start. The watchdog is what guarantees that a
   * single wedged child cannot do that.
   */
  timeoutMs?: number;
  /**
   * The most tokens (input plus output, as the child reports them) one sub-agent may spend, or `0` for no budget.
   *
   * The stall watchdog bounds silence, not spend: a child that keeps producing is never stopped by it, and a child
   * has no round cap, so a busy loop — edit, test, the same failure — could spend without limit while looking
   * healthy. This is the bound on that, measured from the child's own progress frames, so it does not depend on
   * how long the work takes.
   */
  maxTokens?: number;
  /**
   * How long `collect_subagents` waits for running tasks by default. Without a wait the model has
   * nothing to wait *with*: the live run showed it filling the gap with filler shell commands.
   */
  collectWaitMs?: number;
}
export interface ResolvedSubAgentOptions {
  enabled: boolean;
  maxDepth: number;
  maxFanout: number;
  maxConcurrency: number;
  maxPerRun: number;
  timeoutMs: number;
  maxTokens: number;
  collectWaitMs: number;
}
/**
 * Limits applied once delegation is switched on.
 *
 * `enabled` is false by default: the kernel is embedded by hosts whose context budget and billing the
 * agent does not own, and registering a tool that can fan out billable model runs is not a safe
 * default for a library. The CLI, the JSONL host and the desktop turn it on explicitly, and an
 * operator can turn it back off with YUANTU_SUBAGENTS=off.
 */
export const SUBAGENT_DEFAULTS = {
  enabled: false,
  maxDepth: 1,
  maxFanout: 4,
  /**
   * Children allowed to work at once, which is what bounds delegation now that no token pool does.
   *
   * A slot is the resource a parent shares with its children: each child has its own session, its own window
   * and its own aim, so the only thing a parent can run out of is room to run another one — and that is a
   * count, not an allowance. Eight is wide enough for a genuine fan-out and small enough that a parent which
   * spawned everything it could still has one model connection's worth of work in flight.
   */
  maxConcurrency: 8,
  maxPerRun: 8,
  // No round allowance: a child is a run like any other, and a run has no round cap to reach. What bounds a child
  // here is the stall watchdog below — ten minutes of *silence*, not ten minutes of life — because the parent run
  // cannot finish while one of its children is wedged (`settle()` joins them in its `finally`).
  timeoutMs: 600_000,
  maxTokens: 4_000_000,
  collectWaitMs: 5_000,
} as const;
/**
 * Hard ceilings. An operator may lower these, never raise them: `delegate_task` fans out real,
 * billable model runs, and the fan-out width is also what the tool schema advertises to the model.
 */
export const SUBAGENT_CEILINGS = {
  maxFanout: 4,
  maxConcurrency: 8,
  // Long enough to cover a slow child in one call. Safe because the wait also ends when the user sends
  // a correction or cancels, so it cannot hold either of them hostage.
  collectWaitMs: 120_000,
} as const;
export function resolveSubAgentOptions(options?: SubAgentOptions): ResolvedSubAgentOptions {
  const resolved: ResolvedSubAgentOptions = { ...SUBAGENT_DEFAULTS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (name === 'enabled') continue;
    // Zero is meaningful for the two windows here and means "do not wait": `collectWaitMs` restores "return at
    // once", and `timeoutMs` restores "no wall clock, let the child finish". Every other option is a cap, where
    // a zero limit would silently disable it, so those must stay positive.
    if ((name === 'collectWaitMs' || name === 'timeoutMs' || name === 'maxTokens') && value === 0)
      continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1)
      throw new Error(`Invalid sub-agent option ${name}`);
  }
  resolved.maxFanout = Math.min(resolved.maxFanout, SUBAGENT_CEILINGS.maxFanout);
  resolved.maxConcurrency = Math.min(resolved.maxConcurrency, SUBAGENT_CEILINGS.maxConcurrency);
  resolved.collectWaitMs = Math.min(resolved.collectWaitMs, SUBAGENT_CEILINGS.collectWaitMs);
  return resolved;
}
/**
 * What a parent is told when its child was stopped for going quiet.
 *
 * One function because the abort reason and the recorded error have to be the same sentence — the model reads the
 * tool result and an operator reads the card, and two hand-written copies of one fact is how they drift.
 */
export function stallMessage(timeoutMs: number): string {
  const window = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`;
  return `Sub-agent made no progress for ${window}`;
}
export function budgetMessage(maxTokens: number): string {
  return `Sub-agent exceeded its token budget of ${maxTokens} tokens`;
}
/** A promise that never resolves, for the optional race arms. */
export const NEVER = new Promise<void>(() => {});
export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
/** One finished task's summary plus the report text that only the parent's tool result needs. */
export interface SubAgentResult {
  summary: SubAgentSummary;
  text: string;
  /** Present when this task was forked: what it inherited, so the parent can see the copy was trimmed. */
  seed?: SubAgentSeed;
  /** Present when this task declared its own `schema`: the object the child came back with. */
  data?: unknown;
}
/**
 * One child's answer, for a caller that asked for exactly one child.
 *
 * Deliberately not {@link SubAgentResult}: a workflow's `agent()` wants "what did it say", and the reporting
 * shape exists to introduce *several* children to a model that did not address them individually. The summary
 * itself stays on the card and in the log, where every other reader finds it.
 */
export interface SubAgentAnswer {
  status: SubAgentTaskStatus;
  sessionId: string;
  answer: string;
  /** The structured answer, when the caller asked for a shape of its own. */
  data?: unknown;
  rounds: number;
  error?: string;
}
/** One admitted task: it exists as soon as it is scheduled, whether or not anyone waits for it. */
export interface ScheduledSubAgent {
  id: string;
  index: number;
  total: number;
  role: SubAgentRole;
  objective: string;
  context?: string;
  /** `subagent_fork` rather than `delegate_task`: this child starts from the parent's transcript. */
  fork: boolean;
  /** What the child inherited, once it has started. */
  seed?: SubAgentSeed;
  /** The answer shape this task declared, before any child existed. */
  schema?: Record<string, unknown>;
  /** The child's structured answer, once it submitted one under that schema. */
  data?: unknown;
  /** What the caller asked the provider for; already validated against its capabilities. */
  options: SubAgentRequestOptions;
  /** The provider that accepted this task, chosen and capability-checked before any child existed. */
  provider: SubAgentProvider;
  summary: SubAgentSummary;
  text: string;
  collected: boolean;
  done: boolean;
  /**
   * True while this child's admitted run is live: false while it is still queued behind the concurrency cap,
   * and false again once it has settled.
   *
   * The watchdog is armed in the same step that sets this, so the two cannot disagree: a frame observed for a
   * task whose run is not live has no watchdog to re-arm and must not create one. The second half is what keeps
   * a *settled* task's frames — a resident child's later turn arrives on the same id — from arming a timer that
   * nothing would clear.
   */
  active: boolean;
  /** Aborted by `settle` when the run ends without collecting this task. */
  controller: AbortController;
  /** Settles when this task settles, so `collect` can wait for it instead of making the model poll. */
  promise: Promise<void>;
  settleTask: () => void;
  /**
   * The stall watchdog: re-armed every time this child shows progress, cleared when it settles.
   *
   * It lives on the task rather than inside `execute` because the progress that re-arms it is observed
   * elsewhere — the parent's loop sees the child's own events — and a per-execution local would be unreachable
   * from there.
   */
  stallTimer?: NodeJS.Timeout;
  /** Aborts this child because it stopped making progress; separate from the run and caller signals. */
  stallController: AbortController;
  /** Set when the caller of `runOne` (a workflow call) stopped the child, so its error names that cause. */
  callerStopped?: boolean;
  /** Aborts this child because it spent its token budget (`SubAgentOptions.maxTokens`). */
  budgetController: AbortController;
  /**
   * The directory this child was given, once it has one.
   *
   * Held on the task rather than recomputed per use, because the three places that need it — the child's turns, the
   * result export, and the report the parent reads — must agree about which directory the child worked in.
   */
  binding?: WorkspaceBinding;
  /**
   * The task as it was admitted, kept for the one caller that needs the whole thing later.
   *
   * The batch allocator keys its directories by task identity, and reconstructing the task at dispatch time would
   * hand it a different object — so the admitted task travels with the scheduled one instead. Rebuilding it would
   * also be a place for the two to drift: the mode that was capability-checked is the mode the directory must be
   * allocated for.
   */
  admitted?: AdmittedTask;
  /**
   * The batch this task belongs to, when this run isolates its children.
   *
   * Held per task rather than looked up at dispatch, because the directory must be allocated by the *batch* — it is
   * the object that knows which baseline was frozen for this call and which directories it has already handed out.
   */
  batch?: BatchWorkspace;
}
/** One task as the coordinator accepts it, after normalisation and before it is scheduled. */
export interface AdmittedTask {
  role: SubAgentRole;
  objective: string;
  context?: string;
  model?: string;
  /**
   * The provider that must run this task, when the caller named one.
   *
   * Absent means "whatever this run's provider is", which is what every task meant before this field
   * existed. It is resolved through the same registry as the default, so an unknown name is refused
   * with the list of names that do exist, before any child session is created.
   */
  provider?: string;
  /**
   * This child's own persona, when its caller has one to install.
   *
   * Set by a caller that composes per-task identities; the delegation *tools* do not offer it, because a role is
   * what a model chooses and a persona is what a deployment decides. It travels to the provider so that the
   * `persona` capability means something a provider can honour — see `SubAgentRequestOptions.persona` for why this
   * is not the role prompt.
   */
  persona?: string;
  /** The caller's own answer shape for this task, when it declared one (see `SubAgentTask.schema`). */
  schema?: Record<string, unknown>;
  /** Whether this task starts from the parent's transcript; set by which tool admitted it. */
  fork: boolean;
  /**
   * Which directory this task asked for, after `auto` was resolved against its role.
   *
   * Resolved at admission rather than at dispatch, because the capability check that decides whether the task may
   * run at all depends on it: a provider that cannot isolate must refuse a task that needs isolation *before* any
   * child session exists, and a task that only wanted a shared directory must not be refused for a capability it
   * never needed.
   */
  workspaceMode: 'shared' | 'worktree';
}

/**
 * What one delegation call's worth of isolated directories looks like from the coordinator's side.
 *
 * Two operations, and the split between them is the plan's rule stated as an interface. `forTask` is called when a
 * task actually starts, so a batch that is refused or cancelled before dispatch never pays for directories it does
 * not use; the *baseline* it allocates from was frozen once, before any of them, so the order they start in cannot
 * change what they see.
 */
export interface BatchWorkspace {
  /** The directory for one task, created on first use and remembered for the rest of the call. */
  forTask(task: AdmittedTask): Promise<WorkspaceBinding>;
  /** Releases whatever this batch holds that no child will use — nothing that a started child depends on. */
  release?(): Promise<void>;
}
/**
 * A counting semaphore. The coordinator used to bound concurrency per call, which stopped being enough
 * the moment a call could return without waiting: `wait: false` would have been a way around the cap.
 */
export class Semaphore {
  private available: number;
  private readonly waiting: (() => void)[] = [];
  constructor(size: number) {
    this.available = size;
  }
  async run<T>(worker: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await worker();
    } finally {
      // Hand the slot straight to the next waiter instead of releasing and re-acquiring.
      const next = this.waiting.shift();
      if (next) next();
      else this.available++;
    }
  }
}
/** Resolves after `ms`, without holding the event loop open by itself. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending poll must not be the reason a process stays alive.
    timer.unref?.();
  });
}
/** Resolves when the signal aborts, so a wait ends early instead of ignoring a cancellation. */
export function abortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
/**
 * Resolves as soon as the predicate turns true. Polling is enough: threading a queue event into the
 * coordinator would couple it to the run loop to save a latency nobody can perceive next to a model round.
 *
 * The interval is returned with the promise because `unref` only stops a pending poll from holding the process
 * open — it does not stop the poll. A race that was won by another branch leaves this one running forever,
 * calling the predicate every interval for the rest of the process's life: a `steerPending` read per tick, and
 * a query against the durable inbox behind it. Whoever raced it disposes it in a `finally`, which is the only
 * place that runs whether the poll, the race or an exception ended the wait.
 */
export function whenTrue(
  predicate: () => boolean,
  intervalMs = 250,
): { promise: Promise<void>; dispose: () => void } {
  if (predicate()) return { promise: Promise.resolve(), dispose: () => {} };
  let timer: NodeJS.Timeout | undefined;
  const dispose = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  const promise = new Promise<void>((resolve) => {
    timer = setInterval(() => {
      if (!predicate()) return;
      dispose();
      resolve();
    }, intervalMs);
    timer.unref?.();
  });
  return { promise, dispose };
}
/**
 * What the parent is told when it starts background work instead of waiting for it, or when a blocking
 * call stopped waiting because a correction arrived.
 */
export function startedNotice(
  scheduled: readonly ScheduledSubAgent[],
  interrupted = false,
): string {
  const lines = scheduled.map(
    (task) =>
      `- ${task.id} [${task.role}] ${task.objective}${task.done ? ` — not started: ${task.summary.error ?? 'unknown reason'}` : ''}`,
  );
  return [
    interrupted
      ? `Stopped waiting for ${scheduled.length} sub-agent task(s) because a new instruction arrived; they are still running:`
      : `Started ${scheduled.length} sub-agent task(s):`,
    ...lines,
    'They keep working while you continue. Call collect_subagents for their reports; if one is still working when your turn ends it is stopped, and you will be told its outcome at the start of your next turn so you can collect it then or resume that same child with send_message.',
  ].join('\n');
}
/**
 * How many undelivered messages are quoted in full before the notice only counts the rest.
 *
 * The notice exists to be acted on, so the message has to be there to act on; the cap is what keeps a session
 * that queued twenty of them from spending its context on the reminder.
 */
const INBOX_NOTICE_LIMIT = 3;
/**
 * What the parent is told about messages it accepted for a child that never reached the child's transcript.
 *
 * The two states get different sentences because they have different prescriptions, and a single sentence would
 * have to be wrong for one of them: a message that was never handed over never reached the child (send it
 * again), while one whose hand-off happened may already be in the child's next step (look before resending).
 * Phrased as an instruction rather than a status either way, because there is something to *do* about both. It
 * is deliberately not marked as delivered when it is read — unlike a report, reading this does not resolve it,
 * and a notice that stopped after one read would be the silent failure it exists to report.
 */
export function inboxNotice(entries: readonly PendingSubagentMessage[]): string {
  const line = (entry: PendingSubagentMessage) =>
    `- ${entry.id} → ${entry.childSessionId}: ${entry.message.slice(0, 160).replace(/\s+/g, ' ')}`;
  const neverHanded = entries.filter((entry) => !entry.handed);
  const unconfirmed = entries.filter((entry) => entry.handed);
  const groups: string[] = [];
  for (const [group, header] of [
    [
      neverHanded,
      `Accepted for a sub-agent and never delivered (${neverHanded.length}): the message was written down before the hand-off, and nothing recorded the hand-off, so the process stopped in between and the child never saw it. Send it again with send_message:`,
    ],
    [
      unconfirmed,
      `Handed to a sub-agent that never recorded reading it (${unconfirmed.length}): a turn's queue accepted the message, but no turn has folded it into the child's transcript — the process may have stopped before the next step boundary. Read the child first (collect_subagents or job_output), and send it again only if its transcript does not show it:`,
    ],
  ] as const) {
    if (!group.length) continue;
    const shown = group.slice(0, INBOX_NOTICE_LIMIT);
    groups.push(
      header,
      ...shown.map(line),
      ...(group.length > shown.length
        ? [`…and ${group.length - shown.length} more of these.`]
        : []),
    );
  }
  return groups.join('\n');
}
/**
 * True when an explicit `ids` list names this child, in either of the two names a child has.
 *
 * The delegation's task id is what the started notice quotes and what `subagent.delta` carries; the child's own
 * session is what `job_output` and `send_message` address and what `subagent.progress` carries. One matcher,
 * because each collect path had grown its own comparison and two of them had grown the wrong one: `running` and
 * `reports` were selected on the task id alone, so a parent that named the child by its session was answered
 * "No outstanding sub-agents" — and the wait did not wait for it either, since its pending filter read the same
 * field. The inbox narrowing reads this too, for the same reason.
 *
 * An empty identity never matches. A task that is scheduled but has not started yet has no session id of its
 * own, and `ids: ['']` is a legal call, so comparing that field unguarded would read an empty name as "the
 * children that have no session yet" and turn a narrowing list into a selection of everything queued. An id
 * that names no child selects no child: the list only ever narrows.
 */
export function isSelected(
  wanted: Set<string> | undefined,
  ...identities: readonly string[]
): boolean {
  if (!wanted) return true;
  return identities.some((identity) => identity !== '' && wanted.has(identity));
}
export interface SubAgentCoordinatorDeps {
  options: ResolvedSubAgentOptions;
  /** Emits a parent-scoped event; the agent loop owns session and run attribution. */
  emit: (type: AgentEventType, data: Record<string, unknown>) => void;
  signal: AbortSignal;
  /** Folds a finished child's usage into the parent's running totals. Reported, never an admission test. */
  onUsage: (usage: Usage) => void;
  /** True when the parent run is read-only (plan mode), which forbids write-capable sub-agents. */
  readOnly: boolean;
  /**
   * True when the user has sent a correction the parent has not read yet.
   *
   * It exists so a long collect window can yield to the user: without it the only choices are a short
   * window that forces polling for slow children, or a long one that holds a correction hostage.
   */
  steerPending?: () => boolean;
  /** Which implementations can run a child, and what each one declares it can honour. */
  providers: SubAgentProviderRegistry;
  /** The provider this run delegates to unless the host configured a different default. */
  provider: string;
  /** Where this run sits in the lineage. Passed to the provider as data, never as a scope tree. */
  parent: SubAgentParent;
  /**
   * The models this host can actually run a child on, for `list_subagent_models`.
   *
   * Absent when the host has no opinion, and then the tool is not registered at all: a discovery tool that
   * can only guess would be worse than no tool, because the model would trust it.
   */
  models?: () => readonly { model: string; note?: string }[];
  /**
   * Records that a child's outcome reached the parent, so the notice stops repeating.
   *
   * The coordinator knows *what* was delivered; only the agent can write it down, because the parent's durable
   * log is the agent's. Delivery has to outlive the run: the whole point of the notice is the parent that
   * comes back later, and "collected" is what tells that parent's next request it has already been told.
   */
  collected?: (ids: readonly string[]) => void;
  /**
   * Children that settled in an *earlier* run and were never read, oldest first.
   *
   * `collect_subagents` is documented as the way to read background results, so after a run boundary it has to
   * answer for the children of that run too — and the only place they still exist is the parent's log.
   */
  settlements?: () => SettlementNotice[];
  /**
   * Messages this session accepted for a child and never handed over, oldest first.
   *
   * Read from the parent's log through the same seam as `settlements`, and for the same reason: the failure it
   * reports is a durable one. A message is written down before it is delivered, so a process that stops in
   * between leaves a record of something the *parent* believes it sent — and the only reader that can tell the
   * parent is the one that folds the log.
   */
  inbox?: () => readonly PendingSubagentMessage[];
  /**
   * The directory a task must be given, when this run isolates its children at all.
   *
   * Called once for the whole batch, and the answer is reused for every task in it — including the ones that are
   * still queued behind the concurrency cap when the call returns. That is the whole reason it takes the task list
   * as one argument instead of being read per child: a snapshot taken when a child *happens to start* would give
   * the early and late children of one delegation two different baselines, which is exactly the divergence that
   * makes two agents overwrite each other's conclusions.
   *
   * Absent means this run does not isolate: every child shares the delegator's directory, as it always did.
   */
  workspaceForBatch?: (input: {
    tasks: readonly AdmittedTask[];
    signal: AbortSignal;
  }) => Promise<BatchWorkspace>;
  /**
   * How this run's tasks choose a directory.
   *
   * Read at admission, because it decides two things at once: whether a task is shared or isolated, and therefore
   * which provider capability the task has to be checked against before any child exists.
   */
  workspaceMode?: WorkspaceMode;
}
