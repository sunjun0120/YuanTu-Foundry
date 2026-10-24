import { type FailureCode, RunFailure } from '../protocol/failure.ts';
import type {
  Approver,
  FileChange,
  ModelResponse,
  Questioner,
  RunResult,
  RunStatus,
  Usage,
  UserInput,
} from '../protocol/index.ts';
import { validateUserInput } from '../protocol/images.ts';
import { resolveRunLimits } from '../protocol/settings.ts';
import { emptyStatistics } from '../protocol/statistics.ts';
import { loadInstructions } from '../tools/instructions.ts';
import { discoverSkills } from '../resources/skills.ts';
import { goalTools } from '../tools/goal.ts';
import type { AgentOptions, AgentRunInput } from './agent-options.ts';
import { admitVisibleBackground } from './background-deliveries.ts';
import { TokenCalibration, calibrationRoute } from './calibration.ts';
import { prepareContext, type PreparedContext } from './context.ts';
import { createPlanningTools, type PlanningTools } from './plan-tools.ts';
import { assemblePrompt, type PromptTrace } from './prompt-sections.ts';
import { abandonRun, submitPrompt } from './run-admission.ts';
import { RunAim } from './run-aim.ts';
import { createRunCompletion } from './run-completion.ts';
import { createAutomaticVerification } from './automatic-verification.ts';
import { buildContextInput } from './run-context.ts';
import { createRunDelegation, registerRunReport } from './run-delegation.ts';
import { createRunEmit, type RunEmission } from './run-emit.ts';
import { RunEnvelopes } from './run-envelope.ts';
import { checkRunEnd, finalizeRun } from './run-finalization.ts';
import { RunInbox } from './run-inbox.ts';
import { injectContext, userMessage } from './run-input.ts';
import { createRunInteraction } from './run-interaction.ts';
import { StepBlockedError, settleThrownRun, stepEndReason } from './run-outcome.ts';
import { approvedPlanNotice, createRunPromptSections, planPhaseNotice } from './run-prompt.ts';
import { createRunAnnouncements } from './run-snapshots.ts';
import { RunSteps } from './run-steps.ts';
import { RunSurface } from './run-surface.ts';
import { settleAnswerRound } from './run-verdict.ts';
import { createProviderMeasurement } from './run-provider.ts';
import { RunQueue, type InputMode, type QueuedInput } from './run-queue.ts';
import { requestRunRound } from './run-request.ts';
import { ResidentTurnSettlements } from './run-residency.ts';
import { loadRunTask, registerTaskStepTool, startRunTask } from './run-task.ts';
import { createToolBatch } from './run-tools.ts';
import { ToolProgressGuard, toolProgressNotice } from './tool-progress.ts';
import { projectChangedPaths } from './work-evidence.ts';
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
 * Serial number for the ids of messages handed to sub-agents.
 *
 * The id has to be unique across the *log*, not just this process: the inbox fold removes an entry by id, so a
 * repeat after a restart would silently cancel a message that was never delivered. The timestamp covers the
 * restart, the counter covers two messages in the same millisecond.
 */
let messageCounter = 0;
/**
 * Rounds a failed threshold compaction waits before it is tried again.
 *
 * A summary that failed (refused, timed out, answered with a tool call) usually fails the same way on the next
 * round, and each attempt costs a model request and up to the summary deadline. A request that stops fitting is
 * still compressed immediately; only the early, threshold-driven attempt waits.
 */
const COMPACTION_RETRY_ROUNDS = 3;

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
  /** The live queue of each running session, and the log behind it once nothing runs (see `run-inbox.ts`). */
  private inbox: RunInbox;
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
    this.inbox = new RunInbox(options.store);
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
   * What the system prompt of this agent's last assembled round was made of.
   *
   * Every section the composition registers, in assembly order, with whether it contributed text, had none to
   * contribute, or was replaced by another section. Reported rather than inferred: a prompt is a thing a person
   * has to be able to audit, and "which persona was in effect for this run" is not answerable from a string.
   */
  promptSections(): readonly PromptTrace[] {
    return this.lastPrompt;
  }
  async run(input: AgentRunInput): Promise<RunResult> {
    const admittedAt = input.admittedAt ?? Date.now();
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
    /**
     * Everything from here on runs with the run row open and the session's lease held.
     *
     * The round loop's own `try`/`finally` is what normally closes both, but it starts only once the run's
     * seams exist, and building them can throw (a task deleted under the run, a store write that fails, a
     * calibration record that does not parse). A throw in that window used to leave `active_run` naming a live
     * process — the lease never expires on time, so the session refused every later run until the Host restarted.
     * The outer guard closes whatever is still open; on the ordinary path the run is already finished and it
     * does nothing.
     */
    /**
     * Undo for the run-scoped tools whose closures name this run's goal standing or plan record.
     *
     * A registry can outlive a run (a goal's continuation rounds, an embedded host), and a planning tool left behind
     * would offer the next run an `exit_plan_mode` bound to a plan that is no longer being made.
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
      if (ownWork) for (const tool of goalTools()) runScoped.push(tools.replace(tool));
      registerTaskStepTool(store, tools, input, task, taskAttempt, (type, data) =>
        emit(type, data),
      );
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
        for (const tool of planning.tools) runScoped.push(tools.replace(tool));
      }
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      const statistics = emptyStatistics();
      const committedSummaryUsage = emptyStatistics();
      let text = '',
        status: RunStatus = 'failed',
        error: string | undefined,
        /** Why the run ended, when the reason has a name. Absent is a real answer: some failures are prose only. */
        code: FailureCode | undefined,
        /** The failure itself, when the thing that threw was one this runtime named (see `run-outcome.ts`). */
        endpointFailure: RunFailure | undefined,
        result!: RunResult;
      /** Every event type this run emitted, which is what the protocol invariant checks at the end. */
      const emittedTypes = new Set<string>();
      /**
       * One emitter for the run: identity, timing, activity and the child-stall signal, in one place.
       *
       * The counters it shares with this loop are grouped here so the module that owns the emission rule can
       * read and write *this run's* numbers without owning them: `toolCalls` is opened and closed by the emitter's
       * tool frames while the loop settles whatever was still open when the run ended, `statistics` is folded by
       * both, and the child token map is the stall watchdog's memory (see `RunEmission.childOutputTokens`).
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
      const progressGuard = new ToolProgressGuard({
        workspace,
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
      const queryState: { phase: 'none' | 'act' | 'conclude' } = { phase: 'none' };
      let noChangeActRounds = 0;
      let releaseAct: (() => void) | undefined;
      let refreshProgressTools: (() => void) | undefined;
      const setQueryPhase = (next: typeof queryState.phase): void => {
        if (next === queryState.phase) return;
        releaseAct?.();
        releaseAct = undefined;
        queryState.phase = next;
        if (next === 'act')
          releaseAct = tools.restrict({ allow: tools.namesWithEffect('workspace-file') });
        // Registry restrictions take effect immediately; the two cached catalogs need rebuilding too.
        refreshProgressTools?.();
      };
      const resetQueryPhase = (): void => {
        noChangeActRounds = 0;
        setQueryPhase('none');
      };
      const consume = (mode: InputMode): boolean => {
        const item = queue.take(mode);
        if (!item) return false;
        progressGuard.reset();
        resetQueryPhase();
        /**
         * A message the user typed is the user's own input, whichever run is carrying it.
         *
         * This is what makes a correction fold-able into a round the runtime started: the round began on the
         * goal's behalf, and the person who owns the goal has since said something in it — so from here on the
         * turn may change the goal's standing, exactly as a request they typed would.
         */
        humanTurn = true;
        const message = userMessage({
          workspace,
          prompt: item.prompt,
          createdAt: item.createdAt,
          images: item.images,
          modelInfo: this.options.modelInfo,
        });
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
      // The step the log has open, its timing, and the one way it closes (see `run-steps.ts`).
      const steps = new RunSteps({ store, sessionId: input.sessionId, runId, statistics, emit });
      try {
        signal.throwIfAborted();
        const instructions = loadInstructions(workspace);
        const skills = discoverSkills(workspace);
        // The goal notice and the runtime snapshots the conversation carries (see `./run-snapshots.ts`).
        const announcements = createRunAnnouncements({
          store,
          sessionId: input.sessionId,
          workspace,
          emit,
          taskId: input.taskId,
          task,
          completion,
        });
        if (ownWork) announcements.admitGoal();
        await announcements.snapshots(0);
        /**
         * The system prompt, assembled from named, ordered sections (`./prompt-sections.ts`), with the trace kept so
         * a caller can ask what the prompt it just sent was made of. Rebuilt only when the run's state changes it.
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
        // The model each round aims at, and the transitions between them (see `run-aim.ts`).
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
        // What each round asked the model to read (see `run-envelope.ts`).
        const envelopes = new RunEnvelopes(store, input.sessionId, runId);
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
        /** The first round that may again start a threshold compaction after one failed (see `COMPACTION_RETRY_ROUNDS`). */
        let compactionRetryRound = 0;
        const loopStartedAt = Date.now();
        for (let round = 0; ; round++) {
          signal.throwIfAborted();
          /**
           * The run's total budget, checked where a round begins: every tool result of the round before is already
           * recorded, so stopping here leaves nothing half done. This is the backstop the comment above leaves
           * room for — not a guess at the task's size, but the ceiling an operator set on what one run may spend
           * when nobody is watching it (`RunDefaults.maxRunRounds`; `0` turns a budget off).
           */
          const exhausted = runBudgetExhausted(limits, {
            rounds: round,
            elapsedMs: Date.now() - loopStartedAt,
            tokens: usage.inputTokens + usage.outputTokens,
          });
          if (exhausted) throw new RunFailure('run-budget', exhausted);
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
          if (surface.refreshPolicies()) {
            progressGuard.reset();
            resetQueryPhase();
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
            progressGuard.reset();
            resetQueryPhase();
            readOnly = false;
            automaticVerification.register(approved);
            surface.setPlanNotice(approvedPlanNotice(approved));
            // The delegation guard was built with this run's original promise; a run that may now write may also
            // delegate work that writes, so the coordinator is told rather than left refusing a general child.
            coordinator?.promoteToWritable();
          }
          steps.begin(round);
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
              model: aim.configuredModel ?? '',
            },
            signal,
          );
          if (preStep.blocked) throw new StepBlockedError(preStep.blocked);
          const roundAim = aim.aim(round, preStep);
          const { cacheKeyOf } = roundAim;
          // The state the round is about to be asked about, before the round's own injections: a policy note is a
          // message to the model, while a snapshot is the world it is being asked about.
          await announcements.snapshots(round);
          if (preStep.inject.length)
            injectContext(store, input.sessionId, emit, preStep.inject.join('\n\n'), {
              source: 'pre-step',
              round,
              notes: preStep.inject.length,
            });
          /**
           * A `load_tools` call (or a direct call to a held-back tool) in the previous round widens this round's
           * catalog, and a goal created (or finished) in it adds (or drops) `update_goal`. The transcript part only
           * grows, so the catalog changes once per load or goal transition, not per round.
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
             * The two accumulators below are the run's own, not this round's: `usage` is what the result reports
             * and `committedSummaryUsage` is what the session's aggregates claim was stored, so the callbacks have
             * to write into the objects the loop keeps for the rest of the run.
             */
            usage,
            committedSummaryUsage,
            emit,
          });
          if (round < compactionRetryRound) contextInput.deferThresholdCompaction = true;
          const context = await prepareContext(contextInput);
          if (context.compactionProblem !== undefined)
            compactionRetryRound = round + 1 + COMPACTION_RETRY_ROUNDS;
          signal.throwIfAborted();
          // Recorded as the round is decided on it, from the prompt `prepareContext` returned (see `run-envelope.ts`).
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
           * The resolved limit, not the raw option: `resolveRunLimits` is what decides whether an operator asked
           * for a total wall-clock limit at all, and reading `this.options` here made the answer depend on
           * whether the value came from a CLI flag or from the defaults — the one number `RunDefaults` owned in
           * two places. There is no default for the main request (a streaming model is making progress; the
           * stream idle timeout is what catches a stalled one), so this is `undefined` unless a limit was set.
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
            // A nudged answer is still real model output and stays in the model's history, but the transcript
            // must not show it beside the answer the nudge produces (see `Message.provisional`).
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
          // An abort after the provider's terminal event must keep the completed text while still
          // refusing to execute any pending tool call.
          signal.throwIfAborted();
          if (response.toolCalls.length === 0) {
            if (queue.hasSteer || consume('follow-up')) {
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
                // Wrapped like every other machine-written context: the transcript hides it by its tag, and the
                // model still reads exactly the instruction it needs. Unwrapped, the nudge appeared as if the
                // person had typed it between the two answers.
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
              resetQueryPhase();
              steps.end(round, 'queued-input');
              continue;
            }
            status = verdict.status;
            if (verdict.error !== undefined) error = verdict.error;
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
          // The tool calls are about to run. The message that names them is written first, so a crash while a
          // tool is in flight leaves the record that lets recovery report its outcome as unknown rather than
          // letting the call be replayed as if it had never happened. Everything the round appends after this
          // point is written as one batch by the next read or by the end of the run.
          store.flush(input.sessionId);
          // The calls run inside the batch that owns their grouping, their effect journal and the order their
          // results are recorded in (see `run-tools.ts`); what comes back is what the model is told *after* those
          // results, which is the loop's own step.
          await automaticVerification.beforeTools(response.toolCalls);
          const { injected, changedGoals, observations } = await batch.run(response.toolCalls);
          automaticVerification.observe(observations);
          for (const goal of changedGoals) announcements.goal(goal);
          // Context a post-execute policy asked to inject becomes a persisted user message *after* the
          // batch's tool results, never a field riding along inside a tool block (see `run-input.ts`).
          for (const entry of injected)
            injectContext(store, input.sessionId, emit, entry.notes.join('\n\n'), {
              source: 'post-execute',
              callId: entry.callId,
              notes: entry.notes.length,
            });
          let progress =
            injected.length || changedGoals.length
              ? (progressGuard.reset(), 'continue')
              : progressGuard.observeRound(observations);
          if (progress === 'investigation-warn' || progress === 'investigation-conclude') {
            await automaticVerification.assessChanges();
            if (automaticVerification.hasProjectWork) {
              progressGuard.reset();
              progress = 'continue';
            }
          }
          if (progress === 'conclude') {
            setQueryPhase('conclude');
          } else if (queryState.phase === 'act') {
            const projectChanged = observations.some(
              ({ result }) =>
                result.change && projectChangedPaths(result.change, workspace).length > 0,
            );
            if (projectChanged) {
              // Preserve failure/blocker counts across edits; only leave the edit-only phase.
              resetQueryPhase();
            } else if (++noChangeActRounds >= 2) {
              setQueryPhase('conclude');
              progress = 'conclude';
            } else if (progress === 'investigation-conclude') {
              // An exhausted investigation is still exhausted; it cannot buy a fresh pair of attempts.
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
          // Submitting the plan ends the planning run: the next step is a human decision, and letting
          // the loop continue would only burn rounds on a phase that cannot change anything.
          if (planning?.submitted) {
            status = 'completed';
            steps.end(round, 'final');
            break;
          }
          // A submitted report ends the child run too: the parent is waiting for the answer, and further
          // rounds would only spend the budget the two of them share. A custom schema's answer ends it the
          // same way — the caller asked for one object, and the child submitted it.
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
