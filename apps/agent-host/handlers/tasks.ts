import { DeferredApprovalError } from '../../../packages/protocol/failure.ts';
import {
  verifyTaskAcceptance,
  type TaskBaselines,
} from '../../../packages/core/task-acceptance.ts';
import { proposeTask } from '../../../packages/core/task-planner.ts';
import type { Approver } from '../../../packages/protocol/index.ts';
import { addUsage, emptyStatistics } from '../../../packages/protocol/statistics.ts';
import { createProvider, readConfig } from '../../../packages/providers/index.ts';
import { executionEnvironment, safeError } from '../../shared/runtime.ts';
import { ownedSession, required, withWaiting } from '../params.ts';
import { createVerifier } from '../approvals.ts';
import { sessionPermissionPolicy } from '../session-policy.ts';
import {
  acquireLocks,
  acquireModelSlot,
  assertUnlocked,
  executionRoot,
  fileClaims,
  hostClaim,
  sessionClaim,
  type HostContext,
  type ManualOperation,
} from '../state.ts';
import type { Handler } from '../dispatch.ts';

/**
 * The durable task records, and the transitions between their states.
 *
 * A task is a definition the user approved plus the evidence that it was carried out, so every case here is one
 * step of that: proposing a definition, running it, verifying the result against the acceptance criteria, and the
 * manual confirmations that stand in for a criterion a machine cannot check. Two rules run through all of them.
 * The Host refuses to change a definition while anything is running, because a task edited under a run is a task
 * whose evidence describes something else. And a restore in progress counts as busy for the same reason: the
 * attempt being written would race the one being read.
 */
/** Verification honors the policy of the session whose task it checks, not another session's selection. */
const sessionVerifier = (ctx: HostContext, sessionId: string): Approver =>
  createVerifier({
    policy: () => sessionPermissionPolicy(ctx, sessionId),
    options: ctx.options,
    approvalSources: ctx.approvalSources,
  });

/**
 * A manual operation, registered so Stop for its session and Host shutdown can abort it.
 *
 * Its work runs commands or a model request 閳?up to 64 checks, each allowed minutes 閳?and it used to be handed no
 * signal at all: Stop did nothing, and shutdown aborted every manual operation except this one and then waited for
 * it to finish. The caller removes it in the same `finally` that releases its locks.
 */
function manualOperation(
  ctx: HostContext,
  sessionId: string,
  limitMs: number,
  label: string,
): ManualOperation {
  const operation: ManualOperation = { sessionId, controller: new AbortController() };
  ctx.manualOperations.add(operation);
  /**
   * And a limit on the whole of it, not only on each step: 64 checks of five minutes each is over five hours of a
   * request nobody may be waiting for any more. Past the limit the operation is aborted like a Stop, and the
   * attempt records why.
   */
  const limit = setTimeout(
    () =>
      operation.controller.abort(
        new Error(`${label} exceeded its ${String(Math.round(limitMs / 60_000))}-minute limit`),
      ),
    limitMs,
  );
  limit.unref?.();
  operationLimits.set(operation, limit);
  return operation;
}

function manualVerification(ctx: HostContext, sessionId: string): ManualOperation {
  return manualOperation(ctx, sessionId, MANUAL_VERIFICATION_LIMIT_MS, 'Manual verification');
}

/** Ends what `manualOperation` started; called from the `finally` that releases the operation's locks. */
function finishManualOperation(ctx: HostContext, operation: ManualOperation): void {
  clearTimeout(operationLimits.get(operation));
  operationLimits.delete(operation);
  ctx.manualOperations.delete(operation);
}

/** The longest a manual confirm or verify may run in total. */
const MANUAL_VERIFICATION_LIMIT_MS = 30 * 60_000;
const operationLimits = new WeakMap<ManualOperation, NodeJS.Timeout>();

export const taskHandlers: Readonly<Record<string, Handler>> = {
  'task.create': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return ctx.store.createTask(sessionId, {
      title: required(params, 'title'),
      ...(typeof params.description === 'string' ? { description: params.description } : {}),
      ...(Array.isArray(params.acceptance) ? { acceptance: params.acceptance as never } : {}),
      ...(Array.isArray(params.steps) ? { steps: params.steps as never } : {}),
    });
  },
  'task.get': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return withWaiting(ctx.store, sessionId, [
      ctx.store.getTask(sessionId, required(params, 'taskId')),
    ])[0];
  },
  'task.list': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return withWaiting(
      ctx.store,
      sessionId,
      ctx.store.listTasks(
        sessionId,
        typeof params.status === 'string' ? (params.status as never) : undefined,
      ),
    );
  },
  'task.steps': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return ctx.store.taskStepCheckpoints(sessionId, required(params, 'taskId'));
  },
  'task.history': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return Object.fromEntries(
      ctx.store.listTasks(sessionId).map((task) => [
        task.id,
        {
          attempts: ctx.store.listTaskAttempts(sessionId, task.id),
          steps: ctx.store.taskStepCheckpoints(sessionId, task.id),
        },
      ]),
    );
  },
  'task.approval.respond': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (typeof params.allow !== 'boolean') throw new Error('allow must be a boolean');
    const task = ctx.store.resolveTaskApproval(
      sessionId,
      required(params, 'taskId'),
      params.allow,
      required(params, 'approvalId'),
    );
    if (params.allow) {
      // A person approved the next attempt, which is the decision a failure backoff was waiting for.
      ctx.scheduler.clearFailures(task.id);
      ctx.scheduler.wake();
    }
    return task;
  },
  'task.trigger': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    assertUnlocked(
      ctx,
      [hostClaim('shared'), sessionClaim(sessionId)],
      'Host is busy; wait before editing tasks',
    );
    const taskId = required(params, 'taskId');
    // A changed trigger is a new rule, so failures counted under the old one no longer delay it.
    ctx.scheduler.clearFailures(taskId);
    // `null` clears the trigger; an absent field would be indistinguishable from "unchanged".
    return ctx.store.updateTask(sessionId, taskId, {
      trigger: (params.trigger ?? null) as never,
    });
  },
  'task.update': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    assertUnlocked(
      ctx,
      [hostClaim('shared'), sessionClaim(sessionId)],
      'Host is busy; wait before editing tasks',
    );
    const update = { ...params } as Record<string, unknown>;
    delete update.sessionId;
    delete update.taskId;
    delete update.status;
    const expectedUpdatedAt =
      typeof update.expectedUpdatedAt === 'string' ? update.expectedUpdatedAt : undefined;
    delete update.expectedUpdatedAt;
    const taskId = required(params, 'taskId');
    const task = ctx.store.getTask(sessionId, taskId);
    // An edited definition gets a fresh chance; the old one's failures say nothing about it.
    ctx.scheduler.clearFailures(taskId);
    return ctx.store.replaceTaskDefinition(
      sessionId,
      taskId,
      { ...task, ...update },
      expectedUpdatedAt,
    );
  },
  'task.attempts': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return ctx.store.listTaskAttempts(sessionId, required(params, 'taskId'));
  },
  'task.propose': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const model = ctx.models.capture(sessionId, true);
    // Planning rewrites this task's own definition from one model request: only this session has to be idle.
    const planning = [hostClaim('shared'), sessionClaim(sessionId)];
    assertUnlocked(ctx, planning, 'Host is busy; wait before planning');
    const task = ctx.store.getTask(sessionId, required(params, 'taskId'));
    if (task.status === 'in_progress') throw new Error('Task is running');
    // Planning spends model capacity even though it is not a run; reserve one of the same slots first.
    const releaseSlot = acquireModelSlot(ctx, sessionId);
    let lease: ReturnType<typeof acquireLocks>;
    try {
      lease = acquireLocks(ctx, planning, 'Host is busy; wait before planning');
    } catch (error) {
      releaseSlot();
      throw error;
    }
    // Planning is a model request a person can wait on, so Stop for this session must reach it; its own request
    // timeout remains the shorter of the two bounds.
    const operation = manualOperation(ctx, sessionId, 120_000, 'Task planning');
    let runId: string | undefined;
    const statistics = emptyStatistics();
    const started = performance.now();
    let resultText = '',
      errorText: string | undefined;
    try {
      runId = ctx.store.beginRun(sessionId);
      const proposal = await proposeTask(
        createProvider(readConfig(model.env)),
        task,
        AbortSignal.any([
          operation.controller.signal,
          AbortSignal.timeout(Math.min(ctx.options.requestTimeoutMs ?? 120000, 120000)),
        ]),
        (text) => {
          if (text && !statistics.firstTokenCount) {
            statistics.firstTokenMs = performance.now() - started;
            statistics.firstTokenCount = 1;
          }
        },
        executionEnvironment(),
      );
      addUsage(statistics, proposal.usage);
      resultText = proposal.draft.description;
      return ctx.store.replaceTaskDefinition(sessionId, task.id, proposal.draft, task.updatedAt);
    } catch (error) {
      statistics.usageComplete = false;
      errorText = safeError(error);
      throw error;
    } finally {
      statistics.modelMs = performance.now() - started;
      try {
        if (runId)
          ctx.store.finishRun({
            runId,
            sessionId,
            status: errorText ? 'failed' : 'completed',
            text: resultText,
            usage: {
              inputTokens: statistics.inputTokens,
              outputTokens: statistics.outputTokens,
            },
            statistics,
            ...(errorText ? { error: errorText } : {}),
          });
      } finally {
        finishManualOperation(ctx, operation);
        releaseSlot();
        lease.release();
      }
    }
  },
  'task.confirm': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    // Verification runs its checks where the session works 閳?its own worktree when it has one, where the baselines
    // were captured 閳?and compares them with those baselines, so nothing may write there meanwhile.
    const root = executionRoot(ctx, sessionId);
    const confirming = fileClaims(sessionId, root);
    assertUnlocked(ctx, confirming, 'Host is busy; wait before manual confirmation');
    const taskId = required(params, 'taskId');
    const task = ctx.store.getTask(sessionId, taskId);
    if (required(params, 'expectedUpdatedAt') !== task.updatedAt)
      throw new Error('Task changed; reload before confirming');
    if (
      !task.latestRunId ||
      !task.verification ||
      !['needs_review', 'completed'].includes(task.status)
    )
      throw new Error('Execute the current task definition before manual confirmation');
    if (!Array.isArray(params.indices) || !params.indices.length || params.indices.length > 64)
      throw new Error('Select manual criteria explicitly');
    const indices = [...new Set(params.indices)];
    for (const index of indices) {
      if (
        !Number.isInteger(index) ||
        (index as number) < 0 ||
        !task.acceptance[index as number] ||
        task.acceptance[index as number]!.check
      )
        throw new Error('Only manual criteria can be confirmed');
      task.acceptance[index as number]!.met = true;
    }
    const baselines = ctx.store.latestRunAttemptBaselines(sessionId, taskId) as TaskBaselines;
    const attempt = ctx.store.startTaskAttempt(sessionId, taskId, { kind: 'review', baselines });
    const lease = acquireLocks(ctx, confirming, 'Host is busy; wait before manual confirmation');
    const operation = manualVerification(ctx, sessionId);
    try {
      const verified = await verifyTaskAcceptance(
        root,
        task,
        baselines,
        operation.controller.signal,
        sessionVerifier(ctx, sessionId),
      );
      return ctx.store.finishTaskAttempt(sessionId, taskId, attempt.id, {
        status: verified.passed ? 'completed' : 'needs_review',
        verification: verified.evidence,
        acceptance: verified.acceptance,
        steps: verified.steps,
        ...(verified.error ? { error: verified.error } : {}),
      });
    } catch (error) {
      ctx.store.finishTaskAttempt(sessionId, taskId, attempt.id, {
        status: 'blocked',
        error: safeError(error),
      });
      throw error;
    } finally {
      finishManualOperation(ctx, operation);
      lease.release();
    }
  },
  'task.verify': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    // Baselines were captured in the directory the task ran in 閳?the session's worktree when it has one 閳?so the
    // checks have to run there too; a project-relative command would judge a different tree.
    const root = executionRoot(ctx, sessionId);
    const verifying = fileClaims(sessionId, root);
    assertUnlocked(ctx, verifying, 'Host is busy; wait before verifying');
    const taskId = required(params, 'taskId');
    const task = ctx.store.getTask(sessionId, taskId);
    const baselines = ctx.store.latestRunAttemptBaselines(sessionId, taskId) as TaskBaselines;
    const attempt = ctx.store.startTaskAttempt(sessionId, taskId, {
      kind: 'verify',
      baselines,
    });
    const lease = acquireLocks(ctx, verifying, 'Host is busy; wait before verifying');
    const operation = manualVerification(ctx, sessionId);
    try {
      const acceptanceEffects = new Map<string, string>();
      const approvalForVerification: Approver =
        params.resumeApproval === true
          ? async (approval, signal) => {
              signal.throwIfAborted();
              const decision = sessionPermissionPolicy(ctx, sessionId)?.decide(approval);
              if (decision === 'deny') return false;
              if (ctx.store.consumeTaskApproval(sessionId, taskId, approval)) return true;
              if (
                decision === 'allow' ||
                (decision !== 'ask' &&
                  ((approval.kind === 'write' && ctx.options.allowWrite) ||
                    (approval.kind === 'command' &&
                      ctx.options.allowCommand &&
                      !approval.escalation)))
              )
                return true;
              ctx.store.deferTaskApproval(sessionId, taskId, approval);
              throw new DeferredApprovalError();
            }
          : sessionVerifier(ctx, sessionId);
      const verified = await verifyTaskAcceptance(
        root,
        task,
        baselines,
        operation.controller.signal,
        async (approval, signal) => {
          const allowed = await approvalForVerification(approval, signal);
          if (allowed)
            acceptanceEffects.set(
              approval.toolCall.id.slice('acceptance:'.length),
              ctx.store.beginTaskEffect(sessionId, taskId, attempt.id, approval.toolCall.name),
            );
          return allowed;
        },
      );
      // Verification must not promote a task that was never actually run: without a prior
      // run attempt there is no evidence the steps were executed, so completion stays gated.
      const completed = verified.passed && Boolean(task.latestRunId);
      const updated = ctx.store.finishTaskAttempt(sessionId, taskId, attempt.id, {
        resolvedEffectIds: verified.evidence.checks.flatMap((check) =>
          check.command && !check.command.timedOut
            ? [acceptanceEffects.get(check.id)].filter((id): id is string => Boolean(id))
            : [],
        ),
        status: completed ? 'completed' : 'needs_review',
        verification: verified.evidence,
        ...(verified.error ? { error: verified.error } : {}),
        ...(!completed
          ? {
              /**
               * "Never run" is the more useful of the two truths.
               *
               * A verification of a task that was never executed also fails for a definition-level reason 閳?its
               * steps are still pending, which is what not having run means. Reporting the cause rather than the
               * consequence is what tells the reader to run the task instead of to edit it.
               */
              error: task.latestRunId
                ? (verified.error ?? 'Task verification did not pass; review the evidence')
                : 'Task has not been run; run it before verifying completion',
            }
          : {}),
        acceptance: verified.acceptance,
        steps: verified.steps,
      });
      return {
        task: updated,
        attempt: ctx.store.getTaskAttempt(sessionId, taskId, attempt.id),
      };
    } catch (error) {
      ctx.store.finishTaskAttempt(sessionId, taskId, attempt.id, {
        status: error instanceof DeferredApprovalError ? 'needs_review' : 'blocked',
        error: safeError(error),
      });
      throw error;
    } finally {
      finishManualOperation(ctx, operation);
      lease.release();
    }
  },
  'task.retry': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const taskId = required(params, 'taskId');
    const latestRun = ctx.store
      .listTaskAttempts(sessionId, taskId)
      .filter((attempt) => attempt.kind === 'run')
      .at(-1);
    const prompt =
      typeof params.prompt === 'string' && params.prompt.trim() ? params.prompt : latestRun?.prompt;
    if (!prompt) throw new Error('Task has no prior run prompt; provide prompt');
    return ctx.dispatch('run.start', {
      sessionId,
      taskId,
      prompt,
      ...(ctx.store.getTask(sessionId, taskId).approvalOutcomeUnknown ? { resume: true } : {}),
    });
  },
};
