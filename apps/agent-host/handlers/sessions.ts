import { undoFileChange } from '../../../packages/tools/file-undo.ts';
import { ownedSession, required } from '../params.ts';
import type { Handler } from '../dispatch.ts';

/**
 * A session's own state, and the two ways it stops existing.
 *
 * Everything here is a fold of the durable log rather than memory the Host happens to hold — the checklist, the
 * plan, the deliverables, the goal — which is why a Host that never saw the run that wrote them answers exactly
 * like the one that did. They are asked for separately because they outlive the run that wrote them and a reload
 * has to bring them back.
 *
 * Deletion is the one destructive case, and it is deliberately thorough: a terminal holds a real process, so a
 * deleted session must not leave a shell running behind it; the `session-close` invariant is checked before the
 * log goes away, because that is the last moment the check can read it; and the `sessionEnd` hook fires with
 * reason `delete` so a hook can tell this apart from the shutdown that fires the same hook with reason
 * `shutdown`.
 */
export const sessionHandlers: Readonly<Record<string, Handler>> = {
  'changes.list': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return ctx.store.fileChanges(sessionId);
  },
  'subagents.list': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    return ctx.store.subagents(id);
  },
  'todos.get': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    return { todos: ctx.store.todos(id), change: ctx.store.todoChange(id) };
  },
  'plan.get': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return ctx.store.latestPlan(sessionId);
  },
  /**
   * The two pieces of session state a reopened window has to restore that are not messages.
   *
   * Both are folds of the durable log (`projections.ts`), so a Host that never saw the run that wrote them
   * answers exactly like the one that did: the files a run marked as its deliverables, and the goal the
   * session is working toward.
   */
  'deliverables.get': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return ctx.store.deliverables(sessionId);
  },
  'goal.get': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    return ctx.store.goal(sessionId);
  },
  'plan.approve': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before approving a plan');
    // The hash is the text the human reviewed, so an edit between review and approval is refused.
    return ctx.store.approvePlan(sessionId, required(params, 'planId'), required(params, 'hash'));
  },
  'plan.reject': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before rejecting a plan');
    return ctx.store.rejectPlan(
      sessionId,
      required(params, 'planId'),
      typeof params.reason === 'string' ? params.reason : undefined,
    );
  },
  'changes.undo': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring) throw new Error('Host is busy; wait before undo');
    ctx.restoring = true;
    try {
      await undoFileChange(ctx.store, sessionId, required(params, 'id'), ctx.workspace);
      return { undone: true };
    } finally {
      ctx.restoring = false;
    }
  },
  'session.create': async (ctx) => {
    const created = ctx.store.create(ctx.workspace);
    await ctx.announceSession(created.id, false);
    ctx.notifyScheduler({ name: 'session.created', sessionId: created.id });
    return created;
  },
  'session.list': async (ctx, params) => {
    if (params.query !== undefined && typeof params.query !== 'string')
      throw new Error('Invalid search query');
    return ctx.store.list(params.query as string | undefined, ctx.workspace);
  },
  'session.rename': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before changing sessions');
    return ctx.store.rename(id, required(params, 'title'));
  },
  'session.delete': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before changing sessions');
    ctx.restoring = true;
    try {
      await ctx.background.close(id);
      // A terminal holds a real process, so a deleted session must not leave a shell running behind it —
      // the same rule the background commands follow, for a stronger reason.
      await ctx.terminals.closeAllAndWait(id);
      /**
       * Checked before the session goes away, because the check reads its log. A `session-close`
       * violation cannot stop anything — the session is being deleted on purpose — so it is reported on
       * stderr, where an operator sees the promises this deployment is not keeping.
       */
      const closingViolations = await ctx.invariants.run('session-close', { sessionId: id });
      for (const violation of closingViolations)
        process.stderr.write(
          `invariant violated on session close: ${violation.name} (${violation.owner}): ${violation.detail}\n`,
        );
      ctx.store.delete(id);
      if (ctx.announced.delete(id)) {
        const failures = await ctx.hooks.sessionEnd(
          { sessionId: id, reason: 'delete' },
          new AbortController().signal,
        );
        for (const failure of failures)
          process.stderr.write(`sessionEnd hook failed: ${failure}\n`);
      }
      return { deleted: true };
    } finally {
      ctx.restoring = false;
    }
  },
};
