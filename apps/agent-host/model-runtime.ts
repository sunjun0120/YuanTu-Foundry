import { createHash } from 'node:crypto';
import type { SubAgentResidency } from '../../packages/core/subagents/residency.ts';
import { createProvider, readConfig } from '../../packages/providers/index.ts';
import { MODEL_LIMIT_KEYS, parseSetting } from '../../packages/protocol/settings.ts';
import type {
  ModelCatalogConfiguration,
  ModelConnectionConfiguration,
  ModelSelection,
} from '../../packages/protocol/model-configuration.ts';
import type { SessionStore } from '../../packages/storage/sqlite.ts';
import type { Options } from '../shared/args.ts';
import { redactSecrets } from '../../packages/platform/redact.ts';

const fields = [
  'connectionId',
  'protocol',
  'model',
  'baseUrl',
  'apiKey',
  'supportsVision',
  'maxContextTokens',
  'autoCompactTokens',
  'maxOutputTokens',
  'streamIdleTimeoutMs',
  'modelCapacities',
];
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export interface RuntimeModelSnapshot {
  env: NodeJS.ProcessEnv;
  options: Options;
}

/** Owns connection configuration; session journals keep only an opaque connection id. */
export class HostModelRuntime {
  private catalog: ModelCatalogConfiguration | null = null;
  private revision = 0;
  private readonly residentConfigurations = new Map<string, string>();
  private readonly store: SessionStore;
  private readonly options: Options;
  private readonly launchEnvironment: NodeJS.ProcessEnv;
  constructor(
    store: SessionStore,
    options: Options,
    launchEnvironment: NodeJS.ProcessEnv = { ...process.env },
  ) {
    this.store = store;
    this.options = options;
    this.launchEnvironment = launchEnvironment;
  }

  configure(input: Record<string, unknown>): { revision: number } {
    const invalid = (): never => {
      throw new Error('Invalid model configuration');
    };
    if (
      Object.keys(input).some((key) => !['connections', 'defaultConnectionId'].includes(key)) ||
      !Array.isArray(input.connections) ||
      input.connections.length > 100
    )
      invalid();
    const connections: ModelConnectionConfiguration[] = [];
    const ids = new Set<string>();
    for (const value of input.connections as unknown[]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
      const row = value as Record<string, unknown>;
      if (
        Object.keys(row).some((key) => !fields.includes(key)) ||
        !validId(row.connectionId) ||
        ids.has(row.connectionId)
      )
        invalid();
      for (const [key, max] of [
        ['model', 256],
        ['baseUrl', 2048],
        ['apiKey', 16384],
      ] as const) {
        const text = row[key];
        if (
          typeof text !== 'string' ||
          !text.trim() ||
          text.length > max ||
          /[\x00-\x1f\x7f]/.test(text)
        )
          invalid();
      }
      if (!['anthropic', 'openai', 'openai-responses'].includes(row.protocol as string)) invalid();
      if (row.supportsVision !== undefined && typeof row.supportsVision !== 'boolean') invalid();
      for (const field of Object.keys(MODEL_LIMIT_KEYS) as (keyof typeof MODEL_LIMIT_KEYS)[]) {
        if (
          row[field] !== undefined &&
          (typeof row[field] !== 'number' || !Number.isSafeInteger(row[field]))
        )
          invalid();
      }
      if (row.modelCapacities !== undefined && typeof row.modelCapacities !== 'string') invalid();
      const connection = { ...row } as unknown as ModelConnectionConfiguration;
      const env = this.environment(connection);
      for (const key of Object.values(MODEL_LIMIT_KEYS)) parseSetting(env, key);
      parseSetting(env, 'YUANTU_MODEL_CAPACITIES');
      if (
        connection.autoCompactTokens !== undefined &&
        (connection.maxContextTokens === undefined ||
          connection.autoCompactTokens >= connection.maxContextTokens)
      )
        invalid();
      if (
        connection.maxOutputTokens !== undefined &&
        connection.maxContextTokens !== undefined &&
        connection.maxOutputTokens >= connection.maxContextTokens
      )
        invalid();
      const url = new URL(connection.baseUrl);
      if (url.username || url.password || url.search || url.hash) invalid();
      createProvider(readConfig(env));
      ids.add(connection.connectionId);
      connections.push(connection);
    }
    if (
      input.defaultConnectionId !== null &&
      (!validId(input.defaultConnectionId) || !ids.has(input.defaultConnectionId))
    )
      invalid();
    if (connections.length && input.defaultConnectionId === null) invalid();
    this.catalog = { connections, defaultConnectionId: input.defaultConnectionId as string | null };
    return { revision: ++this.revision };
  }

  private environment(connection?: ModelConnectionConfiguration): NodeJS.ProcessEnv {
    const env = { ...this.launchEnvironment };
    if (!connection) return env;
    Object.assign(env, {
      YUANTU_MODEL: connection.model,
      YUANTU_PROTOCOL: connection.protocol,
      YUANTU_BASE_URL: connection.baseUrl,
      YUANTU_API_KEY: connection.apiKey,
      YUANTU_CONNECTION_ID: connection.connectionId,
      YUANTU_SUPPORTS_VISION: String(connection.supportsVision ?? true),
      YUANTU_MODEL_CAPACITIES: connection.modelCapacities,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_BASE_URL: '',
      OPENAI_BASE_URL: '',
    });
    for (const [field, key] of Object.entries(MODEL_LIMIT_KEYS))
      env[key] = connection[field as keyof ModelConnectionConfiguration]?.toString();
    return env;
  }

  private connectionId(sessionId: string): string | undefined {
    const saved = this.store.newestPayload(sessionId, 'model.selected')?.connectionId;
    return typeof saved === 'string' ? saved : (this.catalog?.defaultConnectionId ?? undefined);
  }

  capture(sessionId: string, remember = false): RuntimeModelSnapshot {
    const id = this.connectionId(sessionId);
    const connection = this.catalog?.connections.find((row) => row.connectionId === id);
    if (id && !connection)
      throw new Error('The selected model connection is unavailable; select another model');
    if (remember && id && !this.store.newestPayload(sessionId, 'model.selected'))
      this.store.recordEvent(sessionId, 'model.selected', { connectionId: id });
    const env = this.environment(connection);
    const options = { ...this.options };
    if (connection) {
      options.maxContextTokens = connection.maxContextTokens;
      options.autoCompactTokens = connection.autoCompactTokens;
      options.maxOutputTokens = connection.maxOutputTokens;
    }
    return { env, options };
  }

  selection(sessionId: string): ModelSelection {
    const connectionId = this.connectionId(sessionId) ?? '';
    try {
      const { env } = this.capture(sessionId);
      const config = readConfig(env);
      return {
        connectionId,
        model: redactSecrets(config.model, env),
        protocol: config.protocol ?? 'anthropic',
        supportsVision: config.supportsVision ?? true,
        configured: true,
      };
    } catch {
      return { connectionId, model: '', protocol: '', supportsVision: false, configured: false };
    }
  }

  select(sessionId: string, connectionId: string): ModelSelection {
    if (!this.catalog?.connections.some((row) => row.connectionId === connectionId))
      throw new Error('Model connection does not exist');
    this.store.recordEvent(sessionId, 'model.selected', { connectionId });
    return this.selection(sessionId);
  }

  /** Release stale Agents while keeping the Host's one shared residency/resource bound. */
  async residency(
    snapshot: RuntimeModelSnapshot,
    sessionId: string,
    pool: SubAgentResidency,
  ): Promise<SubAgentResidency> {
    const key = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const previous = this.residentConfigurations.get(sessionId);
    if (previous !== undefined && previous !== key) {
      const children = pool.list();
      const stale = children
        .filter((child) => {
          // An intermediary can be evicted while its descendants remain loaded. Follow its durable ancestry.
          let parent: string | null | undefined = child.parentSessionId;
          const visited = new Set<string>();
          while (parent && !visited.has(parent)) {
            if (parent === sessionId) return true;
            visited.add(parent);
            const loaded = children.find((entry) => entry.childSessionId === parent);
            if (loaded) parent = loaded.parentSessionId;
            else {
              try {
                parent = this.store.get(parent).parentSessionId;
              } catch (error) {
                // An unrelated deleted chat may still have idle resources awaiting the ordinary reaper.
                if (error instanceof Error && error.message === `Session not found: ${parent}`)
                  return false;
                throw error;
              }
            }
          }
          return false;
        })
        .sort((a, b) => b.depth - a.depth);
      if (stale.some((child) => child.status === 'running'))
        throw new Error('Wait for running sub-agents before changing their model connection');
      for (const child of stale)
        if (pool.get(child.childSessionId) && !(await pool.unload(child.childSessionId)))
          throw new Error('Could not release the previous model connection');
    }
    this.residentConfigurations.set(sessionId, key);
    return pool;
  }
}
