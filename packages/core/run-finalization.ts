import type { RunFailure, FailureCode } from '../protocol/failure.ts';
import type {
  RunResult,
  RunStatus,
  SubAgentSummaryReport,
  Task,
  Usage,
} from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { withExecutionPolicy as underExecutionPolicy } from '../tools/execution-policy.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { AgentOptions } from './agent-options.ts';
import type { RunCompletion } from './run-completion.ts';
import type { RunEmit } from './run-emit.ts';
import { settleOpenToolSpans, type RunEmission } from './run-emit.ts';
import type { RunQueue } from './run-queue.ts';
import type { ResidentTurnSettlements } from './run-residency.ts';
import { finishRunTask } from './run-task.ts';
import type { SubAgentCoordinator } from './subagents.ts';

export interface RunFinalizationOptions {
  agent: Pick<AgentOptions, 'ownsToolResources' | 'executionPolicy'>;
  store: Pick<SessionStore, 'finishTaskAttempt' | 'goal' | 'finishRun'>;
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
  try {
    if (agent.ownsToolResources !== false) await tools.close();
  } catch {
    status = 'failed';
    error = 'Tool resource cleanup failed; an external process may still be running';
    code = 'tool-cleanup';
  }
  // Stop hooks may annotate the answer or touch source files. They must settle before the final fingerprint.
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
  if (status === 'completed') {
    const stale = await completion.settleFinalInputs();
    if (stale !== undefined) {
      status = 'needs_review';
      error = stale;
    }
  }
  ({ status, error } = finishRunTask({
    store,
    sessionId,
    task,
    taskAttempt,
    status,
    error,
    verification: completion.state.taskVerification,
  }));
  completion.finalizeVerdict(status, error);
  result = {
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
   * Anything still queued was never folded into a turn, and the run it was queued for is now over. The
   * record says so — the reason distinguishes "the person pressed Stop" from "the run reached its end
   * first" — because the alternative, an empty queue nobody wrote about, is exactly the silent loss the
   * durable inbox exists to remove. What is *not* written here is the crash case: a process that dies
   * before this point leaves `input.queued` standing, which is how a later reader knows.
   */
  releaseRun(
    queue.clear().map((item) => item.id),
    status === 'cancelled' ? 'cancelled' : 'run-ended',
  );
  emit('queue.changed', { queue: [] });
  /**
   * The run-end promises are checked before the result is persisted, so a broken one is reported as a
   * failed run rather than discovered later against a run that claims to have completed. `failed` is
   * already part of `RunStatus`, so nothing downstream has to learn a new vocabulary — and a run whose
   * promises were broken is exactly what `failed` means.
   */
  await checkRunEnd(result, [...emittedTypes]);
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
  try {
    // Verdict, bound goal and run end commit together; live observers only see that committed state.
    store.finishRun(result, { completeGoalObjective });
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
     * The retry is the same write, so it can fail the same way — and a rejection from here would escape the
     * `finally` that called this, turning a run that has a result into a rejected `run()` with no
     * `run.finished` at all. The result stays in memory for the caller; the row this could not write is what
     * the next process's reconciliation converges, and that is the smaller loss of the two.
     */
    try {
      store.finishRun(result);
    } catch (error) {
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
