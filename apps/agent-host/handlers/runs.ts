import {
  backgroundState,
  setBackgroundPolicy,
} from '../../../packages/core/background-deliveries.ts';
import { validateImages } from '../../../packages/protocol/images.ts';
import { ownedSession, required } from '../params.ts';
import type { Handler } from '../dispatch.ts';
import { startRun } from '../run-start.ts';

/**
 * The input a running session may still accept, and the two ways one ends.
 *
 * A run holds its session exclusively, so the interesting part of these cases is what they do *without* one: a
 * queue read falls back to the durable log, because what nobody ever delivered is exactly what a reopened session
 * has to show, and a cancel that also pauses an auto-waking session is the difference between stopping this run
 * and stopping the next twenty.
 */
export const runHandlers: Readonly<Record<string, Handler>> = {
  'run.enqueue': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const agent = ctx.active.get(sessionId)?.agent;
    if (!agent) throw new Error('Session is not running');
    if (params.mode !== 'steer' && params.mode !== 'follow-up')
      throw new Error('Invalid input mode');
    return {
      item: agent.enqueue(
        sessionId,
        { prompt: required(params, 'prompt'), images: validateImages(params.images) },
        params.mode,
      ),
    };
  },
  'run.queue.get': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const agent = ctx.active.get(sessionId)?.agent;
    // The run identity travels in the same answer as the state it belongs to, so a client cannot be told "a run
    // holds this session" and be left unable to recognise that run's frames. It is the same id the live frames
    // carry: `beginRun` writes it to the session and the emitter stamps it on every event.
    const activeRun = ctx.store.get(sessionId).activeRun;
    const identity = activeRun ? { runId: activeRun } : {};
    // With no run holding the session there is no agent either, and the answer comes from the log: what
    // nobody ever delivered. Asking the store directly is what lets a reopened session show that at all.
    return agent
      ? { ...agent.inboxOf(sessionId), ...identity }
      : { running: false, items: ctx.store.pendingInputs(sessionId), ...identity };
  },
  'run.queue.clear': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const agent = ctx.active.get(sessionId)?.agent;
    if (agent) agent.clearQueue(sessionId);
    else ctx.store.discardPendingInputs(sessionId, 'user');
    return { cleared: true };
  },
  'run.cancel': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const run = ctx.active.get(sessionId);
    const manual = ctx.manualOperation?.sessionId === sessionId ? ctx.manualOperation : undefined;
    const policy = backgroundState(ctx.store, sessionId).policy;
    if (policy.mode === 'auto')
      setBackgroundPolicy(ctx.store, sessionId, {
        mode: policy.mode,
        paused: true,
        maxWakeups: policy.maxWakeups,
        maxRunMs: policy.maxRunMs,
      });
    run?.controller.abort();
    manual?.controller.abort();
    await ctx.background.close(sessionId);
    return { cancelled: !!run || !!manual };
  },
  'run.start': startRun,
};
