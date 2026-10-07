import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProvider } from '../../packages/providers/index.ts';
import type { ProviderConfig } from '../../packages/providers/config.ts';
import { redactSecrets } from '../../packages/core/errors.ts';
import { mainText } from './i18n.ts';
import {
  MODEL_LIMIT_KEYS,
  environmentProblems,
  parseSetting,
  type ModelLimitField,
} from '../../packages/protocol/settings.ts';
import {
  parseSettingsCommand,
  type ModelSettingsInput,
  type ModelSettingsView,
  type ModelConnectionView,
  type ModelGroupInput,
} from './settings-contract.ts';

interface SecretCipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(bytes: Buffer): string;
}
function baseUrl(value: string): string {
  try {
    const url = new URL(value.trim() || 'https://api.anthropic.com');
    if (url.username || url.password || url.search || url.hash) throw new Error();
    createProvider({ baseUrl: url.href, model: 'validation', apiKey: 'validation' });
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new Error(mainText('settings.baseUrlInvalid'));
  }
}
export interface PreparedModelSettings extends ProviderConfig {
  connectionId: string;
  groupId: string;
  groupName: string;
  name: string;
  supportsVision: boolean;
}
export interface PreparedModelGroup {
  connections: Map<string, PreparedModelSettings>;
  activeConnectionId: string;
  activeConfig: PreparedModelSettings;
}
/**
 * The protocol as the settings UI knows it.
 *
 * `ProviderConfig.protocol` is a string now, because a host may register a fourth adapter; the desktop only
 * ever offers the built-in three, and the environment path validates `YUANTU_PROTOCOL` against exactly that
 * list. So a value that is not one of the three here means a carrier registered its own adapter — the UI shows
 * the default rather than inventing a label it has no strings for.
 */
function builtinProtocol(value: string | undefined): 'anthropic' | 'openai' | 'openai-responses' {
  return value === 'openai' || value === 'openai-responses' ? value : 'anthropic';
}
export class ModelSettingsStore {
  private file: string;
  private cipher: SecretCipher;
  private env: NodeJS.ProcessEnv;
  private connections = new Map<string, PreparedModelSettings>();
  private activeConnectionId: string | null = null;
  private error: string | null = null;
  /**
   * What the launch environment got wrong, if anything.
   *
   * Kept apart from `error`, which is about the saved file and decides whether `current()` may use the
   * environment branch at all — a broken variable must not also hide a working configuration. Both are
   * reported, because the alternative is what this class used to do: `envLimit` refused a value outside its
   * own narrower range and returned `undefined`, so `YUANTU_MAX_CONTEXT_TOKENS=5000000` was honoured by the CLI
   * and silently ignored here, and the run was measured against a window nobody had declared.
   */
  private environmentError: string | null = null;
  constructor(file: string, cipher: SecretCipher, env: NodeJS.ProcessEnv = process.env) {
    this.file = file;
    this.cipher = cipher;
    this.env = { ...env };
    /**
     * `environmentProblems` rather than `parseSetting` alone, so a *bad* value is reported instead of thrown
     * out of a constructor — and so an unknown `YUANTU_*` name is reported too, which is the same failure one
     * keystroke earlier: `YUANTU_MAX_CONTEXT_TOKEN` (no S) is a value that never arrives.
     */
    const problems = environmentProblems(this.env);
    if (problems.length)
      this.environmentError = mainText('settings.environmentProblems', {
        problems: problems.map((entry) => `${entry.key}: ${entry.problem}`).join('；'),
      });
  }
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (!this.cipher.available() || ![1, 2].includes(raw.version)) throw new Error();
      const legacy = raw.version === 1;
      const rows = legacy
        ? [{ ...raw, connectionId: 'legacy', name: raw.model, supportsVision: true }]
        : raw.connections;
      if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error();
      const connections = new Map<string, PreparedModelSettings>();
      const legacyGroups = new Map<string, string>();
      const groupKeys = new Map<string, string>();
      const groupNames = new Map<string, string>();
      for (const row of rows) {
        if (!row || typeof row.encryptedApiKey !== 'string' || !row.connectionId) throw new Error();
        const connection = this.prepare({
          connectionId: row.connectionId,
          name: row.name,
          supportsVision: row.supportsVision,
          maxContextTokens: row.maxContextTokens,
          autoCompactTokens: row.autoCompactTokens,
          maxOutputTokens: row.maxOutputTokens,
          streamIdleTimeoutMs: row.streamIdleTimeoutMs,
          protocol: row.protocol,
          model: row.model,
          baseUrl: row.baseUrl,
          apiKey: this.cipher.decrypt(Buffer.from(row.encryptedApiKey, 'base64')),
        });
        const groupKey = JSON.stringify([
          connection.protocol,
          connection.baseUrl,
          connection.apiKey,
        ]);
        let groupId = row.groupId;
        if (
          groupId !== undefined &&
          (typeof groupId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(groupId))
        )
          throw new Error();
        if (!groupId) {
          groupId = legacyGroups.get(groupKey) || randomUUID();
          legacyGroups.set(groupKey, groupId);
        }
        connection.groupId = groupId;
        const savedName = row.groupName;
        if (
          savedName !== undefined &&
          (typeof savedName !== 'string' ||
            !savedName.trim() ||
            savedName.length > 128 ||
            /[\x00-\x1f\x7f]/.test(savedName))
        )
          throw new Error();
        const groupName =
          savedName?.trim() || groupNames.get(groupId) || connection.name || connection.model;
        if (groupKeys.has(groupId) && groupKeys.get(groupId) !== groupKey) throw new Error();
        if (groupNames.has(groupId) && groupNames.get(groupId) !== groupName) throw new Error();
        groupKeys.set(groupId, groupKey);
        groupNames.set(groupId, groupName);
        connection.groupName = groupName;
        if (connections.has(connection.connectionId)) throw new Error();
        connections.set(connection.connectionId, connection);
      }
      const activeId = legacy ? 'legacy' : raw.activeConnectionId;
      if (!connections.has(activeId) || (!legacy && raw.defaultConnectionId !== activeId))
        throw new Error();
      if (legacy) await this.persist(connections, activeId);
      this.connections = connections;
      this.activeConnectionId = activeId;
      this.error = null;
    } catch (error) {
      this.connections.clear();
      this.activeConnectionId = null;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.error = mainText('settings.modelLoadFailed');
    }
  }
  private current(): PreparedModelSettings {
    if (this.activeConnectionId) return this.configFor(this.activeConnectionId);
    /**
     * Read through `parseSetting`, which is the one reader there is, and declare each bound once.
     *
     * `parseSetting` cannot fail here: this class read `environmentProblems` at construction, so a value it
     * would refuse has already been reported in `environmentError`. It is still the reader rather than a local
     * `Number()` because that is what keeps the desktop and the CLI answering "is this value legal" the same
     * way — the ranges used to differ, and the desktop's answer was to drop the value in silence.
     */
    const envLimit = (field: ModelLimitField): number | undefined => {
      try {
        return parseSetting(this.env, MODEL_LIMIT_KEYS[field]) as number | undefined;
      } catch {
        // Already named in `environmentError`; here it means "not declared", so nothing invents a window.
        return undefined;
      }
    };
    const metadata = {
      connectionId: '',
      groupId: '',
      groupName: '',
      name: '',
      supportsVision: (() => {
        try {
          return (parseSetting(this.env, 'YUANTU_SUPPORTS_VISION') as boolean | undefined) ?? true;
        } catch {
          return true;
        } // Invalid declarations are already shown by environmentError.
      })(),
      maxContextTokens: envLimit('maxContextTokens'),
      autoCompactTokens: envLimit('autoCompactTokens'),
      maxOutputTokens: envLimit('maxOutputTokens'),
      streamIdleTimeoutMs: envLimit('streamIdleTimeoutMs'),
    };
    if (this.error)
      return {
        ...metadata,
        protocol: 'openai',
        model: '',
        baseUrl: 'https://api.openai.com',
        apiKey: '',
      };
    const protocol =
      this.env.YUANTU_PROTOCOL ??
      (this.env.YUANTU_MODEL?.trim() ||
      this.env.YUANTU_API_KEY?.trim() ||
      this.env.ANTHROPIC_API_KEY?.trim()
        ? 'anthropic'
        : 'openai');
    return {
      ...metadata,
      protocol:
        protocol === 'openai-responses'
          ? 'openai-responses'
          : protocol === 'openai'
            ? 'openai'
            : protocol === 'anthropic'
              ? 'anthropic'
              : 'openai',
      model: this.env.YUANTU_MODEL?.trim() || '',
      baseUrl:
        this.env.YUANTU_BASE_URL ||
        (['openai', 'openai-responses'].includes(protocol)
          ? this.env.OPENAI_BASE_URL || 'https://api.openai.com'
          : this.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
      apiKey:
        this.env.YUANTU_API_KEY?.trim() ||
        (['openai', 'openai-responses'].includes(protocol)
          ? this.env.OPENAI_API_KEY
          : this.env.ANTHROPIC_API_KEY
        )?.trim() ||
        '',
    };
  }
  configFor(connectionId: string): PreparedModelSettings {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(mainText('settings.connectionMissing'));
    return { ...connection };
  }
  private publicConnection(current: PreparedModelSettings): ModelConnectionView {
    let publicUrl = '';
    try {
      publicUrl = baseUrl(current.baseUrl || '');
    } catch {
      /* Do not reflect credentials embedded in an invalid environment URL. */
    }
    return {
      connectionId: current.connectionId,
      groupId: current.groupId,
      groupName: this.redact(current.groupName),
      name: this.redact(current.name),
      supportsVision: current.supportsVision,
      maxContextTokens: current.maxContextTokens,
      autoCompactTokens: current.autoCompactTokens,
      maxOutputTokens: current.maxOutputTokens,
      streamIdleTimeoutMs: current.streamIdleTimeoutMs,
      baseUrl: this.redact(publicUrl),
      protocol: builtinProtocol(current.protocol),
      model: this.redact(current.model),
      hasKey: Boolean(current.apiKey),
    };
  }
  private redact(value: string): string {
    const secrets: NodeJS.ProcessEnv = { ...this.env, YUANTU_API_KEY: this.current().apiKey };
    let index = 0;
    for (const connection of this.connections.values())
      secrets[`CONNECTION_${index++}_API_KEY`] = connection.apiKey;
    return redactSecrets(value, secrets);
  }
  get view(): ModelSettingsView {
    const current = this.current();
    return {
      ...this.publicConnection(current),
      connections: [...this.connections.values()].map((connection) =>
        this.publicConnection(connection),
      ),
      activeConnectionId: this.activeConnectionId,
      defaultConnectionId: this.activeConnectionId,
      source: this.activeConnectionId
        ? 'saved'
        : current.model || current.apiKey
          ? 'environment'
          : 'empty',
      encryptionAvailable: this.cipher.available(),
      error: this.error ?? this.environmentError,
    };
  }
  prepare(input: ModelSettingsInput): PreparedModelSettings {
    const parsed = parseSettingsCommand({ type: 'save', values: input });
    if (parsed.type !== 'save') throw new Error(mainText('settings.modelConfigInvalid'));
    const model = input.model.trim();
    if (!model) throw new Error(mainText('settings.modelRequired'));
    const target = baseUrl(input.baseUrl);
    const current =
      input.connectionId === undefined ? this.current() : this.connections.get(input.connectionId);
    let apiKey = input.apiKey.trim();
    if (!apiKey) {
      if (
        current?.apiKey &&
        (target !== baseUrl(current.baseUrl || '') ||
          (input.protocol ?? 'anthropic') !== (current.protocol ?? 'anthropic'))
      )
        throw new Error(mainText('settings.apiKeyRequiredAfterChange'));
      apiKey = current?.apiKey || '';
    }
    if (!apiKey) throw new Error(mainText('settings.apiKeyRequired'));
    return {
      groupId: current?.groupId || randomUUID(),
      groupName: current?.groupName || input.name?.trim() || model,
      connectionId:
        input.connectionId ||
        (input.connectionId === undefined ? current?.connectionId : '') ||
        randomUUID(),
      name: input.name?.trim() || current?.name || model,
      supportsVision: input.supportsVision ?? current?.supportsVision ?? true,
      ...(input.maxContextTokens !== undefined ? { maxContextTokens: input.maxContextTokens } : {}),
      ...(input.autoCompactTokens !== undefined
        ? { autoCompactTokens: input.autoCompactTokens }
        : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.streamIdleTimeoutMs !== undefined
        ? { streamIdleTimeoutMs: input.streamIdleTimeoutMs }
        : {}),
      protocol: input.protocol ?? 'anthropic',
      model,
      baseUrl: target,
      apiKey,
    };
  }
  prepareGroup(input: ModelGroupInput): PreparedModelGroup {
    const command = parseSettingsCommand({ type: 'save-group', values: input });
    if (command.type !== 'save-group') throw new Error('Invalid model group');
    const groupId = input.groupId || randomUUID();
    const previous = [...this.connections.values()].filter((row) => row.groupId === input.groupId);
    if (input.groupId && !previous.length) throw new Error('Model group no longer exists.');
    const target = baseUrl(input.baseUrl);
    const previousKey = previous[0]?.apiKey || '';
    const changedEndpoint =
      previous.length &&
      (target !== baseUrl(previous[0]!.baseUrl || '') || input.protocol !== previous[0]!.protocol);
    const apiKey = input.apiKey.trim() || (!changedEndpoint ? previousKey : '');
    if (!apiKey)
      throw new Error(
        changedEndpoint
          ? mainText('settings.apiKeyRequiredAfterChange')
          : mainText('settings.apiKeyRequired'),
      );
    const remaining = new Map(this.connections);
    for (const row of previous) remaining.delete(row.connectionId);
    const seenModels = new Set<string>();
    const seenIds = new Set<string>();
    const prepared: PreparedModelSettings[] = [];
    for (const model of input.models) {
      const modelId = model.model.trim();
      if (seenModels.has(modelId)) throw new Error('Model IDs must be unique for an endpoint.');
      seenModels.add(modelId);
      if (model.connectionId && !previous.some((row) => row.connectionId === model.connectionId))
        throw new Error('Model does not belong to this group.');
      const row = this.prepare({
        ...model,
        connectionId: model.connectionId || '',
        protocol: input.protocol,
        baseUrl: target,
        apiKey,
      });
      row.groupId = groupId;
      row.groupName = input.name.trim();
      row.name = model.name?.trim() || modelId;
      if (seenIds.has(row.connectionId) || remaining.has(row.connectionId))
        throw new Error('Duplicate model connection ID.');
      seenIds.add(row.connectionId);
      prepared.push(row);
      remaining.set(row.connectionId, row);
    }
    if (remaining.size > 100) throw new Error('A maximum of 100 models can be saved.');
    const activeConnectionId =
      input.activeConnectionId && seenIds.has(input.activeConnectionId)
        ? input.activeConnectionId
        : this.activeConnectionId && seenIds.has(this.activeConnectionId)
          ? this.activeConnectionId
          : prepared[0]!.connectionId;
    return {
      connections: remaining,
      activeConnectionId,
      activeConfig: remaining.get(activeConnectionId)!,
    };
  }
  async savePreparedGroup(group: PreparedModelGroup): Promise<void> {
    await this.persist(group.connections, group.activeConnectionId);
    this.connections = group.connections;
    this.activeConnectionId = group.activeConnectionId;
    this.error = null;
  }
  environment(config: ProviderConfig = this.current()): NodeJS.ProcessEnv {
    const fallback = (key: string) =>
      (config as Partial<PreparedModelSettings>).connectionId
        ? undefined
        : this.env[key] || undefined;
    return {
      YUANTU_MODEL: config.model,
      YUANTU_MAX_CONTEXT_TOKENS:
        config.maxContextTokens?.toString() || fallback('YUANTU_MAX_CONTEXT_TOKENS'),
      /**
       * The window and output cap of every model saved beside the active one on the same endpoint.
       *
       * One declaration answers for one route, and a round can be re-aimed at a sibling model (a pre-step
       * policy choosing a cheap model for a summarising round, or a wider one for a big read). The sibling's
       * window is already saved here — it is what the model's own entry in this window says — so the Host is
       * told all of them rather than only the active one, and a re-aimed round is measured against the number
       * its model actually has. Rows without a window are left out: they have nothing to declare, and the
       * endpoint catalogue or a refusal is the honest answer for them.
       */
      YUANTU_MODEL_CAPACITIES: this.routeCapacities(config) || fallback('YUANTU_MODEL_CAPACITIES'),
      YUANTU_AUTO_COMPACT_TOKENS:
        config.autoCompactTokens?.toString() || fallback('YUANTU_AUTO_COMPACT_TOKENS'),
      YUANTU_MAX_OUTPUT_TOKENS:
        config.maxOutputTokens?.toString() || fallback('YUANTU_MAX_OUTPUT_TOKENS'),
      YUANTU_STREAM_IDLE_TIMEOUT_MS:
        config.streamIdleTimeoutMs?.toString() || fallback('YUANTU_STREAM_IDLE_TIMEOUT_MS'),
      YUANTU_PROTOCOL: config.protocol ?? 'anthropic',
      YUANTU_BASE_URL: config.baseUrl,
      YUANTU_API_KEY: config.apiKey,
      YUANTU_CONNECTION_ID: (config as Partial<PreparedModelSettings>).connectionId || '',
      YUANTU_SUPPORTS_VISION: String(
        (config as Partial<PreparedModelSettings>).supportsVision ?? true,
      ),
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: '',
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
    };
  }
  /**
   * Every sibling model of the active one, as the JSON map the Host reads (`declaredRoutes`).
   *
   * `undefined` when there is nothing to say: an environment-only configuration has no saved rows, and a
   * single-model group would produce a map that says exactly what `YUANTU_MAX_CONTEXT_TOKENS` already says.
   */
  private routeCapacities(config: ProviderConfig): string | undefined {
    const groupId = (config as Partial<PreparedModelSettings>).groupId;
    if (!groupId) return undefined;
    const rows = [...this.connections.values()].filter(
      (row) => row.groupId === groupId && row.maxContextTokens !== undefined,
    );
    if (!rows.length) return undefined;
    return JSON.stringify(
      Object.fromEntries(
        rows.map((row) => [
          row.model,
          {
            contextWindow: row.maxContextTokens,
            ...(row.maxOutputTokens === undefined ? {} : { maxOutputTokens: row.maxOutputTokens }),
          },
        ]),
      ),
    );
  }
  async save(config: ProviderConfig): Promise<void> {
    const metadata = config as Partial<PreparedModelSettings>;
    const prepared = this.prepare({
      ...(metadata.connectionId !== undefined ? { connectionId: metadata.connectionId } : {}),
      ...(metadata.name !== undefined ? { name: metadata.name } : {}),
      ...(metadata.supportsVision !== undefined ? { supportsVision: metadata.supportsVision } : {}),
      ...(metadata.maxContextTokens !== undefined
        ? { maxContextTokens: metadata.maxContextTokens }
        : {}),
      ...(metadata.autoCompactTokens !== undefined
        ? { autoCompactTokens: metadata.autoCompactTokens }
        : {}),
      ...(metadata.maxOutputTokens !== undefined
        ? { maxOutputTokens: metadata.maxOutputTokens }
        : {}),
      ...(metadata.streamIdleTimeoutMs !== undefined
        ? { streamIdleTimeoutMs: metadata.streamIdleTimeoutMs }
        : {}),
      protocol: builtinProtocol(config.protocol),
      model: config.model,
      baseUrl: config.baseUrl || '',
      apiKey: config.apiKey,
    });
    const connections = new Map(this.connections);
    connections.set(prepared.connectionId, prepared);
    if (connections.size > 100) throw new Error(mainText('settings.connectionLimit'));
    await this.persist(connections, prepared.connectionId);
    this.connections = connections;
    this.activeConnectionId = prepared.connectionId;
    this.error = null;
  }
  async select(connectionId: string): Promise<void> {
    this.configFor(connectionId);
    await this.persist(this.connections, connectionId);
    this.activeConnectionId = connectionId;
  }
  async delete(connectionId: string): Promise<void> {
    this.configFor(connectionId);
    if (this.activeConnectionId === connectionId)
      throw new Error(mainText('settings.deleteActiveConnection'));
    const connections = new Map(this.connections);
    connections.delete(connectionId);
    await this.persist(connections, this.activeConnectionId!);
    this.connections = connections;
  }
  private async persist(
    connections: Map<string, PreparedModelSettings>,
    activeConnectionId: string,
  ): Promise<void> {
    if (!this.cipher.available()) throw new Error(mainText('settings.encryptionUnavailable'));
    let rows;
    try {
      rows = [...connections.values()].map(({ apiKey, ...config }) => ({
        ...config,
        encryptedApiKey: this.cipher.encrypt(apiKey).toString('base64'),
      }));
    } catch {
      throw new Error(mainText('settings.encryptionFailed'));
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(
        temporary,
        JSON.stringify(
          {
            version: 2,
            activeConnectionId,
            defaultConnectionId: activeConnectionId,
            connections: rows,
          },
          null,
          2,
        ),
        { mode: 0o600, flag: 'wx' },
      );
      await rename(temporary, this.file);
    } catch {
      throw new Error(mainText('settings.saveFailed'));
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
export async function testModelConnection(
  config: ProviderConfig,
  signal: AbortSignal,
): Promise<void> {
  try {
    await createProvider(config).complete({
      system: 'Connection test. Reply OK.',
      messages: [{ role: 'user', content: 'Reply OK.' }],
      tools: [],
      maxOutputTokens: 16,
      signal,
      onText: () => {},
    });
  } catch (error) {
    if (signal.aborted) throw new Error(mainText('settings.connectionTestCancelled'));
    throw new Error(
      redactSecrets(
        error instanceof Error ? error.message : mainText('settings.connectionTestFailed'),
        {
          YUANTU_API_KEY: config.apiKey,
        },
      ),
    );
  }
}
