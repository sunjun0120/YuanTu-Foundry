import type { UiLanguage } from './ui-settings.ts';
import { panelMessages } from './i18n-panels.ts';
import { conversationMessages } from './i18n-conversation.ts';
import { workspaceMessages } from './i18n-workspace.ts';
import { mainProcessMessages } from './i18n-main-process.ts';
import { shellMessages } from './i18n-shell.ts';
import { taskEditorMessages } from './i18n-task-editors.ts';

type Listener = () => void;
export type TranslationValues = Record<string, string | number>;
type Pair = [string, string];
/**
 * The whole dictionary, its parts spread in their original order so a key defined twice resolves exactly as it
 * did in a single table: the later definition wins.
 */
const messages: Record<string, Pair> = {
  ...panelMessages,
  ...conversationMessages,
  ...workspaceMessages,
  ...mainProcessMessages,
  ...shellMessages,
  ...taskEditorMessages,
};
const listeners = new Set<Listener>();
let language: UiLanguage = 'zh-CN';
export function format(template: string, values: TranslationValues = {}): string {
  return template.replace(/\{([a-zA-Z][\w]*)\}/g, (m, k: string) =>
    Object.hasOwn(values, k) ? String(values[k]) : m,
  );
}
export function translate(key: string, lang: UiLanguage, values?: TranslationValues): string {
  const pair = messages[key];
  return format(pair ? pair[lang === 'en-US' ? 1 : 0] : key, values);
}
export function t(key: string, values?: TranslationValues): string {
  return translate(key, language, values);
}
/**
 * The dictionary as data, for the tooling that cannot go through `t`.
 *
 * The copy migrator (`scripts/migrate-ui-copy.mjs`) needs the reverse index `zh → key` to rewrite a literal into
 * a `t('key')` call, and the coverage test needs the same list to refuse a `t('…')` the dictionary does not own.
 * Both must read the one table `translate` reads, or a string could exist in the tooling's copy and nowhere else.
 */
export function dictionaryEntries(): readonly (readonly [string, string, string])[] {
  return Object.entries(messages).map(([key, pair]) => [key, pair[0], pair[1]] as const);
}
/** Whether the dictionary owns `key`; a `t()` miss renders the key itself, which is what the coverage test refuses. */
export function hasTranslation(key: string): boolean {
  return Object.hasOwn(messages, key);
}
export function locale(): UiLanguage {
  return language;
}
/**
 * The language the *main* process renders its own text in.
 *
 * A second piece of state rather than the renderer's `language` because these are two processes: the renderer
 * learns the interface language from the page it is drawing, and the main process from the settings file it
 * reads before a window exists — a failure dialog can be raised while a run is starting, before the renderer has
 * loaded anything. They read the same dictionary, which is the point: a validation message and the label beside
 * it cannot disagree about which language the interface is in.
 *
 * Until somebody sets it, it is the same default the renderer starts from.
 */
let mainLanguage: UiLanguage = 'zh-CN';
export function setMainLocale(next: UiLanguage): void {
  mainLanguage = next;
}
/** `t` for the main process: the same dictionary, read in the language this process was last told about. */
export function mainText(key: string, values?: TranslationValues): string {
  return translate(key, mainLanguage, values);
}
/** React and DOM-island producers render their own copy; locale changes never walk or mutate arbitrary nodes. */
export function setLocale(next: UiLanguage): void {
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  for (const listener of [...listeners]) listener();
}
export function onLocaleChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
