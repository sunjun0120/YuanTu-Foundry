import {
  admitBackground,
  backgroundAuthority,
  type BackgroundAuthority,
  backgroundState,
  finishBackground,
  reconcileBackground,
  setBackgroundPolicy,
} from '../../packages/core/background-deliveries.ts';
import type { RunResult } from '../../packages/protocol/index.ts';
import { safeError } from '../shared/runtime.ts';
import type { HostContext, WakeGrant } from './state.ts';

/** The wake machinery the Host keeps for its whole lifetime. */
export interface BackgroundWake {
  /** The authority a wake for this session would run under, read from the state the Host holds now. */
  currentAuthority: (sessionId: string) => BackgroundAuthority;
  /** Write that authority onto the session's background policy row, so a restart re-reads the same answer. */
  captureAuthority: (sessionId: string, permissionOnly?: boolean) => void;
  /** Ask for a wake run if any background work now deserves one. Coalesced, and safe to call at any time. */
  queueWake: () => void;
  /** Stop watching the store's events. Called once, on the way down. */
  stop: () => void;
}

/**
 * The background half of the run loop: what the Host may start that nobody asked a person for.
 *
 * A wake is the one run that begins without a request, so it is also the one run whose authority has to be
 * *captured*: the sandbox and permission policy a session had when its work was admitted are written onto the
 * background policy row, and the wake runs under those rather than under whatever the policy has become by the
 * time the work settles. Everything else here is coalescing — a wake is expensive and the store can announce
 * several settled producers in one burst, so a request for a wake is folded into the next microtask and the next
 * one after that, and only ever one session at a time.
 */
export function createBackgroundWake(ctx: HostContext): BackgroundWake {
  const currentAuthority = (sessionId: string): BackgroundAuthority => ({
    sandboxMode: ctx.sessionSandboxes.get(sessionId) ?? ctx.defaultSandboxMode,
    permissionPolicy: ctx.permissionPolicy?.toJSON() ?? null,
  });
  const captureAuthority = (sessionId: string, permissionOnly = false) => {
    const { mode, paused, maxWakeups, maxRunMs } = backgroundState(ctx.store, sessionId).policy;
    const authority = currentAuthority(sessionId);
    if (permissionOnly && !ctx.sessionSandboxes.has(sessionId))
      authority.sandboxMode =
        backgroundAuthority(ctx.store, sessionId)?.sandboxMode ?? authority.sandboxMode;
    setBackgroundPolicy(
      ctx.store,
      sessionId,
      { mode, paused, maxWakeups, maxRunMs },
      false,
      authority,
    );
  };
  const queueWake = () => {
    if (ctx.wakeQueued || ctx.closing || !ctx.carrier.connected || !ctx.automaticReady) return;
    ctx.wakeQueued = true;
    queueMicrotask(() => {
      ctx.wakeQueued = false;
      if (
        ctx.closing ||
        ctx.active.size ||
        ctx.restoring ||
        ctx.manualCompaction ||
        !ctx.automaticReady
      )
        return;
      for (const session of ctx.store.list('', ctx.workspace)) {
        if (session.parentSessionId) continue;
        reconcileBackground(ctx.store, session.id);
        const authority = backgroundAuthority(ctx.store, session.id);
        if (!authority) continue;
        const accepted = admitBackground(ctx.store, session.id);
        if (!accepted) continue;
        ctx.waking.add(session.id);
        const wakeTask = ctx
          .dispatch(
            'run.start',
            {
              sessionId: session.id,
              prompt:
                'Review the newly settled background work announced in context. Read its result using job_output or collect_subagents, then report or continue within the existing user request and permissions.',
            },
            { ...accepted, authority } satisfies WakeGrant,
          )
          .then(
            (result) =>
              finishBackground(
                ctx.store,
                session.id,
                accepted.ids,
                String((result as RunResult).status),
              ),
            (error) =>
              finishBackground(ctx.store, session.id, accepted.ids, `failed: ${safeError(error)}`),
          )
          .catch((error) => {
            process.stderr.write(`[background] ${safeError(error)}\n`);
          })
          .finally(() => {
            ctx.tasks.delete(wakeTask);
            ctx.waking.delete(session.id);
            queueWake();
          });
        ctx.tasks.add(wakeTask);
        break;
      }
    });
  };
  const stop = ctx.store.observeEvents(
    () => queueWake(),
    new Set([
      'command.settled',
      'command.collected',
      'subagent.finished',
      'subagent.interrupted',
      'subagent.collected',
      'background.policy',
      'goal.changed',
    ]),
  );
  return { currentAuthority, captureAuthority, queueWake, stop };
}
