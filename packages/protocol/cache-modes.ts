/**
 * What an operator may ask for when it comes to prompt caching.
 *
 * The question the old boolean answered was "send the cache fields or not", and that is not the question this
 * runtime has: two routes cache in two different ways, and the interesting cases sit between "everything" and
 * "nothing". A gateway that accepts `prompt_cache_key` but rejects `cache_control` inside a tool definition — a
 * real shape, since the block form is Anthropic's own extension — had only one answer available to it (turn the
 * whole feature off) and lost the key-based half along with the half that was breaking it.
 *
 * So the vocabulary is four answers rather than two:
 *
 * - `auto` resolves to what the route's protocol can do, which is what the runtime did before this existed and
 *   therefore the default: nothing changes for a connection that says nothing.
 * - `blocks` is the explicit prefix: `cache_control` breakpoints, telling the endpoint where the cacheable prefix
 *   ends. It reaches only routes that declare block support — see `routeSupports`.
 * - `key-only` is the routing hint: `prompt_cache_key` and nothing else.
 * - `off` sends neither field, for endpoints that reject them outright.
 */
export const PROMPT_CACHE_MODES = ['auto', 'blocks', 'key-only', 'off'] as const;
export type PromptCacheMode = (typeof PROMPT_CACHE_MODES)[number];
/**
 * The values the boolean switch accepted, kept working.
 *
 * `YUANTU_PROMPT_CACHE` was documented as `0` / `1` and shipped that way, so a deployment that set it to `0`
 * must not start failing an environment check because the setting grew a vocabulary. The aliases are translated
 * before anything else looks at the value, and they are named in the setting's own description — a reader of the
 * generated table should not have to find this file to learn that `0` still means `off`.
 */
export const PROMPT_CACHE_ALIASES: Readonly<Record<string, PromptCacheMode>> = {
  '0': 'off',
  false: 'off',
  '1': 'auto',
  true: 'auto',
};
/**
 * What a route can do, asked of the protocol name alone.
 *
 * The declaration lives at the protocol boundary rather than on a registered factory because two of the three
 * facts are *the vendor's*: the block form is Anthropic's extension and `prompt_cache_key` is OpenAI's, and a
 * protocol name is the only thing a registry key and this question have in common. The third fact is the
 * conservative default for everything else — an adapter this build has never heard of, a proxy named after a
 * vendor's SDK — and it claims nothing at all.
 *
 * The consequence matters more than the mechanism: a name this file does not recognise gets **no** cache fields
 * from `auto`. Silence is not a declaration of support, so an unknown route sends the request it always sent
 * rather than one carrying a field a gateway might reject. An operator who knows better says so — `blocks` or
 * `key-only` names the intent, and naming it is what the modes are for.
 */
export function routeSupports(
  protocol: string,
  feature: 'prompt-cache-key' | 'prompt-cache-blocks' | 'tool-cache-breakpoint',
): boolean {
  const vendor = protocol.toLowerCase();
  if (vendor === 'anthropic') {
    if (feature === 'prompt-cache-key') return false;
    // Both of the block facts are Anthropic's: the breakpoint *and* its use inside a tool definition, which is
    // the narrower of the two -- a route may cache a system prefix and still refuse the field on a tool.
    return true;
  }
  if (vendor === 'openai' || vendor === 'openai-responses') return feature === 'prompt-cache-key';
  return false;
}
