import { required, ownedSession } from '../params.ts';
import { WorkspaceManager } from '../../../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../../../packages/workspaces/results.ts';
import type { Handler } from '../dispatch.ts';
import {
  bindingClaim,
  executionRoot,
  fileClaims,
  hostClaim,
  rootClaim,
  sessionClaim,
  withLocks,
  type HostContext,
} from '../state.ts';
import type { LockClaim } from '../resource-locks.ts';
import { WorkspaceFailure, type WorkspaceBinding } from '../../../packages/protocol/workspaces.ts';
import { samePath } from '../../../packages/platform/workspace-paths.ts';
import { nodeDependencyWarning } from '../../../packages/workspaces/dependencies.ts';
import { ToolRegistry } from '../../../packages/tools/registry.ts';
import { workspaceResultTools } from '../../../packages/tools/workspaces.ts';
import { createRunApprover } from '../approvals.ts';
import { sessionExecutionPolicy, sessionPermissionPolicy } from '../session-policy.ts';
import { releaseSnapshotsIfIdle } from '../snapshot-release.ts';
import { executionPolicy, withExecutionPolicy } from '../../../packages/tools/execution-policy.ts';
import { metadataWritesAllowed } from '../../shared/runtime.ts';

/**
 * What a client can ask about the directories sub-agents work in.
 *
 * Three rules shape every handler here, and the first is the one a reviewer should check hardest:
 *
 * 1. **Project ownership comes first.** Session-addressed operations start with `ownedSession`. Recovery by binding
 *    id requires a managed orphan whose project matches this Host; the orphan inventory uses the same project
 *    scope. A binding id cannot bypass ownership or address a live session's directory.
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

  /**
   * Session deletion retains managed directories; keep them addressable by their own identity. Their results go
   * with the session (except one interrupted mid-import), so an orphan usually lists none.
   */
  'workspaces.orphaned': async (ctx, params) => {
    if (params.includeRemoved !== undefined && typeof params.includeRemoved !== 'boolean')
      throw new Error('Invalid includeRemoved');
    const manager = new WorkspaceManager({ store: ctx.store });
    const entries = [];
    for (const binding of manager.orphaned(ctx.workspace, params.includeRemoved === true))
      entries.push({
        binding,
        problems: binding.state === 'removed' ? [] : await diagnose(manager, binding),
        results: ctx.store.workspaceResultsForBinding(binding.id),
      });
    return entries;
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
    // The import checks the target's bytes and then writes them, so it holds the directory it writes alone.
    const claims = fileClaims(sessionId, executionRoot(ctx, sessionId));
    const busy = 'Host is busy; wait before importing a sub-agent result';
    return await withLocks(ctx, { claims, busy, operation: { sessionId } }, async (signal) => {
      const service = new WorkspaceResultsService({ store: ctx.store });
      const resultId = required(params, 'resultId');
      const expectedDigest = required(params, 'expectedDigest');
      let preview = await service.previewApply({
        parentSessionId: sessionId,
        resultId,
        expectedDigest,
        signal,
      });
      if (preview.conflicts.length)
        return {
          status: 'conflict' as const,
          conflicts: preview.conflicts,
          files: [] as { path: string; added: number; removed: number }[],
        };
      let outcome: Awaited<ReturnType<WorkspaceResultsService['apply']>> | undefined;
      const tools = new ToolRegistry(ctx.hooks);
      tools.registerExtension(
        workspaceResultTools({
          store: ctx.store,
          sessionId,
          results: {
            previewApply: async (input) => (preview = await service.previewApply(input)),
            reconcile: (signal) => service.reconcile(signal),
            apply: async (input) => (outcome = await service.apply(input)),
          },
        }),
      );
      try {
        const result = await tools.execute(
          {
            id: `workspace-apply-${resultId}`,
            name: 'workspace_result_apply',
            arguments: { resultId, expectedDigest },
          },
          {
            signal,
            sessionId,
            workspaceRoot: ctx.store.workspaceBinding(sessionId).executionRoot,
            executionPolicyForCall: () => sessionExecutionPolicy(ctx, sessionId),
            permissionPolicyForCall: () => sessionPermissionPolicy(ctx, sessionId),
            approve: createRunApprover({
              options: ctx.options,
              store: ctx.store,
              sessionId,
              policy: () => sessionPermissionPolicy(ctx, sessionId),
              wake: false,
              unattendedTaskId: undefined,
              runId: () => '',
              approvals: ctx.approvals,
              approvalSources: ctx.approvalSources,
              send: (data) => ctx.carrier.send(data),
            }),
          },
        );
        if (result.isError) throw new Error(result.content);
        if (!outcome && preview.conflicts.length)
          return { status: 'conflict' as const, conflicts: preview.conflicts, files: [] };
        if (!outcome) throw new Error('Workspace import ended without an outcome');
      } finally {
        await tools.close();
      }
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
    });
  },

  /**
   * Archive a workspace: freeze what it produced, then let the directory go.
   *
   * Refused while anything of the session's is live, because archiving a running child would remove the tree it is
   * writing in. The guard is the Host's own active-run map plus the child's lease, which is the same evidence the
   * delegation path uses.
   */
  'workspace.archive': async (ctx, params) => {
    const { manager, binding } = maintenanceWorkspace(ctx, params);
    // Registered so Stop (for the owning session) and shutdown reach it: these rewrite or delete a whole tree.
    const archived = await withLocks(
      ctx,
      {
        claims: maintenanceClaims(params, binding),
        busy: 'Host is busy; wait before archiving a workspace',
        operation: typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {},
      },
      async (signal) => {
        await manager.archive(binding.id, signal);
        return { archived: true as const, bindingId: binding.id, state: 'archived' as const };
      },
    );
    // Archiving leaves the snapshot it froze named by the archived binding; this releases older, unused ones.
    await releaseSnapshotsIfIdle(ctx);
    return archived;
  },

  /** Rebuild an archived or removed workspace from its own frozen input, keeping the same identity. */
  'workspace.restore': async (ctx, params) => {
    const { manager, binding } = maintenanceWorkspace(ctx, params);
    return await withLocks(
      ctx,
      {
        claims: maintenanceClaims(params, binding),
        busy: 'Host is busy; wait before restoring a workspace',
        operation: typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {},
      },
      async (signal) => {
        // The restored binding is returned rather than the one that was asked for: a restore re-validates the
        // directory and may move the binding's state, and a client that showed the old state would be showing a
        // record that is no longer what the service believes.
        const restored = await manager.restore(binding.id, signal);
        return { restored: true as const, binding: restored };
      },
    );
  },
  'workspace.remove': async (ctx, params) => {
    const { manager, binding } = maintenanceWorkspace(ctx, params);
    const removed = await withLocks(
      ctx,
      {
        claims: maintenanceClaims(params, binding),
        busy: 'Host is busy; wait before removing a workspace',
        operation: typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {},
      },
      async (signal) => {
        await manager.remove(binding.id, signal);
        return { removed: true as const, bindingId: binding.id, state: 'removed' as const };
      },
    );
    // The removal record keeps the snapshot the removal itself froze; older unused shares can go now.
    await releaseSnapshotsIfIdle(ctx);
    return removed;
  },
};

/** A binding ID is a recovery address, never an alternative authority over a live session. */
/**
 * What archiving, restoring or removing a binding holds.
 *
 * Addressed through its session, it is that session, the binding and the binding's directory — another session
 * working elsewhere is no obstacle. An orphan has no session left to hold, and is the one case that still waits for
 * the whole Host to be idle: nothing names who else might be relying on that directory.
 */
function maintenanceClaims(
  params: Record<string, unknown>,
  binding: WorkspaceBinding,
): LockClaim[] {
  if (typeof params.sessionId !== 'string')
    return [hostClaim('exclusive'), bindingClaim(binding.id)];
  return [
    hostClaim('shared'),
    sessionClaim(params.sessionId),
    bindingClaim(binding.id),
    rootClaim(binding.executionRoot, 'exclusive'),
  ];
}

function maintenanceWorkspace(ctx: HostContext, params: Record<string, unknown>) {
  if (params.bindingId !== undefined && params.sessionId !== undefined)
    throw new Error('Specify either a session or a binding');
  const bindingId = params.bindingId === undefined ? undefined : required(params, 'bindingId');
  const sessionId = bindingId === undefined ? required(params, 'sessionId') : undefined;
  if (params.policySessionId !== undefined && bindingId === undefined)
    throw new Error('Invalid policy context');
  const policySessionId =
    params.policySessionId === undefined ? sessionId : required(params, 'policySessionId');
  if (sessionId !== undefined) ownedSession(ctx.store, ctx.workspace, sessionId);
  if (policySessionId !== undefined) ownedSession(ctx.store, ctx.workspace, policySessionId);
  const manager: WorkspaceManager = new WorkspaceManager({
    store: ctx.store,
    metadataWritesAllowed: (): boolean => {
      // Re-read ownership with the operation lease as well: a pending allocation may have acquired a session.
      if (bindingId !== undefined) ownedOrphan(manager.byId(bindingId), ctx.workspace);
      if (policySessionId !== undefined) ownedSession(ctx.store, ctx.workspace, policySessionId);
      const policy =
        policySessionId !== undefined
          ? sessionExecutionPolicy(ctx, policySessionId)
          : executionPolicy(ctx.defaultSandboxMode, {
              files: ctx.defaultSandboxFiles,
              network: ctx.defaultSandboxNetwork,
              image: ctx.launchSandbox.image,
            });
      return withExecutionPolicy(policy, () => metadataWritesAllowed());
    },
  });
  return {
    manager,
    binding:
      bindingId !== undefined
        ? ownedOrphan(manager.byId(bindingId), ctx.workspace)
        : manager.resolve(sessionId!),
  };
}

function ownedOrphan(binding: WorkspaceBinding | null, workspace: string): WorkspaceBinding {
  if (!binding) throw new WorkspaceFailure('WORKSPACE_NOT_FOUND', 'Unknown workspace binding');
  if (!samePath(binding.projectRoot, workspace))
    throw new Error('Workspace binding belongs to a different workspace');
  if (binding.kind !== 'worktree' || binding.sessionId !== null)
    throw new WorkspaceFailure('WORKSPACE_INTEGRITY', 'Binding recovery requires an orphan');
  return binding;
}

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
