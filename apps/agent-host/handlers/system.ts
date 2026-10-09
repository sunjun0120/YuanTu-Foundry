import { PermissionPolicy } from '../../../packages/core/permissions.ts';
import { negotiateHostVersion } from '../../../packages/protocol/host-wire.ts';
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
      /**
       * The live cursor and the replay that goes with it. Advertised rather than assumed: a client that
       * reconnects to a Host which does not offer it has to re-read the session, and saying so is how the
       * carrier decides what to do instead of asking for a method that is not there.
       */
      'event-cursor',
      'session-events',
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
    const mode = params.mode;
    if (mode !== 'host' && mode !== 'docker' && mode !== 'sbx' && mode !== 'windows')
      throw new Error('Invalid sandbox mode; use host, docker, sbx, or windows');
    if (params.sessionId !== undefined && typeof params.sessionId !== 'string')
      throw new Error('Invalid sandbox session identity');
    if (typeof params.sessionId === 'string') {
      ownedSession(ctx.store, ctx.workspace, params.sessionId);
      // Pending tools refresh the selection after approval; executing bodies keep their snapshot.
      ctx.sessionSandboxes.set(params.sessionId, mode);
      ctx.captureAuthority(params.sessionId);
    } else {
      if (ctx.active.size)
        throw new Error('Wait for active runs before changing the default execution policy');
      ctx.defaultSandboxMode = mode;
    }
    return { mode };
  },
  'permission.update': async (ctx, params) => {
    const next = new PermissionPolicy(params.policy);
    if (params.sessionId !== undefined)
      ownedSession(ctx.store, ctx.workspace, required(params, 'sessionId'));
    ctx.permissionPolicy = next;
    if (typeof params.sessionId === 'string') ctx.captureAuthority(params.sessionId, true);
    else
      for (const session of ctx.store.list('', ctx.workspace))
        ctx.captureAuthority(session.id, true);
    let resolvedApprovals = 0;
    for (const pending of [...ctx.approvals.values()]) {
      const decision = next.decide(pending.approval);
      if (decision === 'allow' || decision === 'deny') {
        resolvedApprovals++;
        pending.resolve(decision === 'allow');
      }
    }
    return { applied: true, resolvedApprovals };
  },
};
