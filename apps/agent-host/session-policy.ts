import { backgroundAuthority } from '../../packages/core/background-deliveries.ts';
import { executionPolicy, withExecutionPolicy } from '../../packages/tools/execution-policy.ts';
import type { HostContext } from './state.ts';
import type { ExecutionPolicy } from '../../packages/protocol/execution.ts';
import type { PermissionPolicy } from '../../packages/protocol/permission-policy.ts';

/** The permission policy a live session runs under: its own override, else the process default. */
export function sessionPermissionPolicy(
  ctx: HostContext,
  sessionId: string,
): PermissionPolicy | undefined {
  return ctx.sessionPermissionPolicies.get(sessionId) ?? ctx.permissionPolicy;
}

/** Resolve live session authority, including the persisted authority of a cold session. */
export function sessionExecutionPolicy(ctx: HostContext, sessionId: string): ExecutionPolicy {
  const durable = ctx.sessionSandboxes.has(sessionId)
    ? undefined
    : backgroundAuthority(ctx.store, sessionId);
  return executionPolicy(
    ctx.sessionSandboxes.get(sessionId) ?? durable?.sandboxMode ?? ctx.defaultSandboxMode,
    {
      files:
        ctx.sessionSandboxFiles.get(sessionId) ?? durable?.sandboxFiles ?? ctx.defaultSandboxFiles,
      network: ctx.sessionSandboxNetwork.has(sessionId)
        ? ctx.sessionSandboxNetwork.get(sessionId)
        : (durable?.sandboxNetwork ?? ctx.defaultSandboxNetwork),
      image: ctx.launchSandbox.image,
    },
  );
}

/** Lifecycle hooks carry the session's live policy, including cold durable authority. */
export function underSessionPolicy<T>(ctx: HostContext, sessionId: string, action: () => T): T {
  return withExecutionPolicy(sessionExecutionPolicy(ctx, sessionId), action);
}

/** Keep a planning invocation read-only through its end notification, even after it submits its plan. */
export function sessionLifecycleReadOnly(ctx: HostContext, sessionId: string): boolean {
  return (
    sessionExecutionPolicy(ctx, sessionId).files === 'read-only' ||
    (ctx.sessionLifecyclePhases.get(sessionId) ?? ctx.store.planMode(sessionId) !== null)
  );
}
