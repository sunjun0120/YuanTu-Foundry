#!/usr/bin/env node
import type { RunResult, Task, TaskAttempt } from '../../packages/protocol/index.ts';
import { safeError } from '../shared/runtime.ts';
import { createVerifier } from './approvals.ts';
import { createBackgroundWake } from './background-wake.ts';
import { HostCarrier } from './carrier.ts';
import { resolveLaunch } from './cli.ts';
import { createDispatcher, createRequestHandler } from './dispatch.ts';
import { serveHost } from './lifecycle.ts';
import { createSchedulerNotifier } from './params.ts';
import { TaskScheduler } from './scheduler.ts';
import { openHostServices } from './services.ts';
import { createHostState } from './state.ts';

/**
 * Assemble one Host process and hand it a carrier.
 *
 * This file is deliberately only wiring. Everything it builds is a module that owns one responsibility, and the
 * order below is the only contract it keeps: the store is opened and converged before anything can serve, the
 * services and the shared state come next, and the three mutually referential pieces — the carrier, the
 * scheduler and the dispatcher — are built in an order where each one's *closure* may name the ones after it,
 * because none of them runs before the read loop does. `serveHost` takes it from there.
 */
async function main(): Promise<void> {
  const launch = resolveLaunch(process.argv.slice(2));
  if (!launch) return;
  const { options, workspace } = launch;
  const services = await openHostServices(options, workspace);
  const ctx = createHostState(launch, services);
  ctx.carrier = new HostCarrier({ listen: options.listen, isClosing: () => ctx.closing });
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
    canRun: () => ctx.automaticReady && !ctx.closing && ctx.active.size === 0 && !ctx.restoring,
    ...(ctx.workflowIntervalMs ? { intervalMs: ctx.workflowIntervalMs } : {}),
    run: async (scheduled) => {
      if (
        scheduled.task.pendingApproval?.state === 'approved' &&
        scheduled.task.pendingApproval.phase === 'acceptance'
      ) {
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
  });
  await serveHost(ctx);
}
await main().catch((error) => {
  process.stderr.write(safeError(error) + '\n');
  process.exitCode = 1;
});
