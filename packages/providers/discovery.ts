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
/** How much of a failed probe's body is read, and how long that read may take. */
const MAX_ERROR_BODY_BYTES = 16_384;
const ERROR_BODY_TIMEOUT_MS = 5_000;
/**
 * The endpoint's own explanation of a failed probe, bounded in both bytes and time.
 *
 * `response.text()` is the obvious way to read this and the wrong one: a gateway that answers 500 with an endless
 * body — or that opens a body and then says nothing — leaves the probe waiting on a request that has already
 * failed, and a connection probe is exactly the code that must not hang. The reader takes at most
 * `MAX_ERROR_BODY_BYTES`, gives up after `ERROR_BODY_TIMEOUT_MS`, and cancels the body either way so the socket is
 * not left open. An operator's own abort is re-raised rather than replaced: a cancellation is a decision, and
 * reporting it as a status code would hide it.
 */
async function readDiscoveryError(response: Response, signal?: AbortSignal): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('the endpoint stopped sending its error body')),
      ERROR_BODY_TIMEOUT_MS,
    );
  });
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        const fail = () => reject(signal.reason ?? new Error('cancelled'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      })
    : undefined;
  try {
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        stalled,
        ...(aborted ? [aborted] : []),
      ]);
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= MAX_ERROR_BODY_BYTES) break;
    }
    return text + decoder.decode();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return text + decoder.decode();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}
/**
 * The largest successful catalogue this probe will read, in bytes.
 *
 * A catalogue is a list of model ids, and a megabyte of JSON is already two orders of magnitude more than any
 * endpoint publishes. The bound belongs to the probe rather than to one caller of it: reading a *successful*
 * answer with `response.json()` and no limit means a gateway that answers 200 and then keeps writing leaves the
 * probe — the one piece of code that must not hang — waiting while the body grows without end. The failed-answer
 * path has always been bounded; this is the same rule for the answer that succeeded. It bounds bytes, not time:
 * an explicit caller decides its own deadline by passing a signal, and the automatic path already supplies one.
 */
const MAX_CATALOGUE_BYTES = 1024 * 1024;

/**
 * Read a successful answer under the byte bound, releasing the body either way.
 *
 * Returned as a `Response` so callers keep reading it exactly as they did: the cap is a property of this probe,
 * not a second response shape for them to learn.
 */
async function readBoundedCatalogue(response: Response): Promise<Response> {
  const body = response.body;
  if (!body) return response;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOGUE_BYTES)
        throw new Error(`The model list exceeds ${MAX_CATALOGUE_BYTES} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new Response(bytes ? Buffer.concat(chunks) : null, {
    status: response.status,
    headers: response.headers,
  });
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
    /**
     * A catalogue probe carries the operator's credential and asks a URL the operator named, so a redirect is
     * refused rather than followed: the answer would leave for a host nobody chose, with the key attached. The
     * automatic path has always refused one; the policy lives here so the explicit path cannot answer the same
     * question differently.
     */
    redirect: 'error',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const body = await readDiscoveryError(response, options.signal);
    throw new Error(
      `The endpoint answered ${response.status} for its model list${body.trim() ? `: ${body.trim().slice(0, 300)}` : ''}`,
    );
  }
  const payload: unknown = await (await readBoundedCatalogue(response)).json();
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
