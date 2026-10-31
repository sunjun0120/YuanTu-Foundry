/** Sub-agent options and ceilings, the scheduling records, and the notices a parent reads about its children. */
import type {
  AgentEventType,
  SubAgentRole,
  SubAgentSummary,
  SubAgentTaskStatus,
  Usage,
} from '../../protocol/index.ts';
import type { WorkspaceBinding, WorkspaceMode } from '../../protocol/workspaces.ts';
import type { PendingSubagentMessage } from '../../storage/projections.ts';
import type { SettlementNotice } from './settlements.ts';
import type {
  SubAgentParent,
  SubAgentProvider,
  SubAgentProviderRegistry,
  SubAgentRequestOptions,
  SubAgentSeed,
} from './providers.ts';

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
   * How long a sub-agent may make no progress before it is stopped, or `0` for no watchdog. Bounds
   * stall, not duration: the timer is re-armed by visible progress (message deltas, tool calls
   * starting or finishing, growing output tokens), so a working child is never stopped. Which
   * frames count is decided in the parent's `emit` (`packages/core/agent.ts`).
   *
   * The bound must exist: `settle()` runs in the parent run's `finally`, so a child that never
   * settles would keep the session locked.
   */
  timeoutMs?: number;
  /**
   * Most tokens (input plus output) one sub-agent may spend, or `0` for no budget. The stall
   * watchdog does not bound a busy loop; this does.
   */
  maxTokens?: number;
  /**
   * How long `collect_subagents` waits for running tasks by default, so the model does not fill the
   * gap with filler commands.
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
 * Limits applied once delegation is enabled. `enabled` is false by default because the kernel is
 * embedded by hosts whose billing it does not own; the CLI, JSONL host and desktop enable it, and
 * `YUANTU_SUBAGENTS=off` disables it.
 */
export const SUBAGENT_DEFAULTS = {
  enabled: false,
  maxDepth: 1,
  maxFanout: 4,
  /** Children allowed to work at once; the main bound on delegation. */
  maxConcurrency: 8,
  maxPerRun: 8,
  // Children have no round cap; the stall watchdog bounds them (ten minutes of silence).
  timeoutMs: 600_000,
  maxTokens: 4_000_000,
  collectWaitMs: 5_000,
} as const;
/**
 * Hard ceilings an operator may lower but never raise: `delegate_task` fans out billable runs, and
 * the width is advertised in the tool schema.
 */
export const SUBAGENT_CEILINGS = {
  maxFanout: 4,
  maxConcurrency: 8,
  // Long enough for a slow child; the wait also ends on a user correction or cancel.
  collectWaitMs: 120_000,
} as const;
export function resolveSubAgentOptions(options?: SubAgentOptions): ResolvedSubAgentOptions {
  const resolved: ResolvedSubAgentOptions = { ...SUBAGENT_DEFAULTS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (name === 'enabled') continue;
    // Zero means "do not wait" for `collectWaitMs`, "no watchdog" for `timeoutMs` and "no budget"
    // for `maxTokens`. Every other option is a cap and must stay positive.
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
 * What a parent is told when its child was stopped for going quiet; shared by the abort reason and
 * the recorded error.
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
/** One child's answer, for a caller that asked for exactly one (a workflow's `agent()`). */
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
   * True while this child's admitted run is live (false while queued and after settling). Set
   * together with arming the watchdog, so frames for a non-live task, including a resident child's
   * later turns, arm nothing.
   */
  active: boolean;
  /** Aborted by `settle` when the run ends without collecting this task. */
  controller: AbortController;
  /** Settles when this task settles, so `collect` can wait for it instead of making the model poll. */
  promise: Promise<void>;
  settleTask: () => void;
  /**
   * The stall watchdog, re-armed on progress and cleared on settle. On the task because progress is
   * observed in the parent's loop.
   */
  stallTimer?: NodeJS.Timeout;
  /** Aborts this child because it stopped making progress; separate from the run and caller signals. */
  stallController: AbortController;
  /** Set when the caller of `runOne` (a workflow call) stopped the child, so its error names that cause. */
  callerStopped?: boolean;
  /** Aborts this child because it spent its token budget (`SubAgentOptions.maxTokens`). */
  budgetController: AbortController;
  /**
   * The directory this child was given, held once so its turns, the result export and the report
   * agree.
   */
  binding?: WorkspaceBinding;
  /**
   * The task as admitted. The batch allocator keys directories by task identity, and the
   * capability-checked mode must be the allocated one.
   */
  admitted?: AdmittedTask;
  /**
   * The batch this task belongs to when children are isolated; it knows the frozen baseline and the
   * directories already handed out.
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
   * The provider that must run this task, when named; absent means the run's own. Unknown names are
   * refused before any child session is created.
   */
  provider?: string;
  /**
   * This child's own persona, when the caller installs one. Not offered by the delegation tools: a
   * role is the model's choice, a persona the deployment's (see `SubAgentRequestOptions.persona`).
   */
  persona?: string;
  /** The caller's own answer shape for this task, when it declared one (see `SubAgentTask.schema`). */
  schema?: Record<string, unknown>;
  /** Whether this task starts from the parent's transcript; set by which tool admitted it. */
  fork: boolean;
  /**
   * The directory this task needs, with `auto` resolved against its role. Resolved at admission
   * because the provider capability check depends on it.
   */
  workspaceMode: 'shared' | 'worktree';
}

/**
 * One delegation call's isolated directories. `forTask` allocates when a task starts, so cancelled
 * tasks cost nothing, from a baseline frozen once before any of them.
 */
export interface BatchWorkspace {
  /** The directory for one task, created on first use and remembered for the rest of the call. */
  forTask(task: AdmittedTask): Promise<WorkspaceBinding>;
  /** Releases whatever this batch holds that no child will use — nothing that a started child depends on. */
  release?(): Promise<void>;
}
/**
 * A counting semaphore. Concurrency is bounded across calls, so `wait: false` cannot bypass the
 * cap.
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
 * Resolves when the predicate turns true, by polling. The interval is returned so the racer can
 * dispose it in `finally`; `unref` alone would leave it polling forever.
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
 * What the parent is told when it starts background work, or when a blocking call stopped waiting
 * for a correction.
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
/** Undelivered messages quoted in full before the notice only counts the rest. */
const INBOX_NOTICE_LIMIT = 3;
/**
 * What the parent is told about messages it accepted for a child that never reached the child.
 * Never handed over: send again. Handed over: check before resending. Not marked delivered on read;
 * it repeats until resolved.
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
 * True when an explicit `ids` list names this child by task id or by child session id. An empty
 * identity never matches, so `ids: ['']` cannot select every queued child; the list only narrows.
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
   * True when the user has sent a correction the parent has not read, so a long collect window can
   * yield.
   */
  steerPending?: () => boolean;
  /** Which implementations can run a child, and what each one declares it can honour. */
  providers: SubAgentProviderRegistry;
  /** The provider this run delegates to unless the host configured a different default. */
  provider: string;
  /** Where this run sits in the lineage. Passed to the provider as data, never as a scope tree. */
  parent: SubAgentParent;
  /**
   * Models this host can run a child on, for `list_subagent_models`. Absent means the tool is not
   * registered.
   */
  models?: () => readonly { model: string; note?: string }[];
  /**
   * Records durably that a child's outcome reached the parent, so the notice stops repeating across
   * runs.
   */
  collected?: (ids: readonly string[]) => void;
  /**
   * Children that settled in an earlier run and were never read, oldest first, from the parent's
   * log.
   */
  settlements?: () => SettlementNotice[];
  /**
   * Messages this session accepted for a child and never handed over, oldest first, from the
   * parent's log.
   */
  inbox?: () => readonly PendingSubagentMessage[];
  /**
   * Allocates directories for a whole batch at once, so early and late children share one baseline.
   * Absent means no isolation: children share the delegator's directory.
   */
  workspaceForBatch?: (input: {
    tasks: readonly AdmittedTask[];
    signal: AbortSignal;
  }) => Promise<BatchWorkspace>;
  /**
   * How this run's tasks choose a directory; read at admission because it decides the capability
   * check.
   */
  workspaceMode?: WorkspaceMode;
}
