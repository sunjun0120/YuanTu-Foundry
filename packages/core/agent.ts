import { createChildTurns } from './run-child-turns.ts';
import { goalNoticeText, taskDefinitionText, skillsCatalogue } from './agent-notices.ts';
import { createRunPromptSections } from './run-prompt.ts';
import { admitVisibleBackground } from './background-deliveries.ts';
import type {
  AgentEvent,
  AgentEventType,
  Approver,
  FileChange,
  Message,
  Plan,
  ModelResponse,
  Provider,
  Questioner,
  ReasoningEffort,
  RunResult,
  RunStatus,
  SubAgentTag,
  SubAgentSummaryReport,
  TaskStep,
  TaskTriggerSource,
  ToolCall,
  ToolContext,
  ToolSpec,
  Usage,
  UserInput,
} from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { LEASE_RENEW_INTERVAL_MS } from '../protocol/session-lease.ts';
import { createPlanningTools, type PlanningTools } from './plan-tools.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { redactSecrets } from './errors.ts';
import { DeferredApprovalError } from '../protocol/failure.ts';
import type { PermissionPolicyView } from '../protocol/permissions.ts';
import { memoryContext } from '../knowledge/context.ts';
import { spillOutput, spillResult } from '../tools/spill.ts';
import { repoMapContext } from '../tools/repo-map.ts';
import { cacheKeyFor } from './cache-key.ts';
import { prepareContext, ContextLimitError } from './context.ts';
import type { PreparedContext } from './context.ts';
import { envelopeEvent } from './envelope.ts';
import {
  lastRuntimeSnapshot,
  runtimeSnapshotMessage,
  runtimeSnapshotText,
  type RuntimeSnapshotSource,
} from './runtime-context.ts';
import {
  RunFailure,
  failureCodeOf,
  isContextWindowExceeded,
  statusForFailure,
  type FailureCode,
} from '../protocol/failure.ts';
import { RETRY_MAX_WAIT_MS, retryDelayMs, retryable } from '../protocol/retry.ts';
import { admitGoalRound, type Goal } from '../protocol/goals.ts';
import type { StepEndReason } from '../protocol/steps.ts';
import { resolveRunLimits } from '../protocol/settings.ts';
import { groupToolCalls, runBounded } from './tool-schedule.ts';
import { WINDOW_EXHAUSTED, hopelessForWindow } from './forecast.ts';
import { estimateMessageTokens } from './budget.ts';
import { TokenCalibration, calibrationRoute } from './calibration.ts';
import { emptyStatistics, emptyRequestTiming, addUsage } from '../protocol/statistics.ts';
import { RunQueue, queuedInput, type InputMode, type QueuedInput } from './run-queue.ts';
import { createRunEmit, type RunEmission } from './run-emit.ts';
import { createRunInteraction } from './run-interaction.ts';
import { createProviderMeasurement } from './run-provider.ts';
import { createSubAgentProviders } from './run-subagents.ts';
import { createCoordinator } from './run-coordinator.ts';
import { createResidentMessageTool } from './run-residency.ts';
import {
  REPORT_SCHEMA,
  SUBMIT_REPORT_DESCRIPTION,
  SubAgentCoordinator,
  normalizeReport,
  resolveSubAgentOptions,
  type ResolvedSubAgentOptions,
  type SubAgentOptions,
} from './subagents.ts';
import { assemblePrompt, type PromptTrace } from './prompt-sections.ts';
import type { SubAgentProvider } from './subagent-providers.ts';
import { workflowTool } from './workflow.ts';
import { sessionQueryTools } from './session-query.ts';
import { goalTools } from '../tools/goal.ts';
import { SubAgentResidency } from './residency.ts';
import type { InvariantRegistry } from './invariants.ts';
import { describeViolations } from '../protocol/invariants.ts';
import { subAgentJobProducer } from './subagent-jobs.ts';
import { commandJournal } from './command-jobs.ts';
import { loadInstructions } from '../resources/instructions.ts';
import { validateUserInput } from '../protocol/images.ts';
import { discoverSkills, expandSkill } from '../resources/skills.ts';
import {
  captureTaskBaselines,
  verifyTaskAcceptance,
  type TaskBaselines,
} from './task-acceptance.ts';

export interface AgentOptions {
  /**
   * The execution environment this run reports, as a value or as a getter.
   *
   * A getter because the environment is *live*: the desktop can switch the sandbox between commands, and both the
   * prompt and the tool schema have to describe the environment in force when the round is built rather than the
   * one that was in force when the agent was constructed.
   */
  executionEnvironment?: string | (() => string);
  executionPolicy?: () => import('../protocol/execution.ts').ExecutionPolicy;
  modelInfo?: { model: string; protocol: string; connectionId?: string };
  supportsVision?: boolean;
  store: SessionStore;
  provider: Provider;
  tools: ToolRegistry;
  approve: Approver;
  /**
   * How a run asks the human a structured question, when the host can ask one at all.
   *
   * Optional unlike `approve`, because asking is not an effect: a host that cannot reach a human (a
   * scheduled run, an embedded runtime) still runs, and the tool reports the missing answer to the model
   * instead of failing the call.
   */
  question?: Questioner;
  /**
   * The permission policy in force, read when a run builds the tool schema it sends.
   *
   * A getter rather than the policy itself because the policy can change between runs (the desktop's
   * permission mode is a setting) while one agent instance is reused. What the run does with it is trim:
   * a tool the policy denies every call of is not sent, so the schema the model sees is the schema it can
   * actually use. Hiding it is not the guarantee — the approver still consults the policy — but a run that
   * can only read should not be offered tools to write with.
   */
  permissionPolicy?: () => PermissionPolicyView | undefined;
  onEvent?: (event: AgentEvent) => void;
  /** Delegation limits. Sub-agents are enabled by default and capped by `SUBAGENT_DEFAULTS`. */
  subagents?: SubAgentOptions;
  /**
   * Resolves the provider a sub-agent should use when it asked for a specific model, or `undefined`
   * when this host cannot serve that model. Its presence is what lets the built-in provider advertise
   * the `agentOptions` capability: without a resolver, a task that names a model is refused loudly
   * instead of silently running on the default one.
   */
  subagentProviderFor?: (model: string) => Provider | undefined;
  /** Additional sub-agent providers, registered after the built-in `in-process` one. */
  subagentProviders?: readonly SubAgentProvider[];
  /** Which sub-agent provider this run delegates to. Defaults to the built-in `in-process`. */
  subagentProvider?: string;
  /**
   * The models this host can actually run a sub-agent on, for the `list_subagent_models` tool.
   *
   * Left out by a host with nothing to say, and then the tool is absent rather than empty: the list is a
   * promise that a named model will resolve, and a host that cannot make that promise must not appear to.
   */
  subagentModels?: () => readonly { model: string; note?: string }[];
  /** Characters of this session's transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptChars?: number;
  /** Messages of this session's transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptMessages?: number;
  /**
   * Keeps delegated children resident after their first turn, so a later run in the same session can ask
   * them for more instead of delegating the same ground again.
   *
   * Without one, delegation stays one-shot: the child runs, reports, and its activation is gone. The
   * residency is host-owned because it must outlive runs; see `packages/core/residency.ts` for the
   * trade-offs it brings (children own their tools, and their usage is attributed to their own sessions).
   */
  subagentResidency?: SubAgentResidency;
  /**
   * Where this run publishes and checks runtime invariants.
   *
   * Host-owned, because the registry outlives any one run and a package other than this one registers into
   * it. A run contributes the one invariant that is genuinely per-run state — the tool pipeline trace — and
   * withdraws it when it ends.
   */
  invariants?: InvariantRegistry;
  /**
   * Builds the tool registry a *resident* child owns for its whole residency.
   *
   * A resident child cannot borrow the parent run's registry, because that run ends and closes it. Without
   * a factory, residency is refused rather than silently degraded to borrowing: a child whose tools vanish
   * between turns would fail in a way nobody could attribute.
   */
  childTools?: () => ToolRegistry;
  /** Appended to the system prompt, to give a delegated child its role. */
  rolePrompt?: string;
  /**
   * This agent's own persona, which **replaces** the deployment's rather than adding to it.
   *
   * `rolePrompt` above is additive and sits near the end of the prompt: a child that carries one is told both
   * what the parent was told about itself and what the child is. That is right for a role and wrong for a
   * persona — a persona is the paragraph that says who is speaking, and two of them in one prompt is the model
   * being handed a contradiction to average. This is the same text in a slot that shadows, so a host that
   * composes per-session personas (a support agent, a reviewer, a specialist child) has one place to put it.
   */
  persona?: string;
  /**
   * The deployment's persona, as opposed to this agent's.
   *
   * Both live in the same prompt slot and {@link persona} shadows this one, so a host can state a default
   * persona once (on every agent it composes) and let one agent replace it. Registering the deployment's even
   * when it is not overridden is what lets the prompt trace say which persona was in effect.
   */
  deploymentPersona?: string;
  /** How many delegation levels above this agent. A child is one deeper than its parent. */
  subagentDepth?: number;
  /**
   * Identifies this run as a delegated child, so the effects it causes can name it: the file-change
   * journal and every approval it raises carry this tag. Without it a sub-agent's write is
   * indistinguishable from the parent's own work in the session change list.
   */
  subagentTag?: SubAgentTag;
  /**
   * False for a sub-agent, which borrows its parent's tool registry and provider. Those resources
   * outlive the child: closing them there would take down the parent's language servers, background
   * commands and MCP connections mid-run.
   */
  ownsToolResources?: boolean;
  /** Parent task attempt whose effects a delegated child must journal. */
  taskEffectScope?: { sessionId: string; taskId: string; attemptId: string };
  maxContextChars?: number;
  maxContextTokens?: number;
  /**
   * The capacity of a model this run may be re-aimed at, when the host can resolve one.
   *
   * A window is a property of a *route*, not of a run: a pre-step policy that moves a round onto another model
   * moves it onto that model's window as well, and measuring the round against the model it is no longer using
   * is how a run compacts too early on a wide model or overruns a narrow one. The resolver answers for the
   * model a round will actually use — the connection's declaration, the catalogue this project ships, or
   * nothing — and `undefined` means "no opinion", which leaves this run's own window in place rather than
   * inventing a second one.
   */
  capacityFor?: (model: string) => { contextWindow: number; maxOutputTokens?: number } | undefined;
  autoCompactTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  /** How many times a round's model request may be re-sent after a transient failure. */
  maxModelRetries?: number;
  /** How many sibling tool calls from one assistant message may be in flight at once. */
  maxParallelToolCalls?: number;
  /** How many of the newest tool results are never shortened. */
  toolResultKeepRecent?: number;
  /** Characters a shortened tool result keeps. */
  toolResultShrinkTokens?: number;
  /** Code points a tool result may reach before its middle is dropped. */
  toolResultPruneThresholdChars?: number;
  /** Code points a pruned result keeps at its head. */
  toolResultPruneHeadChars?: number;
  /** Code points a pruned result keeps at its tail. */
  toolResultPruneTailChars?: number;
  /** Share of the window at which old tool results start being shortened. */
  contextShrinkPercent?: number;
}
/**
 * A run's own limit was reached, with the code that says which one.
 *
 * The class already meant "limited" rather than "failed"; what the code adds is *which* limit, so a run
 * result can say "the output limit" instead of leaving a reader to parse the error text. It is a limit on
 * *work* rather than on spend: output produced, not rounds taken — a run has no round cap to reach, and the
 * rounds nobody asked for are counted by the goal that asked for them (see `packages/core/goal-driver.ts`).
 */
class LimitError extends RunFailure {
  constructor(code: 'output-limit', message: string) {
    super(code, message);
    this.name = 'LimitError';
  }
}
/**
 * A round a pre-step hook refused.
 *
 * Its own class because the refusal is not a failure of anything: a policy said no to this round, and a reader
 * asking why the step ended should see that instead of the anonymous `failed` an unclassified error produces.
 * The message and the run's status are deliberately unchanged — the task did not happen, so the run still
 * fails — which is why this names the *step's* end and not the run's outcome.
 */
class StepBlockedError extends Error {
  constructor(blocked: string) {
    super(`Run refused by extension pre-step hook: ${blocked}`);
    this.name = 'StepBlockedError';
  }
}
/**
 * Whether a failure ended a run because it ran out of room or because something broke.
 *
 * The distinction is what tells a user to start a smaller task instead of looking for a bug, so it is
 * answered from one place: the code the failure carries. Every failure this runtime raises itself now carries
 * one (`LimitError`, `ContextLimitError`, the provider adapters), `failureCodeOf` names the two that do not —
 * a `TimeoutError` abort and an endpoint that only describes an overflow in prose — and anything else is a
 * defect without a name, which is exactly what `failed` means.
 */
function failureStatus(value: unknown): 'limited' | 'failed' | undefined {
  return statusForFailure(failureCodeOf(value));
}
/**
 * Why the step that was open when the run threw ended.
 *
 * Read from the same places the run's own status is built from a few lines further down, so the two never
 * disagree: a step that ended because a limit was reached is not a failure, and one that ended because a person
 * was asked to look at something is neither. The abort comes first because that is what the signal says,
 * whatever error arrived carrying it.
 */
function stepEndReason(cause: unknown, aborted: boolean): StepEndReason {
  if (aborted) return 'cancelled';
  if (cause instanceof StepBlockedError || cause instanceof DeferredApprovalError) return 'blocked';
  return failureStatus(cause) === 'limited' ? 'limited' : 'failed';
}

/**
 * Serial number for the ids of messages handed to sub-agents.
 *
 * The id has to be unique across the *log*, not just this process: the inbox fold removes an entry by id, so a
 * repeat after a restart would silently cancel a message that was never delivered. The timestamp covers the
 * restart, the counter covers two messages in the same millisecond.
 */
let messageCounter = 0;

export class Agent {
  private options: AgentOptions;
  private runs = new Map<
    string,
    { queue: RunQueue; emit: (type: AgentEvent['type'], data: Record<string, unknown>) => void }
  >();
  private subagents?: ResolvedSubAgentOptions;
  /**
   * What the most recent assembly of a system prompt was made of.
   *
   * Kept because the alternative to reading it is bisecting `composeSystem` and running model rounds to see what
   * changed. It is per agent rather than per session: an agent serves one composition, and a child is a different
   * agent with its own answer — which is exactly the comparison a caller wants.
   */
  private lastPrompt: readonly PromptTrace[] = [];
  constructor(options: AgentOptions) {
    this.options = options;
    // Resolved once, at construction, so an invalid limit fails before a run opens a row.
    this.subagents = resolveSubAgentOptions(options.subagents);
    /**
     * The kernel owns the sub-agent producer; the command manager registered its own when the registry was
     * built. A child is given no residency (see the child construction below), so it manages its own commands
     * and nothing else — the same "control reaches one level down" rule the rest of delegation follows.
     */
    if (options.subagentResidency)
      options.tools.jobs.register(
        subAgentJobProducer({ store: options.store, residency: options.subagentResidency }),
      );
  }
  /**
   * Queue an input for a running session.
   *
   * `id` is passed through by the one caller that already named the message — a parent correcting a child — so
   * that the child's receipt and the parent's record are about one id (see `RunQueue.add`).
   *
   * The acceptance is durable *before* the input can be folded into a turn, on the same argument the sub-agent
   * inbox follows: the queue is memory, the fact that somebody queued this is not. `input.queued` is written
   * first, so a process that dies holding it leaves "queued and never delivered" readable rather than leaving
   * a conversation that merely ended (see `packages/storage/events.ts`).
   */
  enqueue(sessionId: string, input: UserInput, mode: InputMode, id?: string): QueuedInput {
    if (this.options.supportsVision === false && input.images?.length)
      throw new Error('当前连接未启用图片输入，请选择支持视觉的模型。');
    const active = this.runs.get(sessionId);
    if (!active) throw new Error('Session is not running');
    const pending = active.queue.add(validateUserInput(input), mode, id);
    this.options.store.recordEvent(sessionId, 'input.queued', {
      item: {
        id: pending.id,
        mode: pending.mode,
        prompt: pending.prompt,
        createdAt: pending.createdAt,
        imageCount: pending.images?.length ?? 0,
      },
    });
    const item = queuedInput(pending);
    active.emit('input.queued', { item, queue: active.queue.items });
    return item;
  }
  getQueue(sessionId: string): QueuedInput[] {
    return this.runs.get(sessionId)?.queue.items ?? [];
  }
  /**
   * The session's inbox as a client reads it, live or after the fact.
   *
   * While a run holds the queue, the queue is the answer: it is what the person can still act on (steer it,
   * clear it). Once nothing holds it, the *log* is the answer, and what it says is what nobody ever delivered —
   * a follow-up the process died holding, or the tail of a run that ended with input still waiting. That second
   * case is the one nothing used to be able to show, and it is the whole reason this seam exists.
   */
  inboxOf(sessionId: string): { running: boolean; items: QueuedInput[] } {
    const active = this.runs.get(sessionId);
    if (active) return { running: true, items: active.queue.items };
    return { running: false, items: this.options.store.pendingInputs(sessionId) };
  }
  /**
   * Drop the session's inbox and record that it will never be delivered.
   *
   * Deliberately allowed while no run holds the session: the entries this settles are mostly *leftovers* from
   * a run that ended or died, and a clear that only worked during a run would leave them to reappear after every
   * reload. The log is what is settled rather than the array, so the live queue and the leftovers are one list
   * to this call — which is what a person pressing "clear" means.
   */
  clearQueue(sessionId: string): void {
    const active = this.runs.get(sessionId);
    active?.queue.clear();
    this.options.store.discardPendingInputs(sessionId, 'user');
    active?.emit('queue.changed', { queue: [] });
  }
  /**
   * Record that inputs will never be delivered, and why.
   *
   * One record for the batch rather than one per input, because the reason is the same fact about all of them
   * and the reader asks it once: `ids` names exactly the inputs it covers, so the fold settles all of them.
   */
  /**
   * What the system prompt of this agent's last assembled round was made of.
   *
   * Every section the composition registers, in assembly order, with whether it contributed text, had none to
   * contribute, or was replaced by another section. Reported rather than inferred: a prompt is a thing a person
   * has to be able to audit, and "which persona was in effect for this run" is not answerable from a string.
   */
  promptSections(): readonly PromptTrace[] {
    return this.lastPrompt;
  }
  private discard(ids: readonly string[], sessionId: string, reason: string): void {
    if (!ids.length) return;
    this.options.store.recordEvent(sessionId, 'input.discarded', { ids: [...ids], reason });
  }
  async run(
    input: UserInput & {
      sessionId: string;
      prompt: string;
      signal?: AbortSignal;
      taskId?: string;
      taskTrigger?: TaskTriggerSource;
      resumeTask?: boolean;
      /** Read-only planning phase: the run must end by calling `submit_plan`. */
      planPhase?: boolean;
      /** A sub-agent that may investigate but not change anything. */
      readOnly?: boolean;
      /**
       * A delegated child ends by calling `submit_report`, so the parent gets findings it can cite
       * instead of prose. Only set for a child run: only a child has a parent waiting for the answer.
       */
      reportRequired?: boolean;
      /**
       * The object this child must come back with, when its caller wants a shape of its own.
       *
       * The tool it submits through takes *this* schema as its argument schema, so the answer is validated by
       * the same Ajv pass every other tool call gets — a call that arrives is a call that conforms. The result
       * carries it as `data` instead of `report`.
       */
      reportSchema?: Record<string, unknown>;
      /** The `planning` row this run will fill in when `submit_plan` is called. */
      planId?: string;
      /** An approved plan to execute. Its approval and hash were checked before the run started. */
      approvedPlan?: Plan;
      /**
       * Session that owns the file-change journal. A sub-agent sets it to the parent session, so its
       * writes appear in the session the user is actually looking at and remain undoable there.
       */
      journalSessionId?: string;
      /**
       * Who asked for this turn, when it is not the user.
       *
       * Absent means the user's own request, which is what every entry point's ordinary path is: the CLI's
       * `run` and `resume`, and the Host serving whatever a person did in a carrier. A round the runtime
       * started by itself says so, and there are exactly two such paths today — the goal continuations
       * (`runGoalRounds`) and a task run the clock triggered. The distinction is what the goal tools read to
       * decide whether they may change *who is in charge* of the goal; see `HUMAN_ONLY_GOAL_ACTIONS`.
       *
       * The default is `human` rather than `automatic` on purpose. Defaulting the other way would silently take
       * the ability to pause or re-aim a goal away from every embedder that has not been told about this field,
       * including ones whose runs are all requests from a person; defaulting this way leaves the two automatic
       * paths above to opt in, which is a list short enough to keep true.
       */
      authority?: 'human' | 'automatic';
    },
  ): Promise<RunResult> {
    const { store, provider, tools } = this.options;
    input = { ...input, ...validateUserInput(input) };
    // One owner for the defaults (see `packages/protocol/settings.ts`): the kernel, the Host and the CLI help
    // text all read the same numbers instead of each keeping its own copy of them.
    const limits = resolveRunLimits(this.options);
    const {
      maxContextTokens,
      maxOutputTokens,
      maxParallelToolCalls,
      toolResultKeepRecent,
      toolResultShrinkTokens,
      toolResultPruneThresholdChars,
      toolResultPruneHeadChars,
      toolResultPruneTailChars,
      contextShrinkPercent,
    } = limits;
    if (
      this.options.autoCompactTokens !== undefined &&
      maxContextTokens !== undefined &&
      this.options.autoCompactTokens >= maxContextTokens
    )
      throw new Error('Auto-compact threshold must be below context window');
    if (
      this.options.supportsVision === false &&
      (input.images?.length ||
        store.messages(input.sessionId).some((m) => m.role === 'user' && m.images?.length))
    )
      throw new Error('当前连接未启用图片输入；请切换视觉模型或新建纯文本会话。');
    const signal = input.signal ?? new AbortController().signal;
    /**
     * A read-only run hides every tool that declares a permission and refuses any approval that still
     * arrives. Plan mode and a read-only sub-agent need the same guarantee, so they share one flag
     * rather than two paths that could drift apart.
     *
     * `let` rather than `const` for exactly one transition: a planning run whose plan the user approves
     * mid-run with `exit_plan_mode`. That tool is registered only when a human can answer, and it flips this
     * flag at the next step boundary — never during the round that asked, because that round was already sent
     * a schema of the read-only tools and knows only what it was told. The approver reads this flag on every
     * call, so lifting it here is what makes a write possible at all; each write still asks for its own
     * approval.
     */
    let readOnly = input.planPhase === true || input.readOnly === true;
    // Both are re-read at every round boundary (see the loop below): a preset or sandbox switched mid-run has to
    // reach the prompt, the tool schema and the calls that follow, not just the next run.
    let policy = this.options.permissionPolicy?.();
    let executionPolicy = this.options.executionPolicy?.();
    // Prompt hooks run before the run row is opened, so a refused prompt leaves no run or attempt
    // behind. A hook that itself fails stops the run: these hooks exist to police or shape the
    // request, and silently continuing would drop that enforcement.
    const submitted = await tools.extensions.promptSubmit(
      { sessionId: input.sessionId, prompt: input.prompt, readOnly },
      signal,
    );
    if (submitted.failures.length)
      throw new Error(
        `Prompt hook failed, so the run was not started: ${submitted.failures.join('; ')}`,
      );
    if (submitted.block) throw new Error(`Prompt rejected by extension: ${submitted.block}`);
    if (!submitted.prompt.trim()) throw new Error('Prompt hook produced an empty prompt');
    input.prompt = submitted.prompt;
    const task = input.taskId ? store.getTask(input.sessionId, input.taskId) : undefined;
    const previousAttempt = task
      ? store
          .listTaskAttempts(input.sessionId, task.id)
          .filter((attempt) => attempt.kind === 'run')
          .at(-1)
      : undefined;
    if (task) task.acceptance = task.acceptance.map((item) => ({ ...item, met: false }));
    const workspace = store.get(input.sessionId).workspace;
    const journalSessionId = input.journalSessionId ?? input.sessionId;
    /**
     * A sub-agent's file changes are journaled against the parent session, so the tag has to travel
     * with the change: otherwise the session change list shows work that looks like the parent's own.
     */
    const tagChange = (change: FileChange): FileChange =>
      this.options.subagentTag && !change.subagent
        ? { ...change, subagent: this.options.subagentTag }
        : change;
    const baselines: TaskBaselines = task ? await captureTaskBaselines(workspace, task) : {};
    const runId = store.beginRun(input.sessionId);
    // The host creates the plan row before the run exists, so the run id is only knowable here.
    if (input.planId) store.linkPlanRun(input.sessionId, input.planId, runId);
    let taskAttempt: ReturnType<SessionStore['startTaskAttempt']> | undefined;
    try {
      taskAttempt = task
        ? store.startTaskAttempt(input.sessionId, task.id, {
            kind: 'run',
            runId,
            prompt: input.prompt,
            baselines,
            ...(input.taskTrigger ? { trigger: input.taskTrigger } : {}),
            ...(input.resumeTask ? { resume: true } : {}),
          })
        : undefined;
    } catch (cause) {
      store.finishRun({
        runId,
        sessionId: input.sessionId,
        status: 'failed',
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
    const taskEffectScope =
      task && taskAttempt
        ? { sessionId: input.sessionId, taskId: task.id, attemptId: taskAttempt.id }
        : this.options.taskEffectScope;
    /**
     * Session retrieval, installed for every run because every run has a store.
     *
     * These are the only tools that read *other* conversations, so they are worth being explicit about: the store
     * has indexed message text since v10 and the session list has used it, but the model could not. They carry no
     * permission — reading history is not an effect — which also means they survive a read-only or planning run,
     * and that is the run that most needs to look something up.
     *
     * The run's own workspace and session id are what scope them: a search never leaves this workspace, and a
     * read refuses a session from another one by name.
     */
    for (const tool of sessionQueryTools({
      store,
      workspace,
      sessionId: input.sessionId,
    }))
      tools.replace(tool);
    /**
     * Whether this run is the session's own front door, or one of the runs that serve something narrower.
     *
     * The goal tools are registered only here, and only for this: a planning run is deciding what to do rather
     * than pursuing the session's objective, a read-only run may not act on one, and a delegated child must not
     * be able to rewrite the objective it was delegated from. A child additionally never sees them by
     * inheritance — they are in `RUN_SCOPED_TOOLS`.
     */
    const ownWork =
      (this.options.subagentDepth ?? 0) === 0 &&
      !input.reportRequired &&
      !input.planPhase &&
      !readOnly;
    if (ownWork) for (const tool of goalTools()) tools.replace(tool);
    // Starting the attempt re-seeded the step list (a resume keeps completed steps). Re-read just
    // the steps so the prompt describes the work remaining in this attempt, not the previous one.
    if (task && taskAttempt) task.steps = store.getTask(input.sessionId, task.id).steps;
    if (task && taskAttempt) {
      // Registered only while an attempt is live, so the tool cannot write checkpoints against a
      // task that is not actually running. `replace` keeps a reused registry from keeping a stale
      // closure that would checkpoint the previous run's task.
      const attemptId = taskAttempt.id;
      tools.replace({
        name: 'task_step',
        description:
          'Record durable progress on the approved task: mark one step in_progress, completed, blocked or skipped before moving on. Call this as you finish each step so an interrupted run can resume from the last completed step instead of repeating it.',
        inputSchema: {
          type: 'object',
          properties: {
            index: { type: 'integer', minimum: 0, maximum: 63 },
            status: { type: 'string', enum: ['in_progress', 'completed', 'blocked', 'skipped'] },
            note: { type: 'string', maxLength: 500 },
          },
          required: ['index', 'status'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          context.signal.throwIfAborted();
          try {
            const updated = store.checkpointTaskStep(input.sessionId, task.id, {
              attemptId,
              index: Number(args.index),
              status: String(args.status) as NonNullable<TaskStep['status']>,
              ...(args.note === undefined ? {} : { note: String(args.note) }),
            });
            emit('task.step', { taskId: task.id, steps: updated.steps });
            return {
              isError: false,
              content: updated.steps
                .map((step, index) => `${index}. [${step.status}] ${step.description}`)
                .join('\n'),
            };
          } catch (error) {
            return {
              isError: true,
              content: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
    }
    /**
     * A delegated child ends by submitting a report, and that is a tool call for the same reason the
     * plan is: the result is structured, validated and storable. It is registered only for a child run,
     * so it can never appear in a run whose answer goes straight to the user. The holder exists because
     * the value is assigned inside the tool closure, where control-flow narrowing cannot see it.
     */
    const reportHolder: { report?: SubAgentSummaryReport; data?: unknown } = {};
    if (input.reportRequired) {
      /**
       * Which shape this child must come back with.
       *
       * The fixed report contract by default; the caller's own schema when the task declared one. The schema is
       * the tool's *argument* schema either way, which is what makes the promise real rather than aspirational:
       * the registry validates the call against it before the tool runs, so "the answer matches the schema" is
       * enforced where every other argument is, and the run cannot end with a shape nobody checked.
       */
      const schema = input.reportSchema ?? REPORT_SCHEMA;
      const custom = input.reportSchema !== undefined;
      tools.replace({
        name: 'submit_report',
        description: custom
          ? 'Submit the structured result this task asked for and end this run. The arguments are the object described by this tool’s own schema: include every required field, and use the field descriptions to decide what belongs in each. Call this exactly once, when you can answer or you are blocked.'
          : SUBMIT_REPORT_DESCRIPTION,
        inputSchema: schema,
        execute: async (args, context) => {
          context.signal.throwIfAborted();
          try {
            if (custom) {
              // Kept as submitted: it has already been validated against the caller's schema, and re-shaping
              // somebody else's object here is how a field they asked for would quietly go missing.
              reportHolder.data = args;
              return {
                isError: false,
                content:
                  'Result recorded. This sub-agent run is complete; do not call further tools.',
              };
            }
            reportHolder.report = normalizeReport(args);
            return {
              isError: false,
              content: `Report recorded (${reportHolder.report.findings.length} findings). This sub-agent run is complete; do not call further tools.`,
            };
          } catch (error) {
            return {
              isError: true,
              content: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
    } else {
      /**
       * A turn that does not require a report must not *offer* the report tool.
       *
       * A resident child borrows one registry across every turn it runs, so the `submit_report` a delegation
       * turn installed is still there when the same child is asked a follow-up question. Offering it was wrong
       * in the way that matters: the tool's own result says "this completes the run", so a child that was asked
       * a question answered by calling it — again and again, until it hit its round limit. Removing it makes the
       * offered tool set agree with what the run accepts, which is what `reportRequired` already meant.
       */
      tools.remove('submit_report');
    }
    /**
     * The two seams a person is on the other end of, declared before the planning tools can capture `askTool`.
     *
     * They are assigned below, once the emitter and the queue exist — both adapters write their own frames and
     * read the queue's steering signal — and nothing reads them before then.
     */
    let approveTool!: Approver;
    let askTool!: Questioner;
    let planning: PlanningTools | undefined;
    if (input.planPhase) {
      if (!input.planId) throw new Error('Planning phase requires a plan record');
      planning = createPlanningTools({
        store,
        sessionId: input.sessionId,
        planId: input.planId,
        ask: this.options.question
          ? (request, questionSignal) => askTool(request, questionSignal)
          : undefined,
        onProposed: (plan) => emit('plan.proposed', { plan }),
        onApproved: (plan) => emit('plan.approved', { plan, runId }),
      });
      for (const tool of planning.tools) tools.replace(tool);
    }
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const statistics = emptyStatistics();
    const committedSummaryUsage = emptyStatistics();
    /**
     * When the open step began, and when its first visible text arrived.
     *
     * Two facts about the *step* rather than about the request, because that is what the numbers beside them
     * mean: a round that re-sent a refused request is still one step, so its wall time and its first-token
     * latency are measured from where the step opened and its first token survives the retry. `null` outside a
     * step — before the first one opens, and again once its timing has been closed — so no figure can be
     * accrued twice or against a step that assembled no answer.
     */
    let stepStartedAt: number | null = null;
    let stepFirstTokenAt: number | null = null;
    let text = '',
      status: RunStatus = 'failed',
      error: string | undefined,
      /** Why the run ended, when the reason has a name. Absent is a real answer: some failures are prose only. */
      code: FailureCode | undefined,
      /**
       * The failure itself, when the thing that threw was one this runtime named.
       *
       * Kept as the object rather than as two more locals because what it carries is optional in both fields:
       * `code` above is read from it either way, and a failure that named neither a status nor a request id is
       * the common case rather than an error.
       */
      endpointFailure: RunFailure | undefined,
      acceptance: RunResult['acceptance'],
      taskVerification: Awaited<ReturnType<typeof verifyTaskAcceptance>> | undefined,
      result!: RunResult;
    const acceptanceEffects = new Map<string, string>();
    /** Every event type this run emitted, which is what the protocol invariant checks at the end. */
    const emittedTypes = new Set<string>();
    /**
     * The output tokens each child had reported as of its last `subagent.progress` frame.
     *
     * It exists so that frame can be told apart from the one the watchdog is aimed at: a child that keeps
     * publishing a *running clock* without producing anything is exactly the child worth stopping, while a
     * child whose output token count grew has produced something. Kept here rather than in the coordinator
     * because the frames are folded here (see `reportProgress`), and it is per parent run — a resident child's
     * next turn starts from the count its last turn left, which is what makes the first frame of that turn
     * count as no growth rather than as growth.
     */
    const childOutputTokens = new Map<string, number>();
    /**
     * One emitter for the run: identity, timing, activity and the child-stall signal, in one place.
     *
     * The counters it shares with this loop are grouped here so the module that owns the emission rule can
     * read and write *this run's* numbers without owning them: `toolStarted` is opened and closed by the
     * emitter's tool frames while the loop reads the same slot to charge a tool that was still running when
     * the run ended, `statistics` is folded by both, and the child token map is the stall watchdog's memory.
     */
    const emission: RunEmission = {
      statistics,
      emittedTypes,
      toolStarted: undefined,
      childOutputTokens,
      coordinator: undefined,
    };
    const emit = createRunEmit({
      store,
      sessionId: input.sessionId,
      runId,
      state: emission,
      onEvent: this.options.onEvent,
    });
    /**
     * The wrapper every model call of this run goes through, and the accounting it produces.
     *
     * One factory for both purposes: an answer call and a compaction summary are measured by the same clock
     * and recorded as the same kind of fact, so the run's provider time includes the summaries rather than
     * quietly omitting them (see `run-provider.ts`).
     */
    const measureProvider = createProviderMeasurement({
      provider,
      store,
      sessionId: input.sessionId,
      runId,
      statistics,
      emit,
    });
    const measuredProvider = measureProvider('answer');
    const summaryProvider = measureProvider('summary');
    /**
     * Close the open step's spans, at the moment its answer was assembled.
     *
     * This is the `assistant/message` side of the boundary: `step.started` opened the step, this closes what
     * the step spent, and `endStep` closes the boundary itself. Only a reported output count makes a step a
     * decode sample, which is why a round that answered with no tokens contributes a throughput of nothing
     * rather than a share of its wall time.
     */
    const commitStepTiming = (response: ModelResponse): void => {
      if (stepStartedAt === null) return;
      const now = performance.now();
      statistics.modelMs += Math.max(0, now - stepStartedAt);
      if (stepFirstTokenAt !== null && response.usage.outputTokens > 0) {
        statistics.decodeMs += Math.max(0, now - stepFirstTokenAt);
        const reasoningTokens = response.outputDiagnostics?.reasoningTokens;
        const known =
          reasoningTokens !== undefined &&
          Number.isInteger(reasoningTokens) &&
          reasoningTokens >= 0 &&
          reasoningTokens <= response.usage.outputTokens &&
          response.toolCalls.length === 0 &&
          !response.outputDiagnostics?.toolArgumentChars;
        statistics.decodeKnown = statistics.decodeKnown !== false && known;
        if (known) statistics.decodeTokens += response.usage.outputTokens - reasoningTokens;
      }
      stepStartedAt = null;
      stepFirstTokenAt = null;
    };
    const queue = new RunQueue();
    this.runs.set(input.sessionId, { queue, emit });
    /**
     * The approval and question adapters, which own the *record* of each request and each answer rather than
     * the decision itself (see `run-interaction.ts`). `readOnly` is passed as a getter because the run can
     * tighten it mid-flight, and the adapter must read the value in force when a call arrives.
     */
    ({ approve: approveTool, ask: askTool } = createRunInteraction({
      store,
      sessionId: input.sessionId,
      queue,
      emit,
      isReadOnly: () => readOnly,
      approve: this.options.approve,
      question: this.options.question,
    }));
    /**
     * Whether this turn carries the user's own input, which is what the goal tools read before letting the
     * model change who is in charge of the goal.
     *
     * It starts as whatever the caller declared and can only ever move one way: a round the runtime started
     * stays the user's turn the moment the user types into it (`consume` below), because the person the goal
     * belongs to has spoken in this very round.
     */
    let humanTurn = input.authority !== 'automatic';
    const consume = (mode: InputMode): boolean => {
      const item = queue.take(mode);
      if (!item) return false;
      /**
       * A message the user typed is the user's own input, whichever run is carrying it.
       *
       * This is what makes a correction fold-able into a round the runtime started: the round began on the
       * goal's behalf, and the person who owns the goal has since said something in it — so from here on the
       * turn may change the goal's standing, exactly as a request they typed would.
       */
      humanTurn = true;
      const expanded = expandSkill(store.get(input.sessionId).workspace, item.prompt);
      const message: Message = {
        role: 'user',
        createdAt: item.createdAt,
        ...(this.options.modelInfo ? { modelInfo: this.options.modelInfo } : {}),
        content: expanded.prompt,
        ...(expanded.skill ? { displayContent: item.prompt } : {}),
        ...(item.images?.length ? { images: item.images } : {}),
      };
      // The message and the record that it came from the inbox are one write: a crash between them would
      // either lose a message the model was shown or leave an inbox entry for one already in the transcript.
      store.consumeQueuedInput(input.sessionId, item.id, message);
      emit('input.consumed', { id: item.id, message, queue: queue.items });
      return true;
    };
    /**
     * Learned from provider usage, and carried across runs of this session; see `packages/core/calibration.ts`.
     *
     * The route is resolved once per run because it is what the recorded measurement is *about*: a session whose
     * next run aims at a different model must not inherit the previous model's error, and one that declares no
     * model at all cannot claim any earlier measurement was about the same endpoint.
     */
    const calibrationRouteKey = calibrationRoute(this.options.modelInfo);
    const calibration = TokenCalibration.from(
      store.newestPayload(input.sessionId, 'context.calibration'),
      calibrationRouteKey,
    );
    /**
     * Delegation. The coordinator is per-run state — its budget, counters and event ids belong to this
     * run alone — so the tool is installed per run. A child is one delegation level deeper than its
     * parent and stops being able to delegate at the depth cap, which is what keeps the tree bounded.
     */
    let coordinator: SubAgentCoordinator | undefined;
    const depth = this.options.subagentDepth ?? 0;
    if (this.subagents?.enabled && depth < this.subagents.maxDepth) {
      const limits = this.subagents;
      /**
       * The built-in provider is the closure that used to be the only way to delegate, now one named
       * provider among however many an embedder registers.
       *
       * Its declared capabilities are computed rather than aspirational: `agentOptions` is advertised
       * only when this host can actually resolve a model for a child, so a host that cannot serve a
       * requested model refuses the task instead of quietly running it on the default one.
       */
      /**
       * The coordinator's events, plus the durable record of the same facts.
       *
       * One call writes both, so the live feed and the parent's log cannot describe different things: a
       * child that finishes is announced *and* recorded at the same moment. The durable copy deliberately
       * drops the feed-only fields (`index`, `total`, and the truncated `text`) — the child's transcript
       * lives in the child's own session, and the card needs the summary, not a copy of the report text.
       *
       * `error` is kept, bounded and redacted like every other recorded reason. The card projection already
       * reads it, and without it a child that was cancelled or failed reaches its parent as a bare status: the
       * one thing a person needs after "the sub-agent did not finish" is *why*.
       */
      const subAgentEmit = (type: AgentEventType, data: Record<string, unknown>): void => {
        /**
         * A finished child carries its own work time, read from its session before anyone seals the card.
         *
         * The parent's log records one assignment and one end per turn, so the time a resident child spent in
         * its later turns has no start to subtract from and cannot be folded out of this session at all. The
         * child's own log has it — so the number is read there, here, while the child's run is still the thing
         * that just ended. It stays *derived*: the durable record below deliberately does not copy it, and a
         * reload recomputes the same value from the same events.
         */
        if (type === 'subagent.finished') {
          const childSessionId = String(data.sessionId ?? '');
          if (childSessionId) {
            const timing = store.turnTiming(childSessionId);
            data = { ...data, durationMs: timing.settledMs, runningSince: timing.runningSince };
          }
        }
        emit(type, data);
        if (type !== 'subagent.finished') return;
        store.recordEvent(input.sessionId, 'subagent.finished', {
          runId,
          childRunId: data.sessionId
            ? store.events(String(data.sessionId)).findLast((e) => e.type === 'run.finished')?.data
                .runId
            : undefined,
          id: data.id,
          sessionId: data.sessionId,
          role: data.role,
          objective: data.objective,
          status: data.status,
          rounds: data.rounds,
          toolCalls: data.toolCalls,
          usage: data.usage,
          ...(data.report ? { report: data.report } : {}),
          ...(data.error ? { error: redactSecrets(String(data.error)).slice(0, 600) } : {}),
        });
      };
      /**
       * Everything a child needs to run turns on a session that already exists.
       *
       * This used to live inside the provider's `run`, which meant it existed only while a delegation was
       * starting: a child that had been *delegated* in an earlier process could be seen in the log and in its
       * own transcript, and still nothing could run a turn on it, because the only code that knew how to build
       * one was in the call that had already returned. Extracting it is what makes a cold resume possible —
       * the residency can now open an activation for a child it did not start.
       *
       * The signature says what a turn needs and nothing else: the task it belongs to (for the persona, the
       * read-only rule and the grant), the session to run on, the depth for the lineage, the tag that names it
       * in approvals and events, and — only when a live delegation is resuming its own child — the
       * delegation's own signal.
       */
      const childTurns = createChildTurns({
        agent: this.options,
        store,
        tools,
        emit,
        sessionId: input.sessionId,
        taskEffectScope,
        createAgent: (options) => new Agent(options),
      });
      /**
       * The providers this run delegates through: the built-in in-process one plus the host's own.
       *
       * Built here, after `childTurns`, because the built-in provider *is* that closure — and per run, because
       * its advertised capabilities are a promise about this host, not about the model (see `run-subagents.ts`).
       */
      const providers = createSubAgentProviders({
        store,
        parentSessionId: input.sessionId,
        workspace,
        runId,
        depth,
        residency: this.options.subagentResidency,
        childTurns,
        resolveProviderFor: this.options.subagentProviderFor,
        forkTranscriptChars: this.options.forkTranscriptChars,
        forkTranscriptMessages: this.options.forkTranscriptMessages,
        extraProviders: this.options.subagentProviders,
      });
      /**
       * The coordinator of this run's children, armed into the emitter so their frames keep their stall
       * watchdogs alive, and the tools that reach it (see `run-coordinator.ts`).
       */
      coordinator = createCoordinator({
        store,
        sessionId: input.sessionId,
        workspace,
        depth,
        limits,
        signal,
        readOnly,
        queue,
        emit: subAgentEmit,
        usage,
        statistics,
        providers,
        providerName: this.options.subagentProvider,
        models: this.options.subagentModels,
        tools,
        arm: (armed) => {
          emission.coordinator = armed;
        },
      });
      /**
       * The orchestration tool, on the same admission path as `delegate_task`.
       *
       * `runAgent` goes through `runOne`, which admits and schedules exactly like a delegation task: a script's
       * loop and a model's loop of tool calls meet the same per-run total, the same semaphore and the same
       * capability checks. That is the whole reason this is wired here rather than built inside the tool.
       *
       * `coordinator` is declared outside this block because the run's end has to settle it, and a closure cannot
       * lean on the narrowing the assignments above establish — hence the local name.
       */
      const delegation = coordinator;
      tools.replace(
        workflowTool({
          runAgent: (prompt, options, signal) =>
            delegation.runOne(
              {
                objective: prompt,
                ...(options.model ? { model: options.model } : {}),
                ...(options.schema ? { schema: options.schema } : {}),
              },
              signal,
            ),
        }),
      );
      // Registered only when the host supplied the list: a discovery tool with nothing behind it would
      // teach the model to trust an answer nobody stands behind.
      if (this.options.subagentModels) tools.replace(coordinator.modelsTool());
      /**
       * The control surface for resident children.
       *
       * These tools exist only when a residency does, because without one there is nothing to talk to: a
       * one-shot child is gone the moment it reports. They are scoped to this session's **direct** children,
       * which is what stops a child from driving its siblings (a grandchild is reachable from its own
       * parent, which owns that relationship) — the same reasoning that keeps `delegate_task` out of a
       * child's registry, expressed as a lineage check instead of an allowlist.
       */
      const residency = this.options.subagentResidency;
      if (residency)
        tools.replace(
          createResidentMessageTool({
            store,
            parentSessionId: input.sessionId,
            depth,
            residency,
            childTurns,
            resolveProviderFor: this.options.subagentProviderFor,
            emit: subAgentEmit,
            statistics,
            // The serial lives with the run loop, not in the tool: an id it minted per run would repeat across
            // runs, and the inbox fold cancels an entry *by id*.
            nextMessageId: () => ++messageCounter,
          }),
        );
    }
    /**
     * The step the log currently has open, and the one way it ever closes.
     *
     * Declared out here rather than inside the `try` below because the `catch` is where the interesting close
     * happens: every exit from the round loop goes through `endStep`, so the log holds exactly one
     * `step.finished` per `step.started` — including the exits that throw, which is the whole point. A step left
     * open is how a reader tells a run that was cut off from one that ended, so a stray open step is a false
     * report of a crash, and the number is tracked in a variable of its own because the classification of a
     * throw needs the step it happened in after the loop's own variable is out of scope.
     */
    let openStep: number | null = null;
    const endStep = (step: number, reason: StepEndReason): void => {
      openStep = null;
      // Whatever a step opened and never committed — a cancellation, a failure mid-stream — leaves no span
      // behind. The boundary is still counted, because it happened, and the run that closed it is a turn.
      stepStartedAt = null;
      stepFirstTokenAt = null;
      statistics.steps += 1;
      statistics.turns = 1;
      store.recordEvent(input.sessionId, 'step.finished', { runId, step, reason });
      // The panel's counts and wall times change exactly here, so the boundary is what a listener is told
      // about; a client that only saw the live channel would otherwise learn the step count a round late.
      emit('statistics.updated', { statistics: { ...statistics }, activity: null });
    };
    try {
      signal.throwIfAborted();
      const instructions = loadInstructions(store.get(input.sessionId).workspace);
      const skills = discoverSkills(store.get(input.sessionId).workspace);
      /**
       * What this run says about the plan phase, as a value rather than a literal inside the prompt.
       *
       * It changes once, when the user approves a plan mid-run with `exit_plan_mode`. A prompt that still said
       * "you have read-only tools" after the approval would be the run telling the model something untrue
       * about its own capabilities, and the model would then refuse work it is in fact able to do.
       */
      let planNotice = input.planPhase
        ? this.options.question
          ? '\n\nPlanning mode: you have read-only tools and every permission-requiring operation is refused, so investigate the codebase and then end the planning phase with one tool call: exit_plan_mode to ask the user to approve the plan now, or submit_plan to record it for a decision later. Prefer exit_plan_mode when the user is present. Give a concrete, ordered plan either way. Do not attempt modifications.'
          : '\n\nPlanning mode: you have read-only tools and every permission-requiring operation is refused, so investigate the codebase and then call submit_plan exactly once with a concrete, ordered plan. Do not attempt modifications.'
        : '';
      /**
       * The session's goal, if this run is the one that owns it.
       *
       * Admission happens here, once per run, and it is what `roundsStarted` counts: a goal's budget is
       * expressed in runs, so the run that reads it is the run that spends one. The write is a durable event
       * like any other change, so "how many runs has this been going on" is answered by the log and not by a
       * counter that only exists while something is running.
       *
       * An exhausted goal is admitted as-is rather than refused: the run still happens — the user asked for it —
       * and the notice says the budget is spent, which leaves the decision (more rounds, completed, blocked)
       * where it belongs.
       *
       * The notice is written into the conversation here, before the prompt, so the request the model is about to
       * be sent carries the goal as context it can read rather than as a system section that changes the cacheable
       * prefix (see `goalNoticeText`). Both writers — this one and the `goals` seam below — go through
       * `announceGoal`, so there is one definition of what the conversation is told.
       */
      const announceGoal = (goal: Goal): void => {
        const content = goalNoticeText(goal);
        store.append(input.sessionId, { role: 'user', content });
        emit('context.injected', { source: 'goal', round: 0, notes: 1, content });
      };
      /**
       * Context that changes while the session runs, said in the conversation rather than in the prompt.
       *
       * Same reasoning as the goal notice above, one step further: the workspace outline changes whenever a file
       * does, saved memory changes whenever it is written, and an approved task's steps change whenever one is
       * checkpointed — so as prompt sections they were the most reliable ways to lose the cacheable prefix. What
       * is announced is a *snapshot*, so this is not "tell the model about an event" but "make the conversation
       * hold the current state" — and it is announced only when the conversation does not already hold it, which
       * is what keeps a round's prefix byte-identical to the round before it. `packages/core/runtime-context.ts`
       * owns the shape and the reading.
       *
       * Announced before the run's own prompt on the first round, so the person's request is the last thing in
       * the request; from then on each round re-announces after the work that may have changed the state.
       *
       * What is compared is the window the model can *see*, which is the transcript after the last compaction: a
       * snapshot the summary swallowed is one the model no longer has, so the next round announces it again. That
       * is the one case where a snapshot is repeated, and repeating it is the point — the alternative is a model
       * that lost the outline without anything saying so.
       */
      const announceSnapshots = (round: number): void => {
        const surface = store.contextSurface(input.sessionId);
        const messages = store.messages(input.sessionId).slice(surface?.coveredMessages ?? 0);
        const announce = (source: RuntimeSnapshotSource, body: string): void => {
          const text = body.trim();
          if (!text) return;
          if (lastRuntimeSnapshot(messages, source) === runtimeSnapshotText(source, text)) return;
          const content = runtimeSnapshotMessage(source, text);
          store.append(input.sessionId, { role: 'user', content });
          emit('context.injected', { source, round, notes: 1, content });
        };
        // The task first: it is the objective this run is carrying out, and the steps below it are the state the
        // rest of the snapshot describes. The step list is re-read here rather than taken from the run's own copy,
        // so a step checkpointed during the run is what the next round is told — and whether the run is picking
        // work up or starting it over is read from that same list, so the instruction cannot disagree with it.
        if (input.taskId) {
          const current = store.getTask(input.sessionId, input.taskId);
          announce(
            'task',
            taskDefinitionText(
              current,
              current.steps.some((step) => step.status === 'completed'),
            ),
          );
        }
        announce('memory', memoryContext(workspace));
        // Read per round rather than taken from the run's own list (`skills`, which the `resources.loaded`
        // record keeps as what *this run* loaded): a skill written during the run is available from the next
        // round, and the announcement is what notices that it changed.
        const available = discoverSkills(workspace);
        announce('skills', skillsCatalogue(available));
        const outline = repoMapContext(workspace);
        announce(
          'workspace-outline',
          outline
            ? `Workspace outline (paths with the symbols they declare; use repo_map or read_file for detail):\n${outline}`
            : '',
        );
      };
      if (ownWork) {
        const existing = store.goal(input.sessionId);
        if (existing) {
          const admitted = admitGoalRound(existing, new Date().toISOString());
          if (admitted !== existing) {
            store.recordEvent(input.sessionId, 'goal.changed', {
              action: 'round',
              goal: admitted,
            });
            emit('goal.changed', { action: 'round', goal: admitted });
          }
          announceGoal(admitted);
        }
      }
      announceSnapshots(0);
      /**
       * The system prompt for a round, rebuilt rather than assembled once.
       *
       * A run's instructions are a function of its state, and one piece of that state — whether it may write —
       * can change mid-run when a plan is approved. Rebuilding keeps the system message, the tool schema and
       * the approver telling the same story; the alternative is a prompt that describes a run the model is no
       * longer in. It is called once per promotion, not once per round: everything else here is fixed for the
       * life of the run, and the repo-map outline below genuinely does read the filesystem.
       *
       * Each fragment is a **named, ordered section** (`packages/core/prompt-sections.ts`) rather than a term in
       * one long concatenation. The text is unchanged — sections are joined with a blank line, which is what the
       * `'\n\n' +` chain produced — but three things become answerable that were not: where a new fragment
       * belongs (its `order`), who wrote a paragraph (the {@link PromptTrace}), and what a child's persona does
       * to its parent's (it replaces it, and the trace records the shadowing).
       */
      const promptSections = () =>
        createRunPromptSections({
          agent: this.options,
          store,
          sessionId: input.sessionId,
          approvedPlan: input.approvedPlan,
          previousAttempt,
          instructions: instructions.text,
          planNotice: () => planNotice,
        });
      /** The last assembly's trace, so a caller can ask what the prompt it just sent was made of. */
      const composeSystem = (): string => {
        const assembled = assemblePrompt(promptSections());
        this.lastPrompt = assembled.trace;
        return assembled.text;
      };
      let runSystem = composeSystem();
      /**
       * The catalogue this run's next request will carry, as a function of the run's current state.
       *
       * A read-only phase hides every tool that declares a permission, which is every workspace mutation; a
       * permission policy that denies a tool every call of hides it too, so the schema sent is the schema this
       * run can use. The approver refuses them as well, so hiding is a courtesy to the model, not the
       * guarantee. Built by a function because approving a plan mid-run changes `readOnly`, and the round after
       * that has to be sent the tools it may now actually use.
       */
      const buildCatalog = (): { specs: ToolSpec[]; catalog: ToolSpec[] } => ({
        specs: tools.specs({ readOnly, ...(policy ? { policy } : {}) }),
        /**
         * The same trimmed set, never folded: this is what a `run_code` program may call.
         *
         * The two differ only under `YUANTU_TOOL_MODE=ptc`, and the difference is the point — what the model is
         * *sent* may be one tool with a declaration list, while what the run *has* is unchanged. Computing it here
         * rather than in the tool keeps the catalog a fact about this run's registry and policy, which is what
         * makes a read-only child's program unable to reach the parent's tools.
         */
        catalog: tools.specs({ readOnly, ...(policy ? { policy } : {}), mode: 'native' }),
      });
      if (
        tools.toolMode === 'ptc' &&
        executionPolicy &&
        (executionPolicy.mode === 'docker' || executionPolicy.mode === 'sbx')
      )
        throw new RunFailure(
          'unsupported',
          'PTC programs do not support this backend yet; select native tool mode. No host fallback is allowed.',
        );
      let { specs, catalog: catalogSpecs } = buildCatalog();
      const expanded = expandSkill(store.get(input.sessionId).workspace, input.prompt);
      store.append(input.sessionId, {
        role: 'user',
        createdAt: new Date().toISOString(),
        ...(this.options.modelInfo ? { modelInfo: this.options.modelInfo } : {}),
        content: expanded.prompt,
        ...(expanded.skill ? { displayContent: input.prompt } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
      });
      emit('run.started', {});
      /**
       * The instruction files and skills this run loaded, durable as well as live.
       *
       * The live frame alone meant "which files did that run load?" was unanswerable once the window closed, and
       * that question is half of "what did the model see" — the other half is the envelope, recorded per round.
       * The payload is the same one the live frame carries, so a reader cannot be told two different things.
       */
      store.recordEvent(input.sessionId, 'resources.loaded', {
        instructions: instructions.files,
        skills,
      });
      emit('resources.loaded', { instructions: instructions.files, skills });
      /**
       * The model this run was configured to use, and the pair the next request is currently aiming at.
       *
       * `configuredModel` is `null` for an embedder that declared no `modelInfo`: the kernel then does not know
       * the provider's model name, so it can only report — and re-aim at — a name a policy actually supplies.
       * The previous pair starts as the configured one, so the transition *into* an override is a change.
       */
      const configuredModel = this.options.modelInfo?.model ?? null;
      let previousModel: string | null = configuredModel;
      let previousEffort: ReasoningEffort | undefined;
      /**
       * The identities the session's newest envelope already carries, so this run records rather than re-copies.
       *
       * Seeded from the log rather than from an empty hand: a reopened session whose prompt and catalogue have not
       * changed since the last run would otherwise write a second copy of each — and the catalogue is the large
       * half, so that is the copy worth avoiding. Within the run these are updated as rounds go, so a prompt that
       * changes mid-run still arrives with its own text.
       */
      const recordedEnvelope = store.newestPayload(input.sessionId, 'context.envelope');
      let lastEnvelopeSystemHash =
        typeof recordedEnvelope?.systemHash === 'string' ? recordedEnvelope.systemHash : undefined;
      let lastEnvelopeToolsHash =
        typeof recordedEnvelope?.toolsHash === 'string' ? recordedEnvelope.toolsHash : undefined;
      /**
       * The round loop, which counts rounds without bounding them.
       *
       * A run ends when the model stops asking for tools, when a person cancels it, when the provider refuses
       * one of its requests, or when its own ceiling is reached — the output limit, the window, a tool's wall
       * clock. What it deliberately does *not* end on is a round count: a fixed number of rounds is a guess
       * about how much work the task is, and the guess is wrong in both directions — a long migration is cut
       * off mid-way, and a session that would have answered in two rounds is asked to keep going. A run that
       * wants a bound on rounds nobody asked for has one, and it belongs to the goal that asked for them
       * (`packages/core/goal-driver.ts`, `GOAL_DEFAULTS.maxGoalRounds`), which counts continuation rounds and
       * nothing else. Every round still opens a step, so a visit to this loop is visible in the log: the
       * count is not a limit, but it is a fact.
       */
      for (let round = 0; ; round++) {
        signal.throwIfAborted();
        /**
         * A policy switched between rounds takes effect here, and the round is rebuilt around it.
         *
         * The desktop can change the permission preset or the sandbox *while a run is in flight*, and a run that
         * kept the snapshot it started with would keep offering tools the policy now denies and keep telling the
         * model it is in an environment it is no longer in. Re-read per round rather than per run: the prompt,
         * the tool schema and the execution policy are all derived below, so all three have to be rebuilt from
         * the same answer. A call already in flight keeps the policy it was approved under — the tool layer
         * rechecks that separately (see `executionPolicyForCall` in the tool context).
         */
        const nextPolicy = this.options.permissionPolicy?.();
        const nextExecutionPolicy = this.options.executionPolicy?.();
        if (
          nextPolicy !== policy ||
          JSON.stringify(nextExecutionPolicy) !== JSON.stringify(executionPolicy)
        ) {
          policy = nextPolicy;
          executionPolicy = nextExecutionPolicy;
          runSystem = composeSystem();
          const rebuilt = buildCatalog();
          specs = rebuilt.specs;
          catalogSpecs = rebuilt.catalog;
        }
        /**
         * A plan approved during the previous round takes effect here, before anything about this round is
         * built: the request, the schema and the system paragraph are all assembled below, and all three have
         * to describe the run the model is now in.
         *
         * The approver is the enforcement — it reads `readOnly` per call — while the rebuilt catalogue and
         * prompt are what keep the model from believing it still cannot write. Nothing is *granted* here that
         * was not granted by a human a moment ago: `exit_plan_mode` is the only writer of the planning component's
         * pending approval. It writes only after the question came back approved (I8: an effect is a fact the log or
         * a person established, not something inferred from what a tool intended).
         */
        const approved = planning?.takeApproval();
        if (approved) {
          readOnly = false;
          planNotice =
            '\n\nApproved plan (approved by the user during this run; carry it out in this session and report deviations):\n' +
            JSON.stringify({
              title: approved.title,
              summary: approved.summary,
              steps: approved.steps.map((step) => step.description),
            }) +
            '\nRead-only mode is over for this run: your write and command tools are available again, and each of them still asks for its own approval.';
          runSystem = composeSystem();
          const rebuilt = buildCatalog();
          specs = rebuilt.specs;
          catalogSpecs = rebuilt.catalog;
          // The delegation guard was built with this run's original promise; a run that may now write may also
          // delegate work that writes, so the coordinator is told rather than left refusing a general child.
          coordinator?.promoteToWritable();
        }
        // Opened before the round does anything at all, so a step that dies while its request is still being
        // built is a step the log names. A run cancelled before its first step opens none, which is the honest
        // answer: no work had begun.
        store.recordEvent(input.sessionId, 'step.started', { runId, step: round });
        openStep = round;
        stepStartedAt = performance.now();
        stepFirstTokenAt = null;
        /**
         * The lease is renewed at every step boundary: this run is still the session's writer, and the number
         * is what lets a refusal elsewhere say when the owner last did anything. Nothing is decided by how old
         * a renewal is — see `SessionLease` — so this cannot make a run's own survival depend on a timer.
         */
        store.renewLease(input.sessionId, runId);
        while (consume('steer')) {
          /* deliver all corrections before the next request */
        }
        // The round preamble. Policy gets to see the round before the request is built, and its
        // context contributions are persisted user messages: a pre-step hook can refuse the run or
        // add model-visible context, but it cannot put text in front of the model that the transcript
        // would not show (I7).
        const preStep = await tools.extensions.preStep(
          {
            sessionId: input.sessionId,
            runId,
            round,
            messages: store.messages(input.sessionId),
            // What the round would use if no hook re-aims it. A policy that means "keep the run's model" reads it
            // here rather than hardcoding a name, which is what makes "only downgrade the cheap rounds"
            // expressible without the policy owning the default.
            //
            // The aim is *per round*: it starts from the run's own values every time, never from what the round
            // before it chose. A policy that wants a model for several rounds says so each round — which is the
            // only version of this that stays readable, because the alternative is a state nobody declared.
            model: configuredModel ?? '',
          },
          signal,
        );
        if (preStep.blocked) throw new StepBlockedError(preStep.blocked);
        /**
         * The model and effort this round's request will actually use.
         *
         * A re-aimed round changes how the run spends money, so the change is recorded — and *only* the change,
         * because the transition is the interesting fact: a run on its configured model writes nothing, a run
         * that switches writes one row where it switches, and a policy that switches back writes one more. The
         * row carries the model itself, so a reader does not have to know the run's configuration to read it.
         */
        const aimed = preStep.model.trim() || null;
        /**
         * The override to send, which is *not* the same thing as the model the round uses.
         *
         * When nothing re-aims the round the request carries no model at all, and the adapter uses the model
         * its own configuration names. That is not a detail: what the kernel holds is `modelInfo.model`, a
         * label prepared for display, so sending it as the model would be a guess at somebody else's
         * configuration. Only a policy that names a model puts one on the wire.
         */
        const requestedModel = aimed === configuredModel ? null : aimed;
        // `none` is how a hook takes a level back, so by the time the request is built it means exactly what
        // "no effort was named" means: no reasoning parameter at all.
        const requestedEffort =
          preStep.reasoningEffort === 'none' ? undefined : preStep.reasoningEffort;
        const effectiveModel = requestedModel ?? configuredModel;
        if (
          effectiveModel !== null &&
          (effectiveModel !== previousModel || requestedEffort !== previousEffort)
        ) {
          const shape = {
            runId,
            round,
            model: effectiveModel,
            ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
          };
          store.recordEvent(input.sessionId, 'llm.request', shape);
          emit('llm.request', shape);
        }
        previousModel = effectiveModel;
        previousEffort = requestedEffort;
        // The state the round is about to be asked about, before the round's own injections: a policy note is a
        // message to the model, while a snapshot is the world it is being asked about.
        announceSnapshots(round);
        if (preStep.inject.length) {
          const content = preStep.inject.join('\n\n');
          store.append(input.sessionId, { role: 'user', content });
          emit('context.injected', {
            source: 'pre-step',
            round,
            notes: preStep.inject.length,
            content,
          });
        }
        /**
         * How this round's context is built, kept as a value so a provider-confirmed overflow can rebuild it
         * once with a forced compression without repeating — or drifting from — the way it was built.
         */
        /**
         * The cache key of a request, as a function of that request.
         *
         * The route is resolved here rather than once before the loop, because the model it names can change from
         * round to round: an entry belongs to the model that served it, and two models sharing a key would read
         * each other's cache. The prompt is an argument rather than a captured value because the prompt is not a
         * constant of the run — approving a plan mid-run adds the tools that write and rebuilds it — and a key
         * taken from the prompt the round began with names a prefix nobody was sent.
         *
         * Handed to `prepareContext` as well, so the summary request it makes carries the key of the prefix that
         * request actually replays, rather than of the compressed round it is compressing for.
         */
        const cacheKeyOf = (systemText: string, toolSpecs: readonly ToolSpec[]): string =>
          cacheKeyFor(
            this.options.modelInfo === undefined
              ? undefined
              : {
                  ...this.options.modelInfo,
                  model: effectiveModel ?? this.options.modelInfo.model,
                },
            systemText,
            toolSpecs,
          );
        /** The model this round aims at, when one is named at all: `null` means the embedder declared none. */
        const aimedModel = effectiveModel ?? configuredModel;
        /**
         * The capacity of the route this round will actually use.
         *
         * Resolved per round, after the pre-step waterfall has had its say about the model, because a re-aimed
         * round is measured against the window of the model that will serve it. The run's own window remains
         * the answer when the host has no opinion about this model — a resolver that shrugs is not a licence to
         * invent a window.
         */
        const resolved =
          effectiveModel === null ? undefined : this.options.capacityFor?.(effectiveModel);
        const roundContextTokens = resolved?.contextWindow ?? maxContextTokens;
        const roundOutputTokens = resolved?.maxOutputTokens ?? maxOutputTokens;
        const contextInput: Parameters<typeof prepareContext>[0] = {
          store,
          sessionId: input.sessionId,
          system: runSystem,
          tools: specs,
          provider: summaryProvider,
          limit: limits.maxContextChars,
          signal,
          maxOutputTokens: roundOutputTokens,
          maxContextTokens: roundContextTokens,
          autoCompactTokens: this.options.autoCompactTokens,
          summaryTimeoutMs: limits.summaryTimeoutMs,
          onSummaryRetry: (details) => emit('context.summary.retry', details),
          // The summary request replays the prefix of the prompt it is given, so it asks for the key of *that*
          // prompt: without a key the provider places no cache breakpoint at all, and the replay would be
          // byte-identical and unread.
          cacheKeyFor: cacheKeyOf,
          calibration,
          // The run this compaction is for: it is what the session's write lease is checked against, before the
          // summary request and again at the write.
          runId,
          /**
           * A compression this round cannot produce is reported, not fatal.
           *
           * The estimate that decided to compress is a character heuristic, and the endpoint is the authority on
           * whether a request fits: a run that died here never reached `recoverFromOverflow`, which is the path
           * that answers a *provider-confirmed* refusal by compressing harder. So the round is sent as it stands
           * with the reason attached, and the provider's own verdict — accepted, or refused for size — is what
           * the user finally sees.
           */
          compactionFailure: 'send',
          // The model this round aims at, so a compaction records which one produced the summary. Absent when the
          // embedder declared none, which the record then does not claim to know. The provider is recorded beside
          // it for the same reason: a summary is a model answer, and the model name alone does not say which
          // adapter it came back over.
          ...(aimedModel === null ? {} : { model: aimedModel }),
          ...(this.options.modelInfo?.protocol === undefined
            ? {}
            : { protocol: this.options.modelInfo.protocol }),
          // Shortening needs somewhere to put the full text. Without a spill seam nothing is shortened: a
          // shortened result whose "read it here" path does not exist is worse than a long result.
          shrink: {
            policy: { keepRecent: toolResultKeepRecent, tokens: toolResultShrinkTokens },
            spill: ({ message, content }) =>
              spillResult({
                workspace,
                sessionId: input.sessionId,
                key: message.role === 'tool' ? message.toolCallId : 'message',
                content,
              }),
            /**
             * The round's own price for text, which is what turns the policy's token budget into a character cut.
             *
             * A tool message rather than the raw string: that is the shape the estimator prices everywhere else,
             * images and protocol margin included, and building it here means "shortened to a 400-token budget"
             * and "this request is 4,000 tokens over" are answers from the same arithmetic.
             */
            measure: (text) =>
              estimateMessageTokens(
                { role: 'tool', toolCallId: '', content: text, isError: false },
                calibration?.factor ?? 1,
              ),
          },
          shrinkPercent: contextShrinkPercent,
          /**
           * Dropping the middle of an oversized result needs nothing from the host, so this seam is mounted
           * unconditionally: no spill target to write to, no calibrated measure to convert a budget with, and no
           * workspace to reach. It is what keeps a session bounded in the cases the shortening seam declines —
           * a read-only workspace, a full disk, or a spill directory that is gone.
           */
          prune: {
            policy: {
              thresholdChars: toolResultPruneThresholdChars,
              headChars: toolResultPruneHeadChars,
              tailChars: toolResultPruneTailChars,
            },
            keepRecent: toolResultKeepRecent,
          },
          prunePercent: contextShrinkPercent,
          onUsage: (response) => {
            usage.inputTokens += response.usage.inputTokens;
            usage.outputTokens += response.usage.outputTokens;
            /**
             * The cache fields belong here too, or the result lies by omission.
             *
             * `statistics` gets them through `addUsage`, but this object is what `RunResult.usage` carries — on
             * the wire, in `--json`, into the persisted run row, and into a reader like the CLI's usage line.
             * Hand-summing two fields silently dropped what the provider reported: a fixture whose
             * `cache_read_input_tokens` moved the input total to 200 arrived at the result with
             * `cachedInputTokens` undefined. "Unreported" stays unreported (`?? 0` on the accumulator, the field
             * only exists once something reported it) — the same rule `statistics.ts` keeps with `cacheKnown`.
             */
            if (response.usage.cachedInputTokens !== undefined)
              usage.cachedInputTokens =
                (usage.cachedInputTokens ?? 0) + response.usage.cachedInputTokens;
            if (response.usage.cacheWriteInputTokens !== undefined)
              usage.cacheWriteInputTokens =
                (usage.cacheWriteInputTokens ?? 0) + response.usage.cacheWriteInputTokens;
          },
          onCompaction: (state, coveredMessages, summaryUsage) => {
            if (state === 'finished' && summaryUsage) addUsage(committedSummaryUsage, summaryUsage);
            emit(state === 'started' ? 'context.compacting' : 'context.compacted', {
              coveredMessages,
            });
          },
        };
        let context = await prepareContext(contextInput);
        signal.throwIfAborted();
        /**
         * What this round asked the model to read, recorded as the round is decided on it.
         *
         * The envelope is `context.system` rather than the compose step's own text, and that is not a detail:
         * `prepareContext` is free to change what it is given — it is the call that decides whether to compress, and
         * that decision can rewrite the prompt — so the prompt the request carries is only knowable after it. A
         * record taken earlier would name a prompt nobody was ever sent.
         *
         * Once per round, plus once more when a provider-confirmed overflow re-prepares the context and re-sends
         * under a different summary — that round really did send two envelopes, and the log says so rather than
         * keeping only the first. Retries are deliberately not recorded again: they re-send the same request, so
         * a second record would be a second answer to a question that has one.
         */
        const recordEnvelope = (prepared: PreparedContext): void => {
          const written = envelopeEvent({
            runId,
            round,
            system: prepared.system,
            tools: specs,
            model: effectiveModel ?? configuredModel,
            maxOutputTokens: roundOutputTokens,
            ...(roundContextTokens === undefined ? {} : { maxContextTokens: roundContextTokens }),
            // The key belongs to the request, so the record keeps the one this request carries: it is part of what
            // the request was, not a transport detail. Taken from the prompt being recorded rather than from the
            // one the round began with — `prepareContext` may rewrite the prompt it is handed, and only the prompt
            // it returned is the one the request will carry.
            cacheKey: cacheKeyOf(prepared.system, specs),
            ...(lastEnvelopeSystemHash === undefined
              ? {}
              : { previousSystemHash: lastEnvelopeSystemHash }),
            ...(lastEnvelopeToolsHash === undefined
              ? {}
              : { previousToolsHash: lastEnvelopeToolsHash }),
          });
          lastEnvelopeSystemHash = written.systemHash;
          lastEnvelopeToolsHash = written.toolsHash;
          store.recordEvent(input.sessionId, 'context.envelope', { ...written.envelope });
        };
        recordEnvelope(context);
        /**
         * The resolved limit, not the raw option: `resolveRunLimits` is what decides whether an operator asked
         * for a total wall-clock limit at all, and reading `this.options` here made the answer depend on
         * whether the value came from a CLI flag or from the defaults — the one number `RunDefaults` owned in
         * two places. There is no default for the main request (a streaming model is making progress; the
         * stream idle timeout is what catches a stalled one), so this is `undefined` unless a limit was set.
         */
        const requestSignal = limits.requestTimeoutMs
          ? AbortSignal.any([signal, AbortSignal.timeout(limits.requestTimeoutMs)])
          : signal;
        const messageId = `${runId}:${round}`;
        emit('message.started', { messageId });
        let streamedText = '';
        /**
         * This round's reasoning, on its own accumulator.
         *
         * It is kept apart from `streamedText` everywhere — it is not the answer, so it never becomes
         * `RunResult.text`, never goes back to a provider, and never enters the stream checkpoint (an
         * interrupted turn preserves what the user can read; half a thought is not that). It is discarded
         * whole when an attempt is thrown away, so what is stored is the reasoning of the attempt whose
         * answer was stored.
         */
        let streamedReasoning = '';
        let checkpointChars = 0;
        let checkpointAt = 0;
        /**
         * Captured before the request so the provider's reported usage can be compared against the uncorrected
         * estimate that admitted this exact request. A recovered round reassigns both, so the calibration
         * always sees the request that was actually answered rather than the one that was refused.
         */
        let rawInputEstimate = 0;
        /** The sizes that estimate was assembled from, so the endpoint's answer can be read per part. */
        let roundBytes: { system: number; tools: number; messages: number } | undefined;
        let requestOutputLimit = 0;
        /**
         * How many recoveries from a provider-confirmed context overflow this round has spent.
         *
         * The allowance comes from the compaction policy the round resolved — one attempt by default, because a
         * conversation that still does not fit after the most aggressive compression available cannot be made to
         * fit by repeating the same decision.
         */
        let overflowAttempts = 0;
        let lastCompactionProblem = context.compactionProblem;
        /**
         * Take back the reasoning the user has already seen.
         *
         * Reasoning is streamed live (see `message.reasoning`), so an attempt that is thrown away has to take
         * its thinking with it: otherwise a re-sent round would leave the folded block showing two attempts'
         * reasoning as one, and the live view would disagree with the message that gets stored. The frame is a
         * reset rather than a correction because a client cannot un-know deltas it has already rendered.
         */
        const resetReasoning = (): void => {
          if (!streamedReasoning) return;
          streamedReasoning = '';
          emit('message.reasoning', { messageId, text: '', reset: true });
        };
        /**
         * Compress the conversation once more, and report whether the round should be sent again.
         *
         * `compacted: false` is the answer that decides it: it means there was no boundary left to compress,
         * so the re-sent request would be byte-for-byte the one that just failed and the original failure
         * stands. Every caller requires an empty `streamedText` first, so the retry can never duplicate output
         * the user has already seen.
         */
        const recoverFromOverflow = async (): Promise<boolean> => {
          if (overflowAttempts >= (context.maxOverflowRetries ?? 1)) {
            // The retry was refused as well. Reporting it is the point: an operator reading this run's stream
            // sees both the compression that was tried and the refusal that outlived it.
            emit('context.overflow', {
              round,
              recovered: false,
              coveredMessages: store.contextSurface(input.sessionId)?.coveredMessages ?? 0,
            });
            return false;
          }
          overflowAttempts++;
          const before = store.contextSurface(input.sessionId)?.coveredMessages ?? 0;
          let forced: PreparedContext | undefined;
          try {
            forced = await prepareContext({ ...contextInput, forceCompact: true });
          } catch (cause) {
            // Compression cannot always even be attempted — a conversation with a single message has no
            // boundary to compress at, and says so by refusing. That is not a second failure to report: it is
            // the answer that the request has to stand as it is, so the provider's own failure is what the
            // user sees.
            forced = undefined;
            lastCompactionProblem = cause instanceof Error ? cause.message : String(cause);
          }
          const coveredMessages = store.contextSurface(input.sessionId)?.coveredMessages ?? before;
          if (!forced?.compacted) {
            lastCompactionProblem = forced?.compactionProblem ?? lastCompactionProblem;
            emit('context.overflow', { round, recovered: false, coveredMessages });
            return false;
          }
          context = forced;
          lastCompactionProblem = undefined;
          // The re-send carries a different envelope — the forced compression changed the summary the request
          // opens with — so this round writes a second record rather than leaving the log claiming it sent the
          // prompt that was refused.
          recordEnvelope(forced);
          emit('context.overflow', { round, recovered: true, coveredMessages });
          // The attempt that was refused is discarded whole. Its reasoning was already streamed, so the
          // reset goes out too: otherwise the folded block would show two attempts' thinking as one, and
          // the live view would disagree with the message that gets stored.
          resetReasoning();
          // Durable, because it is a decision about the conversation that no checkpoint explains: the
          // compression is recorded, "the provider refused this for size and we answered by compressing" is not.
          store.recordEvent(input.sessionId, 'context.overflow', {
            round,
            recovered: true,
            coveredMessages,
          });
          return true;
        };
        /**
         * Send this round, answering a context overflow once and a transient failure as often as the retry
         * allowance for this round permits.
         *
         * This is the step boundary the retries belong to, and moving them here from the transport is what makes
         * them worth having. The transport could only ever see an HTTP status before the stream started, could
         * not retry a stream that broke mid-flight, left nothing in the record, and forgot its count when the
         * process did. Here the same decision covers a broken stream, the count is a row in the log that the
         * next process reads back, and the wait is cancelled by the same Stop that cancels everything else.
         *
         * Two rules keep a retry from costing more than it buys:
         *
         * - **Nothing has been shown yet.** A retry re-sends the request, so any text the user already saw
         *   would be shown twice — the same rule the overflow recovery follows, extended to reasoning, because
         *   reasoning is displayed too.
         * - **The failure is transient by nature** (`retryable`), never a failure that describes the run's own
         *   room or the request's content: re-sending those buys the same answer at full price.
         */
        const retryRequest = async (cause: unknown): Promise<boolean> => {
          const code = failureCodeOf(cause);
          if (!retryable(code)) return false;
          const attempts = store.retryCount(runId, round);
          if (attempts >= limits.maxModelRetries) return false;
          const waitMs = retryDelayMs(
            attempts + 1,
            cause instanceof RunFailure ? cause.retryAfterMs : undefined,
          );
          // The endpoint's own cooldown is never shortened; one longer than we are willing to hold a round
          // open is not retried at all, because the alternative is ignoring what it asked for.
          if (waitMs > RETRY_MAX_WAIT_MS) return false;
          const retry = {
            runId,
            round,
            attempt: attempts + 1,
            max: limits.maxModelRetries,
            code,
            waitMs,
          };
          /**
           * Recorded before the wait, so the record and the count are the same fact: an attempt that is already
           * written down is one the next process will not make again, whether this one survives the wait or not.
           */
          store.recordEvent(input.sessionId, 'llm.retry', retry);
          emit('llm.retry', retry);
          const waitStarted = performance.now();
          try {
            await delay(waitMs, undefined, { signal: requestSignal });
          } catch (error) {
            /**
             * A cancelled wait reports *why* it was cancelled, not that a timer was cancelled.
             * `timers/promises` rejects with its own `AbortError`, which would make a request-deadline abort
             * during the backoff look like an anonymous failure; the signal's own reason is either the
             * timeout that fired or the Stop that arrived, and both are things the run can name.
             */
            requestSignal.throwIfAborted();
            throw error;
          } finally {
            (statistics.requestTiming ??= emptyRequestTiming()).retryWaitMs += Math.max(
              0,
              performance.now() - waitStarted,
            );
          }
          return true;
        };
        const sendRequest = async (): Promise<ModelResponse> => {
          for (;;) {
            /**
             * The numbers this attempt was decided on, reported so a client and an operator see the same
             * prediction the run acted on — not a recomputation that may disagree with it. A round that
             * recovered reports the prediction it was re-sent with.
             */
            emit('context.forecast', {
              round,
              inputTokens: context.forecast.inputTokens,
              rawInputTokens: context.forecast.rawInputTokens,
              outputTokens: context.forecast.outputTokens,
              windowRoom: context.forecast.windowRoom,
              // What the estimate is made of. "The request is too big" is not actionable on its own: a catalog
              // of tool schemas can cost more than the conversation, and this is the number that says so.
              breakdown: context.forecast.breakdown,
              shortened: context.shortened,
              freedChars: context.freedChars,
              // Reported beside the shortening pair rather than folded into it: the two are different bargains —
              // a pointer to the full text, or the middle gone with nothing to read back — and an operator
              // reading a round that made the conversation smaller needs to know which one it got.
              pruned: context.pruned,
              prunedChars: context.prunedChars,
              compacted: context.compacted,
              // Why proactive compression is off for this route, when it is: a window that cannot carry the
              // request's output reservation plus the headroom is a configuration mistake, and a reader of the
              // stream should see that rather than wonder why a small window never compressed.
              ...(context.policyProblem === undefined
                ? {}
                : { policyProblem: context.policyProblem }),
              // Why the request cannot be sent, when it cannot: without it the stream shows numbers the reader
              // has to compare by hand to learn the same one word.
              ...(context.forecast.problem === undefined
                ? {}
                : { problem: context.forecast.problem }),
            });
            /**
             * A request the estimate says does not fit is still sent — unless the estimate is far past the window.
             *
             * The run is the caller that knows what "does not fit" means, and the answer used to be "fail here",
             * which made a heuristic the authority on somebody else's endpoint: an uncalibrated estimate can be
             * wrong by the width of its own clamp. `hopelessForWindow` is where that stops being plausible, and
             * everything under it is sent: the endpoint answers, or refuses for size and the round compresses and
             * re-sends. The round is told why it is uncompressed through `compactionProblem` in the frame above.
             */
            if (context.forecast.problem && hopelessForWindow(context.forecast, roundContextTokens))
              throw new ContextLimitError(
                context.compactionProblem
                  ? 'Context compaction failed: ' +
                      context.compactionProblem +
                      '; ' +
                      WINDOW_EXHAUSTED
                  : WINDOW_EXHAUSTED,
              );
            rawInputEstimate = context.forecast.rawInputTokens;
            roundBytes = context.forecast.bytes;
            requestOutputLimit = context.forecast.outputTokens;
            let attempt: ModelResponse;
            /**
             * While the request is in flight the run is working, and the lease says so.
             *
             * The renewal is on a timer rather than only at the boundaries around this request because a model
             * call can take minutes: without it a healthy run would look idle for the whole of it. It decides
             * nothing — the timer cannot expire anything, and `LEASE_RENEW_INTERVAL_MS` is not a timeout.
             */
            const renewing = setInterval(
              () => store.renewLease(input.sessionId, runId),
              LEASE_RENEW_INTERVAL_MS,
            );
            renewing.unref?.();
            try {
              admitVisibleBackground(store, input.sessionId, context.system);
              attempt = await measuredProvider.complete({
                system: context.system,
                messages: context.messages,
                tools: specs,
                // The key of the request this is, from the prompt this request carries — see `cacheKeyOf`.
                cacheKey: cacheKeyOf(context.system, specs),
                ...(requestedModel === null ? {} : { model: requestedModel }),
                ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
                signal: requestSignal,
                maxOutputTokens: requestOutputLimit,
                onText: (delta) => {
                  // Only text about to become a message.delta is a visible first token. Internal
                  // summaries share the measured provider but never enter this callback.
                  if (stepFirstTokenAt === null && delta.length && stepStartedAt !== null) {
                    stepFirstTokenAt = performance.now();
                    statistics.firstTokenMs += Math.max(0, stepFirstTokenAt - stepStartedAt);
                    statistics.firstTokenCount += 1;
                  }
                  streamedText += delta;
                  if (
                    delta &&
                    (!checkpointChars ||
                      streamedText.length - checkpointChars >= 256_000 ||
                      performance.now() - checkpointAt >= 2_000)
                  ) {
                    store.checkpointStream(input.sessionId, runId, messageId, streamedText);
                    checkpointChars = streamedText.length;
                    checkpointAt = performance.now();
                  }
                  emit('message.delta', { messageId, text: delta });
                },
                onReasoning: (delta) => {
                  streamedReasoning += delta;
                  emit('message.reasoning', { messageId, text: delta });
                },
              });
            } catch (cause) {
              // A refused request is recoverable only while nothing has been shown: once text has streamed,
              // compressing and re-sending would show the beginning of the turn to the user twice.
              if (!streamedText && isContextWindowExceeded(cause)) {
                if (await recoverFromOverflow()) continue;
                if (lastCompactionProblem)
                  throw new RunFailure(
                    'context-window-exceeded',
                    'Provider context window exceeded; context compaction failed: ' +
                      lastCompactionProblem,
                    {
                      cause,
                      ...(cause instanceof RunFailure
                        ? {
                            httpStatus: cause.httpStatus,
                            requestId: cause.requestId,
                            retryAfterMs: cause.retryAfterMs,
                          }
                        : {}),
                    },
                  );
              }
              // A transient failure is re-sent under the same rule, and for the same reason.
              if (!streamedText && (await retryRequest(cause))) {
                /**
                 * Only `streamedText` blocks a retry. Reasoning that was displayed belongs to the attempt being
                 * discarded, and the frame that takes it back already exists — the overflow recovery sends it —
                 * so a round whose endpoint failed after thinking aloud is retried rather than abandoned. The
                 * guard used to be `!streamedReasoning` as well, which turned "the endpoint streamed a thought
                 * and then broke" into a failed run that had produced no answer at all.
                 */
                resetReasoning();
                continue;
              }
              // An interrupted stream may have shown useful text before the provider failed. Preserve
              // exactly those visible deltas, but never persist or execute incomplete tool calls.
              if (streamedText) {
                text = streamedText;
                const message: Message = {
                  role: 'assistant',
                  content: streamedText,
                  toolCalls: [],
                  interrupted: true,
                  ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
                };
                store.appendStreamMessage(input.sessionId, runId, messageId, message);
                emit('message.finished', { messageId, message });
              }
              throw cause;
            } finally {
              clearInterval(renewing);
            }
            // The same overflow also arrives as a terminal stop reason, on a stream that produced no text.
            if (
              attempt.finishReason === 'length' &&
              attempt.truncation === 'context-window' &&
              !streamedText
            ) {
              if (await recoverFromOverflow()) continue;
              if (lastCompactionProblem)
                throw new ContextLimitError(
                  'Provider context window exceeded; context compaction failed: ' +
                    lastCompactionProblem,
                );
            }
            /**
             * A turn that carried nothing at all goes through the same retry decision as a broken stream.
             *
             * Where this is judged is the whole point. It used to be judged after `sendRequest` had returned,
             * which put it outside the retry path entirely: `empty-response` was in the retry table but no
             * failure could reach it, so an endpoint that closed a turn with an empty body ended the run where a
             * transport hiccup on the same request would have been re-sent for free.
             *
             * "Nothing at all" is the test, and it is deliberately wider than the envelope. Text, tool calls,
             * streamed text and streamed reasoning all count as something: a thinking model that answered only
             * in its reasoning channel has still answered, and re-sending it would spend the request again to
             * throw away the thought the user is reading. What is left is a turn that produced no text, no call
             * and no thought, which is a hiccup rather than an answer whatever the finish reason says — and
             * because `carried` is false, nothing has been shown to the user, so a re-send cannot duplicate
             * output. A `length` turn is not judged here at all: the two branches around this one own it.
             */
            const carried =
              attempt.toolCalls.length > 0 ||
              attempt.text.trim() !== '' ||
              streamedText !== '' ||
              streamedReasoning !== '';
            if (!carried && attempt.finishReason !== 'length') {
              const empty = new RunFailure(
                'empty-response',
                attempt.finishReason === 'tool_calls'
                  ? 'Provider returned an empty tool-call turn'
                  : 'Provider returned a turn with no content',
              );
              if (await retryRequest(empty)) continue;
              throw empty;
            }
            return attempt;
          }
        };
        const response = await sendRequest();
        /**
         * What the endpoint billed, read as evidence about each part.
         *
         * One total, but the round knows how that total was assembled — the system prompt, the catalogue and the
         * conversation, in bytes — so the residual is attributed to the parts by their share of it. That is what
         * lets a route whose catalogue is overestimated and whose conversation is underestimated end up with two
         * weights pointing in opposite directions instead of one average that is wrong for both.
         */
        calibration.observe(
          rawInputEstimate,
          response.usage.inputTokens,
          rawInputEstimate > 0 ? roundBytes : undefined,
        );
        /**
         * The measurement is durable, because it is about the endpoint rather than about this run.
         *
         * Written per observed round rather than once at the end: a run that is stopped, crashes or is cancelled
         * keeps what it had already learned, which is the whole reason the reading half exists. Rounds that reported
         * no usable usage are already filtered out by `observe` — the state simply does not move for them — so this
         * records the value that was in force for the round, which is what a reader asking "what correction was
         * this round sized against" needs. The anchor travels with it: the estimate this round was sized from and
         * the usage that came back are the two numbers that make the correction checkable rather than merely
         * present.
         */
        if (calibrationRouteKey !== undefined)
          store.recordEvent(input.sessionId, 'context.calibration', {
            route: calibrationRouteKey,
            factor: calibration.factor,
            samples: calibration.observed,
            parts: calibration.parts,
            anchor: {
              rawEstimate: rawInputEstimate,
              reportedInputTokens: response.usage.inputTokens,
            },
          });
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        // The cache fields ride along, for the reason spelled out on the context builder's `onUsage`: this hand
        // sum is what `RunResult.usage` is made of, and dropping them made the result under-report what the
        // provider said — a run whose input was mostly a cache hit arrived looking like it paid for all of it.
        if (response.usage.cachedInputTokens !== undefined)
          usage.cachedInputTokens =
            (usage.cachedInputTokens ?? 0) + response.usage.cachedInputTokens;
        if (response.usage.cacheWriteInputTokens !== undefined)
          usage.cacheWriteInputTokens =
            (usage.cacheWriteInputTokens ?? 0) + response.usage.cacheWriteInputTokens;
        if (response.finishReason === 'length') {
          // The text already reached the client through message.delta. Persist it before failing so
          // the stored transcript and RunResult.text match what the user actually saw, instead of
          // the answer appearing and then vanishing when the UI rebuilt from history. Any partial
          // tool calls in a truncated turn are deliberately dropped: they were never executed.
          text = response.text;
          if (text.trim()) {
            store.appendStreamMessage(input.sessionId, runId, messageId, {
              role: 'assistant',
              content: text,
              toolCalls: [],
              interrupted: true,
              ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
            });
            emit('message.finished', {
              messageId,
              message: {
                role: 'assistant',
                content: text,
                toolCalls: [],
                interrupted: true,
                ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
              },
              usage: response.usage,
            });
          }
          // A truncated answer is still an answer: it assembled a message, so the step spent what it spent.
          commitStepTiming(response);
          const details = response.outputDiagnostics;
          const breakdown = [
            String(response.usage.outputTokens) +
              '/' +
              String(requestOutputLimit) +
              ' output tokens',
            ...(details?.reasoningTokens === undefined
              ? []
              : [String(details.reasoningTokens) + ' reasoning tokens']),
            ...(details?.reasoningChars
              ? [String(details.reasoningChars) + ' reasoning characters']
              : []),
            String(details?.visibleChars ?? text.length) + ' visible characters',
            ...(details?.toolArgumentChars
              ? [String(details.toolArgumentChars) + ' tool argument characters']
              : []),
          ];
          throw new LimitError(
            'output-limit',
            'Model output limit reached (' +
              breakdown.join(', ') +
              '); partial tool calls were not executed',
          );
        }
        const ids = new Set<string>();
        for (const call of response.toolCalls) {
          if (!call.id || ids.has(call.id)) throw new Error('Invalid or duplicate tool call ID');
          ids.add(call.id);
        }
        // A turn that carried nothing was already refused inside `sendRequest`, where the retry decision could
        // see it; what is left here is the envelope contradicting itself, which no re-send can repair.
        if (response.finishReason === 'stop' && response.toolCalls.length > 0)
          throw new Error('Provider stop reason conflicts with tool calls');
        text = response.text;
        store.appendStreamMessage(input.sessionId, runId, messageId, {
          role: 'assistant',
          content: text,
          toolCalls: response.toolCalls,
          ...(response.providerState ? { providerState: response.providerState } : {}),
          ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
        });
        emit('message.finished', {
          messageId,
          // `providerState` stays out of the event — it is the protocol's business, not the client's — while
          // the reasoning is in it, because the folded block is exactly what the client has to render.
          message: {
            role: 'assistant',
            content: text,
            toolCalls: response.toolCalls,
            ...(streamedReasoning ? { reasoning: streamedReasoning } : {}),
          },
          usage: response.usage,
        });
        // The step's spans close here, with the answer that ends it: the rounds that returned before this
        // point — a refused request the round recovered from — assembled nothing and are already accounted
        // for by the step's own start, so no attempt can be charged twice.
        commitStepTiming(response);
        // An abort after the provider's terminal event must keep the completed text while still
        // refusing to execute any pending tool call.
        signal.throwIfAborted();
        if (response.toolCalls.length === 0) {
          if (queue.hasSteer || consume('follow-up')) {
            endStep(round, 'queued-input');
            continue;
          }
          status = 'completed';
          if (task && taskAttempt) {
            if (store.hasPendingTaskEffects(input.sessionId, task.id, taskAttempt.id)) {
              status = 'needs_review';
              error = 'Task side effect outcome unknown; inspect state before retrying.';
              endStep(round, 'final');
              break;
            }
            taskVerification = await verifyTaskAcceptance(
              workspace,
              task,
              baselines,
              signal,
              async (approval, approvalSignal) => {
                const allowed = await approveTool(approval, approvalSignal);
                if (allowed) {
                  acceptanceEffects.set(
                    approval.toolCall.id.slice('acceptance:'.length),
                    store.beginTaskEffect(
                      input.sessionId,
                      task.id,
                      taskAttempt.id,
                      approval.toolCall.name,
                    ),
                  );
                }
                return allowed;
              },
            );
            acceptance = taskVerification.evidence;
            if (!taskVerification.passed) {
              status = 'needs_review';
              error = taskVerification.error;
            }
          }
          endStep(round, 'final');
          break;
        }
        const injected: { callId: string; notes: string[] }[] = [];
        const changedGoals: Goal[] = [];
        // The tool calls are about to run. The message that names them is written first, so a crash while a
        // tool is in flight leaves the record that lets recovery report its outcome as unknown rather than
        // letting the call be replayed as if it had never happened. Everything the round appends after this
        // point is written as one batch by the next read or by the end of the run.
        store.flush(input.sessionId);
        /**
         * One call, from its own effect journal entry to its own tool result.
         *
         * `effectId` is per invocation rather than shared, because two calls of the same batch can be in
         * flight at once once the group scheduler below overlaps them: a single `let` would let the second
         * call's journal entry overwrite the first one's, and a task would then be told an effect completed
         * that it never recorded.
         */
        const queuedClock = performance.now();
        const queuedAt = Date.now();
        let activeExecutions = 0;
        let peakConcurrency = 0;
        const toolTimings = new Map<
          string,
          {
            queuedAt: number;
            queueMs: number;
            dispatchMs: number;
            durationMs: number;
            attempts: number;
            finishedAttempts: number;
            dispatchStartedAt?: number;
            dispatchFinishedAt?: number;
            executionStartedAt?: number;
            executionFinishedAt?: number;
          }
        >(
          response.toolCalls.map((call) => [
            call.id,
            {
              queuedAt,
              queueMs: 0,
              dispatchMs: 0,
              durationMs: 0,
              attempts: 0,
              finishedAttempts: 0,
            },
          ]),
        );
        const runToolCall = async (call: ToolCall) => {
          const timing = toolTimings.get(call.id)!;
          const dispatchClock = performance.now();
          timing.queueMs = Math.max(0, dispatchClock - queuedClock);
          timing.dispatchStartedAt = Date.now();
          try {
            let effectId: string | undefined;
            const programEffects = new Map<string, string>();
            /**
             * The context one call runs in — and the one an *inner* call runs in.
             *
             * A `run_code` program is not a second kind of tool call: it reaches its tools through this function
             * and this registry, one call at a time, carrying the run's own signal, approval seam, journals and
             * policy. So an inner write is approved by the same person, blocked by the same read-only promise,
             * bounded by the same deadline and recorded in the same file journal as a write the model asked for
             * directly. The inner id is derived from the outer one (`<outer>#<n>`) rather than freshly generated,
             * because what has to survive every seam is the link between a program and what it did.
             */
            const toolContext = (callId: string): ToolContext => ({
              signal,
              /**
               * The call's identity and its run's promise. A policy hook that reports about a call has to be
               * able to name the session, and one that would touch the world outside this process has to be
               * able to see that this run promised not to.
               */
              sessionId: input.sessionId,
              workspaceRoot: workspace,
              readOnly,
              ...(executionPolicy ? { executionPolicy } : {}),
              /**
               * The policy *getters*, so a call can be judged by the policy in force when it runs.
               *
               * `executionPolicy` above is the snapshot this round was built with — what the prompt and the tool
               * schema describe — and a snapshot is the right shape for those. It is the wrong shape for a call
               * that has been waiting: the desktop can switch the sandbox while an approval is open, and the
               * command that finally runs has to run in the backend that is selected *now*, not the one that was
               * selected when the model asked. The tool layer reads these per call and rechecks execution.
               */
              ...(this.options.executionPolicy
                ? { executionPolicyForCall: this.options.executionPolicy }
                : {}),
              ...(this.options.permissionPolicy
                ? { permissionPolicyForCall: this.options.permissionPolicy }
                : {}),
              // Output too large for a result goes to this session's spill directory. The run supplies it
              // because the run is what knows the session and, through it, the workspace the file belongs in.
              spill: ({ tool, content }) =>
                spillOutput({ workspace, sessionId: input.sessionId, tool, content }),
              ...(taskEffectScope
                ? {
                    effectJournal: {
                      begin: (effectCall: ToolCall) => {
                        effectId = store.beginTaskEffect(
                          taskEffectScope.sessionId,
                          taskEffectScope.taskId,
                          taskEffectScope.attemptId,
                          effectCall.name,
                        );
                      },
                    },
                  }
                : {}),
              fileJournal: {
                prepare: (change, before, after) =>
                  store.prepareFileChange(journalSessionId, tagChange(change), before, after),
                prepareGroup: (change, files) =>
                  store.prepareFileChangeGroup(journalSessionId, tagChange(change), files),
                applied: (id) => store.markFileChange(id, 'applied'),
              },
              approve: approveTool,
              ask: askTool,
              callId,
              // The registry the executing tools belong to, so a child's `job_*` answers for the child's jobs.
              jobs: tools.jobs,
              /**
               * The checklist lives in this session's log, so the run supplies the seam that writes it: reading
               * folds the log, writing appends the event and announces it. Doing it here rather than in the tool
               * is what keeps the tool ignorant of sessions, and what makes the live event exactly as frequent
               * as an accepted call.
               */
              todos: {
                read: () => store.todos(input.sessionId),
                write: (items) => {
                  store.recordEvent(input.sessionId, 'todo.written', { todos: items });
                  emit('todo.written', { todos: items });
                  return items;
                },
              },
              /**
               * The files this session handed over. One write per accepted `present` call, carrying every file
               * that call named, so the panel's update and the log line are the same event and a call that
               * presents three files cannot become three partial updates.
               */
              deliverables: {
                read: () => store.deliverables(input.sessionId),
                write: (files) => {
                  store.recordEvent(input.sessionId, 'deliverable.presented', { files });
                  emit('deliverable.presented', { files });
                },
              },
              /**
               * The session's goal. One write per accepted action, carrying the whole goal, so the fold is a
               * replacement and a reload needs no replay of the actions that produced it.
               *
               * A write says so in the conversation rather than rebuilding the prompt (`announceGoal`): the notice
               * states the goal's round count, so as a prompt section it made every round of a goal a new cacheable
               * prefix, and a run whose model completed the goal mid-run would have contradicted its own record for
               * the rest of the run. Announced, it takes effect from the next round — the boundary the model can
               * see — and the prefix is untouched.
               */
              goals: {
                read: () => store.goal(input.sessionId),
                // Read as the context is built, which is once per tool call: a run that consumed a message from
                // the user mid-flight is the user's turn from that step onwards, and the next call is the one
                // that has to see it.
                human: humanTurn,
                /**
                 * A goal the model writes mid-run is *said*, not rebuilt into the prompt.
                 *
                 * The prompt is the cacheable prefix, and rebuilding it here invalidated the system prompt and the
                 * whole tool catalogue one round after the model had paid for them — inside the very run that is
                 * making progress. The conversation is the right place for a change: it is appended at the tail,
                 * so everything before it stays byte-identical, and it is the same statement the run-start notice
                 * makes, so a reader of the transcript sees the goal's history in order.
                 */
                write: (action, goal) => {
                  store.recordEvent(input.sessionId, 'goal.changed', { action, goal });
                  emit('goal.changed', { action, goal });
                  // A user notice cannot interrupt an assistant's outstanding tool calls. Keep the
                  // durable goal change immediate, and publish its notice after the whole batch settles.
                  if (ownWork) changedGoals.push(goal);
                },
              },
              /**
               * The session's own record of the background commands it started.
               *
               * A command is the one kind of work whose result has nowhere to go when the turn that started it is
               * over: the process outlives the call, so the exit code and the output are known only to a manager
               * that keeps them in memory. This seam is what makes them durable — written at start, at settlement
               * (with the tail of the output, because the ring dies with the process) and when the model reads a
               * finished one, which is the cursor the notice repeats against.
               */
              commandJournal: commandJournal(store, input.sessionId),
              /**
               * What a program may call, and the only way it can call it.
               *
               * `tools.execute` is the same entry point the model's own calls use, so there is no second dispatch
               * path to keep in step — a guard, a permission rule or a timeout added for a direct call applies to
               * an inner one the moment it exists. The registry is *this run's*, which is why a delegated run hands
               * its program the child's tools and not the parent's.
               */
              catalog: {
                specs: catalogSpecs,
                invoke: async (inner, innerSignal) => {
                  const innerContext = toolContext(inner.id);
                  const result = await tools.execute(inner, {
                    ...innerContext,
                    signal: innerSignal ? AbortSignal.any([signal, innerSignal]) : signal,
                    ...(taskEffectScope
                      ? {
                          effectJournal: {
                            begin: (effectCall: ToolCall) => {
                              programEffects.set(
                                inner.id,
                                store.beginTaskEffect(
                                  taskEffectScope.sessionId,
                                  taskEffectScope.taskId,
                                  taskEffectScope.attemptId,
                                  effectCall.name,
                                ),
                              );
                            },
                          },
                        }
                      : {}),
                  });
                  return result;
                },
                // The registry's own classification and the run's own width, so a program cannot overlap what the
                // model's batches may not overlap, nor fan out wider than the run allows.
                mode: (inner) => tools.executionMode(inner),
                parallelLimit: maxParallelToolCalls,
              },
              programJournal: {
                record: (inner, state, result) => {
                  store.recordEvent(input.sessionId, 'program.call.settled', {
                    callId: inner.id,
                    name: inner.name,
                    state,
                    ...(result
                      ? { isError: result.isError, content: result.content.slice(0, 24000) }
                      : {}),
                  });
                  const intent = programEffects.get(inner.id);
                  if (intent && state === 'known' && result && !result.isError && taskEffectScope) {
                    store.completeTaskEffect(
                      taskEffectScope.sessionId,
                      taskEffectScope.taskId,
                      intent,
                    );
                    programEffects.delete(inner.id);
                  }
                },
              },
            });
            const { additionalContext, ...result } = await tools.execute(call, {
              ...toolContext(call.id),
              onExecution: ({ phase, attempt, startedAt, finishedAt, durationMs }) => {
                if (phase === 'started') {
                  timing.executionStartedAt ??= startedAt;
                  timing.attempts++;
                  peakConcurrency = Math.max(peakConcurrency, ++activeExecutions);
                } else {
                  timing.executionFinishedAt = finishedAt;
                  timing.durationMs += durationMs!;
                  timing.finishedAttempts++;
                  activeExecutions--;
                }
                const measurement = {
                  callId: call.id,
                  name: call.name,
                  attempt,
                  queuedAt,
                  queueMs: timing.queueMs,
                  startedAt,
                  ...(phase === 'finished'
                    ? {
                        finishedAt,
                        durationMs,
                      }
                    : {}),
                  activeExecutions,
                  peakConcurrency,
                  scope: 'model-tool-batch',
                };
                const type =
                  phase === 'started' ? 'tool.execution.started' : 'tool.execution.finished';
                store.recordEvent(input.sessionId, type, { runId, ...measurement });
                emit(type, measurement);
              },
            });
            return { effectId, result, additionalContext };
          } finally {
            timing.dispatchFinishedAt = Date.now();
            timing.dispatchMs = Math.max(0, performance.now() - dispatchClock);
          }
        };
        /**
         * Which sibling calls may overlap, and the order everything they produce is written in.
         *
         * The model asked for these calls in one message, so running two independent reads one after the
         * other buys nothing — but only a call whose tool *promised* it is safe may overlap a sibling
         * (`Tool.isConcurrencySafe`), and the promise is checked per call rather than per tool name, because a
         * tool may read for one argument and write for another.
         *
         * What is *not* shared with the dispatch is the record. `tool.started` is emitted for the whole group
         * up front to announce admission to the group; actual body spans have their own execution events.
         * Results are appended, announced and journalled strictly
         * in model order, so the transcript is the transcript the model wrote, whatever order the reads
         * finished in, and a fast call can never overtake a slow sibling in the log.
         */
        const groups = groupToolCalls(response.toolCalls, (call) => tools.executionMode(call));
        /** A steer retires a pending call with its reason recorded, rather than leaving it looking unanswered. */
        const retire = (call: ToolCall): void => {
          const skipped = {
            isError: true,
            content: 'Not executed: a new user instruction superseded this pending tool call.',
          };
          store.append(input.sessionId, { role: 'tool', toolCallId: call.id, ...skipped });
          emit('tool.finished', {
            callId: call.id,
            ...skipped,
            timing: {
              ...toolTimings.get(call.id)!,
              peakConcurrency,
              scope: 'model-tool-batch',
              executionComplete:
                toolTimings.get(call.id)!.attempts === toolTimings.get(call.id)!.finishedAttempts,
            },
          });
        };
        /**
         * The first failure in model order, wrapped rather than held raw: `throw undefined` is a legal throw,
         * and an `undefined` sentinel would let that call be treated as one that never failed at all.
         */
        let failure: { reason: unknown } | undefined;
        let cancelled = false;
        for (const group of groups) {
          if (signal.aborted) signal.throwIfAborted();
          if (queue.hasSteer) {
            for (const call of group) retire(call);
            continue;
          }
          for (const call of group) emit('tool.started', { call, queuedAt });
          /**
           * A rolling pool bounded by the run's limit, started in model order. `shouldStop` is consulted
           * before every start and never after one, so a call reported as not started is one that really did
           * not start; the already-started calls are awaited either way, because a tool cannot be uninvented.
           */
          const outcomes = await runBounded(
            group,
            maxParallelToolCalls,
            runToolCall,
            () => queue.hasSteer || signal.aborted,
          );
          for (let index = 0; index < group.length; index++) {
            const call = group[index]!;
            const outcome = outcomes[index]!;
            if (outcome.status === 'skipped') {
              // A steer says so in the transcript; a cancel leaves the call unresolved, which is what
              // `resolvePending` below reports as an unknown outcome rather than as a call that never happened.
              if (queue.hasSteer) retire(call);
              else cancelled = true;
              continue;
            }
            if (outcome.status === 'rejected') {
              failure ??= { reason: outcome.reason };
              continue;
            }
            const { effectId, result, additionalContext } = outcome.value;
            store.append(input.sessionId, { role: 'tool', toolCallId: call.id, ...result });
            /**
             * Checked here rather than inside the registry, because this is the layer that can fail the run: a
             * violated pipeline order means a policy stage ran out of order, and the registry's own handling
             * turns that into a failed tool result the model reads and moves on from. The trace is this run's
             * own registry, passed in because the registration that checks it is process-wide.
             */
            await this.options.invariants?.assert('tool-execution', {
              sessionId: input.sessionId,
              runId,
              pipeline: tools.pipelineInvariant,
            });
            if (effectId && !result.isError && taskEffectScope)
              store.completeTaskEffect(taskEffectScope.sessionId, taskEffectScope.taskId, effectId);
            emit('tool.finished', {
              callId: call.id,
              ...result,
              timing: {
                ...toolTimings.get(call.id)!,
                peakConcurrency,
                scope: 'model-tool-batch',
                executionComplete:
                  toolTimings.get(call.id)!.attempts === toolTimings.get(call.id)!.finishedAttempts,
              },
            });
            if (additionalContext?.length)
              injected.push({ callId: call.id, notes: additionalContext });
          }
          // A failed or cancelled call ends the batch: later groups are not started at all, exactly as the
          // serial loop would have stopped at the first one that threw.
          if (failure !== undefined || cancelled) break;
        }
        if (cancelled) signal.throwIfAborted();
        if (failure !== undefined) throw failure.reason;
        for (const goal of changedGoals) announceGoal(goal);
        // Context a post-execute policy asked to inject becomes a persisted user message *after* the
        // batch's tool results, never a field riding along inside a tool block: injected context is
        // model-visible, and everything model-visible has to be in the transcript (and therefore in
        // the summary, the compaction boundary and the session reader).
        for (const entry of injected) {
          const content = entry.notes.join('\n\n');
          store.append(input.sessionId, { role: 'user', content });
          emit('context.injected', {
            source: 'post-execute',
            callId: entry.callId,
            notes: entry.notes.length,
            content,
          });
        }
        // Submitting the plan ends the planning run: the next step is a human decision, and letting
        // the loop continue would only burn rounds on a phase that cannot change anything.
        if (planning?.submitted) {
          status = 'completed';
          endStep(round, 'final');
          break;
        }
        // A submitted report ends the child run too: the parent is waiting for the answer, and further
        // rounds would only spend the budget the two of them share. A custom schema's answer ends it the
        // same way — the caller asked for one object, and the child submitted it.
        if (reportHolder.report || reportHolder.data !== undefined) {
          status = 'completed';
          endStep(round, 'final');
          break;
        }
        // The last of the ordinary ways out: the step asked for tools, they ran, and the run continues.
        endStep(round, 'tool-calls');
      }
    } catch (cause) {
      // Closed before anything else in here can fail, so no path out of a run leaves its last step open.
      if (openStep !== null) endStep(openStep, stepEndReason(cause, signal.aborted));
      try {
        const partial = store.persistStreamCheckpoint(input.sessionId, runId);
        if (partial) text = partial;
      } catch {
        status = 'failed';
        error = 'Failed to persist partial model output';
      }
      status =
        error === 'Failed to persist partial model output'
          ? 'failed'
          : signal.aborted
            ? 'cancelled'
            : cause instanceof DeferredApprovalError
              ? 'needs_review'
              : (failureStatus(cause) ?? 'failed');
      error =
        error === 'Failed to persist partial model output'
          ? error
          : cause instanceof Error && cause.name === 'ToolCleanupError'
            ? cause.message
            : signal.aborted
              ? 'Run cancelled'
              : cause instanceof Error
                ? cause.message
                : String(cause);
      /**
       * What kind of failure it was, in the form a client can branch on.
       *
       * A `tool-cleanup` failure is named here because that error class carries no code: the run failed
       * *after* its work, and a reader should be able to see that without matching on a message. A cancelled
       * run has no code at all — its status already says `cancelled`, and inventing a code for it would make
       * a deliberate stop look like a failure with a name.
       */
      code =
        error === 'Failed to persist partial model output'
          ? undefined
          : cause instanceof Error && cause.name === 'ToolCleanupError'
            ? 'tool-cleanup'
            : signal.aborted
              ? undefined
              : failureCodeOf(cause);
      /**
       * What the endpoint said about the request, when it was the endpoint that failed.
       *
       * Not codes: nothing branches on them and the run's own status already says `failed`. They are the two
       * facts a person needs to take the failure back to whoever runs the endpoint — the status, and the id
       * the endpoint filed the call under — and they are read from the same thrown value the code is, so a
       * failure that never carried them reports none rather than an empty one.
       */
      endpointFailure = cause instanceof RunFailure ? cause : undefined;
      try {
        store.resolvePending(
          input.sessionId,
          cause instanceof DeferredApprovalError
            ? 'Approval deferred; the requested operation was not executed. Review it before retrying.'
            : `Run ${status}. A tool may already have had effects; inspect state before retrying.`,
        );
      } catch {
        status = 'failed';
        error = 'Failed to resolve pending tool calls; execution outcome is unknown';
      }
      error = redactSecrets(error);
    } finally {
      // A tool still running when the run ends is charged here: the emitter opens `toolStarted` on
      // `tool.started` and closes it on `tool.finished`, and a run that is cancelled or that throws never sees the
      // finish — so without this the wall time a person spent waiting on that tool would vanish from the totals.
      if (emission.toolStarted !== undefined) {
        statistics.toolMs += performance.now() - emission.toolStarted;
        emission.toolStarted = undefined;
      }
      // A background sub-agent must not outlive the run that started it: this run's row is about to be
      // finalised (so its usage could no longer be attributed) and the tool registry it borrowed is
      // about to be closed. Cancel first, then await, so the guarantee does not depend on timing.
      if (coordinator) await coordinator.settle();
      try {
        if (this.options.ownsToolResources !== false) await tools.close();
      } catch {
        status = 'failed';
        error = 'Tool resource cleanup failed; an external process may still be running';
        code = 'tool-cleanup';
      }
      if (task && taskAttempt) {
        try {
          const persistedTask = store.finishTaskAttempt(input.sessionId, task.id, taskAttempt.id, {
            resolvedEffectIds: taskVerification?.evidence.checks.flatMap((check) =>
              check.command && !check.command.timedOut
                ? [acceptanceEffects.get(check.id)].filter((id): id is string => Boolean(id))
                : [],
            ),
            status:
              status === 'completed' || status === 'needs_review'
                ? status
                : status === 'cancelled'
                  ? 'cancelled'
                  : 'blocked',
            ...(taskVerification ? { verification: taskVerification.evidence } : {}),
            ...(error ? { error } : {}),
            ...(taskVerification
              ? { acceptance: taskVerification.acceptance, steps: taskVerification.steps }
              : {}),
          });
          if (status === 'completed' && persistedTask.status === 'needs_review') {
            status = 'needs_review';
            error = 'Task side effect outcome unknown; inspect state before retrying.';
          }
        } catch {
          status = 'failed';
          error = 'Failed to persist task finalization';
        }
      }
      result = {
        runId,
        sessionId: input.sessionId,
        status,
        text,
        usage,
        statistics,
        ...(committedSummaryUsage.inputTokens || committedSummaryUsage.outputTokens
          ? {
              compactionUsage: {
                inputTokens: committedSummaryUsage.inputTokens,
                outputTokens: committedSummaryUsage.outputTokens,
                cachedInputTokens: committedSummaryUsage.cachedInputTokens,
                cacheWriteInputTokens: committedSummaryUsage.cacheWriteInputTokens,
              },
            }
          : {}),
        ...(coordinator?.summaries.length ? { subagents: coordinator.summaries } : {}),
        ...(reportHolder.report ? { report: reportHolder.report } : {}),
        ...(reportHolder.data !== undefined ? { data: reportHolder.data } : {}),
        ...(error ? { error } : {}),
        ...(code ? { code } : {}),
        ...(endpointFailure?.httpStatus === undefined
          ? {}
          : { httpStatus: endpointFailure.httpStatus }),
        ...(endpointFailure?.requestId === undefined
          ? {}
          : { requestId: endpointFailure.requestId }),
        ...(acceptance ? { acceptance } : {}),
      };
      // Stop hooks observe the finished run and can only annotate it. The effects already happened
      // and the result is about to be persisted, so a reason here is reported, never a veto.
      try {
        const stopped = await tools.extensions.stop(
          {
            sessionId: input.sessionId,
            runId,
            status,
            text,
            readOnly,
            ...(error ? { error } : {}),
          },
          signal,
        );
        const notices = [
          ...stopped.reasons,
          ...stopped.failures.map((failure) => `stop hook failed: ${failure}`),
        ];
        if (notices.length)
          result.text = `${result.text}${result.text ? '\n\n' : ''}${notices
            .map((notice) => `[Extension stop hook] ${notice}`)
            .join('\n')}`;
      } catch {
        /* A stop hook must never change the outcome of an already-finished run. */
      }
      /**
       * Anything still queued was never folded into a turn, and the run it was queued for is now over. The
       * record says so — the reason distinguishes "the person pressed Stop" from "the run reached its end
       * first" — because the alternative, an empty queue nobody wrote about, is exactly the silent loss the
       * durable inbox exists to remove. What is *not* written here is the crash case: a process that dies
       * before this point leaves `input.queued` standing, which is how a later reader knows.
       */
      this.discard(
        queue.clear().map((item) => item.id),
        input.sessionId,
        status === 'cancelled' ? 'cancelled' : 'run-ended',
      );
      this.runs.delete(input.sessionId);
      emit('queue.changed', { queue: [] });
      /**
       * The run-end promises are checked before the result is persisted, so a broken one is reported as a
       * failed run rather than discovered later against a run that claims to have completed. `failed` is
       * already part of `RunStatus`, so nothing downstream has to learn a new vocabulary — and a run whose
       * promises were broken is exactly what `failed` means.
       */
      await this.checkRunEnd(result, input.sessionId, runId, [...emittedTypes]);
      try {
        store.finishRun(result);
      } catch {
        result.status = 'failed';
        result.error = 'Failed to persist run finalization';
        store.finishRun(result);
      }
      emit('run.finished', { result });
    }
    return result;
  }
  /**
   * Runs the `run-end` invariants and turns a violation into a failed run.
   *
   * A violation is logged as well as recorded: the registry is process-wide and a host may outlive many
   * runs, so the log is where an operator sees that a promise broke even if nobody looks at this run's
   * result.
   */
  private async checkRunEnd(
    result: RunResult,
    sessionId: string,
    runId: string,
    emittedTypes: string[],
  ): Promise<void> {
    const invariants = this.options.invariants;
    if (!invariants) return;
    const violations = await invariants.run('run-end', { sessionId, runId, emittedTypes });
    if (!violations.length) return;
    const detail = describeViolations(violations);
    try {
      this.options.onEvent?.({
        type: 'invariant.violated',
        sessionId,
        runId,
        // Read from the log like any other frame's cursor: a diagnostic is still ordered against the record.
        seq: this.options.store.lastSeq(sessionId),
        data: { violations },
      });
    } catch {
      /* diagnostics must not change the outcome of a run that already ended */
    }
    result.status = 'failed';
    result.error = `Runtime invariant violated: ${detail}`;
  }
}
