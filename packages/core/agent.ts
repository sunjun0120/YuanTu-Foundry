import { memoryContext } from '../knowledge/context.ts';
import {
  DeferredApprovalError,
  RunFailure,
  failureCodeOf,
  statusForFailure,
  type FailureCode,
} from '../protocol/failure.ts';
import { admitGoalRound, type Goal } from '../protocol/goals.ts';
import { validateUserInput } from '../protocol/images.ts';
import type {
  AgentEvent,
  Approver,
  CompletionStep,
  FileChange,
  Message,
  ModelResponse,
  Questioner,
  ReasoningEffort,
  RunResult,
  RunStatus,
  ToolSpec,
  Usage,
  UserInput,
} from '../protocol/index.ts';
import { describeViolations } from '../protocol/invariants.ts';
import { resolveRunLimits } from '../protocol/settings.ts';
import { emptyStatistics } from '../protocol/statistics.ts';
import type { StepEndReason } from '../protocol/steps.ts';
import { loadInstructions } from '../resources/instructions.ts';
import { discoverSkills, expandSkill } from '../resources/skills.ts';
import { withExecutionPolicy as underExecutionPolicy } from '../tools/execution-policy.ts';
import { goalTools } from '../tools/goal.ts';
import { repoMapContext } from '../tools/repo-map.ts';
import {
  completionContractText,
  goalNoticeText,
  skillsCatalogue,
  taskDefinitionText,
} from './agent-notices.ts';
import type { AgentOptions, AgentRunInput } from './agent-options.ts';
import { admitVisibleBackground } from './background-deliveries.ts';
import { cacheKeyFor } from './cache-key.ts';
import { TokenCalibration, calibrationRoute } from './calibration.ts';
import { taskCompletionStepId } from './completion-contract.ts';
import type { PreparedContext } from './context.ts';
import { prepareContext } from './context.ts';
import { envelopeEvent } from './envelope.ts';
import { redactSecrets } from './errors.ts';
import { createPlanningTools, type PlanningTools } from './plan-tools.ts';
import { assemblePrompt, type PromptTrace } from './prompt-sections.ts';
import { createRunCompletion } from './run-completion.ts';
import { buildContextInput } from './run-context.ts';
import { createRunDelegation, registerRunReport } from './run-delegation.ts';
import { createRunEmit, type RunEmission } from './run-emit.ts';
import { finalizeRun } from './run-finalization.ts';
import { createRunInteraction } from './run-interaction.ts';
import { createRunPromptSections } from './run-prompt.ts';
import { createProviderMeasurement } from './run-provider.ts';
import { RunQueue, queuedInput, type InputMode, type QueuedInput } from './run-queue.ts';
import { requestRunRound } from './run-request.ts';
import { ResidentTurnSettlements } from './run-residency.ts';
import { loadRunTask, registerTaskStepTool, startRunTask } from './run-task.ts';
import { createToolBatch } from './run-tools.ts';
import {
  lastRuntimeSnapshot,
  runtimeSnapshotMessage,
  runtimeSnapshotText,
  type RuntimeSnapshotSource,
} from './runtime-context.ts';
import { sessionQueryTools } from './session-query.ts';
import { subAgentJobProducer } from './subagent-jobs.ts';
import {
  SubAgentCoordinator,
  resolveSubAgentOptions,
  type ResolvedSubAgentOptions,
} from './subagents.ts';
import { captureTaskBaselines, type TaskBaselines } from './task-acceptance.ts';
export type { AgentOptions } from './agent-options.ts';
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
  async run(input: AgentRunInput): Promise<RunResult> {
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
    const submitted = await underExecutionPolicy(executionPolicy, () =>
      tools.extensions.promptSubmit(
        { sessionId: input.sessionId, prompt: input.prompt, readOnly },
        signal,
      ),
    );
    if (submitted.failures.length)
      throw new Error(
        `Prompt hook failed, so the run was not started: ${submitted.failures.join('; ')}`,
      );
    if (submitted.block) throw new Error(`Prompt rejected by extension: ${submitted.block}`);
    if (!submitted.prompt.trim()) throw new Error('Prompt hook produced an empty prompt');
    input.prompt = submitted.prompt;
    const { task, previousAttempt } = loadRunTask(store, input);
    /**
     * The project a session belongs to, and the directory it works in — two facts, deliberately separate.
     *
     * `project` is what `Session.workspace` has always meant: the logical project the session lives in, which
     * ownership checks, session listing, search and the scheduler all read. `workspace` is where this run's files,
     * instructions, skills, outline and spill actually go, which for a delegated child is its own worktree.
     */
    const project = store.get(input.sessionId).workspace;
    const workspace = this.options.workspaceRoots?.(input.sessionId).executionRoot ?? project;
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
    const taskAttempt = startRunTask(store, input, task, runId, baselines);
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
      workspace: project,
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
    registerTaskStepTool(store, tools, input, task, taskAttempt, (type, data) => emit(type, data));
    const reportHolder = registerRunReport(tools, input);
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
      result!: RunResult;
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
     * read and write *this run's* numbers without owning them: `toolCalls` is opened and closed by the emitter's
     * tool frames while the loop settles whatever was still open when the run ended, `statistics` is folded by
     * both, and the child token map is the stall watchdog's memory.
     */
    const emission: RunEmission = {
      statistics,
      emittedTypes,
      toolCalls: new Map<string, number>(),
      toolSpanStarted: undefined,
      toolActivityStartedAt: undefined,
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
    const completion = createRunCompletion({
      store,
      sessionId: input.sessionId,
      runId,
      emit,
      tools,
      readOnly,
      planPhase: input.planPhase === true,
      task,
      taskAttempt,
      workspace,
      signal,
      baselines,
      // Read when the round runs rather than when this factory is called: the interaction adapters below assign
      // `approveTool`, and the round is reached long after they have.
      approve: (approval, approvalSignal) => approveTool(approval, approvalSignal),
      request: {
        completion: input.completion,
        resumeCompletionId: input.resumeCompletionId,
        completionInputs: input.completionInputs,
        approvedPlan: input.approvedPlan,
        repairPolicy: input.completionRepairPolicy,
      },
    });
    completion.registerTools();
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
      const expanded = expandSkill(workspace, item.prompt);
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
    const residentTurns = new ResidentTurnSettlements();
    const depth = this.options.subagentDepth ?? 0;
    if (this.subagents?.enabled && depth < this.subagents.maxDepth) {
      coordinator = createRunDelegation({
        agent: this.options,
        store,
        tools,
        emit,
        sessionId: input.sessionId,
        runId,
        workspace,
        depth,
        limits: this.subagents,
        signal,
        readOnly,
        queue,
        usage,
        statistics,
        residentTurns,
        taskEffectScope,
        createAgent: (options) => new Agent(options),
        arm: (armed) => {
          emission.coordinator = armed;
        },
        nextMessageId: () => ++messageCounter,
      });
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
      const instructions = loadInstructions(workspace);
      const skills = discoverSkills(workspace);
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
        /**
         * The completion contract, re-announced when the conversation has lost or outgrown it.
         *
         * A compaction can swallow the record that said what "done" means, and the contract is durable while the
         * summary is not — so without this the model would keep working against a definition it can no longer
         * read. It is announced from the *live* state (the contract, the current steps, the last round's summary)
         * rather than from the record that created it, so what the model reads is what the evidence says now.
         */
        if (completion.state.contractSpec && completion.state.contractId) {
          const liveSteps = task
            ? store.getTask(input.sessionId, task.id).steps
            : completion.state.steps;
          announce(
            'completion',
            completionContractText(
              completion.state.contractSpec,
              liveSteps.map((step, index) => ({
                id: task ? taskCompletionStepId(task.id, index) : (step as CompletionStep).id,
                description: step.description,
                status: step.status,
              })),
              completion.state.summary ?? {
                state: 'unverified',
                reason: 'no verification round has run yet',
                repairRounds: completion.state.repairRounds,
                failedCheckIds: [],
              },
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
      let { specs, catalog: catalogSpecs } = buildCatalog();
      /**
       * The model tool-call batch, one per run.
       *
       * It owns the group scheduler, the bounded pool and the context a call runs in (see `run-tools.ts`); this
       * run owns the seams it reads. The read-only flag, the round's policies, the approver pair, the human-turn
       * fact and the program catalog are passed as getters on purpose: every one of them is reassigned between
       * rounds — or, for the approver, assigned a few lines below — and a call has to run under whatever is in
       * force when it runs, not under what was in force when this factory was called.
       */
      const batch = createToolBatch({
        store,
        sessionId: input.sessionId,
        runId,
        workspace,
        signal,
        emit,
        tools,
        queue,
        maxParallelToolCalls,
        ownWork,
        taskEffectScope,
        journalSessionId,
        tagChange,
        invariants: this.options.invariants,
        completion,
        readOnly: () => readOnly,
        executionPolicy: () => executionPolicy,
        executionPolicyForCall: this.options.executionPolicy,
        permissionPolicyForCall: this.options.permissionPolicy,
        approve: () => approveTool,
        ask: () => askTool,
        humanTurn: () => humanTurn,
        catalogSpecs: () => catalogSpecs,
      });
      const expanded = expandSkill(workspace, input.prompt);
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
        const contextInput = buildContextInput({
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
          // The model this round aims at, so a compaction records which one produced the summary. Absent when the
          // embedder declared none, which the record then does not claim to know. The provider is recorded beside
          // it for the same reason: a summary is a model answer, and the model name alone does not say which
          // adapter it came back over.
          model: aimedModel,
          ...(this.options.modelInfo?.protocol === undefined
            ? {}
            : { protocol: this.options.modelInfo.protocol }),
          workspace,
          toolResultKeepRecent,
          toolResultShrinkTokens,
          contextShrinkPercent,
          toolResultPruneThresholdChars,
          toolResultPruneHeadChars,
          toolResultPruneTailChars,
          /**
           * The two accumulators below are the run's own, not this round's: `usage` is what the result reports
           * and `committedSummaryUsage` is what the session's aggregates claim was stored, so the callbacks have
           * to write into the objects the loop keeps for the rest of the run.
           */
          usage,
          committedSummaryUsage,
          emit,
        });
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
        const response = await requestRunRound({
          store,
          sessionId: input.sessionId,
          runId,
          round,
          limits,
          signal,
          context,
          contextInput,
          roundContextTokens,
          measuredProvider,
          specs,
          requestedModel,
          requestedEffort,
          cacheKeyOf,
          recordEnvelope,
          beforeRequest: (system) => admitVisibleBackground(store, input.sessionId, system),
          onVisibleText: (delta) => {
            if (stepFirstTokenAt === null && delta.length && stepStartedAt !== null) {
              stepFirstTokenAt = performance.now();
              statistics.firstTokenMs += Math.max(0, stepFirstTokenAt - stepStartedAt);
              statistics.firstTokenCount += 1;
            }
          },
          onAnswerText: (answer) => {
            text = answer;
          },
          commitStepTiming,
          statistics,
          usage,
          calibration,
          calibrationRouteKey,
          emit,
        });
        // An abort after the provider's terminal event must keep the completed text while still
        // refusing to execute any pending tool call.
        signal.throwIfAborted();
        if (response.toolCalls.length === 0) {
          if (queue.hasSteer || consume('follow-up')) {
            endStep(round, 'queued-input');
            continue;
          }
          status = 'completed';
          if (completion.state.contractId && completion.state.contractSpec) {
            if (
              task &&
              taskAttempt &&
              store.hasPendingTaskEffects(input.sessionId, task.id, taskAttempt.id)
            ) {
              status = 'needs_review';
              error = 'Task side effect outcome unknown; inspect state before retrying.';
              endStep(round, 'final');
              break;
            }
            const decision = await completion.verifyRound();
            if (decision?.action === 'repair') {
              // The budget is charged when the next request is about to be made, which is exactly here: a run
              // that stops for any other reason never spent the round it was allowed.
              completion.state.repairRounds += 1;
              completion.state.repeatedFailures = decision.summary.repeatedFailures;
              completion.state.previousFailureFingerprint = completion.state.lastFailureFingerprint;
              completion.state.repairStartedAt ??= Date.now();
              store.append(input.sessionId, { role: 'user', content: decision.feedback });
              // Announced as well as appended: a client watching the run sees that a repair round began rather
              // than reading a silently longer transcript.
              emit('context.injected', {
                source: 'completion-repair',
                round: completion.state.verificationRound,
              });
              endStep(round, 'queued-input');
              continue;
            }
            if (decision?.action === 'complete') {
              // A candidate only. Cleanup, the final fingerprint and persistence all still have to succeed
              // before anything may call this verified.
              completion.state.candidate = decision.summary;
            } else if (decision?.action === 'limit') {
              status = 'limited';
              error =
                completion.state.taskVerification?.error ??
                `Acceptance repair stopped: ${decision.summary.reason}`;
            } else if (decision) {
              status = 'needs_review';
              error =
                completion.state.taskVerification?.error ??
                `Acceptance review required: ${decision.summary.reason}`;
            }
          } else if (task && taskAttempt) {
            // A task run whose contract could not be built still refuses to claim success with an unknown effect
            // standing: the effect ledger is a separate promise from the contract and outlives it.
            if (store.hasPendingTaskEffects(input.sessionId, task.id, taskAttempt.id)) {
              status = 'needs_review';
              error = 'Task side effect outcome unknown; inspect state before retrying.';
            }
          }
          endStep(round, 'final');
          break;
        }
        // The tool calls are about to run. The message that names them is written first, so a crash while a
        // tool is in flight leaves the record that lets recovery report its outcome as unknown rather than
        // letting the call be replayed as if it had never happened. Everything the round appends after this
        // point is written as one batch by the next read or by the end of the run.
        store.flush(input.sessionId);
        // The calls run inside the batch that owns their grouping, their effect journal and the order their
        // results are recorded in (see `run-tools.ts`); what comes back is what the model is told *after* those
        // results, which is the loop's own step.
        const { injected, changedGoals } = await batch.run(response.toolCalls);
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
      result = await finalizeRun({
        agent: this.options,
        store,
        tools,
        sessionId: input.sessionId,
        runId,
        signal,
        readOnly,
        status,
        error,
        code,
        text,
        endpointFailure,
        usage,
        statistics,
        committedSummaryUsage,
        emission,
        emittedTypes,
        coordinator,
        residentTurns,
        completion,
        task,
        taskAttempt,
        reportHolder,
        queue,
        emit,
        releaseRun: (ids, reason) => {
          this.discard(ids, input.sessionId, reason);
          this.runs.delete(input.sessionId);
        },
        checkRunEnd: (result, types) => this.checkRunEnd(result, input.sessionId, runId, types),
      });
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
