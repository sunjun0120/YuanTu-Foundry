/**
 * A streamed call's arguments, if they are already a complete JSON object.
 *
 * Used only to report a call early (`ModelRequest.onToolCall`), never to build the response: a fragment that does
 * not parse yet, or parses to something other than an object, is simply not reported, and the adapter's own
 * end-of-turn parse stays the one that accepts or refuses the call. `fallback` is the arguments a protocol sent
 * whole up front (Anthropic's `input`), which stand when no fragment followed.
 */
export function completeArguments(
  json: string,
  fallback?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!json) return fallback ?? {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
