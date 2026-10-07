import { createHash } from 'node:crypto';
import type { ProviderConfig } from './config.ts';
import type { RouteCapacity } from './capacity.ts';
import { discoverModels, modelsUrl } from './discovery.ts';
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '../protocol/limits.ts';

/** Local request budgets, not assertions about an unknown endpoint's actual limits. */
export const AUTOMATIC_CONTEXT_TOKENS = DEFAULT_MAX_CONTEXT_TOKENS;
export const AUTOMATIC_OUTPUT_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;

/** Keep the unified request default, reserving at most a quarter of a smaller known window. */
export function automaticOutputBudget(contextWindow: number): number {
  return contextWindow >= AUTOMATIC_CONTEXT_TOKENS
    ? AUTOMATIC_OUTPUT_TOKENS
    : Math.min(AUTOMATIC_OUTPUT_TOKENS, Math.max(1, Math.floor(contextWindow / 4)));
}
const cache = new Map<
  string,
  { expires: number; capacities: ReadonlyMap<string, RouteCapacity> }
>();
const maxCatalogueBytes = 1024 * 1024;

/** Best-effort metadata only: cancellation propagates, other failures leave the local budget available. */
export async function discoverAutomaticCapacities(
  config: ProviderConfig,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReadonlyMap<string, RouteCapacity>> {
  options.signal?.throwIfAborted();
  const endpoint = modelsUrl(config);
  const key = createHash('sha256')
    .update(JSON.stringify([config.protocol ?? 'anthropic', endpoint, config.apiKey]))
    .digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.capacities;
  cache.delete(key);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 3000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const capacities = new Map<string, RouteCapacity>();
  try {
    const result = await discoverModels(config, {
      signal,
      fetch: async (url, init) => {
        const response = await fetch(url, { ...init, redirect: 'error', signal });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (reader) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxCatalogueBytes)
              throw new Error('Model catalogue exceeds its size limit');
            chunks.push(chunk.value);
          }
        } finally {
          await reader?.cancel().catch(() => {});
        }
        signal.throwIfAborted();
        return new Response(bytes ? Buffer.concat(chunks) : null, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    for (const model of result.models.slice(0, 1000)) {
      if (model.contextWindow !== undefined || model.maxOutputTokens !== undefined)
        capacities.set(model.id, {
          contextWindow: model.contextWindow ?? AUTOMATIC_CONTEXT_TOKENS,
          maxOutputTokens:
            model.maxOutputTokens ??
            automaticOutputBudget(model.contextWindow ?? AUTOMATIC_CONTEXT_TOKENS),
          source: model.contextWindow === undefined ? 'default' : 'discovered',
        });
    }
  } catch {
    options.signal?.throwIfAborted();
  }
  options.signal?.throwIfAborted();
  // Keys include the credential identity without retaining it. Failures expire sooner so outages can recover.
  while (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + (capacities.size ? 300_000 : 30_000), capacities });
  return capacities;
}
