import {
  reconcileBackground,
  setBackgroundPolicy,
} from '../../../packages/core/background-deliveries.ts';
import { durableBackground, ownedSession, required } from '../params.ts';
import type { Handler } from '../dispatch.ts';

/**
 * The background jobs a session has produced, in the two forms a client reads them.
 *
 * A job is a *command the model started and walked away from*, so the record has to survive the process that
 * started it: every read here falls back to the durable log when the in-memory command is gone, which is what
 * lets a reconnected client still see what its earlier session produced. The mutating cases are the policy — how
 * often a session may be woken, and whether it may be woken at all — and clearing, which hides records a client
 * has read without deleting the evidence behind them.
 */
export const backgroundHandlers: Readonly<Record<string, Handler>> = {
  'background.list': async (ctx, params) => {
    const sessionId =
      typeof params.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId
        : undefined;
    if (sessionId) ownedSession(ctx.store, ctx.workspace, sessionId);
    const live = ctx.background.list(sessionId);
    return sessionId
      ? [
          ...live,
          ...durableBackground(ctx.store, sessionId).filter(
            (r) => !live.some((j) => j.id === r.id),
          ),
        ]
      : live;
  },
  'background.poll': async (ctx, params) => {
    // Polling observes output; only model job_output/collect marks a producer collected.
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const cursor = params.cursor === undefined ? 0 : Number(params.cursor);
    const waitMs = params.waitMs === undefined ? 0 : Number(params.waitMs);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid output cursor');
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5000)
      throw new Error('Invalid background wait');
    const id = required(params, 'id');
    if (!ctx.background.list(sessionId).some((j) => j.id === id)) {
      const durable = durableBackground(ctx.store, sessionId, id, cursor)[0];
      if (durable) return durable;
    }
    return ctx.background.poll(required(params, 'id'), sessionId, cursor, waitMs);
  },
  'background.stop': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return ctx.background.stopById(required(params, 'id'), sessionId);
  },
  'background.state': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return reconcileBackground(ctx.store, sessionId);
  },
  'background.policy': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (params.reset !== undefined && typeof params.reset !== 'boolean')
      throw Error('Invalid budget reset');
    if (params.reset === true && ctx.active.has(sessionId))
      throw Error('Stop the run before resetting its budget');
    const policy = setBackgroundPolicy(
      ctx.store,
      sessionId,
      params.policy,
      params.reset === true,
      ctx.currentAuthority(sessionId),
    );
    if ((policy.paused || policy.mode === 'notify') && ctx.waking.has(sessionId))
      ctx.active.get(sessionId)?.controller.abort();
    return reconcileBackground(ctx.store, sessionId);
  },
  'background.clear': async (ctx, params) => {
    const sessionId =
      typeof params.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId
        : undefined;
    if (sessionId) ownedSession(ctx.store, ctx.workspace, sessionId);
    if (sessionId) {
      const ids = durableBackground(ctx.store, sessionId).map((r) => r.id);
      if (ids.length) ctx.store.recordEvent(sessionId, 'background.hidden', { ids });
      ctx.background.clear(sessionId);
      return { cleared: ids.length };
    }
    return { cleared: ctx.background.clear(sessionId) };
  },
};
