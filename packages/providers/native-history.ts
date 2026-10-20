import { createHash } from 'node:crypto';
import type { Message, ModelRequest, ProviderState, ToolCall } from '../protocol/index.ts';
import type { ProviderConfig } from './config.ts';

export interface NativeRoute {
  protocol: 'openai' | 'anthropic';
  model: string;
  endpoint: string;
}

/** Conservative automatic capabilities; an explicit gateway opt-in declares both supported extensions. */
export function deepseekCapabilities(
  config: ProviderConfig,
  endpoint: string,
  model: string,
): {
  reasoning: boolean;
  systemUpdates: boolean;
} {
  if (config.deepseekCompatibility === 'off') return { reasoning: false, systemUpdates: false };
  if (config.deepseekCompatibility === 'on') return { reasoning: true, systemUpdates: true };
  const official = new URL(endpoint).hostname === 'api.deepseek.com';
  const known = /^deepseek-(flash|v4-flash|v4-pro|chat|reasoner)$/.test(model);
  return {
    reasoning: official && known,
    systemUpdates: official && /^deepseek-(flash|v4-flash)$/.test(model),
  };
}

/** Bind native output to the visible assistant and decoded calls, so edited history cannot replay stale output. */
export function assistantHash(message: { content: string; toolCalls: ToolCall[] }): string {
  return createHash('sha256')
    .update(JSON.stringify([message.content, message.toolCalls]))
    .digest('hex');
}

/** Return native output only to the exact producing route, excluding interrupted and edited assistants. */
export function nativeState(message: Message, route: NativeRoute): ProviderState | undefined {
  if (message.role !== 'assistant' || message.interrupted) return;
  const state = message.providerState;
  if (
    state?.protocol === route.protocol &&
    state.model === route.model &&
    state.endpoint === route.endpoint &&
    state.messageHash === assistantHash(message)
  )
    return state;
}

export interface NativeSystemProjection {
  system: string;
  updates: ReadonlyMap<number, string>;
  pending?: string;
  snapshot?: ProviderState['systemPrompt'];
  toolsHash: string;
}

/** Reconstruct a complete native prompt series from retained, route-matched assistant state. */
export function projectNativeSystem(
  request: ModelRequest,
  route: NativeRoute,
  enabled: boolean,
): NativeSystemProjection {
  const toolsHash = createHash('sha256').update(JSON.stringify(request.tools)).digest('hex');
  const reset: NativeSystemProjection = {
    system: request.system,
    updates: new Map(),
    toolsHash,
    ...(enabled ? { snapshot: { kind: 'initial', text: request.system } } : {}),
  };
  if (!enabled || !request.system) return reset;
  let initial: string | undefined;
  let effective: string | undefined;
  const updates = new Map<number, string>();
  for (const [index, message] of request.messages.entries()) {
    if (message.role !== 'assistant') continue;
    const state = nativeState(message, route);
    if (!state || state.systemToolsHash !== toolsHash || state.systemPrompt?.kind === 'initial') {
      initial = undefined;
      effective = undefined;
      updates.clear();
    }
    if (!state || state.systemToolsHash !== toolsHash) continue;
    if (state.systemPrompt?.kind === 'initial') initial = effective = state.systemPrompt.text;
    else if (initial !== undefined && state.systemPrompt?.kind === 'update') {
      effective = state.systemPrompt.text;
      updates.set(index, effective);
    }
  }
  // An empty or compacted-away initial snapshot cannot restore an earlier instruction set.
  if (!initial) return reset;
  if (effective === request.system) return { system: initial, updates, toolsHash };
  const tail = request.messages.at(-1);
  if (!tail || tail.role === 'assistant') return reset;
  return {
    system: initial,
    updates,
    toolsHash,
    pending: request.system,
    snapshot: { kind: 'update', text: request.system },
  };
}
