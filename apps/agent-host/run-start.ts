import {
  exhaustedGoalVerdict,
  GOAL_CONTINUATIONS_PER_REQUEST,
} from '../../packages/protocol/goals.ts';
import { isMachineContext } from '../../packages/protocol/context.ts';
import { validateImages } from '../../packages/protocol/images.ts';
import type { AgentEvent, RunResult, TaskTriggerSource } from '../../packages/protocol/index.ts';
import type { InvariantViolation } from '../../packages/protocol/invariants.ts';
import { parseSetting } from '../../packages/protocol/settings.ts';
import { PermissionPolicy } from '../../packages/core/permissions.ts';
import { runGoalRounds } from '../../packages/core/goal-driver.ts';
import { generateSessionTitle } from '../../packages/core/session-title.ts';
import { createProvider, readConfig } from '../../packages/providers/index.ts';
import { executionPolicy as callExecutionPolicy } from '../../packages/tools/execution-policy.ts';
import { reconcilePendingFileChanges } from '../../packages/tools/file-undo.ts';
import { createAgent } from '../shared/runtime.ts';
import { createRunApprover, createRunQuestioner } from './approvals.ts';
import { ownedSession, required } from './params.ts';
import type { ActiveRun, HostContext, WakeGrant } from './state.ts';

/**
 * One run of one session, from admitting it to settling the work it started.
 *
 * A run is the Host's unit of exclusivity: while it holds `active`, nothing else may start in that session, and
 * the slot is therefore reserved *before* the first await — the reconciliation below does real filesystem I/O, so
 * a check-then-set across it would let a concurrent `run.start` (a duplicate dispatch, or a scheduler tick) pass
 * the same guard, and the loser's `finally` would then delete the winner's entry and leave a live run
 * uncancellable. Everything else here follows from what started the run: a person (who is asked for approvals and
 * answers), a clock or an event (which is nobody, and fails closed), or a background wake (which carries its own
 * authority and its own wall clock).
 *
 * The run is also where a session's goal is continued. A goal is the session's statement of what it is trying to
 * achieve, and with an active goal the request that finished round one keeps going — each continuation is an
 * ordinary round of its own, bounded by the Host's own continuation budget rather than by the goal's own ceiling.
 * Three kinds of run are deliberately left out of that loop: a planning run hands its decision to a human, a task
 * run's rounds belong to that task's acceptance evidence, and an approved plan executes exactly what was approved.
 */
export async function startRun(
  ctx: HostContext,
  params: Record<string, unknown>,
  wake?: WakeGrant,
): Promise<RunResult> {
  const sessionId = required(params, 'sessionId'),
    prompt = required(params, 'prompt');
  ownedSession(ctx.store, ctx.workspace, sessionId);
  if (ctx.active.size || ctx.restoring) throw new Error('This Host already has an active run');
  const requestedTask =
    typeof params.taskId === 'string' ? ctx.store.getTask(sessionId, params.taskId) : undefined;
  const unattendedTaskId =
    requestedTask &&
    typeof params.trigger === 'string' &&
    ['interval', 'daily', 'event', 'recovery', 'at', 'after', 'weekly', 'cron'].includes(
      params.trigger,
    )
      ? requestedTask.id
      : undefined;
  if (
    requestedTask?.pendingApproval &&
    !unattendedTaskId &&
    requestedTask.pendingApproval.state !== 'rejected'
  )
    throw new Error('Review the pending task approval before a manual retry');
  /**
   * Plan mode, phase one: a read-only planning run. The plan row is created up front so an
   * interrupted planning run leaves a visible `planning` record instead of nothing, and the
   * run is told to answer with `submit_plan`.
   *
   * The phase is asked of the *session* when the request does not name one, because plan mode outlives the
   * request that started it: a plan left `planning` by a stopped run, a crash, or a restart means nobody has
   * decided anything yet, so the next run of that session continues planning. Deciding from the request
   * alone made the same session read-only through the CLI's `resume` and read-write through a client that
   * does not send `phase` — the write it then made would have been refused a moment earlier. A request that
   * names a plan to *execute* is a decision and is left alone (`planId` is checked below, and only an
   * approved plan can be executed).
   */
  const explicitPlan = params.phase === 'plan';
  if (params.phase !== undefined && params.phase !== 'plan') throw new Error('Invalid run phase');
  const continuing =
    explicitPlan || typeof params.planId === 'string' ? null : ctx.store.planMode(sessionId);
  const planPhase = explicitPlan || continuing !== null;
  const plannedTaskId = planPhase ? undefined : requestedTask?.id;
  if (planPhase && (requestedTask || typeof params.planId === 'string'))
    throw new Error('A planning run cannot execute a task or an approved plan');
  // Plan mode, phase two: executing an approved plan. Both the status and the body digest are
  // re-checked here, because approval and execution are separate requests and the plan can be
  // edited in between — that edit would otherwise run unreviewed work.
  const approvedPlan =
    typeof params.planId === 'string'
      ? ctx.store.executablePlan(sessionId, params.planId)
      : undefined;
  const controller = new AbortController();
  const entry: ActiveRun = { controller };
  // Reserve the slot before the first await. The reconciliation below does real filesystem
  // I/O, so a check-then-set across it let a concurrent run.start (a duplicate dispatch, or
  // a scheduler tick) pass the same `active.size` guard; the loser then ran its `finally` and
  // deleted the winner's entry, leaving a live run uncancellable and re-admitting new runs.
  ctx.active.set(sessionId, entry);
  const wakePolicy = wake?.authority.permissionPolicy
    ? new PermissionPolicy(wake.authority.permissionPolicy)
    : undefined;
  const wakeTimer = wake
    ? setTimeout(
        () => controller.abort(new Error('Background wake time budget exhausted')),
        wake.maxRunMs,
      )
    : undefined;
  try {
    if (!wake) ctx.captureAuthority(sessionId);
    await ctx.announceSession(sessionId, true);
    /**
     * Name a new session as soon as its request is admitted. This uses the configured provider before
     * file reconciliation, agent setup, or the first reply; a failed call leaves the user-text fallback.
     *
     * "Has anybody asked this session anything yet" is asked of the *person's* messages: a runtime snapshot
     * is a user-role message the runtime wrote to itself, and counting one as a question meant a session
     * whose first turn announced a snapshot never got a model title at all — and the fallback named it
     * after the snapshot.
     */
    const askedByUser = ctx.store
      .messages(sessionId)
      .some(
        (message) =>
          message.role === 'user' && !isMachineContext(message.displayContent ?? message.content),
      );
    if (
      !wake &&
      parseSetting(process.env, 'YUANTU_SESSION_TITLES') !== false &&
      ctx.store.canGenerateTitle(sessionId) &&
      !askedByUser
    ) {
      try {
        const generated = await generateSessionTitle(
          createProvider(readConfig()),
          prompt,
          controller.signal,
        );
        if (generated) ctx.store.setGeneratedTitle(sessionId, generated.title, generated.usage);
      } catch {
        // Title generation is optional; the first user message supplies the fallback.
      }
    }
    await reconcilePendingFileChanges(ctx.store, sessionId, ctx.workspace);
  } catch (error) {
    clearTimeout(wakeTimer);
    ctx.active.delete(sessionId);
    throw error;
  }
  let runId = '';
  const emit = (event: AgentEvent) => {
    runId = event.runId;
    // Kept for `invariants.list`: the run reports its own failure, but a host outlives the run and an
    // operator asking "does this deployment currently satisfy its promises" needs an answer afterwards.
    if (event.type === 'invariant.violated')
      ctx.lastViolations = (event.data.violations ?? []) as InvariantViolation[];
    // The Host adds the id below; avoid publishing a duplicate unanswerable event.
    if (event.type !== 'approval.required' && event.type !== 'question.required')
      ctx.carrier.send({ event });
  };
  const approve = createRunApprover({
    options: ctx.options,
    store: ctx.store,
    sessionId,
    policy: () => (wake ? wakePolicy : ctx.permissionPolicy),
    wake: Boolean(wake),
    unattendedTaskId,
    runId: () => runId,
    approvals: ctx.approvals,
    approvalSources: ctx.approvalSources,
    send: (data) => ctx.carrier.send(data),
  });
  const ask = createRunQuestioner({
    options: ctx.options,
    sessionId,
    wake: Boolean(wake),
    unattendedTaskId,
    runId: () => runId,
    questions: ctx.questions,
    send: (data) => ctx.carrier.send(data),
  });
  try {
    // Idle residents are reaped on the way into a run rather than by a timer: a Host that has been
    // idle for hours should not be holding language servers it cannot use, and reaping here keeps the
    // process free of background timers whose only purpose is bookkeeping.
    ctx.residency.reapIdle();
    if (!ctx.sessionSandboxes.has(sessionId))
      ctx.sessionSandboxes.set(sessionId, ctx.defaultSandboxMode);
    const agent = await createAgent(
      ctx.store,
      ctx.workspace,
      ctx.options,
      approve,
      // Live policy changes affect pending approvals and the next round's tool schema.
      () => (wake ? wakePolicy : ctx.permissionPolicy),
      emit,
      ctx.background,
      sessionId,
      ctx.hooks,
      ctx.residency,
      ask,
      ctx.invariants,
      ctx.terminals,
      () =>
        callExecutionPolicy(
          wake?.authority.sandboxMode ??
            ctx.sessionSandboxes.get(sessionId) ??
            ctx.defaultSandboxMode,
          {
            image: ctx.launchSandbox.image,
          },
        ),
      controller.signal,
    );
    entry.agent = agent;
    // Created after the busy-guard above but before the run, so the row and the run that fills
    // it cannot disagree about which is current. A continued plan is the row it is continuing
    // rather than a second one beside it.
    const planId = explicitPlan ? ctx.store.createPlan(sessionId).id : (continuing?.planId ?? null);
    const firstRound = agent.run({
      sessionId,
      prompt,
      taskId: plannedTaskId,
      // A run the clock started is not the user's turn: it may report on the session's goal but not change
      // who is in charge of it (see `HUMAN_ONLY_GOAL_ACTIONS`). A manual retry of the same task is the
      // user's own request and keeps the default.
      ...(unattendedTaskId || wake ? { authority: 'automatic' as const } : {}),
      ...(planId ? { planPhase: true, planId } : {}),
      ...(approvedPlan ? { approvedPlan } : {}),
      ...(typeof params.trigger === 'string'
        ? { taskTrigger: params.trigger as TaskTriggerSource }
        : {}),
      ...(params.resume === true ? { resumeTask: true } : {}),
      images: validateImages(params.images),
      signal: controller.signal,
    });
    entry.task = firstRound;
    let outcome = await firstRound;
    /**
     * Rounds the session's own goal starts.
     *
     * A goal is the session's statement of what it is trying to achieve, and nothing here used to start the
     * run that would continue it: the client asked again, or nobody did. With an active goal the request
     * that finished round one keeps going — each continuation is an ordinary run (its own steps, tools,
     * retries and wall clock), the goal's own round budget bounds how many, and the loop stops on a
     * terminal goal, a spent budget, or a round that did not finish.
     *
     * Three kinds of run are deliberately left out. A planning run hands its decision to a human. A task
     * run's rounds belong to that task attempt and the acceptance evidence it produces, so extending one
     * invisibly would corrupt what the task's verification is checking. An approved-plan run executes
     * exactly the plan a person approved. In all three the goal is still read afterwards — the next
     * ordinary run in that session continues it.
     *
     * The request's reply is the *last* round's result rather than the first one's: a client that asked for
     * work wants the answer the session arrived at, and the rounds in between are not hidden — each is a
     * run of its own, so the carrier sees every one of them start and every message land.
     */
    if (!wake && !planId && !plannedTaskId && !approvedPlan) {
      const rounds = await runGoalRounds({
        /**
         * The host's own bound, not the goal's ceiling.
         *
         * Passing `GOAL_CEILINGS.maxGoalRounds` here made the "second bound" the goal's own number wearing
         * a different name: `max_goal_rounds` is a record the model may raise through `update_goal`, so a
         * continuation round that raised it to the ceiling also decided how many rounds this loop would
         * run unattended. See `GOAL_CONTINUATIONS_PER_REQUEST`.
         */
        maxContinuations: GOAL_CONTINUATIONS_PER_REQUEST,
        signal: controller.signal,
        goalOf: () => ctx.store.goal(sessionId),
        onRound: (continuation) => {
          process.stderr.write(`[goal] round ${continuation.round}\n`);
        },
        // The goal spent its rounds and is still active, which is a state that tells everyone reading it
        // that more rounds are coming. Recording the verdict is what stops that being a lie.
        onExhausted: (goal) => {
          const verdict = exhaustedGoalVerdict(goal, new Date().toISOString());
          if (!verdict) return;
          ctx.store.recordEvent(sessionId, 'goal.changed', { action: 'blocked', goal: verdict });
          emit({
            type: 'goal.changed',
            sessionId,
            runId,
            // The frame carries the log position of the fact it announces, exactly as the kernel's own
            // `goal.changed` frames do, so the live view and the durable record stay ordered together.
            seq: ctx.store.lastSeq(sessionId),
            data: { action: 'blocked', goal: verdict },
          });
        },
        runOnce: async (prompt) => {
          // Another round of the same goal, started by the runtime rather than by the user: it may carry
          // the work forward and report on the goal, but not re-aim it or undo a pause.
          outcome = await agent.run({
            sessionId,
            prompt,
            signal: controller.signal,
            authority: 'automatic',
          });
          return { status: outcome.status };
        },
      });
      if (rounds.continuations > 0)
        process.stderr.write(
          `[goal] stopped after ${rounds.continuations} round(s): ${rounds.stopped}\n`,
        );
    }
    return outcome;
  } finally {
    clearTimeout(wakeTimer);
    try {
      if (controller.signal.aborted) await ctx.background.close(sessionId);
    } finally {
      ctx.active.delete(sessionId);
      ctx.queueWake();
      // Announce completion only after the slot is free, otherwise a task triggered by this
      // event would be skipped as "Host busy" and silently never run.
      const taskId = typeof params.taskId === 'string' ? params.taskId : undefined;
      ctx.notifyScheduler({
        name: 'run.finished',
        sessionId,
        ...(taskId ? { taskId } : {}),
      });
      if (taskId) {
        try {
          if (ctx.store.getTask(sessionId, taskId).status === 'completed')
            ctx.notifyScheduler({ name: 'task.completed', sessionId, taskId });
        } catch {
          /* A task deleted while running is not a completion. */
        }
      }
    }
  }
}
