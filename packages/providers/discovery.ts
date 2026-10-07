import type { ProviderConfig } from './config.ts';
/**
 * What the endpoint says its models can take.
 *
 * The context window is the only ceiling a run has left: too small and the runtime compacts conversations it
 * did not need to touch, too large and the endpoint refuses the first request that outgrows the real limit. The
 * project therefore refuses to guess it per protocol — `YUANTU_MODEL` is an id on somebody else's endpoint, and
 * a number this runtime invented would be wrong for every endpoint it was not measured on.
 *
 * Most endpoints publish their own catalogue, and the field names for it are a small well-known set across the
 * OpenAI-compatible gateways, Anthropic's `/v1/models` and the aggregators that front them. This module reads
 * that catalogue once, on demand.
 *
 * Explicit discovery reports catalogue errors. App entry points also use a separately bounded, cached,
 * best-effort discovery path when no window is declared; an unreachable catalogue leaves the local budget
 * available. Automatic results never overwrite the operator's saved configuration.
 */
export interface DiscoveredModel {
  id: string;
  name: string;
  /** The window the endpoint declared, when it declared one this runtime can read. */
  contextWindow?: number;
  /** The per-request output cap the endpoint declared, when it declared one. */
  maxOutputTokens?: number;
}
export interface DiscoveryResult {
  /** The URL that answered, so a reader can tell which endpoint was asked (and paste it into a bug report). */
  endpoint: string;
  protocol: string;
  models: DiscoveredModel[];
}
/**
 * Capacity field names, most specific first.
 *
 * Four naming families cover the field: the camelCase one this project uses, the snake_case one OpenAI uses,
 * OpenAI's older `max_tokens`/`max_completion_tokens` pair, and the nested `limit`/`top_provider` objects that
 * aggregators return. All of them are read; none is preferred on faith — the first path that carries a usable
 * positive integer wins.
 */
const CONTEXT_PATHS = [
  'contextWindow',
  'context_window',
  'context_length',
  'max_input_tokens',
  'maxInputTokens',
  'limit.context',
] as const;
const OUTPUT_PATHS = [
  'maxOutputTokens',
  'max_output_tokens',
  'maxTokens',
  'max_tokens',
  'limit.output',
  'top_provider.max_completion_tokens',
] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** One positive integer, from a number or the string form gateways sometimes send instead. */
function capacity(entry: Record<string, unknown>, paths: readonly string[]): number | undefined {
  for (const path of paths) {
    let current: unknown = entry;
    for (const part of path.split('.')) {
      current = isRecord(current) ? current[part] : undefined;
    }
    const value =
      typeof current === 'number'
        ? current
        : typeof current === 'string' && current.trim() !== ''
          ? Number(current)
          : NaN;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}
/**
 * The catalogue URL for one connection.
 *
 * The same convention the adapters use for their own endpoints: a base URL that already ends in `/v1` keeps
 * it, anything else gets `/v1` appended. Both spellings exist in the wild — an operator pastes whatever their
 * gateway documents — and a probe that only worked for one of them would be a probe nobody trusts.
 */
export function modelsUrl(config: ProviderConfig, path = '/models'): string {
  const base =
    config.baseUrl ??
    ((config.protocol ?? 'anthropic') === 'anthropic'
      ? 'https://api.anthropic.com'
      : 'https://api.openai.com');
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Base URL must not contain credentials, query parameters or fragments');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS for remote model endpoints');
  const basePath = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|responses|messages)$/, '');
  url.pathname = basePath.endsWith('/v1') ? basePath + path : `${basePath}/v1${path}`;
  return url.toString();
}
/** The credential the adapter for this protocol would send with a real request. */
export function discoveryHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if ((config.protocol ?? 'anthropic') === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}
/**
 * The list from whichever envelope the endpoint used.
 *
 * Four shapes are in use: a bare array, `{data: [...]}` (OpenAI and Anthropic), `{models: [...]}` and a map of
 * id to entry (several gateways). An envelope this runtime does not recognise is an error rather than an empty
 * list: "the endpoint listed nothing" and "this runtime could not read the answer" send an operator to
 * completely different next steps, and only one of them is true.
 */
function entries(payload: unknown): { key: string; entry: Record<string, unknown> }[] {
  const fromArray = (value: unknown[]): { key: string; entry: Record<string, unknown> }[] =>
    value.flatMap((item, index) => (isRecord(item) ? [{ key: String(index), entry: item }] : []));
  if (Array.isArray(payload)) return fromArray(payload);
  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) return fromArray(payload.data);
    if (Array.isArray(payload.models)) return fromArray(payload.models);
    if (isRecord(payload.models))
      return Object.entries(payload.models).map(([key, entry]) => ({
        key,
        entry: isRecord(entry) ? entry : {},
      }));
  }
  throw new Error(
    'The model list is not a shape this runtime recognises (expected an array, `data`, or `models`)',
  );
}
/**
 * Read one connection's catalogue.
 *
 * `fetch` is injectable because a probe is exactly the kind of code that must be testable without a network:
 * the mapping is what is worth testing, and it is the part that silently goes wrong when a gateway renames a
 * field.
 */
export async function discoverModels(
  config: ProviderConfig,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<DiscoveryResult> {
  const endpoint = modelsUrl(config);
  const request = options.fetch ?? fetch;
  const response = await request(endpoint, {
    method: 'GET',
    headers: discoveryHeaders(config),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `The endpoint answered ${response.status} for its model list${body.trim() ? `: ${body.trim().slice(0, 300)}` : ''}`,
    );
  }
  const payload: unknown = await response.json();
  const models: DiscoveredModel[] = [];
  for (const { key, entry } of entries(payload)) {
    const id =
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : /^\d+$/.test(key)
          ? undefined
          : key;
    if (id === undefined) continue;
    const name =
      (typeof entry.name === 'string' && entry.name.trim()) ||
      (typeof entry.display_name === 'string' && entry.display_name.trim()) ||
      (typeof entry.displayName === 'string' && entry.displayName.trim()) ||
      id;
    const contextWindow = capacity(entry, CONTEXT_PATHS);
    const maxOutputTokens = capacity(entry, OUTPUT_PATHS);
    models.push({
      id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
  }
  return { endpoint, protocol: config.protocol ?? 'anthropic', models };
}
