import { createHash } from 'node:crypto';
import type { ToolSpec } from '../protocol/index.ts';

/**
 * The key a provider files a cacheable prefix under, computed from the request that carries it.
 *
 * A prompt cache is a byte-exact prefix and the key is what names the entry, so the two have to describe the same
 * request: a key computed from anything other than what was sent tells the provider to read an entry whose
 * contents are not how this request begins — a miss at best, and a different conversation at worst. The digest
 * covers the route (an entry written for one model belongs to that model), the system prompt **as it is sent**,
 * and the tool catalogue in its own order, which together are everything the provider caches before the
 * conversation itself. The prompt never leaves the process as part of the key.
 *
 * It is computed per request rather than once per run, because the prompt is not constant for the life of a run:
 * approving a plan adds the tools that write, so the same run can send two prompts and the key has to name the one
 * this request actually carries. The conversation is not in the key — a provider caches the prefix *before* it, and
 * everything that extends the conversation (an injected note, a compaction summary, this round's tool results)
 * leaves the key alone, which is the point.
 */
export function cacheKeyFor(
  route: { protocol?: string; model?: string } | undefined,
  system: string,
  tools: readonly ToolSpec[],
): string {
  return createHash('sha256')
    .update(route?.protocol ?? 'anthropic')
    .update('\u0000')
    .update(route?.model ?? '')
    .update('\u0000')
    .update(system)
    .update('\u0000')
    .update(JSON.stringify(tools))
    .digest('hex')
    .slice(0, 40);
}
