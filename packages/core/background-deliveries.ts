import { randomUUID } from 'node:crypto';
import type { SessionStore } from '../storage/sqlite.ts';
import { logProjection } from './log-projection.ts';
import { PermissionPolicy, type PermissionPolicySource } from './permissions.ts';
import type { SandboxMode } from '../tools/sandbox-provider.ts';
import type { FileEffect, NetworkEffect } from '../protocol/execution.ts';
import type {
  BackgroundPolicy,
  BackgroundDelivery,
  BackgroundState,
  BackgroundPolicyInput,
} from '../protocol/background.ts';
export type {
  BackgroundPolicy,
  BackgroundDelivery,
  BackgroundState,
  BackgroundPolicyInput,
} from '../protocol/background.ts';

export interface BackgroundAuthority {
  sandboxMode: SandboxMode;
  sandboxFiles?: FileEffect;
  sandboxNetwork?: NetworkEffect;
  permissionPolicy: PermissionPolicySource | null;
}

/** Old opt-ins without a durable authority remain notifications until a trusted policy is restored. */
export function backgroundAuthority(
  store: SessionStore,
  sessionId: string,
): BackgroundAuthority | undefined {
  const source = store.events(sessionId).findLast((e) => e.type === 'background.policy')
    ?.data.authority;
  if (!source || typeof source !== 'object') return;
  const a = source as BackgroundAuthority;
  if (!['host', 'windows', 'native', 'seatbelt'].includes(a.sandboxMode)) return;
  if (
    a.sandboxFiles !== undefined &&
    a.sandboxFiles !== 'read-only' &&
    a.sandboxFiles !== 'workspace-write'
  )
    return;
  if (
    a.sandboxNetwork !== undefined &&
    a.sandboxNetwork !== 'denied' &&
    a.sandboxNetwork !== 'unrestricted'
  )
    return;
  try {
    return {
      sandboxMode: a.sandboxMode,
      ...(a.sandboxNetwork ? { sandboxNetwork: a.sandboxNetwork } : {}),
      ...(a.sandboxFiles !== undefined ? { sandboxFiles: a.sandboxFiles } : {}),
      permissionPolicy:
        a.permissionPolicy === null ? null : new PermissionPolicy(a.permissionPolicy).toJSON(),
    };
  } catch {
    return;
  }
}

export function normalizeBackgroundPolicy(input: unknown): BackgroundPolicyInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid background policy');
  const p = input as Record<string, unknown>;
  if (
    Object.keys(p).some((k) => !['mode', 'paused', 'maxWakeups', 'maxRunMs'].includes(k)) ||
    !['notify', 'auto'].includes(String(p.mode)) ||
    typeof p.paused !== 'boolean' ||
    !Number.isSafeInteger(p.maxWakeups) ||
    Number(p.maxWakeups) < 1 ||
    Number(p.maxWakeups) > 20 ||
    !Number.isSafeInteger(p.maxRunMs) ||
    Number(p.maxRunMs) < 1000 ||
    Number(p.maxRunMs) > 300000
  )
    throw Error('Invalid background policy or budget');
  return p as unknown as BackgroundPolicyInput;
}

/** The policy and the deliveries, folded in log order and continued from the last seq (see `logProjection`). */
const deliveryLog = logProjection<{
  policy: BackgroundPolicy;
  deliveries: Map<string, BackgroundDelivery>;
}>(
  () => ({
    policy: {
      mode: 'notify',
      paused: false,
      maxWakeups: 3,
      maxRunMs: 60000,
      epoch: 'default',
      used: 0,
    },
    deliveries: new Map(),
  }),
  (state, e) => {
    if (e.type === 'background.policy')
      state.policy = structuredClone(e.data.policy as unknown as BackgroundPolicy);
    if (e.type === 'background.pending') {
      const delivery = e.data.delivery as unknown as BackgroundDelivery;
      if (!state.deliveries.has(delivery.id))
        state.deliveries.set(delivery.id, structuredClone(delivery));
    }
    if (e.type === 'background.admitted' || e.type === 'background.processed') {
      for (const id of (e.data.ids as string[]) ?? []) {
        const d = state.deliveries.get(id);
        if (!d) continue;
        d.state = e.type === 'background.admitted' ? 'admitted' : 'processed';
        d.reason = String(e.data.reason ?? 'automatic');
      }
      if (
        e.type === 'background.admitted' &&
        e.data.automatic === true &&
        e.data.epoch === state.policy.epoch
      )
        state.policy.used++;
    }
  },
);

export function backgroundState(store: SessionStore, sessionId: string): BackgroundState {
  const { policy, deliveries } = deliveryLog.read(store, sessionId);
  // Copies: the fold behind them is kept and continued, and a caller may change what it was handed.
  return { policy: structuredClone(policy), deliveries: structuredClone([...deliveries.values()]) };
}

/** The producers' outcomes as the log tells them, before they are compared with the recorded deliveries. */
const outcomeLog = logProjection<{
  outcomes: Map<string, BackgroundDelivery>;
  commands: Set<string>;
  children: Map<string, string>;
}>(
  () => ({ outcomes: new Map(), commands: new Set(), children: new Map() }),
  ({ outcomes, commands, children }, e) => {
    const producerId = String(e.data.id ?? '');
    if (e.type === 'command.started') commands.add(producerId);
    if (e.type === 'subagent.assigned')
      children.set(producerId, String(e.data.childSessionId ?? ''));
    if (
      (e.type === 'command.settled' && commands.has(producerId)) ||
      e.type === 'subagent.finished' ||
      e.type === 'subagent.interrupted'
    ) {
      const kind = e.type === 'command.settled' ? 'command' : 'subagent';
      const childSessionId = String(
        e.data.sessionId ?? e.data.childSessionId ?? children.get(producerId) ?? '',
      );
      const knownId = producerId || [...children].find(([, id]) => id === childSessionId)?.[0];
      if (!knownId || (kind === 'subagent' && !children.has(knownId))) return;
      const id =
        kind === 'command'
          ? `command:${knownId}`
          : `subagent:${knownId}:${e.data.childRunId ?? e.seq}`;
      if (outcomes.has(id)) return;
      outcomes.set(id, {
        id,
        kind,
        producerId: knownId,
        ...(childSessionId ? { childSessionId } : {}),
        status: String(e.data.status ?? 'interrupted'),
        ...(e.data.cleanupConfirmed === false ? { cleanupUnknown: true } : {}),
        state: 'pending',
        at: e.at,
      });
    }
    if (e.type === 'command.collected' || e.type === 'subagent.collected') {
      const ids = Array.isArray(e.data.ids) ? e.data.ids : [];
      for (const d of outcomes.values())
        if (
          d.kind === (e.type === 'command.collected' ? 'command' : 'subagent') &&
          (ids.includes(d.producerId) || ids.includes(d.childSessionId))
        ) {
          d.state = 'processed';
          d.reason = 'collected';
        }
    }
  },
);

/** Producer events, including collection, are folded in order: a later child turn is a new result. */
export function reconcileBackground(store: SessionStore, sessionId: string): BackgroundState {
  const { outcomes } = outcomeLog.read(store, sessionId);
  const current = deliveryLog.read(store, sessionId).deliveries;
  for (const d of outcomes.values()) {
    const existing = current.get(d.id);
    // A copy: the journal keeps the event's data by reference, and the fold goes on changing `d`.
    if (!existing)
      store.recordEvent(sessionId, 'background.pending', { delivery: structuredClone(d) });
    else if (d.state === 'processed' && existing.state !== 'processed')
      store.recordEvent(sessionId, 'background.processed', { ids: [d.id], reason: 'collected' });
  }
  return backgroundState(store, sessionId);
}

export function setBackgroundPolicy(
  store: SessionStore,
  sessionId: string,
  input: unknown,
  reset = false,
  authority = backgroundAuthority(store, sessionId),
): BackgroundPolicy {
  const prior = backgroundState(store, sessionId).policy;
  const policy = {
    ...normalizeBackgroundPolicy(input),
    epoch: reset ? randomUUID() : prior.epoch,
    used: reset ? 0 : prior.used,
  };
  store.recordEvent(sessionId, 'background.policy', {
    policy,
    ...(authority ? { authority } : {}),
  });
  return policy;
}

/** Write acceptance before invoking any model. An interrupted acceptance is deliberately never retried. */
export function admitBackground(
  store: SessionStore,
  sessionId: string,
): { ids: string[]; maxRunMs: number } | undefined {
  const { policy, deliveries } = reconcileBackground(store, sessionId);
  if (
    policy.mode !== 'auto' ||
    policy.paused ||
    policy.used >= policy.maxWakeups ||
    store.goal(sessionId)?.status === 'paused' ||
    store.planMode(sessionId)
  )
    return;
  const ids = deliveries
    .filter(
      (d) =>
        d.state === 'pending' && !d.cleanupUnknown && ['completed', 'failed'].includes(d.status),
    )
    .slice(0, 8)
    .map((d) => d.id);
  if (!ids.length) return;
  store.recordEvent(sessionId, 'background.admitted', {
    ids,
    automatic: true,
    epoch: policy.epoch,
  });
  return { ids, maxRunMs: policy.maxRunMs };
}
export function finishBackground(
  store: SessionStore,
  sessionId: string,
  ids: string[],
  reason: string,
): void {
  store.recordEvent(sessionId, 'background.processed', { ids, reason });
}
/** Record only notices in the final provider envelope, rather than speculative prompt assemblies. */
export function admitVisibleBackground(
  store: SessionStore,
  sessionId: string,
  system: string,
): void {
  const ids = reconcileBackground(store, sessionId)
    .deliveries.filter(
      (d) =>
        d.state === 'pending' &&
        (d.kind === 'command'
          ? system.includes(`job_output id: ${d.producerId}`)
          : system.includes(`collect_subagents id: ${d.producerId}`)),
    )
    .map((d) => d.id);
  if (ids.length)
    store.recordEvent(sessionId, 'background.admitted', {
      ids,
      automatic: false,
      reason: 'foreground context',
    });
}
