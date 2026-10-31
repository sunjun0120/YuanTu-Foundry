/**
 * Prompt caching modes an operator may choose:
 *
 * - `auto` resolves to what the route's protocol supports; the default.
 * - `blocks` sends `cache_control` breakpoints, only to routes that declare block support
 *   (`routeSupports`).
 * - `key-only` sends `prompt_cache_key` and nothing else, for gateways that reject `cache_control`.
 * - `off` sends neither field.
 */
export const PROMPT_CACHE_MODES = ['auto', 'blocks', 'key-only', 'off'] as const;
export type PromptCacheMode = (typeof PROMPT_CACHE_MODES)[number];
/**
 * Spellings the old boolean `YUANTU_PROMPT_CACHE` accepted (`0`/`1`), still honoured and documented
 * in the setting's description.
 */
export const PROMPT_CACHE_ALIASES: Readonly<Record<string, PromptCacheMode>> = {
  '0': 'off',
  false: 'off',
  '1': 'auto',
  true: 'auto',
};
/**
 * What a route supports, from its protocol name alone: blocks are Anthropic's extension and
 * `prompt_cache_key` is OpenAI's. Unknown names get no cache fields from `auto`; an operator can
 * opt in with `blocks` or `key-only`.
 */
export function routeSupports(
  protocol: string,
  feature: 'prompt-cache-key' | 'prompt-cache-blocks' | 'tool-cache-breakpoint',
): boolean {
  const vendor = protocol.toLowerCase();
  if (vendor === 'anthropic') {
    if (feature === 'prompt-cache-key') return false;
    // Both block facts are Anthropic's, including the narrower use inside a tool definition.
    return true;
  }
  if (vendor === 'openai' || vendor === 'openai-responses') return feature === 'prompt-cache-key';
  return false;
}
