import type { FileChange, ToolCall, ToolContext } from '../../protocol/index.ts';
import type { ToolExecutionResult } from '../../protocol/tool-pipeline.ts';
import type { Goal } from '../../protocol/goals.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { digestFileStates, type FileStateDigest } from '../../tools/file-state-digest.ts';
import { spillOutput } from '../../tools/spill.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import { commandJournal } from '../command-jobs.ts';
import type { RunCompletion } from './completion.ts';
import type { InvariantRegistry } from '../invariants.ts';
import type { RunEmit } from './emit.ts';
import type { RunQueue } from './queue.ts';
import { groupToolCalls, runBounded } from '../tool-schedule.ts';
import type { ToolObservation } from '../tool-progress.ts';

/**
 * One round's model tool calls: which may overlap, the pool that runs them, and the order results
 * are written in.
 *
 * - Overlap is the tool's promise (`isConcurrencySafe`), grouped by adjacency so the model's order
 *   is kept.
 * - Results are appended, announced and journalled in model order; a fast call never overtakes a
 *   slow one.
 * - Each call gets its own effect journal entry, even when overlapping.
 * - The batch ends only after every started call is awaited; a steer retires superseded calls, a
 *   cancel leaves them to `resolvePending`, and the first failure in model order is rethrown last.
 *
 * Injected context and changed goals are handed back for the loop to publish after the batch's
 * results. Seams that change between rounds arrive as getters; fixed ones as values.
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
   * The run's completion contract, read by the goal seam when `goal_complete` arrives. Built once
   * per run (`run/completion.ts`).
   */
  completion: RunCompletion;
  /** Tags a change with the sub-agent that made it, so a child's work is not read as the parent's. */
  tagChange(change: FileChange): FileChange;
  /** Where the run publishes and checks runtime invariants — the type of `AgentOptions.invariants`. */
  invariants: InvariantRegistry | undefined;
  /** Whether this run may change anything, read per context: a mid-run plan approval lifts it. */
  readOnly(): boolean;
  /**
   * The execution snapshot this round was built with (what the prompt and schema describe). Waiting
   * calls are rechecked against the trusted selection below.
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
 * The batch one round's calls run through, built once per run: per-call context, group scheduler,
 * bounded pool and result loop. The loop owns the state; this owns the order.
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
   * One call, from its effect journal entry to its result. `effectId` is per invocation because
   * overlapping calls would otherwise overwrite each other's entry.
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
       * The context one call runs in, also used for inner `run_code` calls, which go through the
       * same registry, approvals, read-only promise, deadline and journals. Inner ids derive from
       * the outer one (`<outer>#<n>`).
       */
      const pending = new Map<string, FileStateDigest[]>();
      const toolContext = (callId: string, fileStates: FileStateDigest[]): ToolContext => ({
        signal,
        /** The call's session and its run's read-only promise, for policy hooks. */
        sessionId,
        workspaceRoot: workspace,
        readOnly: readOnly(),
        ...(executionPolicy() ? { executionPolicy: executionPolicy() } : {}),
        /**
         * Policy getters, so a call that waited (e.g. on approval) runs under the sandbox selected
         * now, not when it was requested.
         */
        ...(executionPolicyForCall ? { executionPolicyForCall } : {}),
        ...(permissionPolicyForCall ? { permissionPolicyForCall } : {}),
        // Spill oversized output to this session's directory.
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
         * The write boundary: take digests just before the journal row, for the oscillation guard
         * only.
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
        /** The checklist seam: reading folds the log, writing appends and announces the event. */
        todos: {
          read: () => store.todos(sessionId),
          write: (items) => {
            store.recordEvent(sessionId, 'todo.written', { todos: items });
            emit('todo.written', { todos: items });
            return items;
          },
        },
        /** One write per accepted `present` call, covering every file it named. */
        deliverables: {
          read: () => store.deliverables(sessionId),
          write: (files) => {
            store.recordEvent(sessionId, 'deliverable.presented', { files });
            emit('deliverable.presented', { files });
          },
        },
        /**
         * The session's goal: one write per accepted action, carrying the whole goal. Changes are
         * announced in the conversation rather than rebuilt into the prompt, so the cached prefix
         * stays intact.
         */
        goals: {
          read: () => store.goal(sessionId),
          // Read once per tool call, so a mid-run user message makes later calls the user's turn.
          human: humanTurn(),
          /**
           * Whether the completion contract lets this goal close as complete. Only a contract whose
           * objective is exactly the goal's binds it; unbound goals keep their plain behaviour.
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
           * A goal written mid-run is announced in the conversation, not rebuilt into the prompt,
           * so the cached system prompt and catalogue stay valid.
           */
          write: (action, goal) => {
            store.recordEvent(sessionId, 'goal.changed', { action, goal });
            emit('goal.changed', { action, goal });
            // A user notice cannot interrupt outstanding tool calls: record the change now,
            // announce after the batch.
            if (ownWork) changedGoals.push(goal);
          },
        },
        /**
         * The session's durable record of background commands: written at start, at settlement
         * (with the output tail) and when the model reads a finished one.
         */
        commandJournal: commandJournal(store, sessionId),
        /**
         * What a program may call. `tools.execute` is the same entry point direct calls use, on
         * this run's registry, so guards, permissions and timeouts apply to inner calls too.
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
          // Programs cannot overlap or fan out more than the model's batches.
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
            // Same known-outcome rule as a direct call: an exited command is settled; an errored
            // external tool may have had an effect and stays pending.
            if (
              intent &&
              state === 'known' &&
              result &&
              (!result.isError || result.commandExecuted === true) &&
              taskEffectScope
            ) {
              store.completeTaskEffect(taskEffectScope.sessionId, taskEffectScope.taskId, intent);
              programEffects.delete(inner.id);
            }
          },
        },
      });
      const fileStates: FileStateDigest[] = [];
      /**
       * The preparation observer; both start and stop frames are forwarded so the status line
       * clears on refusal or cancellation.
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
          /** The tool name is recorded so durable evidence says what a call actually did. */
          store.recordEvent(sessionId, type, {
            runId,
            tool: call.name,
            ...measurement,
          });
          emit(type, measurement);
        },
      };
      /**
       * The registry makes the preparation observer ambient; Stop still cancels the wait and clears
       * its progress.
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
    // Handed back to the loop and published after every call of the batch settles.
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
     * Group sibling calls: only `Tool.isConcurrencySafe` calls overlap, checked per call.
     * `tool.started` goes out for the whole group; results are recorded strictly in model order.
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
    /** The first failure in model order, wrapped so `throw undefined` still counts as a failure. */
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
       * A rolling pool bounded by the run's limit, started in model order. `shouldStop` is checked
       * before each start; started calls are always awaited.
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
          // A steer is recorded in the transcript; a cancel leaves the call for `resolvePending`.
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
         * Checked here because this layer can fail the run; a pipeline-order violation inside the
         * registry would only fail the tool result.
         */
        await invariants?.assert('tool-execution', {
          sessionId,
          runId,
          pipeline: tools.pipelineInvariant,
        });
        /**
         * A command that answered, even with a non-zero exit, has a known outcome
         * (`commandExecuted`). Only calls that never answered stay pending.
         */
        const effectSettled = !result.isError || result.commandExecuted === true;
        if (effectId && effectSettled && taskEffectScope)
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
      // A failed or cancelled call ends the batch; later groups do not start.
      if (failure !== undefined || cancelled) break;
    }
    if (cancelled) signal.throwIfAborted();
    if (failure !== undefined) throw failure.reason;
    return { injected, changedGoals, observations };
  };
  return { run };
}
