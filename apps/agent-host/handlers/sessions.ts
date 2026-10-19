import { undoFileChange } from '../../../packages/tools/file-undo.ts';
import { removeSpills } from '../../../packages/tools/spill.ts';
import { releaseSessionResources } from '../../../packages/catalog/resource-pool.ts';
import { removeResultArtifacts } from '../../../packages/workspaces/result-files.ts';
import { underSessionPolicy, sessionLifecycleReadOnly } from '../session-policy.ts';
import { releaseSnapshotsIfIdle } from '../snapshot-release.ts';
import { ownedSession, required } from '../params.ts';
import {
  assertUnlocked,
  executionRoot,
  fileClaims,
  hostClaim,
  lockConflict,
  sessionClaim,
  withLocks,
  type HostContext,
} from '../state.ts';
import type { Handler } from '../dispatch.ts';

/** A change to one session's own rows: only that session has to be idle. */
const assertSessionIdle = (ctx: HostContext, sessionId: string, busy: string) =>
  assertUnlocked(ctx, [hostClaim('shared'), sessionClaim(sessionId)], busy);

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
    return ctx.store.subagents(id, params.includePreviousRuns === true);
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
    assertSessionIdle(ctx, sessionId, 'Host is busy; wait before approving a plan');
    // The hash is the text the human reviewed, so an edit between review and approval is refused.
    return ctx.store.approvePlan(sessionId, required(params, 'planId'), required(params, 'hash'));
  },
  'plan.reject': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    assertSessionIdle(ctx, sessionId, 'Host is busy; wait before rejecting a plan');
    return ctx.store.rejectPlan(
      sessionId,
      required(params, 'planId'),
      typeof params.reason === 'string' ? params.reason : undefined,
    );
  },
  'changes.undo': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    // The change was journalled where the session works: its own worktree when it has one. Both the lock and the
    // undo have to name that directory, or a bound session would rewrite the project instead of its tree.
    const root = executionRoot(ctx, sessionId);
    // Undo checks the files and then rewrites them, so nothing else may write in that directory meanwhile.
    return await withLocks(
      ctx,
      { claims: fileClaims(sessionId, root), busy: 'Host is busy; wait before undo' },
      async () => {
        await undoFileChange(ctx.store, sessionId, required(params, 'id'), root);
        return { undone: true };
      },
    );
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
    // The store validates the page fields; only the ones the caller sent are passed, so an absent field stays absent.
    const page: { limit?: number; before?: string; id?: string; archived?: boolean } = {};
    if (params.limit !== undefined) page.limit = params.limit as number;
    if (params.before !== undefined) page.before = params.before as string;
    if (params.id !== undefined) page.id = params.id as string;
    if (params.archived !== undefined) page.archived = params.archived as boolean;
    return ctx.store.list(params.query as string | undefined, ctx.workspace, page);
  },
  'session.rename': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    assertSessionIdle(ctx, id, 'Host is busy; wait before changing sessions');
    return ctx.store.rename(id, required(params, 'title'));
  },
  'session.archive': async (ctx, params) => {
    const id = required(params, 'sessionId');
    if (typeof params.archived !== 'boolean') throw new Error('Invalid archive flag');
    ownedSession(ctx.store, ctx.workspace, id);
    assertSessionIdle(ctx, id, 'Host is busy; wait before changing sessions');
    return ctx.store.setArchived(id, params.archived);
  },
  'session.delete': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    // Every session the delete removes, so a delegated child that is still busy keeps its tree alive.
    const claims = [hostClaim('shared'), ...ctx.store.sessionTree(id).map(sessionClaim)];
    const deleted = await withLocks(
      ctx,
      {
        claims,
        busy: 'Host is busy; wait before changing sessions',
        // A delete can spend a while closing terminals and reclaiming files; Stop for the session and shutdown
        // should be able to reach it rather than waiting for all of that to finish.
        operation: { sessionId: id },
      },
      async (signal) => {
        // Checked before anything irreversible: browser profiles and terminals belong to the session, and a Stop
        // that arrived before the delete began should leave all of it as it was.
        signal.throwIfAborted();
        await ctx.background.close(id);
        // A terminal holds a real process, so a deleted session must not leave a shell running behind it —
        // the same rule the background commands follow, for a stronger reason.
        await ctx.terminals.closeAllAndWait(id);
        // Closing processes is already visible, but the profiles are the next irreversible step; a Stop before
        // this point still leaves the session's saved logins for a delete the person runs again.
        signal.throwIfAborted();
        // What the doomed sessions kept between runs, browser profiles included: a login must not outlive its session.
        for (const sessionId of ctx.store.sessionTree(id)) await releaseSessionResources(sessionId);
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
        if (ctx.announced.delete(id)) {
          const failures = await underSessionPolicy(ctx, id, () =>
            ctx.hooks.sessionEnd(
              { sessionId: id, reason: 'delete', readOnly: sessionLifecycleReadOnly(ctx, id) },
              new AbortController().signal,
            ),
          );
          for (const failure of failures)
            process.stderr.write(`sessionEnd hook failed: ${failure}\n`);
        }
        // Where each doomed session spilled is only answerable while its rows still exist: the project, and the
        // execution root a delegated child worked in when that was a directory of its own.
        const doomed = ctx.store.sessionTree(id);
        const spills = doomed.flatMap((sessionId) => {
          const binding = ctx.store.workspaceBinding(sessionId);
          const roots = new Set([ctx.store.get(sessionId).workspace, binding.executionRoot]);
          return [...roots].map((root) => ({ root, sessionId }));
        });
        /**
         * The results the delete removes, and the repository each one keeps its manifest and ref in — also only
         * answerable while the rows exist. The same rule as the store's: a result still `applying` is kept.
         */
        const results = new Map<string, string>();
        for (const sessionId of doomed)
          for (const result of [
            ...ctx.store.workspaceResults(sessionId),
            ...ctx.store.childWorkspaceResults(sessionId),
          ]) {
            const repositoryRoot = ctx.store.workspaceById(result.bindingId)?.repositoryRoot;
            if (result.status !== 'applying' && repositoryRoot)
              results.set(result.id, repositoryRoot);
          }
        // The destructive step: everything before it only released resources, so an abort here leaves the session
        // and its log intact rather than half-deleted.
        signal.throwIfAborted();
        ctx.store.delete(id);
        for (const [resultId, repositoryRoot] of results)
          await removeResultArtifacts(repositoryRoot, resultId).catch((error: unknown) =>
            process.stderr.write(
              `result cleanup failed for ${resultId}: ${(error as Error).message}\n`,
            ),
          );
        for (const spill of spills)
          await removeSpills(spill.root, spill.sessionId).catch((error: unknown) =>
            process.stderr.write(
              `spill cleanup failed for ${spill.sessionId}: ${(error as Error).message}\n`,
            ),
          );
        // Every session the delete removed, not only the one named: a delegated child had its own sandbox choice,
        // policy and phase, and keys for sessions that no longer exist are memory nothing will ever release. A
        // child still announced would also get a `sessionEnd` at shutdown for a session whose log is gone.
        for (const sessionId of doomed) {
          ctx.sessionLifecyclePhases?.delete(sessionId);
          ctx.sessionSandboxes.delete(sessionId);
          ctx.sessionSandboxFiles.delete(sessionId);
          ctx.sessionSandboxNetwork.delete(sessionId);
          ctx.sessionPermissionPolicies.delete(sessionId);
          ctx.announced.delete(sessionId);
        }
        return { deleted: true };
      },
    );
    // The deleted session can be the last name a snapshot had; releasing here is safe because this Host has no run
    // or manual operation in flight, and a run that starts now waits before recording a new snapshot.
    await releaseSnapshotsIfIdle(ctx);
    return deleted;
  },
  /**
   * An operator's way out of a lease that can never be confirmed dead.
   *
   * Refused while *this* Host is running the session: that run is demonstrably live, and settling it would let a
   * second writer in. Every other case is the caller's decision — a pid reused by an unrelated process, an owner
   * row written before start times were recorded, a machine where the start-time probe kept failing — and the
   * interruption it records says so.
   */
  'session.recover': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    if (ctx.active.has(id))
      throw new Error('This Host is running the session; cancel that run before recovering it');
    if (lockConflict(ctx, [hostClaim('shared'), sessionClaim(id)]))
      throw new Error('Host is busy; wait before recovering a session');
    return ctx.store.recoverSession(
      id,
      'Operator forced recovery: the owning process could not be confirmed dead',
    );
  },
};
