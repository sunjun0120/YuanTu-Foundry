import type { UiLanguage } from './ui-settings.ts';
import { panelMessages } from './i18n-panels.ts';
import { conversationMessages } from './i18n-conversation.ts';
import { workspaceMessages } from './i18n-workspace.ts';
import { mainProcessMessages } from './i18n-main-process.ts';

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
};
/**
 * The DOM walker matches on already-rendered text, so it needs a Chinese to
 * English index of the dictionary. Keeping it derived means every string has
 * exactly one definition and cannot drift between two tables.
 */
const domText = new Map<string, string>();
for (const pair of Object.values(messages)) domText.set(pair[0], pair[1]);
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
const originals = new WeakMap<Node, string>();
const applied = new WeakMap<Node, string>();
const attributeSources = new WeakMap<Element, Map<string, { original: string; applied: string }>>();
const translatedAttributes = ['placeholder', 'aria-label', 'title'];
const excludedContent = 'script,style,pre,code,.message-content,[translate="no"]';
let observing = false;
function translatedText(value: string): string {
  if (language === 'zh-CN') return value;
  const m = value.match(/^(\s*)(.*?)(\s*)$/s)!;
  let body = domText.get(m[2]!) ?? m[2]!;
  body = body
    .replace(/^◇\s+MCP 服务$/, '◇ MCP Services')
    .replace(/^会话操作[：:]\s*(.+)$/, 'Session actions: $1')
    .replace(/^会话 ([a-f0-9]{1,8})$/i, 'Session $1')
    .replace(
      /^项目规则 (\d+) · 技能 (\d+) · 扩展 (\d+)$/,
      'Project rules $1 · Skills $2 · Extensions $3',
    )
    .replace(/^会话改动 · (\d+) 次文件操作$/, 'Session changes · $1 file operations')
    .replace(/^正在执行 (.+)$/, 'Running $1')
    .replace(/^当前工作区：/, 'Current workspace: ')
    .replace(/ · 已停用 · /g, ' · Disabled · ');
  return m[1] + body + m[3];
}
function translateDocument(root: Node): void {
  const nodes: Node[] = root.nodeType === Node.TEXT_NODE ? [root] : [];
  if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) nodes.push(n);
  }
  for (const node of nodes) {
    if (node.parentElement?.closest(excludedContent)) continue;
    const current = node.textContent ?? '';
    if (!originals.has(node) || (applied.has(node) && applied.get(node) !== current))
      originals.set(node, current);
    const next = translatedText(originals.get(node)!);
    if (current !== next) node.textContent = next;
    applied.set(node, next);
  }
  if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE) {
    const elements =
      root instanceof Element
        ? [root, ...root.querySelectorAll('*')]
        : [...(root as Document).querySelectorAll('*')];
    for (const element of elements) {
      if (element.closest(excludedContent)) continue;
      let sources = attributeSources.get(element);
      if (!sources) attributeSources.set(element, (sources = new Map()));
      for (const attribute of translatedAttributes) {
        const value = element.getAttribute(attribute);
        if (value === null) {
          sources.delete(attribute);
          continue;
        }
        const previous = sources.get(attribute);
        const original = !previous || previous.applied !== value ? value : previous.original;
        const next = translatedText(original);
        sources.set(attribute, { original, applied: next });
        if (value !== next) element.setAttribute(attribute, next);
      }
    }
  }
}
export function setLocale(next: UiLanguage): void {
  language = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
    translateDocument(document);
    if (!observing && document.body) {
      observing = true;
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) translateDocument(n);
          if (r.type === 'characterData') translateDocument(r.target);
          if (r.type === 'attributes') translateDocument(r.target);
        }
      }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: translatedAttributes,
      });
    }
  }
  for (const listener of listeners) listener();
}
export function onLocaleChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
