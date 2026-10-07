import { marked, type Token } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import { t } from './i18n.ts';
for (const [name, language] of Object.entries({
  javascript,
  typescript,
  python,
  json,
  bash,
  css,
  xml,
  sql,
}))
  hljs.registerLanguage(name, language);
export function safeWebUrl(input: string): string | null {
  try {
    if (input.length > 4096 || /[\x00-\x20]/.test(input)) return null;
    const url = new URL(input);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export interface MarkdownActions {
  copy(text: string): Promise<void>;
  open(url: string): Promise<void>;
}
function element(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
export function renderMarkdown(text: string, actions: MarkdownActions): HTMLElement {
  const root = element('div');
  root.className = 'message-content markdown';
  if (text.length > 120000) {
    root.classList.add('plain-fallback');
    root.textContent = text;
    return root;
  }
  let count = 0;
  const decoder = document.createElement('textarea');
  const decode = (value: string) =>
    value.replace(/&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][\da-z]{1,31});/gi, (entity) => {
      decoder.innerHTML = entity;
      return decoder.value;
    });
  const render = (tokens: Token[], parent: HTMLElement, depth = 0) => {
    if (depth > 32) {
      parent.append(document.createTextNode(tokens.map((t) => t.raw).join('')));
      return;
    }
    for (const token of tokens) {
      if (++count > 12000) throw new Error('Markdown complexity limit');
      const nested: Token[] = 'tokens' in token ? (token.tokens ?? []) : [];
      const children = (node: HTMLElement) => {
        render(nested, node, depth + 1);
        return node;
      };
      switch (token.type) {
        case 'space':
        case 'def':
          break;
        case 'heading':
          parent.append(children(element(`h${Math.min(6, Math.max(1, token.depth))}`)));
          break;
        case 'paragraph':
          parent.append(children(element('p')));
          break;
        case 'blockquote':
          parent.append(children(element('blockquote')));
          break;
        case 'strong':
        case 'em':
        case 'del':
          parent.append(children(element(token.type)));
          break;
        case 'br':
        case 'hr':
          parent.append(element(token.type));
          break;
        case 'codespan':
          parent.append(element('code', token.text));
          break;
        case 'html':
          parent.append(document.createTextNode(token.raw));
          break;
        case 'text':
        case 'escape':
          if (nested.length) render(nested, parent, depth + 1);
          else parent.append(document.createTextNode(decode(token.text)));
          break;
        case 'link': {
          const url = safeWebUrl(decode(token.href));
          if (!url) {
            render(nested, parent, depth + 1);
            break;
          }
          const link = children(element('a')) as HTMLAnchorElement;
          link.href = url;
          link.title = url;
          link.addEventListener('click', (event) => {
            event.preventDefault();
            void actions.open(url).catch(() => {
              link.title = t('ui.openLinkFailed');
            });
          });
          parent.append(link);
          break;
        }
        case 'image':
          parent.append(
            element('span', `[${t('ui.image')}: ${token.text || t('ui.imageNotLoaded')}]`),
          );
          break;
        case 'list': {
          const list = element(token.ordered ? 'ol' : 'ul');
          if (token.ordered && token.start) (list as HTMLOListElement).start = token.start;
          for (const item of token.items) {
            const li = element('li');
            if (item.task) li.append(element('span', item.checked ? '☑ ' : '☐ '));
            render(item.tokens, li, depth + 1);
            list.append(li);
          }
          parent.append(list);
          break;
        }
        case 'table': {
          const wrapper = element('div');
          wrapper.className = 'markdown-table';
          const table = element('table');
          const head = element('thead'),
            row = element('tr');
          for (const cell of token.header) {
            const th = element('th');
            render(cell.tokens, th, depth + 1);
            row.append(th);
          }
          head.append(row);
          table.append(head);
          const body = element('tbody');
          for (const cells of token.rows) {
            const tr = element('tr');
            for (const cell of cells) {
              const td = element('td');
              render(cell.tokens, td, depth + 1);
              tr.append(td);
            }
            body.append(tr);
          }
          table.append(body);
          wrapper.append(table);
          parent.append(wrapper);
          break;
        }
        case 'code': {
          const block = element('section');
          block.className = 'code-block';
          const language = (token.lang || 'text').split(/\s/)[0]!.toLowerCase();
          const header = element('div');
          header.className = 'code-header';
          header.append(element('span', language.slice(0, 40)));
          const copy = element('button', t('ui.copy')) as HTMLButtonElement;
          copy.type = 'button';
          copy.addEventListener('click', () => {
            copy.disabled = true;
            void actions
              .copy(token.text)
              .then(
                () => {
                  copy.textContent = t('ui.copied');
                },
                () => {
                  copy.textContent = t('ui.copyFailed');
                },
              )
              .finally(() => {
                copy.disabled = false;
              });
          });
          header.append(copy);
          const pre = element('pre'),
            code = element('code');
          code.textContent = token.text;
          if (token.text.length <= 30000 && hljs.getLanguage(language)) {
            // Highlight.js escapes input. Copy only its text and known span nodes.
            const parsed = new DOMParser().parseFromString(
              hljs.highlight(token.text, { language, ignoreIllegals: true }).value,
              'text/html',
            );
            const copyNodes = (from: Node, to: Node) => {
              for (const child of from.childNodes) {
                if (child.nodeType === Node.TEXT_NODE)
                  to.appendChild(document.createTextNode(child.textContent || ''));
                else if (child instanceof HTMLElement && child.tagName === 'SPAN') {
                  const span = element('span');
                  span.className = child.className.replace(/[^a-zA-Z0-9_ -]/g, '');
                  copyNodes(child, span);
                  to.appendChild(span);
                }
              }
            };
            code.replaceChildren();
            copyNodes(parsed.body, code);
          }
          pre.append(code);
          block.append(header, pre);
          parent.append(block);
          break;
        }
        default:
          parent.append(document.createTextNode(token.raw));
      }
    }
  };
  try {
    render(marked.lexer(text, { gfm: true }), root);
  } catch {
    root.replaceChildren(document.createTextNode(text));
    root.classList.add('plain-fallback');
  }
  return root;
}
