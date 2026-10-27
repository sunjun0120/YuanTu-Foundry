import { marked, type Token } from 'marked';
import { highlightCode } from './highlight.ts';
import { t } from './i18n.ts';
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
/**
 * Decode the percent escapes a Markdown destination may carry.
 *
 * A link to a workspace file is a URL, so a space arrives as `%20` and a literal `%` as `%25`. Decoding the
 * whole string at once would reject a name that contains a bare `%` the author did not escape, so each run of
 * escapes is decoded on its own and an invalid run is left as written.
 */
function decodeLocalPath(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
/** A relative link that may name a workspace file; absolute paths and other schemes are left as text. */
export function safeLocalPath(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 4096) return null;
  // A fragment names a place inside the target, not part of the file name. Splitting before decoding keeps an
  // encoded `%23` — a literal `#` in the name — from being mistaken for a fragment.
  const pathname = decodeLocalPath(text.split('#', 1)[0]!).trim();
  if (!pathname || pathname.length > 4096) return null;
  // Spaces in a file name are ordinary; control characters are not, and the main process refuses them too.
  if (/[\x00-\x1f\x7f]/.test(pathname)) return null;
  // An absolute/UNC path is not a workspace-relative file the bridge can resolve.
  if (pathname.startsWith('/') || pathname.startsWith('\\')) return null;
  // Any explicit scheme (`https:`, `mailto:`, `file:`) is not this channel's job.
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathname)) return null;
  return pathname;
}
export interface MarkdownActions {
  copy(text: string): Promise<void>;
  open(url: string): Promise<void>;
  /** Open a workspace-relative path; absent in a harness without the desktop bridge. */
  openLocal?(path: string): Promise<void>;
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
          const href = decode(token.href);
          const url = safeWebUrl(href);
          if (!url) {
            const local = safeLocalPath(href);
            if (local && actions.openLocal) {
              const button = children(element('button')) as HTMLButtonElement;
              button.type = 'button';
              button.className = 'markdown-local-link';
              button.title = t('ui.openWorkspaceFile');
              button.addEventListener('click', () => {
                void actions.openLocal!(local).catch(() => {
                  button.title = t('ui.openLinkFailed');
                });
              });
              parent.append(button);
              break;
            }
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
          const pre = element('pre');
          // The shared highlighter escapes the source and returns only text and token spans; 30 KB keeps a huge
          // fenced block from stalling the turn that renders it.
          pre.append(highlightCode(token.text, language === 'text' ? null : language, 30_000));
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
