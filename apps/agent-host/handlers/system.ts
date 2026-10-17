import { parseSandboxMode } from '../../../packages/tools/sandbox-mode.ts';
import { PermissionPolicy } from '../../../packages/core/permissions.ts';
import { negotiateHostVersion } from '../../../packages/protocol/host-wire.ts';
import {
  executionPolicy,
  requireExecutionCapabilities,
} from '../../../packages/tools/execution-policy.ts';
import { ownedSession, required } from '../params.ts';
import type { Handler } from '../dispatch.ts';

/**
 * What the Host says about itself, and the two knobs a client may turn under it.
 *
 * These cases share one property: they answer about the *process* rather than about a session. That is why
 * `host.info` is the one reply whose shape a client negotiates against before it sends anything else, and why the
 * two setters below are the only methods that change how the Host as a whole behaves — the default sandbox a
 * session inherits, and the policy every tool call is judged by.
 */
export const systemHandlers: Readonly<Record<string, Handler>> = {
  'host.info': async (ctx, params) => ({
    protocolVersion: negotiateHostVersion(params),
    runtime: 'yuantu',
    workspace: ctx.workspace,
    capabilities: [
      'runtime.ready',
      'sessions',
      'session-management',
      'streaming',
      'message-turns',
      'approval',
      'cancel',
      'images',
      'steer',
      'follow-up',
      'context-summary',
      'resources',
      'session-pages',
      'tasks',
      'task-attempts',
      'task-verify',
      'task-retry',
      'background-jobs',
      'plan-approval',
      'subagents',
      'workspace-orphans-v1',
      'workspace-orphan-policy-context-v1',
      /**
       * The live cursor and the replay that goes with it. Advertised rather than assumed: a client that
       * reconnects to a Host which does not offer it has to re-read the session, and saying so is how the
       * carrier decides what to do instead of asking for a method that is not there.
       */
      'event-cursor',
      'session-events',
      /**
       * `sandbox.set` acknowledges the file and network policy it was given, not just the mode.
       *
       * Advertised because the carrier has to be able to tell this Host from one that ignores `files`/
       * `network` and answers the mode alone — a client that treated such a reply as applied would cache a
       * restriction that is not in force (see `CarrierService.applySelection`).
       */
      'execution-policy-files-network-v1',
    ],
  }),
  'runtime.ready': async (ctx, params) => {
    if (Object.keys(params).length) throw new Error('Invalid runtime readiness parameters');
    ctx.automaticReady = true;
    ctx.queueWake();
    return { ready: true };
  },
  'invariants.list': async (ctx) => ({
    invariants: ctx.invariants.describe(),
    violations: ctx.lastViolations,
  }),
  'sandbox.set': async (ctx, params) => {
    const mode = parseSandboxMode(params.mode);
    if (params.sessionId !== undefined && typeof params.sessionId !== 'string')
      throw new Error('Invalid sandbox session identity');
    if (
      params.files !== undefined &&
      params.files !== 'read-only' &&
      params.files !== 'workspace-write'
    )
      throw new Error('Invalid file policy');
    const files =
      params.files ??
      (typeof params.sessionId === 'string'
        ? (ctx.sessionSandboxFiles.get(params.sessionId) ?? ctx.defaultSandboxFiles)
        : ctx.defaultSandboxFiles);
    if (files !== 'read-only' && files !== 'workspace-write')
      throw new Error('Invalid file policy');
    const network =
      params.network ??
      (typeof params.sessionId === 'string'
        ? (ctx.sessionSandboxNetwork.get(params.sessionId) ?? ctx.defaultSandboxNetwork)
        : ctx.defaultSandboxNetwork);
    if (network !== undefined && network !== 'denied' && network !== 'unrestricted')
      throw new Error('Invalid network policy');
    const policy = executionPolicy(mode, { files, image: ctx.launchSandbox.image, network });
    if (files === 'read-only') requireExecutionCapabilities(policy, { processFiles: 'read-only' });
    if (typeof params.sessionId === 'string') {
      ownedSession(ctx.store, ctx.workspace, params.sessionId);
      // Pending tools refresh the selection after approval; executing bodies keep their snapshot.
      ctx.sessionSandboxes.set(params.sessionId, mode);
      ctx.sessionSandboxFiles.set(params.sessionId, files);
      ctx.sessionSandboxNetwork.set(params.sessionId, network);
      ctx.captureAuthority(params.sessionId);
    } else {
      if (ctx.active.size)
        throw new Error('Wait for active runs before changing the default execution policy');
      ctx.defaultSandboxMode = mode;
      ctx.defaultSandboxFiles = files;
      ctx.defaultSandboxNetwork = network;
    }
    return { mode, files, ...(network ? { network } : {}) };
  },
  'permission.update': async (ctx, params) => {
    const next = new PermissionPolicy(params.policy);
    const sessionId =
      params.sessionId === undefined ? undefined : required(params, 'sessionId');
    if (sessionId !== undefined) ownedSession(ctx.store, ctx.workspace, sessionId);
    // A session's selection is its own: switching session B must not re-decide what session A is waiting on.
    if (sessionId !== undefined) {
      ctx.sessionPermissionPolicies.set(sessionId, next);
      ctx.captureAuthority(sessionId, true);
    } else {
      ctx.permissionPolicy = next;
      for (const session of ctx.store.list('', ctx.workspace))
        if (!ctx.sessionPermissionPolicies.has(session.id)) ctx.captureAuthority(session.id, true);
    }
    const affected = (owner: string) =>
      sessionId !== undefined ? owner === sessionId : !ctx.sessionPermissionPolicies.has(owner);
    let resolvedApprovals = 0;
    for (const pending of [...ctx.approvals.values()]) {
      if (!affected(pending.sessionId)) continue;
      const decision = next.decide(pending.approval);
      if (decision === 'allow' || decision === 'deny') {
        resolvedApprovals++;
        pending.resolve(decision === 'allow');
      }
    }
    return { applied: true, resolvedApprovals };
  },
};
