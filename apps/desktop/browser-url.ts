/**
 * The browser panel's address grammar, kept pure so both the main process and the address bar agree.
 *
 * The main process accepts only `directHttpUrl` results: a search string is a renderer decision, and a URL that
 * reaches `loadURL` has already been proven to be http(s), credential-free, control-character-free and within the
 * length bound. The renderer adds the search fallback and the local-development shortcuts.
 */
export const SEARCH_URL = 'https://www.bing.com/search?q=';
const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/u;
const LOCAL = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/iu;
const HOST = /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/iu;

export function directHttpUrl(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 4096 || /[\x00-\x20\x7f]/u.test(text)) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function resolveBrowserAddress(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 4096 || /[\x00-\x1f\x7f]/u.test(text)) return null;
  const direct = directHttpUrl(text);
  if (direct) return direct;
  if (LOCAL.test(text)) return directHttpUrl(`http://${text}`);
  if (HOST.test(text)) return directHttpUrl(`https://${text}`);
  if (SCHEME.test(text)) return null;
  try {
    return `${SEARCH_URL}${encodeURIComponent(text)}`;
  } catch {
    return null;
  }
}
