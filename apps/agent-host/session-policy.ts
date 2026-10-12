import { backgroundAuthority } from '../../packages/core/background-deliveries.ts';
import { executionPolicy, withExecutionPolicy } from '../../packages/tools/execution-policy.ts';
import type { HostContext } from './state.ts';

/** Lifecycle hooks carry the session's live policy, including cold durable authority. */
export function underSessionPolicy<T>(ctx: HostContext, sessionId: string, action: () => T): T {
  const durable = ctx.sessionSandboxes.has(sessionId)
    ? undefined
    : backgroundAuthority(ctx.store, sessionId);
  const policy = executionPolicy(
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
  return withExecutionPolicy(policy, action);
}
