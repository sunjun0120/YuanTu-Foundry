import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import type {
  AgentEventType,
  SubAgentRole,
  SubAgentSummary,
  SubAgentSummaryReport,
  SubAgentTaskStatus,
  Tool,
  Usage,
} from '../protocol/index.ts';
import { failure } from '../tools/registry.ts';
import type { PendingSubagentMessage } from '../storage/projections.ts';
import { redactSecrets } from './errors.ts';
import type { SettlementNotice } from './settlements.ts';
import type {
  SubAgentOutcome,
  SubAgentParent,
  SubAgentProvider,
  SubAgentProviderRegistry,
  SubAgentRequestOptions,
  SubAgentSeed,
  SubAgentStartRequest,
  SubAgentTask,
} from './subagent-providers.ts';
export type {
  SubAgentCapability,
  SubAgentOutcome,
  SubAgentParent,
  SubAgentProvider,
  SubAgentRequestOptions,
  SubAgentSeed,
  SubAgentStartRequest,
  SubAgentTask,
} from './subagent-providers.ts';
export {
  SubAgentCapabilityError,
  SubAgentProviderRegistry,
  UnknownSubAgentProviderError,
} from './subagent-providers.ts';

/**
 * Sub-agent delegation.
 *
 * The parent loop stays serial; what this module adds is a bounded fan-out to child runs that each own
 * a private session, so a long or noisy side investigation costs the parent one bounded report instead
 * of a transcript. Everything here is deliberately capped: an agent that can spawn agents without
 * limits can spend an unbounded amount of the user's money on its own judgement.
 */
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
/**
 * How large a caller-supplied answer schema may be, serialised.
 *
 * It is not only a limit on the request: the whole schema is the child's tool definition, so every field
 * description in it is paid for on every round the child runs — a schema the caller is careless with is a bill
 * the child pays.
 */
const MAX_TASK_SCHEMA_CHARS = 4_000;
export function resolveSubAgentOptions(options?: SubAgentOptions): ResolvedSubAgentOptions {
  const resolved: ResolvedSubAgentOptions = { ...SUBAGENT_DEFAULTS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (name === 'enabled') continue;
    // Zero is meaningful for the two windows here and means "do not wait": `collectWaitMs` restores "return at
    // once", and `timeoutMs` restores "no wall clock, let the child finish". Every other option is a cap, where
    // a zero limit would silently disable it, so those must stay positive.
    if ((name === 'collectWaitMs' || name === 'timeoutMs') && value === 0) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1)
      throw new Error(`Invalid sub-agent option ${name}`);
  }
  resolved.maxFanout = Math.min(resolved.maxFanout, SUBAGENT_CEILINGS.maxFanout);
  resolved.maxConcurrency = Math.min(resolved.maxConcurrency, SUBAGENT_CEILINGS.maxConcurrency);
  resolved.collectWaitMs = Math.min(resolved.collectWaitMs, SUBAGENT_CEILINGS.collectWaitMs);
  return resolved;
}
export interface SubAgentTaskShape {
  id: string;
  index: number;
  role: SubAgentRole;
  objective: string;
  context?: string;
}
/**
 * Runs one child and resolves with its outcome. Provided by the agent loop, which owns the store,
 * provider and tool registry the child needs; this module never imports the agent so the dependency
 * stays one-way.
 *
 * It is the body of the built-in `in-process` provider rather than the only way to delegate; see
 * `subagent-providers.ts` for the seam itself.
 */
export type SubAgentSpawn = (request: SubAgentStartRequest) => Promise<SubAgentOutcome>;
export class SubAgentLimitError extends Error {}
/**
 * What a parent is told when its child was stopped for going quiet.
 *
 * One function because the abort reason and the recorded error have to be the same sentence — the model reads the
 * tool result and an operator reads the card, and two hand-written copies of one fact is how they drift.
 */
function stallMessage(timeoutMs: number): string {
  const window = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`;
  return `Sub-agent made no progress for ${window}`;
}
/** A promise that never resolves, for the optional race arms. */
const NEVER = new Promise<void>(() => {});
const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
/** One finished task's summary plus the report text that only the parent's tool result needs. */
interface SubAgentResult {
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
interface ScheduledSubAgent {
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
}
/** One task as the coordinator accepts it, after normalisation and before it is scheduled. */
interface AdmittedTask {
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
}
/**
 * A counting semaphore. The coordinator used to bound concurrency per call, which stopped being enough
 * the moment a call could return without waiting: `wait: false` would have been a way around the cap.
 */
class Semaphore {
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
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending poll must not be the reason a process stays alive.
    timer.unref?.();
  });
}
/** Resolves when the signal aborts, so a wait ends early instead of ignoring a cancellation. */
function abortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
/**
 * Resolves as soon as the predicate turns true. Polling is enough: threading a queue event into the
 * coordinator would couple it to the run loop to save a latency nobody can perceive next to a model round.
 */
function whenTrue(predicate: () => boolean, intervalMs = 250): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!predicate()) return;
      clearInterval(timer);
      resolve();
    }, intervalMs);
    timer.unref?.();
  });
}
/**
 * What the parent is told when it starts background work instead of waiting for it, or when a blocking
 * call stopped waiting because a correction arrived.
 */
function startedNotice(scheduled: readonly ScheduledSubAgent[], interrupted = false): string {
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
function inboxNotice(entries: readonly PendingSubagentMessage[]): string {
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
}
export class SubAgentCoordinator {
  private deps: SubAgentCoordinatorDeps;
  private readonly records: SubAgentSummary[] = [];
  /** One semaphore per run, not per call: background and blocking tasks must share the same cap. */
  private readonly limiter: Semaphore;
  private readonly scheduled: ScheduledSubAgent[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private started = 0;
  constructor(deps: SubAgentCoordinatorDeps) {
    this.deps = deps;
    this.limiter = new Semaphore(deps.options.maxConcurrency);
  }
  /**
   * The parent's read-only promise was lifted, so its children's is too.
   *
   * Called when a planning run has its plan approved mid-run: the parent may now write, and a run that may
   * write may also delegate work that writes. Without this the guard below would keep refusing a `general`
   * child for a restriction that no longer exists — a refusal that is merely mysterious, since the parent can
   * see its own write tools back.
   *
   * One direction only, and deliberately: there is no path that makes a run read-only again, because an
   * approval is not a thing a run can undo.
   */
  promoteToWritable(): void {
    if (!this.deps.readOnly) return;
    this.deps = { ...this.deps, readOnly: false };
  }
  get summaries(): SubAgentSummary[] {
    return this.records.map((record) => ({ ...record }));
  }
  /**
   * The tool the parent model calls. Delegation itself needs no approval: a sub-agent cannot exceed
   * the parent's authority, because every write, command or external call it makes goes through the
   * same approver as the parent's own tools.
   */
  tool(): Tool {
    return {
      name: 'delegate_task',
      description:
        'Delegate self-contained work to sub-agents that run in parallel, each with its own context, and return a report. ' +
        'Use it for broad independent investigation (several parts of the codebase at once) or for a long side quest whose raw output you do not want in this conversation. ' +
        'Do not use it for work you could finish with one or two tool calls, and do not use it to hand off the whole user request. ' +
        'A sub-agent starts with no memory of this conversation: put everything it needs in `objective` and `context`, and ask for a specific report (findings, exact file paths, evidence, open questions). ' +
        "`role: 'explore'` (default) is read-only; `role: 'general'` may change the workspace and run commands and will still ask the user for each permission, so prefer `explore` unless the work must write. " +
        'Sub-agents cannot delegate further and cannot ask you questions; verify their claims before reporting them as your own. ' +
        'Each task may name a `model`; call `list_subagent_models` to see which ones this host can actually serve, because an id it cannot serve is refused rather than run on the default. ' +
        'By default this waits for the reports. Set `wait: false` to start them and carry on with your own work while they run — then call `collect_subagents` before you finish. A sub-agent still working when your run ends is stopped, but it is not lost: it stays reachable, and its outcome is reported to you at the start of your next turn in this session, so you can collect it then or ask that same child to continue with `send_message` rather than doing the work again.',
      inputSchema: {
        type: 'object',
        properties: {
          wait: {
            type: 'boolean',
            description:
              'true (default) returns the reports in this result. false starts them and returns immediately, so you can keep working and collect later.',
          },
          tasks: tasksSchema(this.deps.options.maxFanout, this.deps.providers.names()),
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      execute: (args, context) => this.delegate(args, context.signal, false),
    };
  }
  /**
   * The same delegation, for a child that continues *this* conversation instead of starting from nothing.
   *
   * It is a separate tool rather than a flag on `delegate_task`, for the reason the capability is separate
   * too: a fork inherits the parent's history, which is a different promise from "a fresh child with a good
   * brief", and a model that has to choose between two names has to notice which one it is making.
   */
  forkTool(): Tool {
    return {
      name: 'subagent_fork',
      description:
        'Delegate work to a sub-agent that starts from **this conversation** instead of from nothing: it inherits the transcript above (trimmed from the oldest end to stay within a fixed budget), so you do not have to restate what you have already established. ' +
        'Use it when the work depends on everything discussed so far — continue a hypothesis you are already part-way through, or push a long investigation out of this context while keeping its premises. ' +
        "For anything self-contained, prefer `delegate_task`: a fork pays for the inherited history on every one of the child's rounds. " +
        'The child inherits the *history*, not your identity: it keeps its own sub-agent role prompt, its own session and the same permission rules, and it cannot ask you questions or delegate further. ' +
        "Everything a `delegate_task` task takes is accepted here, including `role` and `model`, and `role: 'general'` still needs an approving user for every write.",
      inputSchema: {
        type: 'object',
        properties: {
          wait: {
            type: 'boolean',
            description:
              'true (default) returns the reports in this result. false starts them and returns immediately, so you can keep working and collect later.',
          },
          tasks: tasksSchema(this.deps.options.maxFanout, this.deps.providers.names()),
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      execute: (args, context) => this.delegate(args, context.signal, true),
    };
  }
  /**
   * What a task may be run on, as this host can actually serve it.
   *
   * Registered only when the host supplied the list. An empty list is not an option: the caller then has
   * nothing to choose between, and saying so is the tool's job rather than its caller's.
   */
  modelsTool(): Tool {
    return {
      name: 'list_subagent_models',
      description:
        'List the models this host can actually run a sub-agent on. Call it before naming a `model` in `delegate_task` or `subagent_fork`: a model that is not on this list is refused, and the task is not started.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_args, context) => {
        context.signal.throwIfAborted();
        try {
          const models = this.deps.models?.() ?? [];
          if (!models.length)
            return {
              isError: false,
              content:
                'No sub-agent model list is available from this host, so name no `model` and the child will run on the default.',
            };
          const lines = models.map(
            (entry) => `- ${entry.model}${entry.note ? ` — ${entry.note}` : ''}`,
          );
          lines.push(
            models.length === 1
              ? 'That is the only model this host is configured to serve for sub-agents; a task that names any other id is refused rather than run on this one.'
              : 'Any other model id is refused rather than run on one of these.',
          );
          return { isError: false, content: lines.join('\n') };
        } catch (error) {
          return failure(error);
        }
      },
    };
  }
  /** The body both delegation tools share; `fork` is the only difference between them. */
  private async delegate(
    args: Record<string, unknown>,
    signal: AbortSignal,
    fork: boolean,
  ): Promise<{ isError: boolean; content: string }> {
    signal.throwIfAborted();
    try {
      const tasks = this.admit(args.tasks, this.deps.options.maxFanout, fork);
      if (args.wait === false) {
        const scheduled = tasks.map((task, index) => this.schedule(task, index, tasks.length));
        // Deliberately not awaited: returning here is the point of `wait: false`. The promises are
        // tracked, so `settle()` still joins them when the run ends.
        for (const task of scheduled) void this.run(task);
        return { isError: false, content: startedNotice(scheduled) };
      }
      const scheduled = tasks.map((task, index) => this.schedule(task, index, tasks.length));
      /**
       * A blocking call stops waiting when the user corrects the course.
       *
       * Without this the parent is parked inside one tool call for as long as the fan-out takes (up to
       * the per-child timeout), so a correction could not be read until every child had finished —
       * which is the whole reason `wait: false` exists. The children are *not* cancelled: the call
       * degrades to "started, collect later", so a correction costs a round, not the work.
       */
      const settled = Promise.all(scheduled.map((task) => this.run(task)));
      if (this.deps.steerPending) await Promise.race([settled, whenTrue(this.deps.steerPending)]);
      else await settled;
      if (this.deps.steerPending?.()) {
        void settled;
        return { isError: false, content: startedNotice(scheduled, true) };
      }
      // A blocking call hands its reports over in the result, so they are collected by definition — and that
      // has to be written down for the same reason the tool path does: the parent must not be reminded about
      // a report it already read in this very tool result.
      for (const task of scheduled) task.collected = true;
      this.deps.collected?.(scheduled.map((task) => task.id));
      return report(
        scheduled.map((task) => ({
          summary: task.summary,
          text: task.text,
          ...(task.seed ? { seed: task.seed } : {}),
          ...(task.data !== undefined ? { data: task.data } : {}),
        })),
        tasks,
      );
    } catch (error) {
      return failure(error);
    }
  }
  /**
   * The read-only and per-run guards, in one place because both entry points need them and a second
   * copy is how one of them would end up weaker than the other.
   */
  private admit(value: unknown, maxFanout: number, fork: boolean): AdmittedTask[] {
    const tasks = normalizeTasks(value, maxFanout).map((task) => ({ ...task, fork }));
    if (this.deps.readOnly && tasks.some((task) => task.role === 'general'))
      throw new SubAgentLimitError('This run is read-only, so it may only delegate explore tasks');
    const remaining = this.deps.options.maxPerRun - this.started;
    if (tasks.length > remaining)
      throw new SubAgentLimitError(
        remaining > 0
          ? `This run may start ${remaining} more sub-agent task(s); reduce the number of tasks`
          : `This run already used its ${this.deps.options.maxPerRun} sub-agent tasks`,
      );
    // Capability validation happens here, before anything is scheduled: a provider that cannot honour a
    // requested option must refuse the call, not accept it and quietly ignore that part. Nothing has
    // been created yet, so a refusal leaves no child session behind either.
    for (const task of tasks)
      this.deps.providers.resolve(this.providerFor(task), this.requestOptions(task));
    return tasks;
  }
  /**
   * Which provider runs this task: the one it named, or the run's own.
   *
   * One function because both resolution sites need the same answer, and a task that was validated against the
   * default while being scheduled onto a named provider would be exactly the "checked one thing, ran another"
   * gap the capability registry exists to close.
   */
  private providerFor(task: AdmittedTask): string {
    return task.provider ?? this.deps.provider;
  }
  /**
   * What one task asks the provider for. Only what the task genuinely needs is requested: a capability
   * assertion is a promise about the run, so asking for one nobody uses would refuse providers for no
   * reason.
   */
  private requestOptions(task: AdmittedTask): SubAgentRequestOptions {
    const provider = this.deps.providers.resolve(this.providerFor(task), {});
    return {
      ...(task.model ? { agentOptions: { model: task.model } } : {}),
      /**
       * The structured answer, asked for when it has to be **enforced**.
       *
       * Two cases, and the difference is the whole reason this is conditional. A task that declared its own
       * `schema` is asking the provider to hold the child to it — a promise, so it is requested, and a provider
       * that cannot keep it must refuse. A task with no schema gets the fixed report contract instead, which the
       * *coordinator* can compose from whatever the child said: that is not something a provider has to be able to
       * do, and requiring it would refuse every provider that runs its child somewhere else (a separate process
       * has no `submit_report` tool to enforce a shape with). Requesting a capability nobody needs is the failure
       * the comment above warns about, and it was refusing exactly the provider this seam exists to allow.
       */
      ...(task.schema !== undefined
        ? { outputSchema: task.schema }
        : provider.capabilities.includes('outputSchema')
          ? { outputSchema: REPORT_SCHEMA }
          : {}),
      maxDepth: this.deps.options.maxDepth,
      ...(task.role === 'explore' ? { toolFilter: [...EXPLORE_TOOLS] } : {}),
      /**
       * The role prompt is **not** sent here, and that is a correction rather than an omission.
       *
       * `persona` used to be set to `subAgentRolePrompt(task.role)`, which asked every provider to take the child's
       * role and put it in the persona slot. A `persona` shadows the deployment's, so a provider that honoured it
       * literally would have replaced the harness's own identity paragraph — the one that carries how to use
       * tools, when to verify a deliverable and what is excluded from them — with "you are a sub-agent". The role
       * belongs where it already goes: `AgentOptions.rolePrompt`, which is additive and applied by the child
       * composition. This option now means what its name says, and is only present when a caller actually has a
       * persona to install.
       */
      ...(task.persona ? { persona: task.persona } : {}),
      // Only asked for when it is wanted, so a provider that cannot fork is still usable for everything else.
      ...(task.fork ? { contextFork: true } : {}),
    };
  }
  /**
   * Takes on one task: identity, provider and record, before anyone waits for it. `wait: false` depends on
   * this being separate from running.
   *
   * Admission is a count and nothing else: the per-run total is checked in `admit`, and the semaphore is what
   * bounds how many of the admitted ones may run at once. A task is therefore never scheduled into a state
   * where it can be admitted but cannot be paid for — which is what the old shared token pool could produce,
   * and what made a late delegation report "N tokens remained" instead of an honest limit.
   */
  private schedule(task: AdmittedTask, index: number, total: number): ScheduledSubAgent {
    const id = randomUUID();
    const options = this.requestOptions(task);
    // Resolve (and re-assert) the provider here rather than at dispatch time: the scheduled task must
    // know which provider accepted it, and `wait: false` hands the task to `run` with nobody watching.
    const provider = this.deps.providers.resolve(this.providerFor(task), options);
    const summary: SubAgentSummary = {
      id,
      role: task.role,
      objective: task.objective,
      sessionId: '',
      status: 'running',
      rounds: 0,
      toolCalls: 0,
      usage: { ...EMPTY_USAGE },
    };
    this.records.push(summary);
    let settleTask!: () => void;
    const promise = new Promise<void>((resolve) => {
      settleTask = resolve;
    });
    const scheduled: ScheduledSubAgent = {
      id,
      index,
      total,
      role: task.role,
      objective: task.objective,
      ...(task.context ? { context: task.context } : {}),
      ...(task.schema ? { schema: task.schema } : {}),
      fork: task.fork,
      options,
      provider,
      summary,
      text: '',
      collected: false,
      done: false,
      active: false,
      controller: new AbortController(),
      stallController: new AbortController(),
      promise,
      settleTask,
    };
    this.started++;
    this.scheduled.push(scheduled);
    return scheduled;
  }
  /**
   * Runs one child to completion and hands back its answer, for a caller that is not a tool call.
   *
   * `delegate_task` admits and schedules, `collect_subagents` reads back; a workflow script wants both halves
   * fused for a single task, one call at a time. Routing it through the same admission, the same semaphore and
   * the same execution is what keeps the caps real: a loop inside a script goes through the same per-run total as
   * a loop of tool calls, so the workflow tool cannot become the way around them.
   *
   * The child is marked delivered as soon as its answer is handed over — the caller is looking at it, and a
   * settlement notice would be announcing something that has already been read.
   */
  async runOne(
    task: { objective: string; context?: string; model?: string; schema?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<SubAgentAnswer> {
    const [admitted] = this.admit([task], 1, false);
    const scheduled = this.schedule(admitted!, 0, 1);
    /**
     * The caller's cancellation propagates into the child.
     *
     * `execute` already ties the child to the parent run and to this task's own controller; what it cannot know
     * is the *call* that asked, which for a workflow is one tool invocation with its own deadline. Without this,
     * a workflow whose time ran out would leave its children running.
     */
    const stop = () => scheduled.controller.abort(signal.reason);
    if (signal.aborted) scheduled.controller.abort(signal.reason);
    else signal.addEventListener('abort', stop, { once: true });
    try {
      await this.run(scheduled);
    } finally {
      signal.removeEventListener('abort', stop);
    }
    scheduled.collected = true;
    this.deps.collected?.([scheduled.id]);
    return {
      status: scheduled.summary.status,
      sessionId: scheduled.summary.sessionId,
      rounds: scheduled.summary.rounds,
      // The child's own answer when it has no prose of its own: a structured child is told to end by calling
      // `submit_report`, so its *text* is often empty and what it submitted is the whole answer.
      answer:
        scheduled.text.trim() ||
        (scheduled.data !== undefined
          ? JSON.stringify(scheduled.data)
          : renderFindings(scheduled.summary.report).join('\n')),
      ...(scheduled.data !== undefined ? { data: scheduled.data } : {}),
      ...(scheduled.summary.error ? { error: scheduled.summary.error } : {}),
    };
  }
  /** Runs a scheduled task under the shared cap, and resolves when it has settled. */
  private run(scheduled: ScheduledSubAgent): Promise<void> {
    if (scheduled.done) return Promise.resolve();
    const promise = this.limiter
      .run(() => this.execute(scheduled))
      // Nobody awaits a background task, so an unattended rejection would take the process down. The
      // failures this can hide are the ones `execute` already turns into an outcome.
      .catch(() => {})
      // Every path out of `execute` goes through here, including the reaping that returns before the body runs
      // and the provider rejecting synchronously: a timer that survived its child would abort a controller
      // nobody is listening to and hold the process open for the rest of the window.
      //
      // `active` goes back to false with the timer, and that half is not bookkeeping. It is what `progress`
      // reads to decide whether there is a live run to re-arm, and leaving it true meant a *resident* child's
      // later turn — which the coordinator does not run, and therefore never arms a watchdog for — kept arming
      // timers for a task that had already settled, with nothing left that would ever clear them. The process
      // stayed alive for the whole stall window, which is exactly the leak this `finally` exists to prevent.
      .finally(() => {
        this.disarmStallWatchdog(scheduled);
        scheduled.active = false;
      });
    this.inFlight.add(promise);
    return promise.finally(() => this.inFlight.delete(promise));
  }
  /**
   * Starts (or restarts) this child's stall watchdog.
   *
   * The timer is deliberately *not* unref'd. It is the only thing standing between a wedged child and a parent
   * run that can never end, and a process that exits while a run is open has already lost that run's outcome —
   * so keeping the loop alive for the remaining window is the honest behaviour. Zero disables it, which is a
   * choice the operator makes knowing the bound is gone (see `SubAgentOptions.timeoutMs`).
   */
  private armStallWatchdog(scheduled: ScheduledSubAgent): void {
    this.disarmStallWatchdog(scheduled);
    scheduled.active = true;
    if (this.deps.options.timeoutMs <= 0) return;
    scheduled.stallTimer = setTimeout(() => {
      // Only the stall controller. Aborting `scheduled.controller` here would be wrong twice over: that signal is
      // the run-end reaping, and a stalled child reported as "the run ended without collecting it" would name the
      // wrong cause. Composing into `signal` is what actually stops the child.
      scheduled.stallController.abort(new Error(stallMessage(this.deps.options.timeoutMs)));
    }, this.deps.options.timeoutMs);
  }
  private disarmStallWatchdog(scheduled: ScheduledSubAgent): void {
    if (scheduled.stallTimer === undefined) return;
    clearTimeout(scheduled.stallTimer);
    scheduled.stallTimer = undefined;
  }
  /**
   * The child showed progress, so its watchdog starts over.
   *
   * Called from the parent's own emit, which is the only seam both of a child's frame paths pass through: the
   * durable announcements (`subagent.started`, `subagent.finished`) and the high-volume ones (`subagent.delta`,
   * `subagent.tool`, `subagent.progress`) reach the parent differently. The id is accepted in either spelling this
   * project already uses for a child — the delegation's task id (`subagent.delta`, `subagent.tool`) or the
   * child's session id (`subagent.progress`) — because a reader that had to know which frame carries which name
   * would be one edit away from arming nothing.
   *
   * The caller decides which frames are progress, not this method: a frame that says nothing about *work* must
   * not re-arm anything, and the frame that reports a running clock is the one that matters most there.
   */
  progress(id: string): void {
    if (!id) return;
    const scheduled = this.scheduled.find(
      (task) => task.active && (task.id === id || task.summary.sessionId === id),
    );
    if (scheduled) this.armStallWatchdog(scheduled);
  }
  private async execute(scheduled: ScheduledSubAgent): Promise<void> {
    const { summary } = scheduled;
    /**
     * The run can end while this task is still queued behind the cap. Reaping it here rather than after
     * a spawn keeps the promise that a cancelled task leaves nothing behind — not even an empty child
     * session that would show up in `reconcileChildRuns` on the next start.
     */
    if (scheduled.controller.signal.aborted || this.deps.signal.aborted) {
      this.cancelScheduled(scheduled);
      return;
    }
    this.armStallWatchdog(scheduled);
    /**
     * The child stops on any of four signals: the parent run, the caller's own cancellation (a correction that
     * gave up waiting, a cancelled tool call), this coordinator reaping it because the run ended without
     * collecting it, or the stall watchdog after the child went silent.
     *
     * The first two are cooperative and were always here. The watchdog is the one that has to exist: `settle()`
     * runs in the parent run's `finally` and joins every child, so a child that never settles would leave the
     * parent's run open — session locked, no later turn able to start — which is the failure this bounds.
     */
    const signal = AbortSignal.any([
      this.deps.signal,
      scheduled.stallController.signal,
      scheduled.controller.signal,
    ]);
    let outcome: SubAgentOutcome;
    try {
      outcome = await scheduled.provider.start({
        provider: scheduled.provider.name,
        task: {
          id: scheduled.id,
          index: scheduled.index,
          role: scheduled.role,
          objective: scheduled.objective,
          ...(scheduled.context ? { context: scheduled.context } : {}),
          ...(scheduled.schema ? { schema: scheduled.schema } : {}),
        },
        parent: this.deps.parent,
        options: scheduled.options,
        signal,
        started: (sessionId) => {
          summary.sessionId = sessionId;
          this.deps.emit('subagent.started', {
            id: scheduled.id,
            index: scheduled.index,
            role: scheduled.role,
            objective: scheduled.objective,
            childSessionId: sessionId,
            total: scheduled.total,
          });
        },
      });
    } catch (error) {
      outcome = {
        sessionId: summary.sessionId,
        status: signal.aborted ? 'cancelled' : 'failed',
        text: '',
        rounds: 0,
        toolCalls: 0,
        usage: { ...EMPTY_USAGE },
        error: error instanceof Error ? error.message : String(error),
      };
    }
    summary.sessionId = outcome.sessionId || summary.sessionId;
    summary.status = outcome.status;
    summary.rounds = outcome.rounds;
    summary.toolCalls = outcome.toolCalls;
    summary.usage = outcome.usage;
    if (outcome.report) summary.report = outcome.report;
    // A custom-schema answer is kept on the scheduled task and not on the summary: the card, the durable
    // `subagent.finished` payload and the settlement notice all have one shape each, and making that shape
    // polymorphic would push a caller's object into every reader of a child's outcome.
    if (outcome.data !== undefined) scheduled.data = outcome.data;
    // Kept on the scheduled task rather than the summary: how much of the parent's transcript the child
    // inherited is a fact about this call, not part of the card the desktop renders.
    if (outcome.seeded) scheduled.seed = outcome.seeded;
    /**
     * Bounded where it is *set*, so every reader sees the same failure.
     *
     * There are four: the rendered report the parent model reads, the `RunResult` this run reports (`--json`, the
     * wire, the settlement), the durable `subagent.finished` record, and the desktop's card. Three of them copied
     * whatever this field held — the record cut it to 600 and the others did not — so a child whose endpoint failed
     * with a long error body handed a model, a client and a log three different amounts of the same sentence. The
     * bound belongs here, at the one place the value is decided.
     */
    const failure = scheduled.stallController.signal.aborted
      ? stallMessage(this.deps.options.timeoutMs)
      : scheduled.controller.signal.aborted
        ? 'Cancelled: the run that started this sub-agent ended without collecting it'
        : outcome.error;
    summary.error = boundedError(failure);
    if (signal.aborted) summary.status = 'cancelled';
    else if (summary.error && summary.status === 'completed') summary.status = 'failed';
    scheduled.text = outcome.text;
    scheduled.done = true;
    this.disarmStallWatchdog(scheduled);
    // Wake anyone waiting in `collect` before the usage is folded in, so a waiting parent sees the
    // report as soon as it exists.
    scheduled.settleTask();
    this.deps.onUsage(outcome.usage);
    this.deps.emit('subagent.finished', {
      ...summary,
      index: scheduled.index,
      total: scheduled.total,
      // Bounded, because the event stream is a progress feed: the untruncated report is in the tool
      // result and in the child session, which is where a reader should go for the whole thing.
      text: outcome.text.slice(0, 4000),
    });
  }
  /** The tool that reads back what background tasks produced. */
  collectTool(): Tool {
    const defaultWaitMs = this.deps.options.collectWaitMs;
    return {
      name: 'collect_subagents',
      description:
        'Read the reports of sub-agents you started with `delegate_task({wait: false})`. Each report is returned once: collecting marks it delivered, and the response lists the ids that are still running. ' +
        `If tasks are still running this call waits for them for up to ${defaultWaitMs} ms instead of returning immediately, so there is no reason to poll in a loop, and no reason to run commands just to pass the time. ` +
        `Set \`waitMs: 0\` to get the current state at once, or a larger value (up to ${SUBAGENT_CEILINGS.collectWaitMs}) to wait longer. This also returns the reports of sub-agents that settled in an earlier turn of this session and were never collected, so it is the way to pick up background work after a run has ended; a sub-agent still working when your run ends is stopped, and you are told about it at the start of your next turn. It also reports messages you sent to a sub-agent that were accepted but never delivered — send those again.`,
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            maxItems: 16,
            items: { type: 'string', maxLength: 64 },
            description: 'Only collect these sub-agent ids; omit to collect everything finished.',
          },
          waitMs: {
            type: 'integer',
            minimum: 0,
            maximum: SUBAGENT_CEILINGS.collectWaitMs,
            description: `How long to wait for running tasks to finish, up to ${SUBAGENT_CEILINGS.collectWaitMs} ms. Defaults to ${defaultWaitMs}; 0 returns without waiting.`,
          },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          const ids = Array.isArray(args.ids) ? (args.ids as string[]) : undefined;
          const wanted = ids ? new Set(ids.map((id) => String(id))) : undefined;
          const requested = args.waitMs === undefined ? defaultWaitMs : Number(args.waitMs);
          const waitMs = Number.isFinite(requested)
            ? Math.min(Math.max(0, Math.trunc(requested)), SUBAGENT_CEILINGS.collectWaitMs)
            : defaultWaitMs;
          const results = await this.collectWaiting(wanted, waitMs, context.signal);
          /**
           * Undelivered messages are read from the log, not from this run.
           *
           * A message that never reached its child is exactly the kind of thing that outlives the run that
           * accepted it: the process can stop, the run row close, and the parent come back to a session where
           * the only trace is in the log. Narrowing follows the same rule as the reports — an explicit `ids`
           * list selects the children it names, in either spelling.
           */
          const inbox = (this.deps.inbox?.() ?? []).filter(
            (entry) => !wanted || wanted.has(entry.childId) || wanted.has(entry.childSessionId),
          );
          if (!results.reports.length && !results.running.length && !inbox.length)
            return { isError: false, content: 'No outstanding sub-agents.' };
          const blocks: string[] = [];
          if (results.reports.length) {
            blocks.push(
              report(
                results.reports,
                results.reports.map((entry) => ({ objective: entry.summary.objective })),
              ).content,
            );
          }
          if (results.running.length)
            blocks.push(
              `Still running after waiting ${waitMs} ms (${results.running.length}): ${results.running.join(', ')}. They keep working while you continue; collect again for their reports, and collect before you finish because they are cancelled when this run ends.`,
            );
          if (inbox.length) blocks.push(inboxNotice(inbox));
          return { isError: false, content: blocks.join('\n\n') };
        } catch (error) {
          return failure(error);
        }
      },
    };
  }
  /**
   * Collects now, or waits first when there is something to wait for.
   *
   * The wait ends on the first of: every awaited task settled, the window elapsed, the call was
   * cancelled, or the user sent a correction. Cancellation matters because a Stop must never be
   * swallowed by a poll; the correction case matters because it is what lets the window be long enough
   * to actually cover a slow child without holding the user's next instruction hostage.
   */
  private async collectWaiting(
    wanted: Set<string> | undefined,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ reports: SubAgentResult[]; running: string[] }> {
    const immediate = this.collect(wanted);
    if (waitMs <= 0 || immediate.reports.length || !immediate.running.length) return immediate;
    const pending = this.scheduled
      .filter((task) => !task.done && (!wanted || wanted.has(task.id)))
      .map((task) => task.promise);
    if (!pending.length) return immediate;
    await Promise.race([
      Promise.all(pending),
      delay(waitMs),
      abortSignal(signal),
      this.deps.steerPending ? whenTrue(this.deps.steerPending) : NEVER,
    ]);
    return this.collect(wanted);
  }
  /**
   * Reports that are finished and not yet delivered, plus the ids still running. Delivering marks them,
   * so a poll loop cannot grow the parent's context by re-reading the same report.
   */
  private collect(wanted?: Set<string>): { reports: SubAgentResult[]; running: string[] } {
    const reports: SubAgentResult[] = [];
    const running: string[] = [];
    /**
     * Every outcome handed over here is recorded as delivered, whoever it came from.
     *
     * Delivery has to be durable as well as in-memory: the in-memory flag only stops *this* run from handing
     * the same report over twice, while the reminder the parent gets on its next request is computed from the
     * log — a report delivered here but not written down would be announced again as if it had never arrived.
     */
    const delivered: string[] = [];
    for (const task of this.scheduled) {
      if (wanted && !wanted.has(task.id)) continue;
      if (!task.done) running.push(task.id);
      else if (!task.collected) {
        task.collected = true;
        reports.push({
          summary: task.summary,
          text: task.text,
          ...(task.seed ? { seed: task.seed } : {}),
          ...(task.data !== undefined ? { data: task.data } : {}),
        });
        delivered.push(task.id);
      }
    }
    /**
     * Then the children of earlier runs.
     *
     * `collect_subagents` is the documented way to read background results, and after a run boundary the
     * coordinator that held them is gone: without this the same call answers "no outstanding sub-agents" while
     * a finished child's report sits unread in its own session. These come from the parent's log, so this is
     * the one place where the tool's answer is durable rather than in-memory.
     */
    for (const notice of this.deps.settlements?.() ?? []) {
      if (wanted && !wanted.has(notice.id) && !wanted.has(notice.childSessionId)) continue;
      if (this.scheduled.some((task) => task.id === notice.id)) continue;
      reports.push({
        summary: {
          id: notice.id,
          sessionId: notice.childSessionId,
          role: notice.role,
          objective: notice.objective,
          status: notice.status === 'interrupted' ? 'failed' : notice.status,
          // Zeroed, not guessed: the durable settlement kept the report and the usage, but a round count and a
          // call count are facts about the child's run, and inventing them here would put numbers in the
          // parent's context that no record supports. The child's own run row carries the real ones.
          rounds: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(notice.report ? { report: notice.report } : {}),
          ...(notice.reason ? { error: notice.reason } : {}),
        },
        // The text is empty on purpose: the durable record keeps the report, and the child's own transcript
        // is where its prose lives (`job_output` reads exactly that).
        text: '',
      });
      delivered.push(notice.id, notice.childSessionId);
    }
    if (delivered.length) this.deps.collected?.(delivered);
    return { reports, running };
  }
  /**
   * Ends this run's ownership of its sub-agents.
   *
   * A background child must not outlive the run: the run row is already finalised, so its usage would be
   * unattributed, and the tool registry it borrowed is about to be closed. Cancelling first and awaiting
   * afterwards is what makes that guarantee real rather than likely — the child's own signal handling
   * still decides how quickly it stops.
   */
  async settle(): Promise<void> {
    for (const task of this.scheduled) if (!task.done) task.controller.abort();
    await Promise.allSettled([...this.inFlight]);
  }
  /** Records a task that was reaped before it could start, so nothing is left reporting as running. */
  private cancelScheduled(scheduled: ScheduledSubAgent): void {
    const { summary } = scheduled;
    scheduled.done = true;
    scheduled.text = '';
    // Nothing to release: a child that never ran cost nothing, and the slot it would have used was never
    // taken (a cancelled task is reaped before the semaphore admits it).
    summary.status = 'cancelled';
    summary.error = 'Cancelled: the run that started this sub-agent ended without collecting it';
    scheduled.settleTask();
    this.deps.emit('subagent.finished', {
      ...summary,
      index: scheduled.index,
      total: scheduled.total,
      text: '',
    });
  }
}
/**
 * The task shape, shared by both delegation tools.
 *
 * Shared rather than copied because the two tools accept exactly the same tasks: a fork differs in where the
 * child starts, not in what may be asked of it, and two copies of a schema is how one of them would quietly
 * stop accepting a field the other still does.
 */
function tasksSchema(maxFanout: number, providers: readonly string[]): Record<string, unknown> {
  return {
    type: 'array',
    minItems: 1,
    maxItems: maxFanout,
    items: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description:
            'What this sub-agent must find out or do, stated as one self-contained goal.',
        },
        role: {
          type: 'string',
          enum: ['explore', 'general'],
          description:
            'explore (default, read-only) or general (may write; each write still needs approval).',
        },
        context: {
          type: 'string',
          maxLength: 8000,
          description: 'Facts, file paths and constraints the sub-agent cannot rediscover cheaply.',
        },
        model: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Optional model id for this sub-agent. Call list_subagent_models first: a host that cannot serve the id refuses the task with UNSUPPORTED_CAPABILITY instead of silently using its default.',
        },
        /**
         * Offered only when this host actually has a choice, which is why it is built here rather than declared
         * as a constant field: a `provider` property on a host with one provider is an invitation to name
         * something that cannot exist, and the model would spend a round learning that.
         */
        ...(providers.length > 1
          ? {
              provider: {
                type: 'string',
                enum: [...providers],
                description:
                  'Optional: which implementation runs this sub-agent. Omit for the default. A name that is not in this list is refused, and so is a task asking this provider for something it does not declare — both before any child session exists.',
              },
            }
          : {}),
        persona: {
          type: 'string',
          minLength: 1,
          maxLength: 600,
          description:
            "Optional: the identity this sub-agent should speak with, which **replaces** the deployment's persona for this child alone rather than adding to it. Use it when the work needs a different voice — a security reviewer, a copy editor — not to change what the child may do: that is `role`, and no persona can grant a permission or lift a restriction. Keep it to an identity and a stance; instructions that contradict the deployment's rules are ignored in favour of those rules.",
        },
        schema: {
          type: 'object',
          additionalProperties: true,
          description:
            'Optional JSON Schema for the object this sub-agent must come back with, when the default report shape (summary, findings with evidence, unverified, blockers) is not what you want to read. It replaces that shape rather than extending it: the child submits through a tool whose argument schema is this one, so what arrives has already been validated against it, and the answer reaches you as that object. Keep it small and give each field a description — the child sees this schema and nothing else about the shape you want.',
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
  };
}
function normalizeTasks(value: unknown, maxFanout: number): Omit<AdmittedTask, 'fork'>[] {
  if (!Array.isArray(value) || !value.length)
    throw new SubAgentLimitError('delegate_task needs at least one task');
  if (value.length > maxFanout)
    throw new SubAgentLimitError(`At most ${maxFanout} sub-agent tasks are accepted in one call`);
  return value.map((entry) => {
    const task = entry as Record<string, unknown>;
    const objective = typeof task.objective === 'string' ? task.objective.trim() : '';
    if (!objective)
      throw new SubAgentLimitError('Every sub-agent task needs a non-empty objective');
    if (objective.length > 2000) throw new SubAgentLimitError('Sub-agent objective is too long');
    const role = task.role === undefined ? 'explore' : task.role;
    if (role !== 'explore' && role !== 'general')
      throw new SubAgentLimitError('Sub-agent role must be explore or general');
    const context = typeof task.context === 'string' ? task.context.trim() : '';
    if (context.length > 8000) throw new SubAgentLimitError('Sub-agent context is too long');
    const model = typeof task.model === 'string' ? task.model.trim() : '';
    const provider = typeof task.provider === 'string' ? task.provider.trim() : '';
    const persona = typeof task.persona === 'string' ? task.persona.trim() : '';
    return {
      role,
      objective,
      ...(context ? { context } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(persona ? { persona } : {}),
      ...(task.schema === undefined ? {} : { schema: answerSchema(task.schema) }),
    };
  });
}
/**
 * The caller's answer shape, checked here rather than when the child runs.
 *
 * The contract this replaces is validated in two places already (Ajv at the tool boundary, `normalizeReport`
 * after it); a caller-supplied schema only gets the first, so the refusals that have to happen *before* a child
 * exists are the ones checked by hand: it must compile, it must describe an object, and it must be small. Getting
 * this wrong later would mean a child session created, a model paid, and the failure surfacing as a tool error
 * inside the child — the exact shape of failure the capability checks were moved early to avoid.
 */
function answerSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new SubAgentLimitError('A task `schema` must be a JSON Schema object');
  const schema = value as Record<string, unknown>;
  if (schema.type !== 'object')
    throw new SubAgentLimitError('A task `schema` must describe an object (`"type": "object"`)');
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || !Object.keys(properties).length)
    throw new SubAgentLimitError(
      'A task `schema` needs at least one property for the child to fill in',
    );
  const encoded = JSON.stringify(schema).length;
  if (encoded > MAX_TASK_SCHEMA_CHARS)
    throw new SubAgentLimitError(
      `A task \`schema\` must be under ${MAX_TASK_SCHEMA_CHARS} characters when serialised (this one is ${encoded}); every field description in it is sent to the child on every round`,
    );
  try {
    new Ajv({ allErrors: true, strict: true }).compile(schema);
  } catch (error) {
    throw new SubAgentLimitError(
      `A task \`schema\` must be a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return schema;
}

/**
 * What a child is told about itself. The role matters to the model: an `explore` child that does not
 * know it is read-only spends rounds discovering that its write tools do not exist.
 */
export function subAgentRolePrompt(role: SubAgentRole): string {
  const shared =
    'You are a sub-agent delegated by a parent agent. Your transcript is private to you: the parent sees only the final report you write, so state findings explicitly instead of referring to "the file above". ' +
    'You cannot ask the parent questions, you cannot delegate further, and no human is reading along. Work autonomously until you can answer the objective, then stop.';
  return role === 'explore'
    ? `${shared} You are read-only: tools that change the workspace or run commands are not available, and every permission-requiring operation is refused. Investigate, verify with evidence, and report what should change rather than changing it.`
    : `${shared} You may change the workspace and run commands, but every write, command and external operation still asks the user for permission, and a refusal is final. Your file changes are recorded against the parent session, so they stay visible and undoable there. Prefer the smallest change that satisfies the objective.`;
}
/**
 * The report schema, kept tight on purpose: the same object is stored in the run result, sent to the
 * parent as a tool result and shown in the desktop card, so its worst case is a real cost. The bounds
 * are enforced by Ajv when the tool is called, and re-applied by `normalizeReport` so nothing that
 * reaches the parent depends on the validator being configured as expected.
 */
export const REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 1200,
      description: 'The answer to the objective, in one short paragraph.',
    },
    findings: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string', minLength: 1, maxLength: 300 },
          evidence: {
            type: 'string',
            minLength: 1,
            maxLength: 300,
            description:
              'What you actually observed — a command and its result, or a file and its content. Write "not verified" rather than guessing.',
          },
          paths: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 200 } },
        },
        required: ['statement', 'evidence'],
        additionalProperties: false,
      },
    },
    unverified: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string', maxLength: 200 },
      description: 'Things you could not check, so the parent does not read them as findings.',
    },
    blockers: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 200 } },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
};
export const SUBMIT_REPORT_DESCRIPTION =
  'Submit the final report and end this run. Every finding needs the evidence you actually observed; put anything you could not check in `unverified` instead of stating it as fact. Call this exactly once, when the objective is answered or you are blocked.';
function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
function boundedList(value: unknown, items: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, items)
    .map((entry) => boundedText(entry, limit))
    .filter(Boolean);
}
/** Bounds a submitted report so the parent, the run row and the UI all receive the same shape. */
export function normalizeReport(value: Record<string, unknown>): SubAgentSummaryReport {
  const findings = Array.isArray(value.findings)
    ? value.findings
        .slice(0, 10)
        .map((entry) => entry as Record<string, unknown>)
        .map((entry) => ({
          statement: boundedText(entry.statement, 300),
          evidence: boundedText(entry.evidence, 300),
          ...(Array.isArray(entry.paths) && entry.paths.length
            ? { paths: boundedList(entry.paths, 4, 200) }
            : {}),
        }))
        .filter((entry) => entry.statement && entry.evidence)
    : [];
  if (!findings.length) throw new SubAgentLimitError('A report needs at least one finding');
  const summary = boundedText(value.summary, 1200);
  if (!summary) throw new SubAgentLimitError('A report needs a summary');
  const unverified = boundedList(value.unverified, 6, 200);
  const blockers = boundedList(value.blockers, 6, 200);
  return {
    summary,
    findings,
    ...(unverified.length ? { unverified } : {}),
    ...(blockers.length ? { blockers } : {}),
  };
}
/**
 * What a read-only sub-agent may use.
 *
 * The read-only filter already removes every mutating tool, so the entries this allowlist excludes *beyond*
 * that are excluded for a different reason: they manage resources the child cannot create and that belong to
 * its parent or its siblings. The job tools are the clearest case — a child's own registry carries the
 * literal `subagent` scope, shared by every resident child, so `job_list` / `job_output` would show a
 * sibling's command output and `job_kill` would stop it. `browser_close` closes the browser the parent may
 * have opened, `lsp_stop`/`lsp_servers` manage the parent's language server, and `discover_validations` only
 * exists to feed a validator the child cannot run. A read-only child must not be able to disturb — or read
 * past — the run it was delegated by.
 *
 * This is enforced as an allowlist on the child's registry rather than as a hint in the prompt, so a tool
 * that is not listed is not executable at all ("Unknown tool"), not merely hidden — which is why even tools
 * the read-only filter keeps have to be named here to be reachable. The current tool and schema sizes are
 * computed by `scripts/docs-facts.mjs` (`npm run docs:generate`), which the docs gate keeps honest.
 */
export const EXPLORE_TOOLS = [
  'read_file',
  'read_image',
  'list_files',
  'search_files',
  'repo_map',
  'git_status',
  'git_diff',
  'git_log',
  'git_branches',
  'git_worktrees',
  'lsp_diagnostics',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_symbols',
  'lsp_code_action',
  'lsp_workspace_symbols',
  'office_inspect',
  'verify_file_delivery',
  'recall_knowledge',
  'list_memories',
  // Asking the user is not an effect, so a read-only child may still ask one thing it cannot decide alone.
  'ask_user_question',
  // The checklist touches no workspace: it records what the child is doing in the child's own session, which
  // is exactly what a long investigation needs to stay legible.
  'todo_write',
  // A program is not an effect either: the tools it reaches are the ones listed above, and the catalog it is
  // handed is this child's own, so a research child that would otherwise spend eight rounds reading eight files
  // can spend one — with every read still going through the child's registry.
  'run_code',
] as const;
/**
 * A bounded, redacted one-line preview of tool arguments for the progress feed.
 *
 * The feed exists so the user can see what a child is doing without opening its transcript, and a bare
 * tool name does not achieve that ("read_file" of what?). It is truncated rather than streamed, and
 * redacted because the arguments of an external call can carry credentials.
 */
export function toolArgumentPreview(args: Record<string, unknown>, limit = 160): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? '';
  } catch {
    return '';
  }
  return redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, limit);
}
/** The child's only user turn: the objective, whatever context the parent could cheaply hand over, and the report contract. */
export function subAgentPrompt(task: SubAgentTask): string {
  return [
    'Delegated task from a parent agent.',
    `Objective: ${task.objective}`,
    ...(task.context ? [`Context supplied by the parent:\n${task.context}`] : []),
    'Finish by calling submit_report exactly once: a short summary, then findings that each pair a statement with the evidence you actually observed (a command and its result, or a file and its content), plus anything you could not verify. Do not restate your whole exploration, and never claim a command or test passed unless you ran it and saw the result. If you are blocked, submit what you have and say so in `blockers`.',
  ].join('\n\n');
}
/**
 * One block per task, in request order, so the parent can cite or distrust each one separately.
 *
 * Every block is bounded to an equal share rather than letting the first report consume the whole tool
 * output limit: with four sub-agents, a single long report would otherwise truncate the other three
 * out of existence, and the parent would never learn they ran.
 */
/**
 * The structured report as the parent reads it. A finding without its evidence would be exactly the
 * prose problem this format exists to fix, so both are always rendered together, and anything the
 * child could not verify is labelled instead of quietly promoted to a finding.
 */
function renderFindings(report?: SubAgentSummaryReport): string[] {
  if (!report) return [];
  const lines = [`summary: ${report.summary}`, 'findings:'];
  for (const finding of report.findings) {
    const paths = finding.paths?.length ? ` [${finding.paths.join(', ')}]` : '';
    lines.push(`- ${finding.statement}\n  evidence: ${finding.evidence}${paths}`);
  }
  if (report.unverified?.length) lines.push(`unverified: ${report.unverified.join('; ')}`);
  if (report.blockers?.length) lines.push(`blockers: ${report.blockers.join('; ')}`);
  return lines;
}
/**
 * The object a caller-defined schema asked for, as the parent reads it.
 *
 * Printed as JSON because that is the shape the caller wrote down: pretty-printed (it is read by a model and by
 * a person looking at the transcript) and bounded by the same share as prose, since a schema cannot promise a
 * small answer and the parent's context is what pays for it.
 */
function renderAnswer(data: unknown, share: number): string {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    // A value that cannot be serialised should never reach here (it crossed a tool-call boundary to get in),
    // and if one ever does, saying so beats rendering nothing.
    text = '[the sub-agent’s answer could not be serialised]';
  }
  return text.length > share
    ? `result:\n${text.slice(0, share)}\n[answer truncated; the sub-agent session above holds the full transcript]`
    : `result:\n${text}`;
}
/**
 * How much of all the reports one `collect`/`delegate_task` call may put into the parent's context.
 *
 * Exported so the property can be asserted rather than described: the bound is what keeps a child's prose from
 * becoming the parent's budget, and a test in `tests/subagents.test.ts` pins it (a child that answers with sixty
 * thousand characters reaches the parent cut, and says so).
 */
/**
 * How much of a child's failure reaches the parent's tool result.
 *
 * The same 600 the durable `subagent.finished` record keeps (`agent.ts`, where the field is written), because the
 * two are read by different audiences for the same reason and a bound in one of them is not a bound: the log keeps
 * a summary of a failure, and the parent — which is a model spending its own context — must not be handed the
 * whole of an endpoint's error body. It is stated here rather than reached for from there so the two numbers can
 * be seen to be one decision.
 */
export const SUBAGENT_ERROR_CHARS = 600;
/** What a cut failure ends with, kept inside the bound so a later reader cannot cut the notice off. */
const ERROR_TRUNCATION_MARK = '…[truncated]';
/**
 * A child's failure as every reader gets it: at most `SUBAGENT_ERROR_CHARS`, and saying so when it was cut.
 *
 * The marker is inside the bound rather than appended after it because the durable record applies the same 600
 * again on its way to the log: a notice outside the limit would be trimmed off there, and the log would be the one
 * reader told least about what it was missing.
 */
function boundedError(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (text.length <= SUBAGENT_ERROR_CHARS) return text;
  return `${text.slice(0, SUBAGENT_ERROR_CHARS - ERROR_TRUNCATION_MARK.length)}${ERROR_TRUNCATION_MARK}`;
}
export const SUBAGENT_REPORT_CHARS = 24_000;
function report(
  results: readonly SubAgentResult[],
  tasks: readonly { objective: string }[],
): { content: string; isError: boolean } {
  const share = Math.max(1000, Math.floor((SUBAGENT_REPORT_CHARS - 400) / results.length));
  const blocks = results.map(({ summary, text: raw, seed, data }, index) => {
    const objective = tasks[index]?.objective ?? summary.objective;
    const lines = [
      `### Sub-agent ${index + 1}/${results.length} [${summary.role}] ${summary.status}`,
      `objective: ${objective}`,
      `session: ${summary.sessionId || 'none'} · rounds: ${summary.rounds} · tools: ${summary.toolCalls} · tokens: ${summary.usage.inputTokens} in / ${summary.usage.outputTokens} out`,
    ];
    // Only a forked child has this, and only a trimmed one needs the second half: a parent that is not told
    // the prefix was cut would assume the child saw everything it saw.
    if (seed)
      lines.push(
        `inherited context: ${seed.messages} message(s), ${seed.chars} characters` +
          (seed.dropped
            ? `; ${seed.dropped} message(s) were omitted to fit the fork budget or exclude an incomplete trailing tool batch`
            : ' (the whole conversation so far)'),
      );
    if (summary.error) lines.push(`error: ${summary.error}`);
    // A task that declared its own schema is answered in that shape, rendered as the object it is: the caller
    // defined the fields precisely so it would not have to read them out of prose.
    if (data !== undefined) lines.push(renderAnswer(data, share));
    else lines.push(...renderFindings(summary.report));
    const text = raw.trim();
    lines.push(
      data !== undefined
        ? ''
        : text
          ? text.length > share
            ? `${text.slice(0, share)}\n[report truncated; the sub-agent session above holds the full transcript]`
            : text
          : summary.report
            ? ''
            : '(the sub-agent produced no final report)',
    );
    return lines.filter((line) => line !== '').join('\n');
  });
  const failed = results.filter(({ summary }) => summary.status !== 'completed').length;
  return {
    content: blocks.join('\n\n'),
    // A partial failure still carries usable reports, so it is only a tool error when nothing worked.
    isError: results.length > 0 && failed === results.length,
  };
}
