import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { LspManager } from '../lsp/manager.ts';
import { readMcpConfigs } from '../mcp/config.ts';
import { mcpTools } from '../mcp/tools.ts';
import { canonicalKey } from '../platform/workspace-paths.ts';
import { userStateDirectory } from '../platform/user-state.ts';
import type { Tool } from '../protocol/index.ts';
import { BrowserSession } from '../tools/browser.ts';

/**
 * The language servers, browsers and MCP connections a session keeps between its runs.
 *
 * A tool registry is built for every run, and these used to be built with it and closed with it: every user turn
 * restarted its language servers and lost what they had indexed, every turn's browser started logged out with no
 * tabs, and every MCP server was handshaked again. They now live for the session rather than the turn, with an
 * idle timeout, so a session left open does not hold a rust-analyzer's memory all day, and a cap on live browsers.
 *
 * The unit is the session, never the process: a language server runs under the execution policy of the session
 * that started it, a browser holds that session's logins, and an MCP connection carries that session's
 * authorization — sharing any of them across sessions would hand one session another's. A registry acquires its
 * session's entry and releases it when the run ends; the entry closes once nothing holds it for the idle period, or
 * when the session is deleted, or with the Host.
 *
 * Only real sessions are pooled. A registry built for a delegated child (`subagent`) or outside any session
 * (`standalone`, a one-shot CLI command) keeps the per-registry lifecycle: there is no session to tie it to, and a
 * child's resident registry already lives as long as the child does.
 */

/** How long an unused entry stays open, per kind. */
export const RESOURCE_IDLE_MS = {
  lsp: 10 * 60_000,
  browser: 5 * 60_000,
  mcp: 10 * 60_000,
} as const;

/** The most browsers kept open at once; the least recently used idle one is closed to make room. */
export const MAX_LIVE_BROWSERS = 4;

type Kind = keyof typeof RESOURCE_IDLE_MS;

interface Entry<T> {
  kind: Kind;
  scope: string;
  value: T;
  close: () => Promise<void>;
  refs: number;
  lastUsed: number;
  timer?: NodeJS.Timeout;
}

const entries = new Map<string, Entry<unknown>>();

/** Whether a registry scope names a session whose resources are pooled. */
export function pooledScope(scope: string): boolean {
  return scope !== 'standalone' && scope !== 'subagent' && scope.length > 0;
}

function keyOf(kind: Kind, scope: string, root: string, extra = ''): string {
  return `${kind}\0${scope}\0${canonicalKey(path.resolve(root))}\0${extra}`;
}

async function closeEntry(key: string, entry: Entry<unknown>): Promise<void> {
  if (entries.get(key) === entry) entries.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  await entry.close().catch(() => undefined);
}

function acquire<T>(
  kind: Kind,
  scope: string,
  key: string,
  create: () => { value: T; close: () => Promise<void> },
): { value: T; release: () => void } {
  let entry = entries.get(key) as Entry<T> | undefined;
  if (!entry) {
    const created = create();
    entry = { kind, scope, ...created, refs: 0, lastUsed: Date.now() };
    entries.set(key, entry as Entry<unknown>);
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  entry.refs += 1;
  entry.lastUsed = Date.now();
  const held = entry;
  let released = false;
  return {
    value: held.value,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      held.lastUsed = Date.now();
      if (held.refs > 0 || entries.get(key) !== held) return;
      held.timer = setTimeout(
        () => void closeEntry(key, held as Entry<unknown>),
        RESOURCE_IDLE_MS[kind],
      );
      // An idle resource is not a reason for the process to stay alive.
      held.timer.unref?.();
    },
  };
}

/** One session's language servers for one directory; see the module note. */
export function acquireLspManager(
  root: string,
  scope: string,
): { value: LspManager; release: () => void } {
  return acquire('lsp', scope, keyOf('lsp', scope, root), () => {
    const manager = new LspManager(root);
    return { value: manager, close: () => manager.close() };
  });
}

/**
 * Where a session's browser keeps its profile — cookies, storage, logins — between launches.
 *
 * One directory per session and directory, under the user's state directory rather than the project, and removed
 * when the session is (`releaseSessionResources`). Playwright MCP keeps one profile per workspace by default; per
 * session is the stricter choice, because two sessions in one workspace are two conversations a person may not
 * want to share a login between.
 */
export function browserProfileDirectory(root: string, scope: string): string {
  return path.join(sessionProfiles(scope), digest(canonicalKey(path.resolve(root))));
}

/** Every browser profile one session has, one directory per project directory below it. */
function sessionProfiles(scope: string): string {
  return path.join(userStateDirectory(), 'browser-profiles', digest(scope));
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** One session's browser for one directory, with a persistent profile; see the module note. */
export function acquireBrowserSession(
  root: string,
  scope: string,
): { value: BrowserSession; release: () => void } {
  const held = acquire('browser', scope, keyOf('browser', scope, root), () => {
    const session = new BrowserSession({ profileDirectory: browserProfileDirectory(root, scope) });
    return { value: session, close: () => session.close() };
  });
  void enforceBrowserCap();
  return held;
}

/** Closes the least recently used idle browsers until no more than `MAX_LIVE_BROWSERS` remain. */
async function enforceBrowserCap(): Promise<void> {
  const browsers = [...entries].filter(([, entry]) => entry.kind === 'browser');
  const excess = browsers.length - MAX_LIVE_BROWSERS;
  if (excess <= 0) return;
  const idle = browsers
    .filter(([, entry]) => entry.refs === 0)
    .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)
    .slice(0, excess);
  // A browser a run is using is never closed under it; the cap is then exceeded until one is released.
  await Promise.all(idle.map(([key, entry]) => closeEntry(key, entry)));
}

/**
 * One session's MCP connections for one directory.
 *
 * Keyed by the configuration as well: a server added, removed or changed in `.yuantu/mcp.json` is a different set
 * of connections, and the next run gets a fresh one while the old set closes when idle.
 */
export function acquireMcpTools(
  root: string,
  scope: string,
): { value: { tools: Tool[] }; release: () => void } {
  const configs = readMcpConfigs(root);
  const fingerprint = createHash('sha256').update(JSON.stringify(configs)).digest('hex');
  return acquire('mcp', scope, keyOf('mcp', scope, root, fingerprint), () => {
    const opened = mcpTools(root, configs);
    return { value: { tools: opened.tools }, close: opened.close };
  });
}

/**
 * Closes everything a session holds, now, and removes its browser profiles.
 *
 * For a deleted session: its logins must not outlive it, and nothing it started should keep running until an idle
 * timer notices. An entry a run still holds is closed too — the session is gone.
 */
export async function releaseSessionResources(scope: string): Promise<void> {
  const owned = [...entries].filter(([, entry]) => entry.scope === scope);
  await Promise.all(owned.map(([key, entry]) => closeEntry(key, entry)));
  // Grouped by session, so a profile an earlier process left is removed as well as the ones open now.
  await rm(sessionProfiles(scope), { recursive: true, force: true }).catch(() => undefined);
}

/** Closes every pooled resource of the process: the Host at shutdown, a test at its end. */
export async function closeAllToolResources(): Promise<void> {
  await Promise.all([...entries].map(([key, entry]) => closeEntry(key, entry)));
}

/** What is pooled right now, by kind and scope; for tests and diagnostics. */
export function pooledResources(): { kind: Kind; scope: string; refs: number }[] {
  return [...entries.values()].map((entry) => ({
    kind: entry.kind,
    scope: entry.scope,
    refs: entry.refs,
  }));
}
