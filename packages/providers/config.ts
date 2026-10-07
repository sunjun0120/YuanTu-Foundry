import { parseSetting, promptCacheMode } from '../protocol/settings.ts';
import type { PromptCacheMode } from '../protocol/cache-modes.ts';
import { credentialsPath, readCredentials } from './credentials.ts';
export interface ProviderConfig {
  /** Operator-declared image input support; absence preserves the legacy default. */
  supportsVision?: boolean;
  /**
   * The window this connection declares for its model.
   *
   * Declared rather than assumed: this runtime cannot know what an endpoint serves, so the number comes from
   * the operator — `YUANTU_MAX_CONTEXT_TOKENS`, the matching flag, or the desktop's model settings — or from
   * `discoverModels()`, which reads the endpoint's own catalogue. Absence lets app entry points automatically
   * discover capacity or select a local application budget without persisting a manual declaration.
   */
  maxContextTokens?: number;
  /** The per-request output cap this connection declares, when it declares one. */
  maxOutputTokens?: number;
  /**
   * The compaction threshold a *settings row* carries, when it carries one.
   *
   * No adapter reads this, and `readConfig` below deliberately never sets it. It is declared here because the
   * desktop's saved connection shape extends this interface, and that is where the value is read from: the
   * settings store puts it into the environment it starts the Host with (`YUANTU_AUTO_COMPACT_TOKENS`), which
   * `parseArgs` reads into the run's options. So the value reaches a run through the options, not through the
   * connection — `readConfig` answers "which credential belongs to which protocol", and this is not that.
   */
  autoCompactTokens?: number;
  streamIdleTimeoutMs?: number;
  /**
   * Which adapter serves this endpoint.
   *
   * A string rather than a union of the three built-ins, because the registry is extensible: a host that
   * registers a fourth adapter has to be able to name it here. The environment path is still checked against
   * the settings table's `BUILTIN_PROTOCOLS` enum before this object exists, so a typo in `YUANTU_PROTOCOL` is
   * refused with the table's own words rather than reaching a factory.
   */
  protocol?: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /**
   * The cache granularity this connection asked for, already resolved to one of the four modes.
   *
   * A mode rather than the text of the setting: the two older spellings (`0` / `false`, `1` / `true`) are
   * translated on the way in, so nothing downstream has to know they existed. `auto` is the default and means
   * "whatever this route's protocol declares", which is exactly what the boolean's `true` used to mean.
   */
  promptCache?: PromptCacheMode;
}
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Whether a model id is required.
   *
   * `optional` exists for the one caller that has no model yet: `models` reads the endpoint's catalogue in
   * order to choose one, so requiring an id there would make the command that answers the question refuse to
   * start until the question is answered.
   */
  options: { model?: 'required' | 'optional' } = {},
): ProviderConfig {
  // Every value goes through `parseSetting` (see `packages/protocol/settings.ts`), which is the single place
  // a setting's type and bounds are decided. This function used to carry its own copies of "must be
  // anthropic, openai or openai-responses", "must be 0 or 1" and "must be 1000 to 3600000", and one of them
  // had already drifted from the table (`YUANTU_MAX_RETRIES` was bounded 0–2 here and 0–10 there). What is
  // left here is only what a *provider* needs: which credential variable belongs to which protocol, and which
  // values are required at all.
  const protocol =
    (parseSetting(env, 'YUANTU_PROTOCOL') as ProviderConfig['protocol']) ?? 'anthropic';
  /**
   * The credential: the environment first, the user's own file second.
   *
   * The environment wins because a per-invocation value has to mean something, and because a file that silently
   * shadowed it would be a second, invisible source of truth. The file is what the callers without a keychain have
   * (`credentials.ts`), and it is read only when the environment supplied nothing — so a setup that exports a key
   * never depends on a file existing, being readable or being valid.
   */
  const fromEnvironment =
    env.YUANTU_API_KEY?.trim() ||
    (protocol !== 'anthropic' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)?.trim();
  const apiKey = fromEnvironment || readCredentials(env)[protocol];
  const model = env.YUANTU_MODEL;
  if (!apiKey)
    throw new Error(
      `Set ${protocol !== 'anthropic' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} or YUANTU_API_KEY in the environment, or store a key for "${protocol}" in ${credentialsPath(env)}`,
    );
  if (!model?.trim() && options.model !== 'optional')
    throw new Error('Set YUANTU_MODEL to a model ID available on your endpoint');
  const streamIdleTimeoutMs = parseSetting(env, 'YUANTU_STREAM_IDLE_TIMEOUT_MS') as
    number | undefined;
  const maxContextTokens = parseSetting(env, 'YUANTU_MAX_CONTEXT_TOKENS') as number | undefined;
  const maxOutputTokens = parseSetting(env, 'YUANTU_MAX_OUTPUT_TOKENS') as number | undefined;
  /**
   * The cache granularity, read through the one reader there is -- and stored as the mode it means.
   *
   * `parseSetting` asks the settings table what is wrong with this value, and the table's rule for this setting
   * knows both vocabularies: the four modes and the boolean spellings they replaced. Normalising here rather than
   * leaving the raw text for every reader to interpret is what keeps `0` from being a legal spelling in the
   * environment and an unknown word everywhere else.
   */
  const promptCache =
    promptCacheMode(parseSetting(env, 'YUANTU_PROMPT_CACHE') as string | undefined) ?? 'auto';
  const supportsVision = parseSetting(env, 'YUANTU_SUPPORTS_VISION') as boolean | undefined;
  return {
    ...(supportsVision === undefined ? {} : { supportsVision }),
    ...(streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs }),
    // The connection declares its own capacity, from the one owner of those bounds (the settings table).
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    apiKey,
    model: model ?? '',
    ...(protocol !== 'anthropic' ? { protocol } : {}),
    // A connection that says nothing is `auto`, which is what the boolean's `true` meant: the route's own
    // protocol decides. An absent value and an empty one are both "not set" -- `VAR=` in a script means exactly
    // that everywhere else in this table, and `parseSetting` already answered `undefined` for both.
    promptCache,
    baseUrl:
      env.YUANTU_BASE_URL ??
      (protocol !== 'anthropic' ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL),
  };
}
