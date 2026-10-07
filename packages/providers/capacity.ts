/**
 * What this project is willing to assert about a model's capacity.
 *
 * The window is the only ceiling a run has, so every number has to come from somewhere it can be checked
 * against: the operator (a flag, an environment variable, a model entry in the desktop) or the endpoint's own
 * catalogue (`discoverModels`). This module is the third source, and it is deliberately the smallest one: an
 * entry exists only where this project can stand behind the number for that *endpoint*, not where a model id
 * merely looks familiar. Everything else must be declared or discovered — a guess that happens to be right for
 * one gateway is a wrong number on the next one, and it reads exactly like a configured value.
 *
 * The order a caller resolves in is `declared` → `catalog`, so an operator's number always wins and an entry
 * here is a convenience rather than a claim that overrides anybody.
 */
export interface KnownCapacity {
  /** The endpoint this applies to, matched on host name (a path, port or scheme difference is not a match). */
  host: string;
  /**
   * The model ids the entry covers, matched as a prefix.
   *
   * A prefix rather than an exact id because the ids carry dated snapshots (`deepseek-v4-flash-0423`) and a
   * catalogue that stopped matching on a date suffix would silently fall back to "no capacity declared". A
   * prefix that is too broad is the failure mode to weigh against that: an endpoint whose 1M window belongs to
   * one model family and not another must not be listed here at all.
   */
  modelPrefix?: string;
  contextWindow: number;
  /** The per-request output cap, when the endpoint publishes one. */
  maxOutputTokens?: number;
  /** Why this project believes the entry, so the next reader can re-check rather than trust it. */
  note: string;
}
/**
 * The endpoints and models this project ships numbers for.
 *
 * Today that is one entry: the official DeepSeek endpoint, whose **published** figures are 1M context and a
 * maximum of 384K output for the models it serves (`deepseek-flash` and `deepseek-v4-pro`, per the endpoint's
 * own Models & Pricing page). The numbers used to be this project's *protocol defaults* — 1,000,000 context
 * and 256,000 output, applied to every route regardless of who was serving it — which is how they were first
 * written here, with the output cap simply carried over. Checking the page is what turned that into a claim
 * with evidence: the context figure matched, the output cap did not (384K, not 256K), and an entry that is
 * *too small* quietly caps answers the endpoint would have allowed.
 *
 * Adding an entry is a deliberate act with evidence behind it. An entry that is wrong is worse than no entry:
 * a window that is too large lets the endpoint refuse the first request that outgrows the real limit, and one
 * that is too small compacts conversations that would have fit — and in both cases the failure looks like
 * something else. When the evidence cannot be produced, the entry is deleted rather than guessed, and the
 * route falls back to an operator's declaration or the endpoint's own catalogue.
 */
export const KNOWN_CAPACITY: readonly KnownCapacity[] = [
  {
    host: 'api.deepseek.com',
    modelPrefix: 'deepseek',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    note: 'the official DeepSeek endpoint (api.deepseek.com, and /anthropic): its Models & Pricing page publishes 1M context and a 384K maximum output for deepseek-flash and deepseek-v4-pro — checked 2026-10-02',
  },
];
/** One endpoint's assertion, when this project has one for that exact route. */
export function catalogCapacity(
  baseUrl: string | undefined,
  model: string,
  catalog: readonly KnownCapacity[] = KNOWN_CAPACITY,
): KnownCapacity | undefined {
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // A base URL this project cannot parse is not a licence to guess: the operator's own declaration (or the
    // endpoint's catalogue) is what has to answer for it.
    return undefined;
  }
  const id = model.trim().toLowerCase();
  return catalog.find(
    (entry) =>
      entry.host.toLowerCase() === host.toLowerCase() &&
      (entry.modelPrefix === undefined || id.startsWith(entry.modelPrefix.toLowerCase())),
  );
}
export interface RouteCapacity {
  contextWindow: number;
  maxOutputTokens?: number;
  /** Where the number came from, so a caller can say so instead of presenting every number as configured. */
  source: 'declared' | 'catalog';
}
/**
 * The windows an operator declared for *the other models on the same endpoint*.
 *
 * One declaration — `--max-context-tokens`, `YUANTU_MAX_CONTEXT_TOKENS`, the active model entry in the desktop
 * settings — answers for one route: the model this connection is configured to use. A pre-step policy that
 * re-aims a round at a sibling model (the cheap model for a summarising round, the wide-window model for one
 * big read) moves the round onto *that* model's window too, and the catalogue can only answer for endpoints
 * this project ships knowledge about. The desktop saves every model in an endpoint group with its own window,
 * and this is how that map reaches a run: `YUANTU_MODEL_CAPACITIES`, a JSON object of model id →
 * `{"contextWindow": n, "maxOutputTokens": n}` (the output cap optional).
 *
 * A map this function cannot read is an **error, not something to skip**. Dropping it silently would leave a
 * re-aimed round measured against this run's own window — exactly the failure the map exists to prevent — and
 * the run would look configured while measuring against a number nobody declared.
 */
export function declaredRoutes(
  value: string | undefined,
): Map<string, { contextWindow: number; maxOutputTokens?: number }> {
  const routes = new Map<string, { contextWindow: number; maxOutputTokens?: number }>();
  if (value === undefined || !value.trim()) return routes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('YUANTU_MODEL_CAPACITIES must be a JSON object of model id to capacity');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('YUANTU_MODEL_CAPACITIES must be a JSON object of model id to capacity');
  for (const [model, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = (raw ?? {}) as { contextWindow?: unknown; maxOutputTokens?: unknown };
    const window = entry.contextWindow;
    if (!model.trim() || !Number.isSafeInteger(window) || (window as number) < 1)
      throw new Error(
        `YUANTU_MODEL_CAPACITIES has no usable contextWindow for "${model}": every entry needs a positive integer`,
      );
    const output = entry.maxOutputTokens;
    if (output !== undefined && (!Number.isSafeInteger(output) || (output as number) < 1))
      throw new Error(
        `YUANTU_MODEL_CAPACITIES has no usable maxOutputTokens for "${model}": leave it out or give a positive integer`,
      );
    routes.set(model.trim(), {
      contextWindow: window as number,
      ...(output === undefined ? {} : { maxOutputTokens: output as number }),
    });
  }
  return routes;
}
/**
 * The capacity of one route: what the operator declared for it, else what this project asserts, else nothing.
 *
 * `undefined` is a real answer and the caller's problem to solve: the entry points refuse a run without a
 * window, and the refusal names the two ways to get one. Returning a default here would put the guess back
 * exactly where it was removed from.
 */
export function resolveRouteCapacity(input: {
  model: string;
  baseUrl?: string;
  /** What the operator declared for this route — a flag, an environment variable, a saved model entry. */
  declared?: { contextWindow?: number; maxOutputTokens?: number };
  /**
   * What the operator declared for the endpoint's other models (`declaredRoutes`). Consulted after `declared`
   * and before the catalogue, because a number a person gave for a model beats a number this project asserts
   * about an endpoint — and the person only had to give one of them.
   */
  routes?: ReadonlyMap<string, { contextWindow: number; maxOutputTokens?: number }>;
  catalog?: readonly KnownCapacity[];
}): RouteCapacity | undefined {
  const declared = input.declared?.contextWindow;
  if (declared !== undefined)
    return {
      contextWindow: declared,
      ...(input.declared?.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.declared.maxOutputTokens }),
      source: 'declared',
    };
  const route = input.routes?.get(input.model.trim());
  if (route)
    return {
      contextWindow: route.contextWindow,
      ...(route.maxOutputTokens === undefined ? {} : { maxOutputTokens: route.maxOutputTokens }),
      source: 'declared',
    };
  const known = catalogCapacity(input.baseUrl, input.model, input.catalog);
  if (!known) return undefined;
  return {
    contextWindow: known.contextWindow,
    ...(known.maxOutputTokens === undefined ? {} : { maxOutputTokens: known.maxOutputTokens }),
    source: 'catalog',
  };
}
