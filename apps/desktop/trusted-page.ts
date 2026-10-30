import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether a frame's URL is the desktop's own page at `pagePath`.
 *
 * Compared as file paths, not URL strings: Node's `pathToFileURL` writes `~` as `%7E` while Chromium keeps it as
 * typed, so a string match refused the desktop's own page whenever the install path held a `~` (a Windows short
 * name such as `RUNNER~1` in a temp directory is enough). A query or fragment still makes it a different page.
 */
export function isTrustedPage(url: string, pagePath: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'file:' &&
      !parsed.search &&
      !parsed.hash &&
      path.resolve(fileURLToPath(parsed)) === path.resolve(pagePath)
    );
  } catch {
    return false;
  }
}
