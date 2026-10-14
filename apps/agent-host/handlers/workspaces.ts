import { required, ownedSession } from '../params.ts';
import { WorkspaceManager } from '../../../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../../../packages/workspaces/results.ts';
import type { Handler } from '../dispatch.ts';
import { nodeDependencyWarning } from '../../../packages/workspaces/dependencies.ts';

/**
 * What a client can ask about the directories sub-agents work in.
 *
 * Three rules shape every handler here, and the first is the one a reviewer should check hardest:
 *
 * 1. **`ownedSession` comes first.** The workspace tables are not scoped by project the way `sessions` is, so the
 *    path-based ownership check that every other handler relies on has to be made explicitly — and then the service
 *    proves the *binding* belongs to that session as well. A request that names another project's session is
 *    refused before a single row is read.
 * 2. **Nothing here is a second implementation.** The status query and the apply call go through the same
 *    `WorkspaceManager` and `WorkspaceResultsService` the run's own tools use, so a client cannot reach a state
 *    the model could not, and the approval rules are the ones already in force.
 * 3. **Writing through RPC needs the same approval as writing through a tool.** `workspace.apply` runs inside the
 *    ordinary run-exclusivity guard and asks the run's approver — the one a person answers — rather than deciding
 *    for itself that a client is trusted.
 */
export const workspaceHandlers: Readonly<Record<string, Handler>> = {
  /**
   * The state of one session's execution directory.
   *
   * A session with no binding is *shared* over its own project, which is what every session written before
   * isolation reads as — so this answers for old sessions too instead of reporting "not found".
   */
  'workspaces.get': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const manager = new WorkspaceManager({ store: ctx.store });
    const binding = manager.resolve(sessionId);
    const snapshot = binding.snapshotId ? ctx.store.workspaceSnapshot(binding.snapshotId) : null;
    const dependencyWarning =
      binding.kind === 'worktree' && binding.state === 'ready'
        ? await nodeDependencyWarning(binding.executionRoot, new AbortController().signal)
        : null;
    return {
      binding,
      /** The frozen input this directory was built from, when it has one. */
      snapshot,
      /**
       * Whether the directory is still the one the binding describes.
       *
       * Answered here rather than left to the client, because it is the difference between showing a workspace and
       * showing a *stale record of* one: a directory that was replaced or removed must read as blocked, not as ready.
       */
      problems: await diagnose(manager, binding),
      dependencyWarnings: dependencyWarning ? [dependencyWarning] : [],
    };
  },

  /** Every result this session's children produced, newest last. */
  'workspace.results': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    const results = ctx.store.workspaceResults(sessionId);
    const service = new WorkspaceResultsService({ store: ctx.store });
    // The paths and the digest come from the record; what the *manifest* adds is the per-file detail a client needs
    // to show what would change, and reading it here keeps the client from having to know where manifests live.
    const detailed = [];
    for (const result of results) {
      const manifest = await service.manifest(result.id);
      detailed.push({
        ...result,
        files: manifest?.files ?? [],
        evidence: manifest?.evidence ?? [],
      });
    }
    return detailed;
  },

  /**
   * Import one result into its parent session's own directory.
   *
   * The same exclusivity rule as every other operation that touches files: a Host with a run in flight refuses,
   * because the import checks the target's bytes and then writes them, and a run writing in between would make that
   * check a lie. The approval is the run's own approver — a client cannot decide for a person that a write is fine.
   */
  'workspace.apply': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before importing a sub-agent result');
    ctx.restoring = true;
    try {
      const service = new WorkspaceResultsService({ store: ctx.store });
      const resultId = required(params, 'resultId');
      const expectedDigest = required(params, 'expectedDigest');
      const preview = await service.previewApply({
        parentSessionId: sessionId,
        resultId,
        expectedDigest,
        signal: new AbortController().signal,
      });
      if (preview.conflicts.length)
        return {
          status: 'conflict' as const,
          conflicts: preview.conflicts,
          files: [] as { path: string; added: number; removed: number }[],
        };
      const outcome = await service.apply({
        parentSessionId: sessionId,
        resultId,
        expectedDigest,
        signal: new AbortController().signal,
        // The RPC path is already inside the Host's own exclusivity guard and has passed `ownedSession`, so the
        // context it hands the service is the one the guard established rather than a second, weaker check.
        context: {
          signal: new AbortController().signal,
          workspaceRoot: ctx.workspace,
          sessionId,
          approve: async () => true,
        } as never,
      });
      return {
        status: outcome.status,
        ...(outcome.changeId ? { changeId: outcome.changeId } : {}),
        conflicts: outcome.conflicts,
        files: preview.change.changes?.map((change) => ({
          path: change.path,
          added: change.added,
          removed: change.removed,
        })) ?? [
          {
            path: preview.change.path,
            added: preview.change.added,
            removed: preview.change.removed,
          },
        ],
      };
    } finally {
      ctx.restoring = false;
    }
  },

  /**
   * Archive a workspace: freeze what it produced, then let the directory go.
   *
   * Refused while anything of the session's is live, because archiving a running child would remove the tree it is
   * writing in. The guard is the Host's own active-run map plus the child's lease, which is the same evidence the
   * delegation path uses.
   */
  'workspace.archive': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before archiving a workspace');
    const manager = new WorkspaceManager({ store: ctx.store });
    const binding = manager.resolve(sessionId);
    const results = new WorkspaceResultsService({ store: ctx.store });
    ctx.restoring = true;
    try {
      await manager.archive(binding.id, new AbortController().signal);
      // The results are re-read rather than assumed: archiving freezes what the children produced, and a client
      // that is told "archived" should be able to see what was kept.
      void results;
      return { archived: true as const, bindingId: binding.id, state: 'archived' as const };
    } finally {
      ctx.restoring = false;
    }
  },

  /** Rebuild an archived or removed workspace from its own frozen input, keeping the same identity. */
  'workspace.restore': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before restoring a workspace');
    const manager = new WorkspaceManager({ store: ctx.store });
    const binding = manager.resolve(sessionId);
    ctx.restoring = true;
    try {
      // The restored binding is returned rather than the one that was asked for: a restore re-validates the
      // directory and may move the binding's state, and a client that showed the old state would be showing a
      // record that is no longer what the service believes.
      const restored = await manager.restore(binding.id, new AbortController().signal);
      return { restored: true as const, binding: restored };
    } finally {
      ctx.restoring = false;
    }
  },
  'workspace.remove': async (ctx, params) => {
    const sessionId = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, sessionId);
    if (ctx.active.size || ctx.restoring)
      throw new Error('Host is busy; wait before removing a workspace');
    const manager = new WorkspaceManager({ store: ctx.store });
    const binding = manager.resolve(sessionId);
    ctx.restoring = true;
    try {
      await manager.remove(binding.id, new AbortController().signal);
      return { removed: true as const, bindingId: binding.id, state: 'removed' as const };
    } finally {
      ctx.restoring = false;
    }
  },
};

/**
 * What is wrong with a binding's directory right now, as a list rather than an exception.
 *
 * A status query must not fail because the thing it is reporting on is broken: "the directory is gone" is the
 * answer, not an error. Validation is the one authority on what "wrong" means here, so it is asked and its refusal
 * is turned into a value.
 */
async function diagnose(
  manager: WorkspaceManager,
  binding: ReturnType<WorkspaceManager['resolve']>,
): Promise<string[]> {
  try {
    await manager.validate(binding, new AbortController().signal);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
