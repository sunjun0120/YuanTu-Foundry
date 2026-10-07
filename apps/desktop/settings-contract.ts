import type { DiscoveredModel } from '../../packages/providers/discovery.ts';
import { modelLimitRange } from '../../packages/protocol/settings.ts';
import { mainText } from './i18n.ts';
export interface ModelSettingsInput {
  /** Empty creates a new connection; omitted preserves the active legacy connection. */
  connectionId?: string;
  name?: string;
  supportsVision?: boolean;
  /** Omitted preserves the saved value; null explicitly restores the default. */
  maxContextTokens?: number | null;
  autoCompactTokens?: number | null;
  maxOutputTokens?: number | null;
  streamIdleTimeoutMs?: number | null;
  protocol?: 'anthropic' | 'openai' | 'openai-responses';
  baseUrl: string;
  model: string;
  apiKey: string;
}
export interface ModelGroupInput {
  groupId: string;
  name: string;
  protocol: 'anthropic' | 'openai' | 'openai-responses';
  baseUrl: string;
  apiKey: string;
  activeConnectionId?: string;
  models: Array<Omit<ModelSettingsInput, 'protocol' | 'baseUrl' | 'apiKey'>>;
}
export interface ModelConnectionView {
  groupId: string;
  groupName: string;
  connectionId: string;
  name: string;
  supportsVision: boolean;
  maxContextTokens?: number;
  autoCompactTokens?: number;
  maxOutputTokens?: number;
  streamIdleTimeoutMs?: number;
  protocol: 'anthropic' | 'openai' | 'openai-responses';
  baseUrl: string;
  model: string;
  hasKey: boolean;
}
export interface ModelSettingsView {
  connectionId: string;
  groupId: string;
  groupName: string;
  name: string;
  supportsVision: boolean;
  maxContextTokens?: number;
  autoCompactTokens?: number;
  maxOutputTokens?: number;
  streamIdleTimeoutMs?: number;
  connections: ModelConnectionView[];
  activeConnectionId: string | null;
  defaultConnectionId: string | null;
  protocol?: 'anthropic' | 'openai' | 'openai-responses';
  baseUrl: string;
  model: string;
  hasKey: boolean;
  source: 'saved' | 'environment' | 'empty';
  encryptionAvailable: boolean;
  error: string | null;
}
/**
 * What the settings page may ask the Host process to do.
 *
 * `discover` is the odd one out: it changes nothing and reads nothing of this machine — it asks the endpoint
 * for the catalogue that contains the one number a run refuses to invent (the context window). It goes through
 * the same handler as `test` because the credential it needs may exist only in the unsaved form.
 */
export type SettingsCommand =
  | { type: 'get' }
  | { type: 'select'; connectionId: string }
  | { type: 'delete'; connectionId: string }
  | { type: 'save' | 'test' | 'discover'; values: ModelSettingsInput }
  | { type: 'save-group'; values: ModelGroupInput };
export type SettingsReply =
  | {
      ok: true;
      settings: ModelSettingsView;
      message?: string;
      /** Present for `discover`: the endpoint's catalogue, with only what it actually declared. */
      discovered?: { endpoint: string; models: DiscoveredModel[] };
    }
  | { ok: false; error: string };
export function parseSettingsCommand(input: unknown): SettingsCommand {
  const invalid = () => {
    throw new Error(mainText('settings.modelRequestInvalid'));
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (value.type === 'get' && Object.keys(value).length === 1) return { type: 'get' };
  const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  if (value.type === 'select' || value.type === 'delete') {
    if (
      !validId(value.connectionId) ||
      Object.keys(value).some((key) => !['type', 'connectionId'].includes(key))
    )
      return invalid();
    return { type: value.type, connectionId: value.connectionId as string };
  }
  if (value.type === 'save-group') {
    if (Object.keys(value).some((key) => !['type', 'values'].includes(key))) return invalid();
    if (!value.values || typeof value.values !== 'object' || Array.isArray(value.values))
      return invalid();
    const group = value.values as Record<string, unknown>;
    if (
      Object.keys(group).some(
        (key) =>
          ![
            'groupId',
            'name',
            'protocol',
            'baseUrl',
            'apiKey',
            'activeConnectionId',
            'models',
          ].includes(key),
      )
    )
      return invalid();
    if (group.groupId !== '' && !validId(group.groupId)) return invalid();
    if (
      typeof group.name !== 'string' ||
      !group.name.trim() ||
      group.name.length > 128 ||
      /[\x00-\x1f\x7f]/.test(group.name)
    )
      return invalid();
    if (group.activeConnectionId !== undefined && !validId(group.activeConnectionId))
      return invalid();
    if (!Array.isArray(group.models) || !group.models.length || group.models.length > 100)
      return invalid();
    for (const model of group.models) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return invalid();
      if (Object.keys(model).some((key) => ['baseUrl', 'protocol', 'apiKey'].includes(key)))
        return invalid();
      parseSettingsCommand({
        type: 'save',
        values: {
          ...model,
          protocol: group.protocol,
          baseUrl: group.baseUrl,
          apiKey: group.apiKey,
        },
      });
    }
    return { type: 'save-group', values: group as unknown as ModelGroupInput };
  }
  if (value.type !== 'save' && value.type !== 'test' && value.type !== 'discover') return invalid();
  if (Object.keys(value).some((key) => !['type', 'values'].includes(key))) return invalid();
  if (!value.values || typeof value.values !== 'object' || Array.isArray(value.values))
    return invalid();
  const values = value.values as Record<string, unknown>;
  if (
    values.protocol !== undefined &&
    values.protocol !== 'anthropic' &&
    values.protocol !== 'openai' &&
    values.protocol !== 'openai-responses'
  )
    return invalid();
  if (
    Object.keys(values).some(
      (key) =>
        ![
          'baseUrl',
          'model',
          'apiKey',
          'protocol',
          'connectionId',
          'name',
          'supportsVision',
          'maxContextTokens',
          'autoCompactTokens',
          'maxOutputTokens',
          'streamIdleTimeoutMs',
        ].includes(key),
    )
  )
    return invalid();
  if (
    values.connectionId !== undefined &&
    values.connectionId !== '' &&
    !validId(values.connectionId)
  )
    return invalid();
  if (
    values.name !== undefined &&
    (typeof values.name !== 'string' ||
      values.name.length > 128 ||
      /[\x00-\x1f\x7f]/.test(values.name))
  )
    return invalid();
  if (values.supportsVision !== undefined && typeof values.supportsVision !== 'boolean')
    return invalid();
  // One range per field, read from the table that declares it: the four numbers used to be written out here
  // *and* in the host's own env reader with different bounds, so the same value was legal in one place and
  // silently dropped in the other.
  for (const field of [
    'maxContextTokens',
    'autoCompactTokens',
    'maxOutputTokens',
    'streamIdleTimeoutMs',
  ] as const) {
    const [min, max] = modelLimitRange(field);
    if (
      values[field] !== undefined &&
      values[field] !== null &&
      (typeof values[field] !== 'number' ||
        !Number.isSafeInteger(values[field]) ||
        values[field] < min ||
        values[field] > max)
    )
      return invalid();
  }
  // Cross-field constraints are also checked after merging with the saved connection.
  if (typeof values.autoCompactTokens === 'number' && values.maxContextTokens === null)
    return invalid();
  if (
    typeof values.autoCompactTokens === 'number' &&
    typeof values.maxContextTokens === 'number' &&
    values.autoCompactTokens >= values.maxContextTokens
  )
    return invalid();
  if (
    typeof values.maxOutputTokens === 'number' &&
    typeof values.maxContextTokens === 'number' &&
    values.maxOutputTokens >= values.maxContextTokens
  )
    return invalid();
  for (const [field, max] of [
    ['baseUrl', 2048],
    ['model', 256],
    ['apiKey', 16384],
  ] as const) {
    if (
      typeof values[field] !== 'string' ||
      values[field].length > max ||
      /[\x00-\x1f\x7f]/.test(values[field])
    )
      return invalid();
  }
  return { type: value.type, values: values as unknown as ModelSettingsInput };
}
