/**
 * Syntax highlighting shared by Markdown fenced blocks and the workspace code preview.
 *
 * The highlighter owns the language registry and the only conversion from highlighted HTML to DOM. Both callers
 * receive a `<code>` element built from text nodes and whitelisted `<span>` nodes, so raw source is never inserted as
 * HTML and highlight.js output cannot smuggle a tag other than the token spans it produces.
 */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import powershell from 'highlight.js/lib/languages/powershell';
import yaml from 'highlight.js/lib/languages/yaml';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';

for (const [name, language] of Object.entries({
  javascript,
  typescript,
  python,
  json,
  bash,
  css,
  xml,
  sql,
  powershell,
  yaml,
  java,
  go,
  rust,
  c,
  cpp,
}))
  hljs.registerLanguage(name, language);

/** Files larger than this (bytes) and fenced blocks longer than this (characters) fall back to plain text. */
export const MAX_HIGHLIGHT_LENGTH = 64 * 1024;

/**
 * The highlighter language for a workspace path, or null for text an editor would not tokenize.
 *
 * Only the extension decides. A file whose name carries no extension, such as `Dockerfile`, stays plain rather than
 * being guessed from content: a wrong highlighter paints identifiers as strings and is worse than no colour.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  pyw: 'python',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  css: 'css',
  scss: 'css',
  less: 'css',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  sql: 'sql',
};

export function languageForPath(path: string): string | null {
  const name = path.replace(/\\/gu, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

function copyTokens(from: Node, to: Node): void {
  for (const child of from.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      to.appendChild(document.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child instanceof HTMLElement && child.tagName === 'SPAN') {
      const span = document.createElement('span');
      // Highlight.js token classes are `hljs-...`; strip anything that could become a selector or HTML attribute.
      span.className = child.className.replace(/[^a-zA-Z0-9_ -]/gu, '');
      copyTokens(child, span);
      to.appendChild(span);
    }
  }
}

/**
 * Highlight `text` as `language` and return the `<code>` element.
 *
 * Unknown languages, text over `limit` and highlight.js failures return the original text as a text node. The
 * returned element is safe to append: its only children are text and the token spans built above.
 */
export function highlightCode(
  text: string,
  language: string | null,
  limit = MAX_HIGHLIGHT_LENGTH,
): HTMLElement {
  const code = document.createElement('code');
  code.textContent = text;
  if (!language || text.length > limit || !hljs.getLanguage(language)) return code;
  try {
    const parsed = new DOMParser().parseFromString(
      hljs.highlight(text, { language, ignoreIllegals: true }).value,
      'text/html',
    );
    code.replaceChildren();
    copyTokens(parsed.body, code);
  } catch {
    code.textContent = text;
  }
  return code;
}
