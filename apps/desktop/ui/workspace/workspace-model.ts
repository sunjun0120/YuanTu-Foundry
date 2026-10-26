/**
 * The workspace panel's reads: directory listings and file previews, and which answer is allowed to win.
 *
 * A listing is written under the path it was asked for, and two reads of the *same* directory can be in flight at
 * once (expand, collapse, expand again). Three counters keep a superseded answer out:
 *
 * - `generation` — which workspace every answer belongs to; a workspace change abandons everything in flight;
 * - `listingRound` — which refresh a listing belongs to; a refresh invalidates the tree but **not** the open file,
 *   because bumping the workspace counter here would leave a preview on "reading" for a file nobody waits for;
 * - a per-path listing token and a per-tab file token, so the older of two same-path reads can never overwrite the
 *   newer one.
 *
 * A **rejected** promise (`files.list` rejects when the IPC handler throws or the channel is gone) is a failure like
 * a refusal: it is caught and written into the same map, not dropped on the floor.
 */
import type { FilesReply } from '../../files-contract.ts';
import type {
  WorkspaceEntry,
  WorkspaceListing,
  WorkspacePreview,
} from '../../../../packages/protocol/rpc.ts';
import type { UiLanguage } from '../../ui-settings.ts';
import { createStore, type ReadableStore } from '../stores.ts';

export interface WorkspaceTab {
  path: string;
  shown: WorkspacePreview | null;
  error: string | null;
  reading: boolean;
  token: number;
  scrollTop: number;
  changeKey?: string;
  /** A diff preview built by the transcript; drawn instead of a read when present. */
  changePreview?: Element | null;
  /** A blob URL for a generated Office page; released when the tab is closed or reloaded. */
  documentUrl?: string;
}

export interface WorkspaceState {
  workspace: string;
  open: boolean;
  fullscreen: boolean;
  selected: string | null;
  expanded: ReadonlySet<string>;
  listings: ReadonlyMap<string, WorkspaceListing>;
  failures: ReadonlyMap<string, string>;
  tabs: ReadonlyMap<string, WorkspaceTab>;
}

export interface WorkspaceController {
  readonly store: ReadableStore<WorkspaceState>;
  setWorkspace(workspace: string): boolean;
  setOpen(open: boolean): void;
  setFullscreen(fullscreen: boolean): void;
  select(path: string | null): void;
  /** Show a tab (or the tree with `null`) without reading anything. */
  activate(path: string | null): void;
  backToTree(): void;
  loadDirectory(path: string): Promise<void>;
  toggleDirectory(path: string): void;
  refresh(): void;
  showFile(path: string): Promise<void>;
  closeTab(path: string): void;
  setTabScroll(path: string, top: number): void;
  /** Show a diff the transcript already built, without reading the file. */
  previewChanges(path: string, content: Element, key: string): void;
  /** Replace the diff under `key`; `false` when no tab is showing it. */
  refreshChangePreview(key: string, content: Element): boolean;
  clearChangePreviews(): void;
  tab(path: string): WorkspaceTab | undefined;
  /** The directories a poll would compare: the root and every expanded directory. */
  pollPaths(): string[];
  dispose(): void;
}

export function fileName(path: string): string {
  return path.split('/').pop() || path;
}

/** A byte count for a tree row: whole units, one decimal past KB. */
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** The tree's rows for one expanded directory, filtered and ordered the way the panel shows them. */
export function visibleEntries(listing: WorkspaceListing | undefined): WorkspaceEntry[] {
  if (!listing) return [];
  return [...listing.entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function createWorkspaceController(deps: {
  files(command: unknown): Promise<FilesReply>;
  locale(): UiLanguage;
}): WorkspaceController {
  let workspace = '';
  let open = false;
  let fullscreen = false;
  let selected: string | null = null;
  let generation = 0;
  let listingRound = 0;
  let listings = new Map<string, WorkspaceListing>();
  let failures = new Map<string, string>();
  let expanded = new Set<string>(['']);
  let tabs = new Map<string, WorkspaceTab>();
  const listingTokens = new Map<string, number>();
  const store = createStore<WorkspaceState>({
    workspace,
    open,
    fullscreen,
    selected,
    expanded,
    listings,
    failures,
    tabs,
  });
  let disposed = false;
  const publish = (): void => {
    if (!disposed)
      store.set({ workspace, open, fullscreen, selected, expanded, listings, failures, tabs });
  };

  async function loadDirectory(path: string): Promise<void> {
    const at = generation;
    const round = listingRound;
    const token = (listingTokens.get(path) ?? 0) + 1;
    listingTokens.set(path, token);
    const current = (): boolean =>
      at === generation && round === listingRound && listingTokens.get(path) === token;
    try {
      const reply = await deps.files(path ? { type: 'list', path } : { type: 'list' });
      if (!current()) return;
      if (reply.ok && 'listing' in reply) {
        listings = new Map(listings).set(path, reply.listing);
        failures = new Map(failures);
        failures.delete(path);
      } else if (!reply.ok) {
        failures = new Map(failures).set(path, reply.error);
      }
    } catch (error) {
      if (!current()) return;
      failures = new Map(failures).set(
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
    publish();
  }

  async function readTab(tab: WorkspaceTab): Promise<void> {
    const token = ++tab.token;
    const at = generation;
    tab.reading = true;
    tab.error = null;
    publish();
    try {
      const reply = await deps.files({
        type: 'read',
        path: tab.path,
        locale: deps.locale(),
      });
      // Closing and reopening the path creates a different tab; the old one's answer is not this one's.
      if (at !== generation || tabs.get(tab.path) !== tab || token !== tab.token) return;
      if (tab.documentUrl) URL.revokeObjectURL(tab.documentUrl);
      tab.documentUrl = undefined;
      tab.shown = reply.ok && 'preview' in reply ? reply.preview : null;
      tab.error = reply.ok ? null : reply.error;
    } catch (error) {
      if (at !== generation || tabs.get(tab.path) !== tab || token !== tab.token) return;
      tab.shown = null;
      tab.error = error instanceof Error ? error.message : String(error);
    }
    tab.reading = false;
    publish();
  }

  return {
    store,
    setWorkspace(next) {
      if (!next || next === workspace) return false;
      workspace = next;
      generation++;
      listingRound++;
      listings = new Map();
      failures = new Map();
      expanded = new Set(['']);
      tabs = new Map();
      listingTokens.clear();
      selected = null;
      fullscreen = false;
      publish();
      if (open) void loadDirectory('');
      return true;
    },
    setOpen(next) {
      open = next;
      publish();
    },
    setFullscreen(next) {
      fullscreen = next;
      publish();
    },
    select(path) {
      selected = path;
      publish();
    },
    activate(path) {
      selected = path;
      publish();
    },
    backToTree() {
      selected = null;
      publish();
    },
    loadDirectory,
    toggleDirectory(path) {
      if (expanded.has(path)) {
        expanded = new Set(expanded);
        expanded.delete(path);
        publish();
        return;
      }
      expanded = new Set(expanded).add(path);
      publish();
      if (!listings.has(path)) void loadDirectory(path);
    },
    refresh() {
      listingRound++;
      listings = new Map();
      failures = new Map();
      listingTokens.clear();
      publish();
      for (const path of expanded) void loadDirectory(path);
      for (const tab of tabs.values()) void readTab(tab);
    },
    async showFile(path) {
      let tab = tabs.get(path);
      // A diff preview is not the file: opening the path itself reads the current bytes.
      const fresh = !tab || Boolean(tab.changePreview);
      if (tab) {
        delete tab.changePreview;
        delete tab.changeKey;
      }
      if (!tab) {
        tab = { path, shown: null, error: null, reading: false, token: 0, scrollTop: 0 };
        tabs = new Map(tabs).set(path, tab);
      }
      selected = path;
      publish();
      if (fresh) await readTab(tab);
    },
    closeTab(path) {
      const paths = [...tabs.keys()];
      const index = paths.indexOf(path);
      const wasActive = selected === path;
      const tab = tabs.get(path);
      if (tab?.documentUrl) URL.revokeObjectURL(tab.documentUrl);
      tabs = new Map(tabs);
      tabs.delete(path);
      if (wasActive) selected = paths[index + 1] ?? paths[index - 1] ?? null;
      publish();
    },
    setTabScroll(path, top) {
      const tab = tabs.get(path);
      if (!tab) return;
      tab.scrollTop = top;
    },
    previewChanges(path, content, key) {
      let tab = tabs.get(path);
      if (!tab) {
        tab = { path, shown: null, error: null, reading: false, token: 0, scrollTop: 0 };
        tabs = new Map(tabs).set(path, tab);
      }
      // A read in flight for this path would replace the diff when it lands; the diff is the newer intent.
      tab.token++;
      tab.reading = false;
      tab.changePreview = content;
      tab.changeKey = key;
      selected = path;
      if (!open) open = true;
      publish();
    },
    refreshChangePreview(key, content) {
      const tab = [...tabs.values()].find((entry) => entry.changeKey === key);
      if (!tab) return false;
      if (tab.changePreview === content) return true;
      tab.changePreview = content;
      publish();
      return true;
    },
    clearChangePreviews() {
      for (const [path, tab] of tabs) {
        if (!tab.changePreview) continue;
        tabs = new Map(tabs);
        tabs.delete(path);
        if (selected === path) selected = null;
      }
      publish();
    },
    tab: (path) => tabs.get(path),
    pollPaths: () => ['', ...expanded],
    dispose() {
      disposed = true;
    },
  };
}
