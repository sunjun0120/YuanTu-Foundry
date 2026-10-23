import type { RunFailure, FailureCode } from '../protocol/failure.ts';
import type {
  RunResult,
  RunStatus,
  SubAgentSummaryReport,
  Task,
  Usage,
} from '../protocol/index.ts';
import { describeViolations } from '../protocol/invariants.ts';
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
   * Stop hooks may annotate the answer or touch source files. They must settle before the final fingerprint — and
   * before the tool resources close.
   *
   * They used to run after `tools.close()`, which had already shut the browser, MCP servers and language servers a
   * hook might reasonably use, and — for a registry that owns its hooks — closed the hook registry itself, which
   * releases the bridge an embedded or CLI host's hooks are reached through. A hook that "may touch source files"
   * could find nothing left to touch them with. A cleanup failure still fails the run below; the hooks see the
   * status the run ended with, before cleanup had a chance to change it.
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
  /**
   * The verdict was computed for the status the run believed it had. A run-end invariant can still lower it, so
   * status, error and the completion summary move together here, before either terminal row is written. The
   * previous order wrote the task attempt first and only then discovered the invariant failure, which is how a
   * failed run kept a completed attempt (and could announce `task.completed` to a dependent task).
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
   * The task attempt, the completion record and the run row are one commit.
   *
   * `settleTask` runs inside `finishRun`'s transaction, before anything terminal is written. A failure there
   * aborts the whole commit, so an attempt can never be durable as completed beside a run that failed to
   * finalize; the retry below re-runs the same commit, and only when the settlement itself was what threw does it
   * fall back to writing the run row alone (an open attempt is honest, a falsely completed one is not).
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
     * The retry is the same write, so it can fail the same way — and a rejection from here would escape the
     * `finally` that called this, turning a run that has a result into a rejected `run()` with no
     * `run.finished` at all. The result stays in memory for the caller; the row this could not write is what
     * the next process's reconciliation converges, and that is the smaller loss of the two.
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
 * Runs the `run-end` invariants and turns a violation into a failed run.
 *
 * A violation is logged as well as recorded: the registry is process-wide and a host may outlive many
 * runs, so the log is where an operator sees that a promise broke even if nobody looks at this run's
 * result.
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
