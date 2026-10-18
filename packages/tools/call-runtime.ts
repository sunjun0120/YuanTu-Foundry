import type { ToolContext, ToolResult, ToolScope } from '../protocol/index.ts';
import type { ToolDispatch } from '../protocol/tool-hooks.ts';
import type { ToolExecution } from './pipeline.ts';
import { ToolTimeoutError, resolveToolDeadline, type ToolDeadlinePolicy } from './timeouts.ts';

/**
 * The bounds one tool call runs inside: the wrapper chain's dispatch, the approval wait and the body's deadline.
 *
 * `ToolRegistry.execute` owns the order these are applied in; this module only says what each bound is.
 */

/**
 * The dispatch one call's wrapper chain threads.
 *
 * The scope is where a wrapper's replacement actually lands, so this is the only place a `ToolScope` is minted:
 * `withSignal` and `withScope` copy the same frozen `execution` forward, which is what keeps "what a wrapper
 * replaced" and "what the audit record says" from being able to drift apart.
 */
export function createDispatch(
  execution: ToolExecution,
  scope: ToolContext,
  abort: AbortController,
): ToolDispatch {
  const bound = scope as ToolScope;
  const make = (next: ToolScope, controller: AbortController): ToolDispatch => ({
    execution,
    scope: next,
    signal: next.signal,
    abort: controller,
    withSignal: (signal, replacement) => make({ ...next, signal }, replacement),
    withScope: (replacement) => make(replacement, controller),
  });
  return make(bound, abort);
}

/**
 * Wait for an approval, but not forever.
 *
 * The per-call deadline below wraps `execute`, and an approval happens before it: an approver that never answers
 * therefore had no bound at all, and the step stayed open until somebody pressed Stop — the case the factory Host
 * papers over with its own 120 s timer, and one a library embedder has nothing for. An unanswered request is a
 * denial, not a timeout: nothing ran, and the model is told which of the two happened. `0` keeps the wait-forever
 * behaviour for a deployment that owns a timer already.
 */
export async function approveWithinBudget(
  approval: Parameters<ToolContext['approve']>[0],
  approve: ToolContext['approve'],
  signal: AbortSignal,
  budgetMs: number | undefined,
): Promise<{ allowed: boolean; timedOut: boolean; budgetMs?: number }> {
  if (budgetMs === undefined || budgetMs <= 0)
    return { allowed: await approve(approval, signal), timedOut: false };
  // Handlers are attached before the race, so a late answer — or a late failure — after the budget expired is
  // observed and discarded instead of surfacing as an unhandled rejection.
  const answer = approve(approval, signal).then(
    (allowed) => ({ allowed }),
    (error: unknown) => ({ error }),
  );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs);
    // A pending approval must not be a reason for the process to stay alive.
    timer.unref();
  });
  try {
    const outcome = await Promise.race([answer, expired]);
    if (outcome === 'expired') return { allowed: false, timedOut: true, budgetMs };
    if ('error' in outcome) throw outcome.error;
    return { allowed: outcome.allowed, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one tool body with its call's deadline, turning "it ran out of budget" into a failure the model reads.
 *
 * It sits at the *terminal* of the around-dispatch chain rather than in an `aroundTool` wrapper, and the
 * placement is the point: a wrapper receives `next()` and the run's signal, but the signal a tool body sees is
 * fixed before that seam runs, so a policy installed there could only bound its own waiting — it would report
 * a timeout while the tool kept running, which is the same "result for an effect that did not happen" the rest
 * of this pipeline refuses. Here the call has a signal of its own, so the deadline can *abort the call*: a
 * cooperative tool kills its child or closes its socket, and a tool that ignores its signal is bounded anyway,
 * because the wait is a race either way.
 *
 * Wrappers lose nothing by this: the timeout arrives as the call's result, so a retry or metrics policy wraps
 * it like any other failure — and because the timer is per invocation, a wrapper that retries gives the attempt
 * a fresh budget rather than the leftovers of the first one.
 */
export async function runWithDeadline(
  name: string,
  abort: AbortController,
  body: () => Promise<ToolResult>,
  deadlines: ToolDeadlinePolicy | undefined,
  cancellationGraceMs?: number,
): Promise<ToolResult> {
  const timeoutMs = resolveToolDeadline(name, deadlines);
  const call = body();
  if (timeoutMs === undefined) return await call;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ToolTimeoutError(name, timeoutMs);
      // Abort before rejecting: a tool that is listening is given the same error it is about to be reported
      // with, so "what the tool was told" and "what the model is told" cannot end up saying different things.
      // The controller is the one the wrapper chain handed down, so a wrapper that replaced the signal gets its
      // replacement aborted — a bound it can actually tighten rather than one it can only report.
      abort.abort(error);
      reject(error);
    }, timeoutMs);
    // A pending deadline must not be a reason for the process to stay alive, or every test that leaves a hung
    // tool behind would wait out the whole budget before it could exit.
    timer.unref();
  });
  // The abandoned attempt may still settle — it was *asked* to stop, not guaranteed to have stopped — and by
  // then nothing is reading it. An unhandled rejection here would take the process down for a call the run
  // already reported as failed.
  void call.catch(() => {});
  try {
    return await Promise.race([call, deadline]);
  } catch (error) {
    if (abort.signal.aborted && cancellationGraceMs !== undefined) {
      let cleanupTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          call.then(
            () => {},
            (cause) => {
              if (cause instanceof Error && cause.name === 'ToolCleanupError') throw cause;
            },
          ),
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => {
              const unknown = new Error(
                'Tool cleanup could not be confirmed; effects may be unknown',
              );
              unknown.name = 'ToolCleanupError';
              reject(unknown);
            }, cancellationGraceMs);
            cleanupTimer.unref();
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
