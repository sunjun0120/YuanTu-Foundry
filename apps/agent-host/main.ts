#!/usr/bin/env node
import { warmToolCache } from '../../packages/builtin-services/index.ts';
import type { RunResult, Task, TaskAttempt } from '../../packages/protocol/index.ts';
import { acquireHostLock } from '../../packages/platform/host-lock.ts';
import { refreshAccountReadiness } from '../../packages/sandbox/sandbox-account.ts';
import { safeError } from '../shared/runtime.ts';
import { createVerifier } from './approvals.ts';
import { createBackgroundWake } from './background-wake.ts';
import { DEFAULT_STALL_THRESHOLD_MS, EventLoopMonitor } from './event-loop-health.ts';
import { HostCarrier } from './carrier.ts';
import { resolveLaunch } from './cli.ts';
import { createDispatcher, createRequestHandler } from './dispatch.ts';
import { serveHost } from './lifecycle.ts';
import { createSchedulerNotifier } from './params.ts';
import { TaskScheduler } from './scheduler.ts';
import { openHostServices } from './services.ts';
import { createHostState, fileClaims, lockConflict, runSlotFree, sessionCanRun } from './state.ts';

/**
 * Assemble one Host process and hand it a carrier.
 *
 * This file is deliberately only wiring. Everything it builds is a module that owns one responsibility, and the
 * order below is the only contract it keeps: the store is opened and converged before anything can serve, the
 * services and the shared state come next, and the three mutually referential pieces — the carrier, the
 * scheduler and the dispatcher — are built in an order where each one's *closure* may name the ones after it,
 * because none of them runs before the read loop does. `serveHost` takes it from there.
 */
/** A task whose next step is the acceptance check a person has already approved. */
const approvedAcceptance = (task: Task | undefined): boolean =>
  task?.pendingApproval?.state === 'approved' && task.pendingApproval.phase === 'acceptance';

type Launch = NonNullable<ReturnType<typeof resolveLaunch>>;

async function main(): Promise<void> {
  const launch = resolveLaunch(process.argv.slice(2));
  if (!launch) return;
  /**
   * The workspace is owned for the whole process, not only while a run is active. Offline maintenance
   * (`workspace-gc`) reads this marker; holding it through `serveHost` means it disappears only after every
   * resource the Host owns is closed.
   */
  const hostLock = acquireHostLock(launch.workspace);
  try {
    await runHost(launch);
  } finally {
    hostLock.release();
  }
}

async function runHost(launch: Launch): Promise<void> {
  const { options, workspace } = launch;
  const services = await openHostServices(options, workspace);
  // Before the first command: `native` on Windows uses the sandbox accounts only once they are known ready.
  await refreshAccountReadiness();
  const ctx = createHostState(launch, services);
  const requestMethods = new Map<string, string>();
  ctx.loopHealth = new EventLoopMonitor({
    thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
    activity: () => ({
      sessions: [...ctx.active.keys()],
      operations: ctx.manualOperations.size,
      requests: [...requestMethods.values()],
    }),
  });
  ctx.loopHealth.start();
  void warmToolCache();
  ctx.carrier = new HostCarrier({ isClosing: () => ctx.closing });
  const wake = createBackgroundWake(ctx);
  ctx.currentAuthority = wake.currentAuthority;
  ctx.captureAuthority = wake.captureAuthority;
  ctx.queueWake = wake.queueWake;
  ctx.stopObservingBackground = wake.stop;
  // Verification commands run outside an active run cannot rely on the streaming approval
  // flow, so they still honor the permission policy and --allow-command, and otherwise fail
  // closed rather than executing an unauthorized host command.
  ctx.verifyApprover = createVerifier({
    policy: () => ctx.permissionPolicy,
    options: ctx.options,
    approvalSources: ctx.approvalSources,
  });
  /**
   * Task triggers fire runs through the same dispatch path as a user request, so approvals,
   * permission policy, budgets and cleanup all behave identically whether a human or the clock
   * started the work.
   */
  const scheduler = new TaskScheduler({
    store: ctx.store,
    workspace: ctx.workspace,
    canRun: (sessionId, task) => {
      if (!ctx.automaticReady || ctx.closing) return false;
      if (sessionId === undefined) return runSlotFree(ctx);
      // An approved acceptance resumes as `task.verify`, not as a run: it needs no run slot, but it does need the
      // project directory to itself. Asking the run's question instead let it start while another session was
      // writing there, be refused, and count that refusal as one of the task's failures.
      if (approvedAcceptance(task))
        return (
          !ctx.active.has(sessionId) && !lockConflict(ctx, fileClaims(sessionId, ctx.workspace))
        );
      return sessionCanRun(ctx, sessionId);
    },
    ...(ctx.workflowIntervalMs ? { intervalMs: ctx.workflowIntervalMs } : {}),
    run: async (scheduled) => {
      if (approvedAcceptance(scheduled.task)) {
        const verified = (await ctx.dispatch('task.verify', {
          sessionId: scheduled.task.sessionId,
          taskId: scheduled.task.id,
          resumeApproval: true,
        })) as { task: Task; attempt: TaskAttempt };
        return {
          status: verified.task.status === 'completed' ? 'completed' : 'needs_review',
          ...(verified.attempt.error ? { error: verified.attempt.error } : {}),
        };
      }
      return (await ctx.dispatch('run.start', {
        sessionId: scheduled.task.sessionId,
        taskId: scheduled.task.id,
        prompt: scheduled.task.description || scheduled.task.title,
        trigger: scheduled.source,
        ...(scheduled.resume ? { resume: true } : {}),
      })) as RunResult;
    },
  });
  ctx.scheduler = scheduler;
  ctx.notifyScheduler = createSchedulerNotifier(scheduler);
  ctx.dispatch = createDispatcher(ctx);
  ctx.handle = createRequestHandler({
    dispatch: ctx.dispatch,
    send: (data) => ctx.carrier.send(data),
    requestIds: ctx.requestIds,
    requestMethods,
  });
  await serveHost(ctx);
}
await main().catch((error) => {
  process.stderr.write(safeError(error) + '\n');
  process.exitCode = 1;
});
