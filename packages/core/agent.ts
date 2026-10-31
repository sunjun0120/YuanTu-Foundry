import { type FailureCode, RunFailure } from '../protocol/failure.ts';
import type {
  Approver,
  FileChange,
  ModelResponse,
  Questioner,
  RunResult,
  RunStatus,
  ToolCall,
  Usage,
  UserInput,
} from '../protocol/index.ts';
import { validateUserInput } from '../protocol/images.ts';
import { resolveRunLimits } from '../protocol/settings.ts';
import { billableTokens, emptyStatistics } from '../protocol/statistics.ts';
import { loadInstructions } from '../tools/instructions.ts';
import { discoverSkills } from '../resources/skills.ts';
import { builtinServiceConfigured } from '../builtin-services/manifest.ts';
import { goalTools } from '../tools/goal.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { AgentOptions, AgentRunInput } from './agent-options.ts';
import { admitVisibleBackground } from './background-deliveries.ts';
import { TokenCalibration, calibrationRoute } from './context/calibration.ts';
import { prepareContext, type PreparedContext } from './context/context.ts';
import { createPlanningTools, type PlanningTools } from './plan-tools.ts';
import { assemblePrompt, type PromptTrace } from './prompt/sections.ts';
import { abandonRun, submitPrompt } from './run/admission.ts';
import { RunAim } from './run/aim.ts';
import { createRunCompletion } from './run/completion.ts';
import { createAutomaticVerification } from './completion/automatic-verification.ts';
import { buildContextInput } from './run/context.ts';
import { createRunDelegation, registerRunReport } from './run/delegation.ts';
import { createRunEmit, type RunEmission } from './run/emit.ts';
import { RunEnvelopes } from './run/envelope.ts';
import { checkRunEnd, finalizeRun } from './run/finalization.ts';
import { RunInbox } from './run/inbox.ts';
import { injectContext, userMessage } from './run/input.ts';
import { createRunInteraction } from './run/interaction.ts';
import { StepBlockedError, settleThrownRun, stepEndReason } from './run/outcome.ts';
import { approvedPlanNotice, createRunPromptSections, planPhaseNotice } from './run/prompt.ts';
import { createRunAnnouncements } from './run/snapshots.ts';
import { RunSteps } from './run/steps.ts';
import { RunSurface } from './run/surface.ts';
import { settleAnswerRound } from './run/verdict.ts';
import { createProviderMeasurement } from './run/provider.ts';
import { textOnlyProvider } from './text-only-provider.ts';
import { RunQueue, type InputMode, type QueuedInput } from './run/queue.ts';
import { requestRunRound } from './run/request.ts';
import { ResidentTurnSettlements } from './run/residency.ts';
import { loadRunTask, registerTaskStepTool, startRunTask } from './run/task.ts';
import { createToolBatch } from './run/tools.ts';
import { ToolProgressGuard, toolProgressNotice } from './tool-progress.ts';
import { shellReadIn, shellReadNotice } from './tool-advice.ts';
import { projectChangedPaths } from './completion/work-evidence.ts';
import { sessionQueryTools } from './session-query.ts';
import { subAgentJobProducer } from './subagents/jobs.ts';
import {
  SubAgentCoordinator,
  resolveSubAgentOptions,
  type ResolvedSubAgentOptions,
} from './subagents/delegation.ts';
import { captureTaskBaselines, type TaskBaselines } from './completion/task-acceptance.ts';
export type { AgentOptions } from './agent-options.ts';

/**
 * Serial number for ids of messages handed to sub-agents. Ids must be unique across the log (the
 * inbox fold removes by id): the timestamp covers restarts, the counter covers the same
 * millisecond.
 */
let messageCounter = 0;
/**
 * Rounds a failed threshold compaction waits before retrying, since a failed summary usually fails
 * again. A request that no longer fits is still compressed immediately.
 */
const COMPACTION_RETRY_ROUNDS = 3;
/**
 * Rounds the post-cutoff act phase allows without a project change (reads, or refused edits).
 * Counted separately so a run mid-repair is not cut off on the read count.
 */
const ACT_NO_CHANGE_ROUNDS = 3;
const ACT_FAILED_EDIT_ROUNDS = 4;
/** The paths a file editor's call names, whichever of the editors' argument shapes it uses. */
const editTargets = (call: ToolCall): string[] => {
  const args = call.arguments;
  const paths = [args.path, args.from, args.to];
  if (Array.isArray(args.edits))
    for (const edit of args.edits) paths.push((edit as { path?: unknown } | null)?.path);
  return paths.filter((value): value is string => typeof value === 'string');
};
/**
 * Compaction-wait rounds the session's previous run left unspent, or `0`. Read from the log so a
 * new run (goal continuation, follow-up) does not immediately retry a failed summary. Clamped to
 * one wait.
 */
export function inheritedCompactionWait(
  store: Pick<SessionStore, 'newestPayload'>,
  sessionId: string,
): number {
  const remaining = store.newestPayload(sessionId, 'context.compaction.deferred')?.remainingRounds;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 0;
  return Math.min(COMPACTION_RETRY_ROUNDS, Math.max(0, Math.floor(remaining)));
}

/** Which of a run's total budgets is spent, said the way the run's error reads; `undefined` while none is. */
export function runBudgetExhausted(
  limits: { maxRunRounds: number; maxRunMs: number; maxRunTokens: number },
  spent: { rounds: number; elapsedMs: number; tokens: number },
): string | undefined {
  if (limits.maxRunRounds > 0 && spent.rounds >= limits.maxRunRounds)
    return `The run reached its budget of ${limits.maxRunRounds} model rounds`;
  if (limits.maxRunMs > 0 && spent.elapsedMs >= limits.maxRunMs)
    return `The run reached its budget of ${Math.round(limits.maxRunMs / 60_000)} minutes`;
  if (limits.maxRunTokens > 0 && spent.tokens >= limits.maxRunTokens)
    return `The run reached its budget of ${limits.maxRunTokens} model tokens`;
  return undefined;
}

export class Agent {
  private options: AgentOptions;
  private serialToolRoutes = new Set<string>();
  /** The live queue of each running session, and the log behind it once nothing runs (see `run/inbox.ts`). */
  private inbox: RunInbox;
  private subagents?: ResolvedSubAgentOptions;
  /**
   * What the most recent system prompt assembly was made of, per agent (a child is a separate
   * agent).
   */
  private lastPrompt: readonly PromptTrace[] = [];
  constructor(options: AgentOptions) {
    this.options = options;
    this.inbox = new RunInbox(options.store);
    // Resolved once, at construction, so an invalid limit fails before a run opens a row.
    this.subagents = resolveSubAgentOptions(options.subagents);
    /**
     * The kernel owns the sub-agent producer; the command manager registered its own. A child gets
     * no residency, so it manages only its own commands.
     */
    if (options.subagentResidency)
      options.tools.jobs.register(
        subAgentJobProducer({ store: options.store, residency: options.subagentResidency }),
      );
  }
  /** Queue an input for a running session (see `RunInbox.enqueue`). */
  enqueue(sessionId: string, input: UserInput, mode: InputMode, id?: string): QueuedInput {
    if (this.options.supportsVision === false && input.images?.length)
      throw new Error('当前连接未启用图片输入，请选择支持视觉的模型。');
    return this.inbox.enqueue(sessionId, input, mode, id);
  }
  getQueue(sessionId: string): QueuedInput[] {
    return this.inbox.queue(sessionId);
  }
  /** The session's inbox as a client reads it, live or after the fact (see `RunInbox.inboxOf`). */
  inboxOf(sessionId: string): { running: boolean; items: QueuedInput[] } {
    return this.inbox.inboxOf(sessionId);
  }
  /** Drop the session's inbox and record that it will never be delivered (see `RunInbox.clear`). */
  clearQueue(sessionId: string): void {
    this.inbox.clear(sessionId);
  }
  /**
   * The sections of this agent's last system prompt, in order, each marked as contributed, empty or
   * replaced, so the prompt can be audited.
   */
  promptSections(): readonly PromptTrace[] {
    return this.lastPrompt;
  }
  async run(input: AgentRunInput): Promise<RunResult> {
    const admittedAt = input.admittedAt ?? Date.now();
    const { store, provider, tools } = this.options;
    input = { ...input, ...validateUserInput(input) };
    // Defaults come from `packages/protocol/settings.ts`, shared with the Host and CLI help.
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
     * A read-only run hides every permissioned tool and refuses any approval that arrives; plan
     * mode and read-only sub-agents share this flag.
     *
     * `let` for one transition: a plan approved mid-run via `exit_plan_mode` lifts it at the next
     * step boundary, never during the round that asked. Each write still asks for approval.
     */
    let readOnly = input.planPhase === true || input.readOnly === true;
    // Re-read at every round boundary so a preset or sandbox switched mid-run reaches the prompt,
    // schema and later calls.
    const policy = this.options.permissionPolicy?.();
    const executionPolicy = this.options.executionPolicy?.();
    input.prompt = await submitPrompt({
      tools,
      executionPolicy,
      sessionId: input.sessionId,
      prompt: input.prompt,
      readOnly,
      signal,
    });
    const { task, previousAttempt } = loadRunTask(store, input);
    /**
     * `project` is the session's logical project (`Session.workspace`), used for ownership,
     * listing, search and scheduling. `workspace` is where this run's files actually go; for a
     * delegated child, its own worktree.
     */
    const project = store.get(input.sessionId).workspace;
    const workspace = this.options.workspaceRoots?.(input.sessionId).executionRoot ?? project;
    const journalSessionId = input.journalSessionId ?? input.sessionId;
    /**
     * A sub-agent's changes are journaled against the parent session, so tag them with the child.
     */
    const tagChange = (change: FileChange): FileChange =>
      this.options.subagentTag && !change.subagent
        ? { ...change, subagent: this.options.subagentTag }
        : change;
    // Checked before the run row exists, so a malformed request leaves nothing to close.
    if (input.planPhase && !input.planId) throw new Error('Planning phase requires a plan record');
    // A retry compares against the images this definition's first run took, never against what the failed attempt left.
    const baselines: TaskBaselines = task
      ? await captureTaskBaselines(
          workspace,
          task,
          store.definitionRunAttemptBaselines(input.sessionId, task.id) as
            TaskBaselines | undefined,
        )
      : {};
    const runId = store.beginRun(input.sessionId);
    // From here on the run row is open and the lease held; the outer guard closes both if building
    // the run's seams throws, so the session is not left locked.
    /**
     * Disposers for run-scoped tools bound to this run's goal or plan, so a registry that outlives
     * the run does not offer stale tools.
     */
    const runScoped: (() => void)[] = [];
    try {
      // The host creates the plan row before the run exists, so the run id is only knowable here.
      if (input.planId) store.linkPlanRun(input.sessionId, input.planId, runId);
      const taskAttempt = startRunTask(store, input, task, runId, baselines);
      const taskEffectScope =
        task && taskAttempt
          ? { sessionId: input.sessionId, taskId: task.id, attemptId: taskAttempt.id }
          : this.options.taskEffectScope;
      /**
       * Session retrieval tools, installed for every run. They read other conversations in this
       * workspace only, carry no permission (reading history is not an effect), and so stay
       * available in read-only and planning runs.
       */
      for (const tool of sessionQueryTools({
        store,
        workspace: project,
        sessionId: input.sessionId,
      }))
        tools.replace(tool);
      /**
       * Whether this run serves the session's own objective. Only such runs get the goal tools:
       * planning runs, read-only runs and delegated children must not rewrite the objective
       * (children also never inherit them, via `RUN_SCOPED_TOOLS`).
       */
      const ownWork =
        (this.options.subagentDepth ?? 0) === 0 &&
        !input.reportRequired &&
        !input.planPhase &&
        !readOnly;
      if (ownWork) for (const tool of goalTools()) runScoped.push(tools.replace(tool));
      registerTaskStepTool(store, tools, input, task, taskAttempt, (type, data) =>
        emit(type, data),
      );
      const reportHolder = registerRunReport(tools, input);
      /** Whether this run already reminded a schema-bound child that its answer has to be submitted. */
      let reportReminded = false;
      /**
       * The two human-facing seams, declared before the planning tools capture `askTool` and
       * assigned once the emitter and queue exist.
       */
      let approveTool!: Approver;
      let askTool!: Questioner;
      let humanWaitMs: () => number = () => 0;
      let planning: PlanningTools | undefined;
      /** Uninstalls the planning tools; called when the plan is approved mid-run, and again (harmlessly) at run end. */
      const planningTools: (() => void)[] = [];
      if (input.planPhase) {
        planning = createPlanningTools({
          store,
          sessionId: input.sessionId,
          planId: input.planId!,
          ask: this.options.question
            ? (request, questionSignal) => askTool(request, questionSignal)
            : undefined,
          onProposed: (plan) => emit('plan.proposed', { plan }),
          onApproved: (plan) => emit('plan.approved', { plan, runId }),
        });
        for (const tool of planning.tools) planningTools.push(tools.replace(tool));
        runScoped.push(...planningTools);
      }
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      const statistics = emptyStatistics();
      const committedSummaryUsage = emptyStatistics();
      let text = '',
        status: RunStatus = 'failed',
        error: string | undefined,
        /** Why the run ended, when the reason has a name. Absent is a real answer: some failures are prose only. */
        code: FailureCode | undefined,
        /** The failure itself, when the thing that threw was one this runtime named (see `run/outcome.ts`). */
        endpointFailure: RunFailure | undefined,
        result!: RunResult;
      /** Every event type this run emitted, which is what the protocol invariant checks at the end. */
      const emittedTypes = new Set<string>();
      /**
       * One emitter for the run: identity, timing, activity and the child-stall signal. The
       * counters it shares with this loop are grouped here (see `RunEmission.childOutputTokens`).
       */
      const emission: RunEmission = {
        statistics,
        emittedTypes,
        toolCalls: new Map<string, number>(),
        toolSpanStarted: undefined,
        toolActivityStartedAt: undefined,
        childOutputTokens: new Map<string, number>(),
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
        // Read at call time: `approveTool` is assigned by the interaction adapters below.
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
      const automaticVerification = createAutomaticVerification({
        enabled:
          input.autoVerify === true &&
          !task &&
          !input.reportRequired &&
          (this.options.subagentDepth ?? 0) === 0,
        objective: input.prompt,
        isReadOnly: () => readOnly,
        plan: input.approvedPlan,
        tools,
        completion,
        workspace,
        signal,
        runtimeStatePaths: store.databaseFiles(),
        // A run without a contract of its own still invalidates the session's previous verdict when it edits.
        onChange: () => completion.noteWorkspaceChange(),
      });
      automaticVerification.register();
      await completion.captureBaselines();
      /**
       * The wrapper every model call of this run goes through, so answers and compaction summaries
       * are measured alike (`run/provider.ts`). Text-only connections never receive tool images
       * (`text-only-provider.ts`).
       */
      const measureProvider = createProviderMeasurement({
        provider: this.options.supportsVision === false ? textOnlyProvider(provider) : provider,
        store,
        sessionId: input.sessionId,
        runId,
        statistics,
        emit,
        admittedAt,
      });
      const measuredProvider = measureProvider('answer');
      // A configured summary model is measured by the same clock and statistics, so its time still counts.
      const summaryProvider = this.options.summaryProvider
        ? createProviderMeasurement({
            provider: this.options.summaryProvider,
            store,
            sessionId: input.sessionId,
            runId,
            statistics,
            emit,
          })('summary')
        : measureProvider('summary');
      const queue = new RunQueue();
      this.inbox.open(input.sessionId, { runId, queue, emit });
      /**
       * The approval and question adapters record each request and answer (`run/interaction.ts`).
       * `readOnly` is a getter because it can change mid-run.
       */
      ({
        approve: approveTool,
        ask: askTool,
        humanWaitMs,
      } = createRunInteraction({
        store,
        sessionId: input.sessionId,
        queue,
        emit,
        isReadOnly: () => readOnly,
        approve: this.options.approve,
        question: this.options.question,
      }));
      /**
       * Whether this turn carries the user's own input, read by the goal tools. It can only become
       * true: once the user types into a runtime-started round (`consume` below), the turn is
       * theirs.
       */
      let humanTurn = input.authority !== 'automatic';
      // The file-tool advice is said once per run (`tool-advice.ts`).
      let shellReadAdvised = false;
      const progressGuard = new ToolProgressGuard({
        workspace,
        investigationMs: limits.investigationMs,
        isQuery: (name) => tools.classify(name).query,
        // Model processing time excludes a person thinking about an approval or answering a question.
        now: () => statistics.modelMs,
        investigate: () =>
          !task &&
          !input.approvedPlan &&
          !input.reportRequired &&
          !completion.state.contractId &&
          !automaticVerification.hasProjectWork &&
          !store.goal(input.sessionId),
      });
      /**
       * After the investigation cutoff: `act` offers editors and targeted reads, `edit` is one last
       * editors-only round, and `conclude` offers nothing.
       */
      const queryState: { phase: 'none' | 'act' | 'edit' | 'conclude' } = { phase: 'none' };
      let noChangeActRounds = 0;
      // A refused edit is the model trying to make the change, not widening the search, so it has its own count.
      let failedEditActRounds = 0;
      /**
       * Whether an edit was attempted and nothing has landed since. If the cutoff ends the run in
       * this state, it must not report `completed`. Reads alone never set this.
       */
      let editRefusedUnchanged = false;
      let releaseAct: (() => void) | undefined;
      let refreshProgressTools: (() => void) | undefined;
      const setQueryPhase = (next: typeof queryState.phase): void => {
        if (next === queryState.phase) return;
        releaseAct?.();
        releaseAct = undefined;
        queryState.phase = next;
        if (next === 'act')
          releaseAct = tools.restrict({
            allow: [
              ...tools.namesWithEffect('workspace-file'),
              ...tools.namesWithEffect('workspace-read'),
            ],
          });
        else if (next === 'edit')
          releaseAct = tools.restrict({ allow: tools.namesWithEffect('workspace-file') });
        // Registry restrictions take effect immediately; the two cached catalogs need rebuilding too.
        refreshProgressTools?.();
      };
      const resetQueryPhase = (): void => {
        noChangeActRounds = 0;
        failedEditActRounds = 0;
        setQueryPhase('none');
      };
      const consume = (mode: InputMode): boolean => {
        const item = queue.take(mode);
        if (!item) return false;
        progressGuard.reset();
        progressGuard.resetOscillation();
        resetQueryPhase();
        /** A message the user typed makes this the user's turn, even in a runtime-started round. */
        humanTurn = true;
        const message = userMessage({
          workspace,
          prompt: item.prompt,
          createdAt: item.createdAt,
          images: item.images,
          modelInfo: this.options.modelInfo,
        });
        // The message and its inbox consumption are one write, so a crash cannot lose or duplicate
        // it.
        store.consumeQueuedInput(input.sessionId, item.id, message);
        emit('input.consumed', { id: item.id, message, queue: queue.items });
        return true;
      };
      /**
       * Learned from provider usage and carried across runs
       * (`packages/core/context/calibration.ts`). Keyed by route, so a different model or an
       * undeclared one does not inherit the measurement.
       */
      const calibrationRouteKey = calibrationRoute(this.options.modelInfo);
      const calibration = TokenCalibration.from(
        store.newestPayload(input.sessionId, 'context.calibration'),
        calibrationRouteKey,
      );
      /**
       * Delegation. The coordinator is per-run state, so the tool is installed per run. Each child
       * is one level deeper and loses delegation at the depth cap.
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
          project,
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
      // The step the log has open, its timing, and the one way it closes (see `run/steps.ts`).
      const steps = new RunSteps({ store, sessionId: input.sessionId, runId, statistics, emit });
      /**
       * The compaction wait this run inherits and leaves (see `COMPACTION_RETRY_ROUNDS`).
       * `retryRound` is the first round that may start a threshold compaction; the remainder passes
       * on via `context.compaction.deferred`.
       */
      const compactionWait = {
        inherited: inheritedCompactionWait(store, input.sessionId),
        retryRound: 0,
        roundsStarted: 0,
      };
      compactionWait.retryRound = compactionWait.inherited;
      try {
        signal.throwIfAborted();
        const instructions = loadInstructions(workspace);
        const skills = discoverSkills(workspace, { analysisService: builtinServiceConfigured() });
        // The goal notice and the runtime snapshots the conversation carries (see `./run-snapshots.ts`).
        const announcements = createRunAnnouncements({
          store,
          sessionId: input.sessionId,
          workspace,
          memoryRoot: project,
          emit,
          taskId: input.taskId,
          task,
          completion,
        });
        if (ownWork) announcements.admitGoal();
        await announcements.snapshots(0);
        /**
         * The system prompt, assembled from named sections (`./prompt-sections.ts`) with a trace
         * kept. Rebuilt only when run state changes it.
         */
        const composeSystem = (planNotice: string): string => {
          const assembled = assemblePrompt(
            createRunPromptSections({
              agent: this.options,
              store,
              sessionId: input.sessionId,
              approvedPlan: input.approvedPlan,
              previousAttempt,
              instructions: instructions.text,
              planNotice: () => planNotice,
              verificationNotice: () => automaticVerification.guidance,
            }),
          );
          this.lastPrompt = assembled.trace;
          return assembled.text;
        };
        // The prompt, the schema, the program catalog and the policies they derive from (see `./run-surface.ts`).
        const surface = new RunSurface({
          store,
          sessionId: input.sessionId,
          tools,
          readOnly: () => readOnly,
          nativeTools: () => queryState.phase === 'act' || queryState.phase === 'edit',
          policy,
          executionPolicy,
          ...(this.options.permissionPolicy
            ? { currentPolicy: this.options.permissionPolicy }
            : {}),
          ...(this.options.executionPolicy
            ? { currentExecutionPolicy: this.options.executionPolicy }
            : {}),
          planNotice: planPhaseNotice(input.planPhase === true, Boolean(this.options.question)),
          composeSystem,
        });
        refreshProgressTools = () => surface.refreshTools();
        /**
         * The model tool-call batch, one per run (`run/tools.ts`). Seams that change between rounds
         * are passed as getters so each call runs under the values in force when it runs.
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
          executionPolicy: () => surface.executionPolicy,
          executionPolicyForCall: this.options.executionPolicy,
          permissionPolicyForCall: this.options.permissionPolicy,
          approve: () => approveTool,
          ask: () => askTool,
          humanTurn: () => humanTurn,
          catalogSpecs: () => surface.catalog,
        });
        store.append(
          input.sessionId,
          userMessage({
            workspace,
            prompt: input.prompt,
            createdAt: new Date().toISOString(),
            images: input.images,
            modelInfo: this.options.modelInfo,
          }),
        );
        emit('run.started', {});
        /**
         * Record loaded instruction files and skills durably too, with the same payload as the live
         * frame.
         */
        store.recordEvent(input.sessionId, 'resources.loaded', {
          instructions: instructions.files,
          skills,
        });
        emit('resources.loaded', { instructions: instructions.files, skills });
        // The model each round aims at, and the transitions between them (see `run/aim.ts`).
        const aim = new RunAim({
          store,
          sessionId: input.sessionId,
          runId,
          emit,
          modelInfo: this.options.modelInfo,
          capacityFor: this.options.capacityFor,
          maxContextTokens,
          maxOutputTokens,
        });
        // What each round asked the model to read (see `run/envelope.ts`).
        const envelopes = new RunEnvelopes(store, input.sessionId, runId);
        /**
         * The round loop counts rounds without bounding them. A run ends when the model stops
         * calling tools, on cancellation, on provider refusal, or at a ceiling (output limit,
         * window, tool clock, run budget). Goal continuations are bounded by
         * `GOAL_DEFAULTS.maxGoalRounds`. Every round opens a step in the log.
         */
        const loopStartedAt = Date.now();
        for (let round = 0; ; round++) {
          signal.throwIfAborted();
          compactionWait.roundsStarted = round + 1;
          /**
           * The run's total budget, checked at a round boundary so nothing is half done
           * (`RunDefaults.maxRunRounds`; `0` turns one off). Excludes time spent waiting on a
           * person and cached input tokens.
           */
          const exhausted = runBudgetExhausted(limits, {
            rounds: round,
            elapsedMs: Date.now() - loopStartedAt - humanWaitMs(),
            tokens: billableTokens(usage),
          });
          if (exhausted) throw new RunFailure('run-budget', exhausted);
          /**
           * Apply a policy switched mid-run (permission preset or sandbox) and rebuild the prompt,
           * tool schema and execution policy from it. Calls already in flight keep their approved
           * policy (`executionPolicyForCall`).
           */
          if (surface.refreshPolicies()) {
            progressGuard.reset();
            progressGuard.resetOscillation();
            resetQueryPhase();
          }
          /**
           * Apply a plan approved in the previous round before building this round. The approver
           * enforces via `readOnly`; the rebuilt catalogue and prompt tell the model it may write.
           * Only `exit_plan_mode` writes the pending approval, and only after a human approved
           * (I8).
           */
          const approved = planning?.takeApproval();
          if (approved) {
            progressGuard.reset();
            progressGuard.resetOscillation();
            resetQueryPhase();
            readOnly = false;
            // Remove the planning tools after approval, before `setPlanNotice` rebuilds the
            // catalogue.
            for (const dispose of planningTools) dispose();
            automaticVerification.register(approved);
            surface.setPlanNotice(approvedPlanNotice(approved));
            // A run that may now write may also delegate writing work.
            coordinator?.promoteToWritable();
          }
          steps.begin(round);
          /**
           * Renew the lease at every step boundary. Renewal age decides nothing (see
           * `SessionLease`).
           */
          store.renewLease(input.sessionId, runId);
          while (consume('steer')) {
            /* deliver all corrections before the next request */
          }
          // Round preamble: hooks may refuse the run or add context, which is persisted as user
          // messages so nothing reaches the model that the transcript would not show (I7).
          const preStep = await tools.extensions.preStep(
            {
              sessionId: input.sessionId,
              runId,
              round,
              messages: store.messages(input.sessionId),
              // The default the round would use, so a policy can keep the run's model without
              // hardcoding it.
              model: aim.configuredModel ?? '',
            },
            signal,
          );
          if (preStep.blocked) throw new StepBlockedError(preStep.blocked);
          const roundAim = aim.aim(round, preStep);
          const { cacheKeyOf } = roundAim;
          // Snapshots go before the round's injections: they describe the world, injections are
          // messages.
          await announcements.snapshots(round, {
            model: roundAim.model ?? provider.route?.model ?? null,
            protocol: this.options.modelInfo?.protocol ?? provider.route?.protocol,
          });
          if (preStep.inject.length)
            injectContext(store, input.sessionId, emit, preStep.inject.join('\n\n'), {
              source: 'pre-step',
              round,
              notes: preStep.inject.length,
            });
          /**
           * A `load_tools` call or a goal transition in the previous round changes this round's
           * catalog.
           */
          surface.refreshLoaded();
          if (automaticVerification.takeToolsChanged()) surface.refreshTools();
          const requestSpecs = queryState.phase === 'conclude' ? [] : surface.specs;
          const contextInput = buildContextInput({
            store,
            sessionId: input.sessionId,
            system: surface.system,
            tools: requestSpecs,
            provider: summaryProvider,
            limit: limits.maxContextChars,
            signal,
            maxOutputTokens: roundAim.outputTokens,
            maxContextTokens: roundAim.contextTokens,
            autoCompactTokens: this.options.autoCompactTokens,
            summaryTimeoutMs: limits.summaryTimeoutMs,
            onSummaryRetry: (details) => emit('context.summary.retry', details),
            // The summary request needs the key of its own prompt, or the provider places no cache
            // breakpoint.
            cacheKeyFor: cacheKeyOf,
            calibration,
            // Checked against the session's write lease before the summary request and at the
            // write.
            runId,
            // Recorded with the summary, alongside the protocol. Absent when the embedder declared
            // none.
            model: roundAim.model,
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
             * Run-level accumulators: `usage` is reported in the result, `committedSummaryUsage` is
             * what the session aggregates claim was stored.
             */
            usage,
            committedSummaryUsage,
            emit,
          });
          if (round < compactionWait.retryRound) contextInput.deferThresholdCompaction = true;
          const context = await prepareContext(contextInput);
          if (context.compactionProblem !== undefined)
            compactionWait.retryRound = round + 1 + COMPACTION_RETRY_ROUNDS;
          signal.throwIfAborted();
          // Recorded as the round is decided on it, from the prompt `prepareContext` returned (see `run/envelope.ts`).
          const recordEnvelope = (prepared: PreparedContext): void =>
            envelopes.record({
              round,
              system: prepared.system,
              tools: requestSpecs,
              model: roundAim.model,
              maxOutputTokens: roundAim.outputTokens,
              maxContextTokens: roundAim.contextTokens,
              cacheKey: cacheKeyOf(prepared.system, requestSpecs),
            });
          recordEnvelope(context);
          /**
           * Uses the resolved limit; `undefined` unless an operator set one (stalls are caught by
           * the stream idle timeout).
           */
          const response: ModelResponse = await requestRunRound({
            store,
            sessionId: input.sessionId,
            runId,
            round,
            limits,
            signal,
            context,
            contextInput,
            roundContextTokens: roundAim.contextTokens,
            measuredProvider,
            serialToolRoutes: this.serialToolRoutes,
            // Without modelInfo the provider exposes only protocol/model; connection identity is unavailable.
            routeKey: JSON.stringify([
              this.options.modelInfo?.protocol ?? provider.route?.protocol ?? '',
              roundAim.model ?? provider.route?.model ?? '',
              this.options.modelInfo?.connectionId ?? '',
            ]),
            specs: requestSpecs,
            requestedModel: roundAim.requestedModel,
            requestedEffort: roundAim.requestedEffort,
            cacheKeyOf,
            recordEnvelope,
            beforeRequest: (system) => admitVisibleBackground(store, input.sessionId, system),
            onVisibleText: (delta) => steps.visibleText(delta),
            onAnswerText: (answer) => {
              text = answer;
            },
            // A nudged answer stays in the model's history but is hidden beside its replacement
            // (`Message.provisional`).
            provisionalAnswer: async () => {
              await automaticVerification.assessChanges();
              return automaticVerification.willNudge();
            },
            commitStepTiming: (answered) => steps.commitTiming(answered),
            statistics,
            usage,
            calibration,
            calibrationRouteKey,
            emit,
          });
          // An abort after the terminal event keeps the text but runs no pending tool call.
          signal.throwIfAborted();
          if (response.toolCalls.length === 0) {
            if (queue.hasSteer || consume('follow-up')) {
              steps.end(round, 'queued-input');
              continue;
            }
            /**
             * A child with a caller-declared schema must answer through the tool. One reminder; a
             * second prose answer fails the child's turn.
             */
            if (
              input.reportSchema !== undefined &&
              reportHolder.data === undefined &&
              !reportReminded
            ) {
              reportReminded = true;
              injectContext(
                store,
                input.sessionId,
                emit,
                '<runtime-context source="report-required">\n' +
                  'This task asked for a structured result. Call submit_report now with an object that matches its schema; an answer written as prose is not delivered to the parent. If you are blocked, submit what you have.\n' +
                  '</runtime-context>',
                { source: 'report-required', round },
              );
              steps.end(round, 'queued-input');
              continue;
            }
            status = 'completed';
            const verificationGate = await automaticVerification.beforeAnswer();
            if (verificationGate === 'continue') {
              injectContext(
                store,
                input.sessionId,
                emit,
                // Wrapped as machine context so the transcript hides it while the model still reads
                // it.
                '<runtime-context source="automatic-verification">\n' +
                  'The work has no verification checks yet. Inspect the project guidance and relevant tests, then call verify_work with executable commands and args before finishing. If verification is blocked or unavailable, state the limitation honestly; do not invent passing evidence.\n' +
                  '</runtime-context>',
                { source: 'automatic-verification' },
              );
              progressGuard.reset();
              resetQueryPhase();
              steps.end(round, 'queued-input');
              continue;
            }
            if (verificationGate === 'review') {
              status = 'needs_review';
              error =
                automaticVerification.reviewError ??
                'The work ended without executable verification checks.';
              steps.end(round, 'final');
              break;
            }
            // The contract, the effect ledger and the verification round decide it (see `./run-verdict.ts`).
            const verdict = await settleAnswerRound({
              store,
              sessionId: input.sessionId,
              emit,
              completion,
              task,
              taskAttempt,
            });
            if (verdict.next === 'repair') {
              progressGuard.reset();
              progressGuard.resetOscillation();
              resetQueryPhase();
              steps.end(round, 'queued-input');
              continue;
            }
            status = verdict.status;
            if (verdict.error !== undefined) error = verdict.error;
            if (status === 'completed' && queryState.phase !== 'none' && editRefusedUnchanged) {
              status = 'needs_review';
              error =
                'The investigation limit ended the run after edit attempts that did not land; the project is unchanged.';
            }
            steps.end(round, 'final');
            break;
          }
          if (queryState.phase === 'conclude') {
            store.resolvePending(
              input.sessionId,
              'Not executed: the run reached a conclusion-only round.',
            );
            status = 'needs_review';
            error =
              'The investigation or repetition limit was reached; further tools were not executed.';
            steps.end(round, 'final');
            break;
          }
          // Write the message naming the tool calls before they run, so a crash mid-call is
          // recorded as an unknown outcome rather than replayed.
          store.flush(input.sessionId);
          // The batch owns grouping, the effect journal and result order (`run/tools.ts`).
          await automaticVerification.beforeTools(response.toolCalls);
          const { injected, changedGoals, observations } = await batch.run(response.toolCalls);
          automaticVerification.observe(observations);
          for (const goal of changedGoals) announcements.goal(goal);
          // Injected context becomes a persisted user message after the batch's results
          // (`run/input.ts`).
          for (const entry of injected)
            injectContext(store, input.sessionId, emit, entry.notes.join('\n\n'), {
              source: 'post-execute',
              callId: entry.callId,
              notes: entry.notes.length,
            });
          // Only an unseen note counts as an intervention (`ToolProgressGuard.newIntervention`).
          const intervened =
            changedGoals.length > 0 ||
            progressGuard.newIntervention(injected.flatMap((entry) => entry.notes));
          let progress = intervened
            ? (progressGuard.reset(), progressGuard.observeWrites(observations))
            : progressGuard.observeRound(observations);
          // One record per hit, for later cost review.
          for (const hit of progressGuard.takeOscillationEvents()) {
            const record = { runId, round, count: hit.count, signal: hit.signal };
            store.recordEvent(input.sessionId, 'edit.oscillation', record);
            emit('edit.oscillation', record);
          }
          if (progress === 'investigation-warn' || progress === 'investigation-conclude') {
            await automaticVerification.assessChanges();
            if (automaticVerification.hasProjectWork) {
              progressGuard.reset();
              progress = 'continue';
            }
          }
          if (progress === 'conclude') {
            setQueryPhase('conclude');
          } else if (queryState.phase === 'act' || queryState.phase === 'edit') {
            const projectChanged = observations.some(
              ({ result }) =>
                result.change && projectChangedPaths(result.change, workspace).length > 0,
            );
            const editors = new Set(tools.namesWithEffect('workspace-file'));
            const editRefused = observations.some(
              ({ call, result }) =>
                result.isError &&
                editors.has(call.name) &&
                !/excluded by a restriction/.test(result.content),
            );
            // Only an edit aimed at the project: a refused scratch probe is investigation, not the change.
            if (
              observations.some(
                ({ call, result }) =>
                  result.isError &&
                  editors.has(call.name) &&
                  !/excluded by a restriction/.test(result.content) &&
                  editTargets(call).some((target) => {
                    const relative = target.replaceAll('\\', '/').replace(/^\.\//, '');
                    return relative !== '.scratch' && !relative.startsWith('.scratch/');
                  }),
              )
            )
              editRefusedUnchanged = true;
            if (projectChanged) {
              editRefusedUnchanged = false;
              // Preserve failure/blocker counts across edits; only leave the edit-only phase.
              resetQueryPhase();
            } else if (queryState.phase === 'edit') {
              setQueryPhase('conclude');
              progress = 'act-conclude';
            } else if (
              editRefused
                ? ++failedEditActRounds >= ACT_FAILED_EDIT_ROUNDS
                : ++noChangeActRounds >= ACT_NO_CHANGE_ROUNDS
            ) {
              // One editors-only round before concluding, so the edit the reads were preparing can
              // still land.
              setQueryPhase('edit');
              // The specs are rebuilt by the phase change: a read-only run has no editors to offer.
              const canEdit = surface.specs.length > 0;
              if (!canEdit) setQueryPhase('conclude');
              progress = canEdit ? 'act-final' : 'act-conclude';
            } else if (progress === 'investigation-conclude') {
              // An exhausted investigation is still exhausted; it cannot buy a fresh allowance of attempts.
              progress = 'continue';
            }
          } else if (progress === 'investigation-conclude') {
            setQueryPhase('act');
            if (!surface.specs.length) {
              setQueryPhase('conclude');
              progress = 'conclude';
            }
          }
          if (progress !== 'continue') {
            injectContext(store, input.sessionId, emit, toolProgressNotice(progress), {
              source: 'tool-progress',
              round,
              action: progress,
            });
          }
          // Only suggest file tools when the run actually has them.
          const shellReader =
            !shellReadAdvised && surface.specs.some((spec) => spec.name === 'read_file')
              ? shellReadIn(observations.map(({ call }) => call))
              : undefined;
          if (shellReader) {
            shellReadAdvised = true;
            injectContext(store, input.sessionId, emit, shellReadNotice(shellReader), {
              source: 'tool-advice',
              round,
            });
          }
          // Submitting the plan ends the planning run; the next step is a human decision.
          if (planning?.submitted) {
            status = 'completed';
            steps.end(round, 'final');
            break;
          }
          // A submitted report or schema answer ends the child run.
          if (reportHolder.report || reportHolder.data !== undefined) {
            status = 'completed';
            steps.end(round, 'final');
            break;
          }
          // The last of the ordinary ways out: the step asked for tools, they ran, and the run continues.
          steps.end(round, 'tool-calls');
        }
      } catch (cause) {
        // Closed before anything else in here can fail, so no path out of a run leaves its last step open.
        if (steps.open !== null) steps.end(steps.open, stepEndReason(cause, signal.aborted));
        const outcome = settleThrownRun({
          store,
          sessionId: input.sessionId,
          runId,
          cause,
          aborted: signal.aborted,
        });
        if (outcome.text !== undefined) text = outcome.text;
        ({ status, error, code, endpointFailure } = outcome);
      } finally {
        resetQueryPhase();
        const remainingWait = Math.max(0, compactionWait.retryRound - compactionWait.roundsStarted);
        // Written only when there is a wait to hand over, or an inherited one to clear: most runs record nothing.
        if (remainingWait > 0 || compactionWait.inherited > 0)
          store.recordEvent(input.sessionId, 'context.compaction.deferred', {
            runId,
            remainingRounds: remainingWait,
          });
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
            this.inbox.discard(ids, input.sessionId, reason);
            this.inbox.release(input.sessionId, runId);
          },
          checkRunEnd: (result, types) =>
            checkRunEnd(this.options, result, input.sessionId, runId, types),
        });
      }
      return result;
    } catch (cause) {
      // Close what is still this run's: the live queue entry if it is ours, and the run row (see `abandonRun`).
      this.inbox.release(input.sessionId, runId);
      abandonRun(store, input.sessionId, runId, cause);
      throw cause;
    } finally {
      for (const dispose of runScoped.splice(0).reverse()) dispose();
    }
  }
}
