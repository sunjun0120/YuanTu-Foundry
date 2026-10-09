import { DeferredApprovalError } from '../../../packages/core/approval-deferred.ts';
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
    if (params.allow) void ctx.scheduler.tick();
    return task;
  },
  'task.trigger': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before editing tasks');
    const taskId = required(params, 'taskId');
    // `null` clears the trigger; an absent field would be indistinguishable from "unchanged".
    return ctx.store.updateTask(sessionId, taskId, {
      trigger: (params.trigger ?? null) as never,
    });
  },
  'task.update': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before editing tasks');
    const update = { ...params } as Record<string, unknown>;
    delete update.sessionId;
    delete update.taskId;
    delete update.status;
    const expectedUpdatedAt =
      typeof update.expectedUpdatedAt === 'string' ? update.expectedUpdatedAt : undefined;
    delete update.expectedUpdatedAt;
    const taskId = required(params, 'taskId');
    const task = ctx.store.getTask(sessionId, taskId);
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
    if (ctx.active.size || ctx.restoring) throw new Error('Host is busy; wait before planning');
    const task = ctx.store.getTask(sessionId, required(params, 'taskId'));
    if (task.status === 'in_progress') throw new Error('Task is running');
    ctx.restoring = true;
    let runId: string | undefined;
    const statistics = emptyStatistics();
    const started = performance.now();
    let resultText = '',
      errorText: string | undefined;
    try {
      runId = ctx.store.beginRun(sessionId);
      const proposal = await proposeTask(
        createProvider(readConfig()),
        task,
        AbortSignal.timeout(Math.min(ctx.options.requestTimeoutMs ?? 120000, 120000)),
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
        ctx.restoring = false;
      }
    }
  },
  'task.confirm': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before manual confirmation');
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
    ctx.restoring = true;
    try {
      const verified = await verifyTaskAcceptance(
        ctx.workspace,
        task,
        baselines,
        undefined,
        ctx.verifyApprover,
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
      ctx.restoring = false;
    }
  },
  'task.verify': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring) throw new Error('Host is busy; wait before verifying');
    const taskId = required(params, 'taskId');
    const task = ctx.store.getTask(sessionId, taskId);
    const baselines = ctx.store.latestRunAttemptBaselines(sessionId, taskId) as TaskBaselines;
    const attempt = ctx.store.startTaskAttempt(sessionId, taskId, {
      kind: 'verify',
      baselines,
    });
    ctx.restoring = true;
    try {
      const acceptanceEffects = new Map<string, string>();
      const approvalForVerification: Approver =
        params.resumeApproval === true
          ? async (approval, signal) => {
              signal.throwIfAborted();
              const decision = ctx.permissionPolicy?.decide(approval);
              if (decision === 'deny') return false;
              if (ctx.store.consumeTaskApproval(sessionId, taskId, approval)) return true;
              if (
                decision === 'allow' ||
                (decision !== 'ask' &&
                  ((approval.kind === 'write' && ctx.options.allowWrite) ||
                    (approval.kind === 'command' && ctx.options.allowCommand)))
              )
                return true;
              ctx.store.deferTaskApproval(sessionId, taskId, approval);
              throw new DeferredApprovalError();
            }
          : ctx.verifyApprover;
      const verified = await verifyTaskAcceptance(
        ctx.workspace,
        task,
        baselines,
        undefined,
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
              error: verified.error ?? 'Task has not been run; run it before verifying completion',
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
      ctx.restoring = false;
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
