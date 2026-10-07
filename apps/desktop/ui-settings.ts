import { mainText } from './i18n.ts';

export type UiLanguage = 'zh-CN' | 'en-US';
export type UiAppearance = 'system' | 'light' | 'dark';
export type UiFontSize = 'small' | 'medium' | 'large';

export interface UiSettings {
  language: UiLanguage;
  appearance: UiAppearance;
  fontSize: UiFontSize;
}

export type UiSettingsCommand = { type: 'get' } | { type: 'save'; settings: UiSettings };

/**
 * What an answer says it is.
 *
 * `ok` alone would leave every reader narrowing by hand — `'settings' in reply` at each call site, and a
 * `reply.settings` that TypeScript cannot prove exists — so a successful answer names its own shape. There is one
 * shape now that the environment panel is gone (see §7-8 of the ledger); the tag stays because the renderer's
 * first call and the carrier seam both read it, and because a second answer arriving later should not have to
 * relearn this.
 */
export type UiSettingsReply =
  { ok: true; kind: 'settings'; settings: UiSettings } | { ok: false; error: string };

const defaults: UiSettings = {
  language: 'zh-CN',
  appearance: 'system',
  fontSize: 'medium',
};

export function defaultUiSettings(): UiSettings {
  return { ...defaults };
}

export function parseUiSettingsCommand(input: unknown): UiSettingsCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(mainText('ui.settingsRequestInvalid'));
  const value = input as Record<string, unknown>;
  if (value.type === 'get' && Object.keys(value).length === 1) return { type: 'get' };
  if (
    value.type !== 'save' ||
    Object.keys(value).some((key) => !['type', 'settings'].includes(key))
  )
    throw new Error(mainText('ui.settingsRequestInvalid'));
  return { type: 'save', settings: parseUiSettings(value.settings) };
}

export function parseUiSettings(input: unknown): UiSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(mainText('ui.settingsInvalid'));
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['language', 'appearance', 'fontSize'].includes(key)) ||
    (value.language !== 'zh-CN' && value.language !== 'en-US') ||
    (value.appearance !== 'system' &&
      value.appearance !== 'light' &&
      value.appearance !== 'dark') ||
    (value.fontSize !== 'small' && value.fontSize !== 'medium' && value.fontSize !== 'large')
  )
    throw new Error(mainText('ui.settingsInvalid'));
  return {
    language: value.language,
    appearance: value.appearance,
    fontSize: value.fontSize,
  } as UiSettings;
}
