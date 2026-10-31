import type { RunFailure, FailureCode } from '../../protocol/failure.ts';
import type {
  RunResult,
  RunStatus,
  SubAgentSummaryReport,
  Task,
  Usage,
} from '../../protocol/index.ts';
import { describeViolations } from '../../protocol/invariants.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { withExecutionPolicy as underExecutionPolicy } from '../../sandbox/execution-policy.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { AgentOptions } from '../agent-options.ts';
import type { RunCompletion } from './completion.ts';
import type { RunEmit } from './emit.ts';
import { settleOpenToolSpans, type RunEmission } from './emit.ts';
import type { RunQueue } from './queue.ts';
import type { ResidentTurnSettlements } from './residency.ts';
import { finishRunTask } from './task.ts';
import { runCancelReason } from './outcome.ts';
import type { SubAgentCoordinator } from '../subagents/delegation.ts';

export interface RunFinalizationOptions {
  agent: Pick<AgentOptions, 'ownsToolResources' | 'executionPolicy'>;
  store: Pick<SessionStore, 'finishTaskAttempt' | 'goal' | 'finishRun' | 'forsakeRun'>;
  tools: ToolRegistry;
  sessionId: string;
  runId: string;
  signal: AbortSignal;
  readOnly: boolean;
  status: RunStatus;
  error: string | undefined;
  code: FailureCode | undefined;
  text: string;
  endpointFailure: RunFailure | undefined;
  usage: Usage;
  statistics: SessionStatistics;
  committedSummaryUsage: SessionStatistics;
  emission: RunEmission;
  emittedTypes: Set<string>;
  coordinator: SubAgentCoordinator | undefined;
  residentTurns: ResidentTurnSettlements;
  completion: RunCompletion;
  task: Task | undefined;
  taskAttempt: ReturnType<SessionStore['startTaskAttempt']> | undefined;
  reportHolder: { report?: SubAgentSummaryReport; data?: unknown };
  queue: RunQueue;
  emit: RunEmit;
  releaseRun(discardedIds: string[], reason: string): void;
  checkRunEnd(result: RunResult, emittedTypes: string[]): Promise<void>;
}

/** Settle resources, verify final inputs, then persist before publishing terminal state. */
export async function finalizeRun(options: RunFinalizationOptions): Promise<RunResult> {
  const {
    agent,
    store,
    tools,
    sessionId,
    runId,
    signal,
    readOnly,
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
    releaseRun,
    checkRunEnd,
  } = options;
  let { status, error, code, text } = options;
  let result: RunResult;

  // A tool still running when the run ends is charged here: the emitter opens a span on the first
  // `tool.started` and closes it when the last `tool.finished` arrives, and a run that is cancelled or that
  // throws never sees that finish — so without this the wall time a person spent waiting on those tools
  // would vanish from the totals. The settlement takes whatever is open and closes it once, so a second call
  // adds nothing.
  settleOpenToolSpans(emission);
  // A background sub-agent must not outlive the run that started it: this run's row is about to be
  // finalised (so its usage could no longer be attributed) and the tool registry it borrowed is
  // about to be closed. Cancel first, then await, so the guarantee does not depend on timing.
  if (coordinator) await coordinator.settle();
  try {
    await residentTurns.settle();
  } catch {
    status = 'failed';
    error = 'Resident sub-agent settlement failed; usage or completion may be incomplete';
    code = undefined;
  }
  /**
   * Stop hooks run before the final fingerprint and before tool resources close, since they may
   * touch source files with those tools. They see the run's status before cleanup could change it.
   */
  try {
    const stopped = await underExecutionPolicy(agent.executionPolicy?.(), () =>
      tools.extensions.stop(
        {
          sessionId: sessionId,
          runId,
          status,
          text,
          readOnly,
          ...(error ? { error } : {}),
        },
        signal,
      ),
    );
    const notices = [
      ...stopped.reasons,
      ...stopped.failures.map((failure) => `stop hook failed: ${failure}`),
    ];
    if (notices.length)
      text = `${text}${text ? '\n\n' : ''}${notices
        .map((notice) => `[Extension stop hook] ${notice}`)
        .join('\n')}`;
  } catch {
    /* The final fingerprint still checks any effects a failed observer already produced. */
  }
  try {
    if (agent.ownsToolResources !== false) await tools.close();
  } catch {
    status = 'failed';
    error = 'Tool resource cleanup failed; an external process may still be running';
    code = 'tool-cleanup';
  }
  if (status === 'completed') {
    const stale = await completion.settleFinalInputs();
    if (stale !== undefined) {
      status = 'needs_review';
      error = stale;
    }
  }
  completion.finalizeVerdict(status, error);
  result = {
    ...(status === 'cancelled' && runCancelReason(signal)
      ? { cancelReason: runCancelReason(signal) }
      : {}),
    runId,
    sessionId: sessionId,
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
    ...(endpointFailure?.requestId === undefined ? {} : { requestId: endpointFailure.requestId }),
    ...(completion.state.acceptance ? { acceptance: completion.state.acceptance } : {}),
    ...(completion.state.summary ? { completion: completion.state.summary } : {}),
  };
  /**
   * Record anything still queued as never delivered, with the reason (Stop vs. run end). A crash
   * before this leaves `input.queued` standing.
   */
  releaseRun(
    queue.clear().map((item) => item.id),
    status === 'cancelled' ? 'cancelled' : 'run-ended',
  );
  emit('queue.changed', { queue: [] });
  /** Check run-end invariants before persisting, so a broken promise makes the run `failed`. */
  await checkRunEnd(result, [...emittedTypes]);
  /**
   * An invariant can lower the status, so status, error and completion summary move together before
   * any terminal row is written.
   */
  if (result.status !== status) {
    status = result.status;
    error = result.error;
    completion.finalizeVerdict(status, error);
    result.status = status;
    if (error === undefined) delete result.error;
    else result.error = error;
    if (completion.state.summary) result.completion = completion.state.summary;
    else delete result.completion;
  }
  if (result.completion?.state === 'verified' && result.status !== 'completed')
    result.completion = {
      ...result.completion,
      state: 'needs_review',
      reason: 'finalization-failed',
    };
  const boundGoal = completion.state.contractSpec ? store.goal(sessionId) : null;
  const completeGoalObjective =
    result.completion?.state === 'verified' &&
    boundGoal?.status === 'active' &&
    boundGoal.objective === completion.state.contractSpec?.objective
      ? boundGoal.objective
      : undefined;
  /**
   * The task attempt, completion record and run row commit together inside `finishRun`'s
   * transaction. If the settlement itself threw, the retry writes the run row alone: an open
   * attempt is honest, a falsely completed one is not.
   */
  let taskSettlementFailed = false;
  const settleTask =
    task && taskAttempt
      ? () => {
          try {
            return finishRunTask({
              store,
              sessionId,
              task,
              taskAttempt,
              status: result.status,
              error: result.error,
              verification: completion.state.taskVerification,
            });
          } catch (cause) {
            taskSettlementFailed = true;
            throw cause;
          }
        }
      : undefined;
  const finalizationOptions = {
    ...(completeGoalObjective === undefined ? {} : { completeGoalObjective }),
    ...(settleTask ? { settleTask } : {}),
  };
  try {
    // Verdict, bound goal, task attempt and run end commit together; live observers only see that committed state.
    store.finishRun(result, finalizationOptions);
  } catch {
    result.status = 'failed';
    result.error = 'Failed to persist run finalization';
    if (result.completion)
      result.completion = {
        ...result.completion,
        state: 'needs_review',
        reason: 'finalization-failed',
      };
    /**
     * The retry can fail too; don't let it reject out of `finally`. The next process's
     * reconciliation converges the unwritten row.
     */
    try {
      store.finishRun(result, taskSettlementFailed ? {} : finalizationOptions);
    } catch (error) {
      // The run is over whether or not the row says so; without this the session stays locked to it.
      store.forsakeRun(runId);
      process.stderr.write(
        `run ${runId} finalization could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  if (result.completion && completion.state.contractId)
    emit('completion.updated', {
      runId,
      contractId: completion.state.contractId,
      summary: result.completion,
    });
  if (result.completion?.state === 'verified' && completeGoalObjective !== undefined) {
    const completedGoal = store.goal(sessionId);
    if (completedGoal?.status === 'completed')
      emit('goal.changed', { action: 'complete', goal: completedGoal });
  }
  emit('run.finished', { result });

  return result;
}

/**
 * Runs the `run-end` invariants and turns a violation into a failed run. Also logged, since the
 * registry outlives individual runs.
 */
export async function checkRunEnd(
  agent: Pick<AgentOptions, 'invariants' | 'onEvent' | 'store'>,
  result: RunResult,
  sessionId: string,
  runId: string,
  emittedTypes: string[],
): Promise<void> {
  const invariants = agent.invariants;
  if (!invariants) return;
  const violations = await invariants.run('run-end', { sessionId, runId, emittedTypes });
  if (!violations.length) return;
  const detail = describeViolations(violations);
  try {
    agent.onEvent?.({
      type: 'invariant.violated',
      sessionId,
      runId,
      // Read from the log like any other frame's cursor: a diagnostic is still ordered against the record.
      seq: agent.store.lastSeq(sessionId),
      data: { violations },
    });
  } catch {
    /* diagnostics must not change the outcome of a run that already ended */
  }
  result.status = 'failed';
  result.error = `Runtime invariant violated: ${detail}`;
}
