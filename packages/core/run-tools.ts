import type { FileChange, ToolCall, ToolContext } from '../protocol/index.ts';
import type { ToolExecutionResult } from '../protocol/tool-pipeline.ts';
import type { Goal } from '../protocol/goals.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { digestFileStates, type FileStateDigest } from '../tools/file-state-digest.ts';
import { spillOutput } from '../tools/spill.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { commandJournal } from './command-jobs.ts';
import type { RunCompletion } from './run-completion.ts';
import type { InvariantRegistry } from './invariants.ts';
import type { RunEmit } from './run-emit.ts';
import type { RunQueue } from './run-queue.ts';
import { groupToolCalls, runBounded } from './tool-schedule.ts';
import type { ToolObservation } from './tool-progress.ts';

/**
 * One round's model tool calls: which of them may overlap, the pool that runs them, and the order their results
 * are written in.
 *
 * The model asks for a whole batch at once, and this module is what turns that batch into work without giving up
 * any of the promises the rest of the runtime makes about a call. Four of them are why this is one unit:
 *
 * - **Overlap is the tool's own statement.** Sibling calls are independent as far as the model is concerned, but
 *   only a call whose tool promised `isConcurrencySafe` may run beside a sibling, and the grouping is by
 *   adjacency: a write between two reads stays between them, because a barrier here is the model's own order
 *   preserved rather than a penalty the scheduler invented.
 * - **The record stays in model order.** `tool.started` announces a whole group up front, while the results are
 *   appended, announced and journalled strictly in the order the model wrote them, so a fast read can never
 *   overtake a slow sibling in the transcript or in the log.
 * - **A call is one effect journal entry even when several overlap.** The id is per invocation rather than
 *   shared, because a single `let` would let the second call's entry overwrite the first one's, and a task would
 *   then be told an effect completed that it never recorded.
 * - **The batch ends after the whole batch.** A steer retires the calls it superseded with that reason recorded,
 *   a cancellation leaves the unresolved call to `resolvePending`, and the first failure in model order is
 *   rethrown only once every started call has been awaited — a tool cannot be uninvented.
 *
 * The two things a batch produces that are *not* tool results — the context a post-execute policy asked to
 * inject, and the goals the model changed — are handed back rather than published here. Both are conversation,
 * and conversation may not jump in front of an outstanding tool call: the loop that calls this appends the
 * batch's results first, and then announces them, in the same order it always did.
 *
 * Every seam this reads belongs to the run: the read-only flag, the round's policies, the approver pair, the
 * human-turn fact and the program catalog are all *live*, reassigned between rounds, so they arrive as getters
 * and are read where the call that depends on them runs. What is fixed for the run — the store, the queue, the
 * signal, the batch's width — arrives as a value.
 */

export interface RunToolBatchOptions {
  store: SessionStore;
  sessionId: string;
  runId: string;
  /** The execution root the calls work in, and the directory oversized output spills into. */
  workspace: string;
  /** The run's cancellation signal: once it aborts, no further call of the batch is started. */
  signal: AbortSignal;
  emit: RunEmit;
  /** The run's own registry: what a call executes through, and the pipeline trace the invariant checks. */
  tools: ToolRegistry;
  /** The run's input queue, whose steering signal retires the pending calls a correction superseded. */
  queue: RunQueue;
  /** How many calls of a group may be in flight at once, which is the width a program may not exceed either. */
  maxParallelToolCalls: number;
  /** Whether this run is the session's own front door, which is what lets a goal change be announced at all. */
  ownWork: boolean;
  /** The task attempt an accepted call's effect is journalled against, when the run has one. */
  taskEffectScope: { sessionId: string; taskId: string; attemptId: string } | undefined;
  /** The session the file journal belongs to, which for a delegated child is its parent's. */
  journalSessionId: string;
  /**
   * The run's completion contract, as the goal seam reads it.
   *
   * A value rather than a getter because there is at most one contract per run and the object is built once
   * (`run-completion.ts`); what changes during the run are the fields inside its state, and those are read here
   * the moment a `goal_complete` call arrives.
   */
  completion: RunCompletion;
  /** Tags a change with the sub-agent that made it, so a child's work is not read as the parent's. */
  tagChange(change: FileChange): FileChange;
  /** Where the run publishes and checks runtime invariants — the type of `AgentOptions.invariants`. */
  invariants: InvariantRegistry | undefined;
  /**
   * Whether this run may change anything, read per context.
   *
   * A getter because approving a plan mid-run lifts it (`exit_plan_mode`): the call that arrives afterwards has
   * to run under the run a person approved, not under the read-only promise made when this factory was built.
   */
  readOnly(): boolean;
  /**
   * The execution snapshot the current round was built with, read per context.
   *
   * The snapshot is what the prompt and the tool schema described, which is the right shape for those; the
   * trusted selection below is what a call that has been waiting is rechecked against.
   */
  executionPolicy(): ToolContext['executionPolicy'];
  /** The host's live execution policy, rechecked immediately before a waiting call's body runs. */
  executionPolicyForCall?: ToolContext['executionPolicyForCall'];
  /** The host's live permission policy, rechecked immediately before a waiting call's body runs. */
  permissionPolicyForCall?: ToolContext['permissionPolicyForCall'];
  /** The approval seam, read per call: the run's adapters are assigned after this factory is built. */
  approve(): ToolContext['approve'];
  /** The question seam, read per call for the same reason. */
  ask(): ToolContext['ask'];
  /** Whether this turn carries the user's own input, which the goal tools read once per call. */
  humanTurn(): boolean;
  /** The run's program catalog, rebuilt per round: what a `run_code` program may call. */
  catalogSpecs(): NonNullable<ToolContext['catalog']>['specs'];
}

export interface RunToolBatch {
  /** Runs one round's calls in model order, honouring the group scheduler and the run's width. */
  run(calls: readonly ToolCall[]): Promise<{
    injected: { callId: string; notes: string[] }[];
    changedGoals: Goal[];
    observations: ToolObservation[];
  }>;
}

/** What one executed call hands back to the batch. */
interface CallOutcome {
  effectId: string | undefined;
  result: Omit<ToolExecutionResult, 'additionalContext'>;
  additionalContext: string[] | undefined;
}

interface CallTiming {
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

/** Where one call's by-products go. */
interface CallScope {
  timing: CallTiming;
  /** The monotonic clock reading `timing.queuedAt` corresponds to. */
  queuedClock: number;
  observations: ToolObservation[];
  changedGoals: Goal[];
}

const newTiming = (queuedAt: number): CallTiming => ({
  queuedAt,
  queueMs: 0,
  dispatchMs: 0,
  durationMs: 0,
  attempts: 0,
  finishedAttempts: 0,
});

/**
 * The batch one round's calls run through, built once per run.
 *
 * The body below is the batch in full: the per-call context (including the effect journal, the file journal and
 * the program catalog), the group scheduler, the bounded pool and the result loop. Splitting it across the run
 * loop is what the getters are for — the loop keeps owning the state, this owns the order it is used in.
 */
export function createToolBatch(options: RunToolBatchOptions): RunToolBatch {
  const {
    store,
    sessionId,
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
    invariants,
    completion,
    readOnly,
    executionPolicy,
    executionPolicyForCall,
    permissionPolicyForCall,
    approve,
    ask,
    humanTurn,
    catalogSpecs,
  } = options;
  let activeExecutions = 0;
  let peakConcurrency = 0;
  /**
   * One call, from its own effect journal entry to its own tool result.
   *
   * `effectId` is per invocation rather than shared, because two calls of the same batch can be in
   * flight at once once the group scheduler below overlaps them: a single `let` would let the second
   * call's journal entry overwrite the first one's, and a task would then be told an effect completed
   * that it never recorded.
   */
  const runToolCall = async (call: ToolCall, scope: CallScope): Promise<CallOutcome> => {
    const { timing, observations, changedGoals } = scope;
    const dispatchClock = performance.now();
    timing.queueMs = Math.max(0, dispatchClock - scope.queuedClock);
    timing.dispatchStartedAt = Date.now();
    try {
      let programCalls = 0;
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
      const pending = new Map<string, FileStateDigest[]>();
      const toolContext = (callId: string, fileStates: FileStateDigest[]): ToolContext => ({
        signal,
        /**
         * The call's identity and its run's promise. A policy hook that reports about a call has to be
         * able to name the session, and one that would touch the world outside this process has to be
         * able to see that this run promised not to.
         */
        sessionId,
        workspaceRoot: workspace,
        readOnly: readOnly(),
        ...(executionPolicy() ? { executionPolicy: executionPolicy() } : {}),
        /**
         * The policy *getters*, so a call can be judged by the policy in force when it runs.
         *
         * `executionPolicy` above is the snapshot this round was built with — what the prompt and the tool
         * schema describe — and a snapshot is the right shape for those. It is the wrong shape for a call
         * that has been waiting: the desktop can switch the sandbox while an approval is open, and the
         * command that finally runs has to run in the backend that is selected *now*, not the one that was
         * selected when the model asked. The tool layer reads these per call and rechecks execution.
         */
        ...(executionPolicyForCall ? { executionPolicyForCall } : {}),
        ...(permissionPolicyForCall ? { permissionPolicyForCall } : {}),
        // Output too large for a result goes to this session's spill directory. The run supplies it
        // because the run is what knows the session and, through it, the workspace the file belongs in.
        spill: ({ tool, content }) => spillOutput({ workspace, sessionId, tool, content }),
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
        /**
         * The write boundary, where both sides of every file still exist.
         *
         * The oscillation guard needs to know a write put a file back the way it was, and after this point the
         * "before" bytes are gone. So the digests are taken here, immediately before the journal row is written,
         * and handed to this call's observation — never to the result, the request or the session log.
         */
        fileJournal: {
          prepare: (change, before, after) => {
            const id = store.prepareFileChange(journalSessionId, tagChange(change), before, after);
            pending.set(id, digestFileStates([{ path: change.path, before, after }]));
            return id;
          },
          prepareGroup: (change, files) => {
            const id = store.prepareFileChangeGroup(journalSessionId, tagChange(change), files);
            pending.set(id, digestFileStates(files));
            return id;
          },
          applied: (id) => {
            store.markFileChange(id, 'applied');
            fileStates.push(...(pending.get(id) ?? []));
            pending.delete(id);
          },
        },
        approve: approve(),
        ask: ask(),
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
          read: () => store.todos(sessionId),
          write: (items) => {
            store.recordEvent(sessionId, 'todo.written', { todos: items });
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
          read: () => store.deliverables(sessionId),
          write: (files) => {
            store.recordEvent(sessionId, 'deliverable.presented', { files });
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
          read: () => store.goal(sessionId),
          // Read as the context is built, which is once per tool call: a run that consumed a message from
          // the user mid-flight is the user's turn from that step onwards, and the next call is the one
          // that has to see it.
          human: humanTurn(),
          /**
           * Whether the completion contract lets this goal be closed as complete.
           *
           * The binding is deliberate and narrow: a goal only answers to a contract whose objective is
           * *exactly* the goal's own. A task the user approved for something else must not be able to close
           * a goal it never described, and an unbound goal keeps its old behaviour instead of being held
           * retroactively to criteria nobody wrote.
           */
          canComplete: async () => {
            const goal = store.goal(sessionId);
            if (!goal || !completion.state.contractId || !completion.state.contractSpec)
              return { allowed: true };
            if (goal.objective !== completion.state.contractSpec.objective)
              return { allowed: true };
            if (completion.state.summary?.state === 'verified') return { allowed: true };
            return {
              allowed: false,
              reason:
                completion.state.summary?.reason ??
                'no verification round has passed for this contract yet',
            };
          },
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
            store.recordEvent(sessionId, 'goal.changed', { action, goal });
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
        commandJournal: commandJournal(store, sessionId),
        /**
         * What a program may call, and the only way it can call it.
         *
         * `tools.execute` is the same entry point the model's own calls use, so there is no second dispatch
         * path to keep in step — a guard, a permission rule or a timeout added for a direct call applies to
         * an inner one the moment it exists. The registry is *this run's*, which is why a delegated run hands
         * its program the child's tools and not the parent's.
         */
        catalog: {
          specs: catalogSpecs(),
          invoke: async (inner, innerSignal) => {
            const innerFileStates: FileStateDigest[] = [];
            const innerContext = toolContext(inner.id, innerFileStates);
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
            programCalls++;
            observations.push({
              call: inner,
              result,
              ...(innerFileStates.length ? { fileStates: innerFileStates } : {}),
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
            store.recordEvent(sessionId, 'program.call.settled', {
              callId: inner.id,
              name: inner.name,
              state,
              ...(result
                ? { isError: result.isError, content: result.content.slice(0, 24000) }
                : {}),
            });
            const intent = programEffects.get(inner.id);
            if (intent && state === 'known' && result && !result.isError && taskEffectScope) {
              store.completeTaskEffect(taskEffectScope.sessionId, taskEffectScope.taskId, intent);
              programEffects.delete(inner.id);
            }
          },
        },
      });
      const fileStates: FileStateDigest[] = [];
      /**
       * Sandbox preparation a call is waiting on, before any command starts.
       *
       * The ambient context is established by the registry, where the call's own signal exists; this is the
       * observer it carries. The stop frame matters as much as the start: a preparation that ended because the
       * helper refused or the call was cancelled has to clear the status line too.
       */
      const context: ToolContext = {
        ...toolContext(call.id, fileStates),
        onPreparation: (progress) =>
          emit('tool.preparation', {
            callId: call.id,
            name: call.name,
            stage: progress.stage,
            root: progress.root,
            active: progress.active,
          }),
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
            queuedAt: timing.queuedAt,
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
          const type = phase === 'started' ? 'tool.execution.started' : 'tool.execution.finished';
          /**
           * The tool's own name rides on the record, and it is the one field a *reader* needs.
           *
           * Everything else here measures how a call was carried out — how many attempts, how long, how many
           * ran at once — which answers "was this run healthy". The name answers "what did it actually do",
           * which is the question a workspace result has to be able to answer from durable evidence rather
           * than from the model's prose: a result that carried only durations could not say whether a child
           * ran the test suite or merely said it had.
           */
          store.recordEvent(sessionId, type, {
            runId,
            tool: call.name,
            ...measurement,
          });
          emit(type, measurement);
        },
      };
      /**
       * The preparation observer above is the only path to the live channel.
       *
       * The registry turns it into an ambient context around the body, carrying the run's signal: stopping the
       * run reaches a first authorization that has no deadline of its own, while a single call's deadline must
       * not discard a walk the next call would have to repeat.
       */
      const { additionalContext, ...result } = await tools.execute(call, context);
      observations.push({
        call,
        result: { ...result, ...(additionalContext?.length ? { additionalContext } : {}) },
        ...(fileStates.length ? { fileStates } : {}),
        ...(call.name === 'run_code' && programCalls && !result.isError
          ? { kind: 'program-output' as const }
          : {}),
      });
      return { effectId, result, additionalContext };
    } finally {
      timing.dispatchFinishedAt = Date.now();
      timing.dispatchMs = Math.max(0, performance.now() - dispatchClock);
    }
  };

  const run: RunToolBatch['run'] = async (calls) => {
    // What the batch hands back to the loop: context a post-execute policy asked to inject, and the goals the
    // model changed. Both are published after every call of the batch has settled, by the caller.
    const injected: { callId: string; notes: string[] }[] = [];
    const changedGoals: Goal[] = [];
    const observations: ToolObservation[] = [];
    const queuedClock = performance.now();
    const queuedAt = Date.now();
    peakConcurrency = activeExecutions;
    const toolTimings = new Map<string, CallTiming>(
      calls.map((call) => [call.id, newTiming(queuedAt)]),
    );
    const batchScope = (call: ToolCall): CallScope => ({
      timing: toolTimings.get(call.id)!,
      queuedClock,
      observations,
      changedGoals,
    });
    const startCall = (call: ToolCall): Promise<CallOutcome> => runToolCall(call, batchScope(call));
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
    const groups = groupToolCalls(calls, (call) => tools.executionMode(call));
    /** A steer retires a pending call with its reason recorded, rather than leaving it looking unanswered. */
    const retire = (call: ToolCall): void => {
      const skipped = {
        isError: true,
        content: 'Not executed: a new user instruction superseded this pending tool call.',
      };
      store.append(sessionId, { role: 'tool', toolCallId: call.id, ...skipped });
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
        startCall,
        () => signal.aborted || queue.hasSteer,
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
        store.append(sessionId, { role: 'tool', toolCallId: call.id, ...result });
        /**
         * Checked here rather than inside the registry, because this is the layer that can fail the run: a
         * violated pipeline order means a policy stage ran out of order, and the registry's own handling
         * turns that into a failed tool result the model reads and moves on from. The trace is this run's
         * own registry, passed in because the registration that checks it is process-wide.
         */
        await invariants?.assert('tool-execution', {
          sessionId,
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
        if (additionalContext?.length) injected.push({ callId: call.id, notes: additionalContext });
      }
      // A failed or cancelled call ends the batch: later groups are not started at all, exactly as the
      // serial loop would have stopped at the first one that threw.
      if (failure !== undefined || cancelled) break;
    }
    if (cancelled) signal.throwIfAborted();
    if (failure !== undefined) throw failure.reason;
    return { injected, changedGoals, observations };
  };
  return { run };
}
