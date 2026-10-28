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
import {
  MAX_BROWSER_TABS,
  type BrowserCommand,
  type BrowserReply,
  type BrowserState,
} from '../../browser-contract.ts';
import type {
  WorkspaceEntry,
  WorkspaceListing,
  WorkspacePreview,
} from '../../../../packages/protocol/rpc.ts';
import type { UiLanguage } from '../../ui-settings.ts';
import { createStore, type ReadableStore } from '../stores.ts';

export type PanelTab =
  | { kind: 'new' }
  | { kind: 'files' }
  | { kind: 'file'; path: string }
  | { kind: 'browser'; id: string };

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
  /** The selected tab; `selected` is the file path derived from it. */
  active: PanelTab;
  selected: string | null;
  /** The start page tab is in the strip. Closing the last tab folds the panel and restores this page. */
  startOpen: boolean;
  /** The files tab is in the strip. Choosing "Workspace files" again restores it after it is closed. */
  filesOpen: boolean;
  /** Open file tabs in open order; the start and files tabs are not in this list. */
  tabOrder: readonly string[];
  expanded: ReadonlySet<string>;
  listings: ReadonlyMap<string, WorkspaceListing>;
  failures: ReadonlyMap<string, string>;
  tabs: ReadonlyMap<string, WorkspaceTab>;
  /** Browser tabs are window-level: a workspace switch keeps them, unlike file tabs. */
  browserTabs: ReadonlyMap<string, BrowserState>;
  browserOrder: readonly string[];
}

export interface WorkspaceController {
  readonly store: ReadableStore<WorkspaceState>;
  setWorkspace(workspace: string): boolean;
  setOpen(open: boolean): void;
  setFullscreen(fullscreen: boolean): void;
  /** Activate the start page. */
  openNewTab(): void;
  /** Activate the files tab, reading the root directory when it has not been read yet. */
  openFiles(): void;
  /** Close the start page, or fold the panel when it is the last tab. */
  closeStart(): void;
  /** Close the files tab, or fold the panel when it is the last tab. */
  closeFiles(): void;
  /** Create a browser tab in the main process and activate it. */
  openBrowser(): Promise<string>;
  activateBrowser(id: string): void;
  updateBrowser(state: BrowserState): void;
  closeBrowserTab(id: string): void;
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
  /** Compare the shown directories with a cheap listing; refresh only when something changed. */
  pollForChanges(): Promise<boolean>;
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
  browser?(command: BrowserCommand): Promise<BrowserReply>;
}): WorkspaceController {
  let workspace = '';
  let open = false;
  let fullscreen = false;
  let active: PanelTab = { kind: 'new' };
  let selected: string | null = null;
  let startOpen = true;
  let filesOpen = false;
  let tabOrder: string[] = [];
  let generation = 0;
  let listingRound = 0;
  let listings = new Map<string, WorkspaceListing>();
  let failures = new Map<string, string>();
  let expanded = new Set<string>(['']);
  let tabs = new Map<string, WorkspaceTab>();
  let browserTabs = new Map<string, BrowserState>();
  let browserOrder: string[] = [];
  let browserSequence = 0;
  const listingTokens = new Map<string, number>();
  const store = createStore<WorkspaceState>({
    workspace,
    open,
    fullscreen,
    active,
    selected,
    startOpen,
    filesOpen,
    tabOrder,
    expanded,
    listings,
    failures,
    tabs,
    browserTabs,
    browserOrder,
  });
  let disposed = false;
  const publish = (): void => {
    if (!disposed)
      store.set({
        workspace,
        open,
        fullscreen,
        active,
        selected,
        startOpen,
        filesOpen,
        tabOrder,
        expanded,
        listings,
        failures,
        tabs,
        browserTabs,
        browserOrder,
      });
  };
  const setActive = (next: PanelTab): void => {
    // Activating a closable built-in tab makes it present again; a closed start page is never the active tab.
    if (next.kind === 'new') startOpen = true;
    else if (next.kind === 'files') filesOpen = true;
    active = next;
    selected = next.kind === 'file' ? next.path : null;
  };
  /** The strip order: start, files, then file tabs and browser tabs in the order they were opened. */
  const tabList = (): PanelTab[] => {
    const list: PanelTab[] = [];
    if (startOpen) list.push({ kind: 'new' });
    if (filesOpen) list.push({ kind: 'files' });
    for (const path of tabOrder) list.push({ kind: 'file', path });
    for (const id of browserOrder) list.push({ kind: 'browser', id });
    return list;
  };
  const isCurrent = (candidate: PanelTab): boolean => {
    if (candidate.kind !== active.kind) return false;
    if (candidate.kind === 'file' && active.kind === 'file') return candidate.path === active.path;
    if (candidate.kind === 'browser' && active.kind === 'browser')
      return candidate.id === active.id;
    return true;
  };
  /**
   * A tab was removed at `index`. Select its right neighbour, else its left, and fold the panel when that was the
   * last tab; the next open starts on the start page. The start tab is restored as the panel folds so the strip is
   * never empty when it comes back.
   */
  const finishClose = (closed: PanelTab, index: number): void => {
    const wasCurrent = isCurrent(closed);
    const remaining = tabList();
    if (!remaining.length) {
      setActive({ kind: 'new' });
      open = false;
      fullscreen = false;
    } else if (wasCurrent) {
      setActive(remaining[index] ?? remaining[index - 1] ?? remaining[0]!);
    }
    publish();
  };
  const emptyBrowserState = (id: string): BrowserState => ({
    id,
    url: '',
    title: '',
    loading: false,
    started: false,
    error: null,
    crashed: false,
    canGoBack: false,
    canGoForward: false,
    notice: null,
  });

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
      tabOrder = [];
      listingTokens.clear();
      setActive({ kind: 'new' });
      fullscreen = false;
      publish();
      if (open) void loadDirectory('');
      return true;
    },
    setOpen(next) {
      open = next;
      // Closing the panel leaves fullscreen with it; reopening starts docked.
      if (!next) fullscreen = false;
      publish();
    },
    setFullscreen(next) {
      fullscreen = next;
      publish();
    },
    openNewTab() {
      setActive({ kind: 'new' });
      publish();
    },
    openFiles() {
      setActive({ kind: 'files' });
      publish();
      if (open && !listings.has('')) void loadDirectory('');
    },
    closeStart() {
      if (!startOpen) return;
      const index = tabList().findIndex((tab) => tab.kind === 'new');
      startOpen = false;
      finishClose({ kind: 'new' }, index);
    },
    closeFiles() {
      if (!filesOpen) return;
      const index = tabList().findIndex((tab) => tab.kind === 'files');
      filesOpen = false;
      finishClose({ kind: 'files' }, index);
    },
    async openBrowser() {
      if (!deps.browser) throw new Error('Browser is unavailable');
      if (browserOrder.length >= MAX_BROWSER_TABS) throw new Error('Browser tab limit reached');
      const id = `browser-${++browserSequence}`;
      const reply = await deps.browser({ type: 'create', id });
      if (!reply.ok) throw new Error(reply.error);
      browserTabs = new Map(browserTabs).set(id, reply.state ?? emptyBrowserState(id));
      browserOrder = [...browserOrder, id];
      open = true;
      setActive({ kind: 'browser', id });
      publish();
      return id;
    },
    updateBrowser(state) {
      if (!browserTabs.has(state.id)) return;
      browserTabs = new Map(browserTabs).set(state.id, state);
      publish();
    },
    activateBrowser(id) {
      if (!browserTabs.has(id)) return;
      open = true;
      setActive({ kind: 'browser', id });
      publish();
    },
    closeBrowserTab(id) {
      if (!browserTabs.has(id)) return;
      const index = tabList().findIndex((tab) => tab.kind === 'browser' && tab.id === id);
      void deps.browser?.({ type: 'destroy', id });
      browserTabs = new Map(browserTabs);
      browserTabs.delete(id);
      browserOrder = browserOrder.filter((entry) => entry !== id);
      finishClose({ kind: 'browser', id }, index);
    },
    select(path) {
      setActive(path === null ? { kind: 'files' } : { kind: 'file', path });
      publish();
    },
    activate(path) {
      setActive(path === null ? { kind: 'files' } : { kind: 'file', path });
      publish();
    },
    backToTree() {
      setActive({ kind: 'files' });
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
        tabOrder = [...tabOrder, path];
      }
      setActive({ kind: 'file', path });
      publish();
      if (fresh) await readTab(tab);
    },
    closeTab(path) {
      const tab = tabs.get(path);
      if (!tab) return;
      const index = tabList().findIndex((entry) => entry.kind === 'file' && entry.path === path);
      if (tab.documentUrl) URL.revokeObjectURL(tab.documentUrl);
      tabs = new Map(tabs);
      tabs.delete(path);
      tabOrder = tabOrder.filter((entry) => entry !== path);
      finishClose({ kind: 'file', path }, index);
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
        tabOrder = [...tabOrder, path];
      }
      // A read in flight for this path would replace the diff when it lands; the diff is the newer intent.
      tab.token++;
      tab.reading = false;
      tab.changePreview = content;
      tab.changeKey = key;
      setActive({ kind: 'file', path });
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
      let activeRemoved = false;
      for (const [path, tab] of tabs) {
        if (!tab.changePreview) continue;
        if (selected === path) activeRemoved = true;
        tabs = new Map(tabs);
        tabs.delete(path);
        tabOrder = tabOrder.filter((entry) => entry !== path);
      }
      if (activeRemoved) setActive({ kind: 'files' });
      publish();
    },
    tab: (path) => tabs.get(path),
    pollPaths: () => ['', ...expanded],
    async pollForChanges() {
      if (!open || (typeof document !== 'undefined' && document.hidden)) return false;
      for (const path of ['', ...expanded]) {
        const reply = await deps.files(path ? { type: 'list', path } : { type: 'list' });
        if (!reply.ok || !('listing' in reply)) continue;
        const previous = listings.get(path);
        if (
          previous &&
          JSON.stringify(previous.entries) !== JSON.stringify(reply.listing.entries)
        ) {
          this.refresh();
          return true;
        }
      }
      return false;
    },
    dispose() {
      disposed = true;
      for (const id of browserOrder) void deps.browser?.({ type: 'destroy', id });
    },
  };
}
