import type { ToolSpec } from '../protocol/index.ts';
import { defaultPromptCacheMode, promptCacheMode } from '../protocol/settings.ts';
import { routeSupports, type PromptCacheMode } from '../protocol/cache-modes.ts';
import type { ProviderConfig } from './config.ts';

/**
 * Prompt caching, as the three questions it actually is.
 *
 * The old shape answered one: "is caching on". That was enough while there were two policies hard-wired to two
 * protocol names, and it stopped being enough as soon as an endpoint existed that wants one half of a policy and
 * rejects the other. So:
 *
 * 1. **What did the operator ask for** — `cacheMode`, the four-value setting, with `auto` meaning "whatever this
 *    route can do" and therefore changing nothing for a connection that never mentioned caching.
 * 2. **What can this route do** — `routeSupports`, a declaration at the protocol boundary. Silence is not a
 *    declaration: an unknown protocol name gets no cache fields from `auto`. The route is named by the *adapter*
 *    rather than read out of the config, because an adapter is what knows which protocol it speaks: `readConfig`
 *    leaves `protocol` unset for anthropic (the default), so asking the config would answer "anthropic" for an
 *    `OpenAIProvider` built by hand — see the `route` argument below.
 * 3. **What goes in the request** — `cacheFields`, which is those two answers combined *once*, so a new adapter
 *    cannot answer either question again for itself.
 */
export function cacheMode(config: ProviderConfig, route?: string): PromptCacheMode {
  const requested = promptCacheMode(config.promptCache);
  if (requested && requested !== 'auto') return requested;
  return defaultPromptCacheMode(route ?? config.protocol ?? 'anthropic');
}
/**
 * Whether this request may carry cache fields at all.
 *
 * A caller that supplies no cache key still gets nothing: the key is what makes a prefix *identifiable*, so
 * without one there is nothing to cache and a write would be paid for by every one-off request (a connection
 * probe, a title).
 */
export function promptCacheEnabled(
  config: ProviderConfig,
  cacheKey?: string,
  route?: string,
): boolean {
  return cacheMode(config, route) !== 'off' && typeof cacheKey === 'string' && cacheKey.length > 0;
}
export interface CacheFields {
  /** Whether breakpoints go in this request: `blocks` *and* a route that declares block support. */
  blocks: boolean;
  /** The prefix identifier, present only when this request is cacheable and the route caches by key. */
  key?: string;
  /**
   * Whether the last tool definition carries a breakpoint.
   *
   * Its own answer rather than a consequence of `blocks`, because it is the narrowest of the three facts: a
   * gateway can accept a system-prompt breakpoint and still reject the field inside a tool definition, and this
   * is the knob that says so.
   */
  toolBreakpoint: boolean;
}
/**
 * The fields one request gets, decided in one place and read by all three adapters.
 *
 * `route` is the adapter's own protocol name, and it is the adapter that passes it: an adapter knows what it
 * speaks, while the config may not say. `readConfig` leaves `protocol` unset for anthropic, so a hand-built
 * `OpenAIProvider` config would otherwise be judged by anthropic's capabilities and lose the cache key it should
 * have sent — which is exactly the bug the first version of this had.
 *
 * Two rules, and the difference between them is the point of having four modes rather than a switch:
 *
 * - **`auto` consults the route.** A protocol this build does not recognise gets no cache fields, because
 *   silence is not a declaration of support. This is what keeps the default byte-identical to the request a
 *   connection that never mentioned caching has always sent.
 * - **An explicit mode is obeyed.** `blocks` on an extension adapter means blocks: the operator is the one who
 *   knows what their endpoint accepts, and second-guessing them here would make the setting a suggestion. This
 *   is why `routeSupports` gates the *default* and not the instruction.
 */
export function cacheFields(
  config: ProviderConfig,
  cacheKey?: string,
  route?: string,
): CacheFields {
  // One shape whichever way the decision goes: a caller reading `fields.key` should not have to know whether the
  // absent case omits the property or sets it to undefined.
  if (!promptCacheEnabled(config, cacheKey, route))
    return { blocks: false, key: undefined, toolBreakpoint: false };
  /**
   * The identifier, decided by the mode and then by the route.
   *
   * An explicit `key-only` always carries it — that is the instruction, and the route's silence is not a reason to
   * drop it. `auto` carries it when the route declares it caches by key, which is how an OpenAI connection gets
   * the request it has always sent. `blocks` never carries it: that policy identifies its prefix by position, and
   * the two identifiers are alternatives rather than companions.
   */
  const mode = cacheMode(config, route);
  if (mode === 'key-only') return { blocks: false, key: cacheKey, toolBreakpoint: false };
  if (mode === 'blocks') return { blocks: true, key: undefined, toolBreakpoint: true };
  if (routeSupports(route ?? config.protocol ?? 'anthropic', 'prompt-cache-key'))
    return { blocks: false, key: cacheKey, toolBreakpoint: false };
  return { blocks: false, key: undefined, toolBreakpoint: false };
}

const ephemeral = { type: 'ephemeral' as const };

/**
 * Anthropic accepts a plain string or a block array. Caching needs the block form so
 * the system prompt can carry a breakpoint; the string form is kept when caching is
 * off so existing endpoints see the same request they always did.
 */
export function anthropicSystem(
  system: string,
  cache: boolean,
): string | Record<string, unknown>[] {
  return cache ? [{ type: 'text', text: system, cache_control: ephemeral }] : system;
}

/**
 * Anthropic caches everything up to and including a breakpoint. Marking the last tool
 * definition makes the whole tool block part of the cached prefix; the earlier tools
 * stay untouched so the request is unchanged when caching is off.
 *
 * `toolBreakpoint` is separate from `cache` because it is the narrower permission: a
 * route may accept a breakpoint on the system prompt and refuse one inside a tool.
 */
export function anthropicTools(
  tools: ToolSpec[],
  cache: boolean,
  toolBreakpoint = cache,
): Record<string, unknown>[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(cache && toolBreakpoint && index === tools.length - 1 ? { cache_control: ephemeral } : {}),
  }));
}

/**
 * Incremental caching: the newest message block is the moving breakpoint, so the next
 * request in the same run reads the whole previous prefix from cache. Anthropic allows
 * at most four breakpoints; system + last tool + last message uses three.
 */
export function markLastContentBlock(
  messages: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[],
  cache: boolean,
): void {
  if (!cache) return;
  const block = messages.at(-1)?.content.at(-1);
  if (block) block.cache_control = ephemeral;
}
