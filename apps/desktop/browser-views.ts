/**
 * The panel browser's main-process views.
 *
 * One `WebContentsView` per renderer tab, in a partition separate from the application and from the Agent's
 * Playwright profile. The guest has no preload, no Node and no bridge; every navigation is re-checked here even when
 * the renderer's address bar already resolved it. Only one guest is visible at a time, and a view is destroyed when
 * its tab closes — not when the window loses focus.
 */
import { session, shell, type BrowserWindow, type WebContents, WebContentsView } from 'electron';
import {
  BROWSER_PARTITION,
  MAX_BROWSER_TABS,
  type BrowserBounds,
  type BrowserCommand,
  type BrowserEvent,
  type BrowserReply,
  type BrowserState,
} from './browser-contract.ts';
import { directHttpUrl } from './browser-url.ts';

interface Entry {
  view: WebContentsView;
  state: BrowserState;
  visible: boolean;
  bounds: BrowserBounds;
}

function initialState(id: string): BrowserState {
  return {
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
  };
}

function finiteBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: Math.max(0, Math.round(Number.isFinite(bounds.x) ? bounds.x : 0)),
    y: Math.max(0, Math.round(Number.isFinite(bounds.y) ? bounds.y : 0)),
    width: Math.max(0, Math.round(Number.isFinite(bounds.width) ? bounds.width : 0)),
    height: Math.max(0, Math.round(Number.isFinite(bounds.height) ? bounds.height : 0)),
  };
}

export class BrowserViews {
  private readonly entries = new Map<string, Entry>();
  private readonly browserSession = session.fromPartition(BROWSER_PARTITION);
  private readonly window: BrowserWindow;
  private readonly onEvent: (event: BrowserEvent) => void;
  private disposed = false;

  constructor(window: BrowserWindow, onEvent: (event: BrowserEvent) => void) {
    this.window = window;
    this.onEvent = onEvent;
    // A guest in this partition can never ask for a device, a permission or a download. Certificate errors keep
    // Electron's default rejection; nothing here overrides `certificate-error`.
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.setDevicePermissionHandler(() => false);
    this.browserSession.on('will-download', (event, item, contents) => {
      event.preventDefault();
      item.cancel();
      const id = this.idFor(contents);
      if (!id) return;
      const entry = this.entries.get(id);
      if (!entry) return;
      entry.state.notice = 'download-blocked';
      this.emit(entry);
      this.onEvent({ type: 'download-blocked', id });
    });
  }

  private idFor(contents: WebContents): string | undefined {
    for (const [id, entry] of this.entries) if (entry.view.webContents === contents) return id;
    return undefined;
  }

  private emit(entry: Entry): void {
    if (!this.disposed && !this.window.isDestroyed())
      this.onEvent({ type: 'state', state: { ...entry.state } });
  }

  private updateHistory(entry: Entry): void {
    const history = entry.view.webContents.navigationHistory;
    entry.state.canGoBack = history.canGoBack();
    entry.state.canGoForward = history.canGoForward();
  }

  private wire(entry: Entry): void {
    const contents = entry.view.webContents;
    contents.setWindowOpenHandler((details) => {
      if (details.postBody) {
        entry.state.notice = 'popup-blocked';
        this.emit(entry);
        this.onEvent({ type: 'popup-blocked', id: entry.state.id });
        return { action: 'deny' };
      }
      const url = directHttpUrl(details.url);
      if (url) this.onEvent({ type: 'open', id: entry.state.id, url });
      return { action: 'deny' };
    });
    // A renderer can set location itself; validate every top-level navigation, including redirects.
    const guard = (event: Electron.Event, url: string): void => {
      if (!directHttpUrl(url)) event.preventDefault();
    };
    contents.on('will-navigate', (event, url) => guard(event, url));
    contents.on('will-redirect', (event, url) => guard(event, url));
    contents.on('did-start-loading', () => {
      entry.state.loading = true;
      this.emit(entry);
    });
    contents.on('did-stop-loading', () => {
      entry.state.loading = false;
      this.updateHistory(entry);
      this.emit(entry);
    });
    const navigated = (_event: Electron.Event, url: string): void => {
      entry.state.url = url;
      entry.state.started = true;
      entry.state.error = null;
      entry.state.notice = null;
      this.updateHistory(entry);
      this.emit(entry);
    };
    contents.on('did-navigate', (_event, url) => navigated(_event, url));
    contents.on('did-navigate-in-page', (event, url, isMainFrame) => {
      if (isMainFrame) navigated(event, url);
    });
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        entry.state.loading = false;
        entry.state.error = { code: errorCode, description: errorDescription, url: validatedURL };
        this.updateHistory(entry);
        this.emit(entry);
      },
    );
    contents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      entry.state.title = title;
      this.emit(entry);
    });
    contents.on('render-process-gone', () => {
      entry.state.crashed = true;
      entry.state.loading = false;
      this.emit(entry);
    });
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Browser tab is not open');
    return entry;
  }

  list(): BrowserState[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.state }));
  }

  create(id: string): BrowserState {
    const existing = this.entries.get(id);
    if (existing) return { ...existing.state };
    if (this.entries.size >= MAX_BROWSER_TABS) throw new Error('Browser tab limit reached');
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition: BROWSER_PARTITION,
      },
    });
    const entry: Entry = {
      view,
      state: initialState(id),
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };
    this.entries.set(id, entry);
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.wire(entry);
    return { ...entry.state };
  }

  navigate(id: string, input: string): BrowserState {
    const entry = this.require(id);
    const url = directHttpUrl(input);
    if (!url) throw new Error('Unsupported browser URL');
    entry.state.notice = null;
    entry.state.error = null;
    entry.state.crashed = false;
    // A rejected loadURL is for a superseded or cancelled navigation; did-fail-load owns the error page.
    void entry.view.webContents.loadURL(url).catch(() => {});
    return { ...entry.state };
  }

  back(id: string): BrowserState {
    const entry = this.require(id);
    entry.view.webContents.navigationHistory.goBack();
    return { ...entry.state };
  }

  forward(id: string): BrowserState {
    const entry = this.require(id);
    entry.view.webContents.navigationHistory.goForward();
    return { ...entry.state };
  }

  reload(id: string): BrowserState {
    const entry = this.require(id);
    entry.state.error = null;
    entry.state.crashed = false;
    entry.view.webContents.reload();
    return { ...entry.state };
  }

  stop(id: string): BrowserState {
    const entry = this.require(id);
    entry.view.webContents.stop();
    return { ...entry.state };
  }

  focus(id: string): void {
    this.require(id).view.webContents.focus();
  }

  layout(id: string, bounds: BrowserBounds, visible: boolean): void {
    if (this.window.isDestroyed()) return;
    const entry = this.require(id);
    const size = this.window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    const next = finiteBounds(bounds);
    entry.bounds = {
      x: Math.min(next.x, Math.max(0, width - 1)),
      y: Math.min(next.y, Math.max(0, height - 1)),
      width: Math.min(next.width, width),
      height: Math.min(next.height, height),
    };
    entry.visible = visible && this.window.isVisible() && !this.window.isMinimized();
    entry.view.setBounds(entry.bounds);
    entry.view.setVisible(entry.visible);
  }

  async openExternal(id: string, input: string): Promise<void> {
    this.require(id);
    const url = directHttpUrl(input);
    if (!url) throw new Error('Unsupported browser URL');
    await shell.openExternal(url);
  }

  destroy(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
  }

  hideAll(): void {
    for (const entry of this.entries.values()) entry.view.setVisible(false);
  }

  /** The window is visible again: the renderer re-measures and sends the current layout. */
  requestLayout(): void {
    if (!this.disposed) this.onEvent({ type: 'layout-request' });
  }

  destroyAll(): void {
    for (const id of [...this.entries.keys()]) this.destroy(id);
    this.disposed = true;
  }

  handle(command: BrowserCommand): BrowserReply {
    switch (command.type) {
      case 'list':
        return { ok: true, states: this.list() };
      case 'create':
        return { ok: true, state: this.create(command.id) };
      case 'navigate':
        return { ok: true, state: this.navigate(command.id, command.url) };
      case 'back':
        return { ok: true, state: this.back(command.id) };
      case 'forward':
        return { ok: true, state: this.forward(command.id) };
      case 'reload':
        return { ok: true, state: this.reload(command.id) };
      case 'stop':
        return { ok: true, state: this.stop(command.id) };
      case 'focus':
        this.focus(command.id);
        return { ok: true };
      case 'layout':
        this.layout(command.id, command.bounds, command.visible);
        return { ok: true };
      case 'open-external':
        void this.openExternal(command.id, command.url);
        return { ok: true };
      case 'destroy':
        this.destroy(command.id);
        return { ok: true };
    }
  }
}
