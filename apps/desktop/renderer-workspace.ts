import type {
  WorkspaceEntry,
  WorkspaceListing,
  WorkspacePreview,
} from '../../packages/protocol/rpc.ts';
import { FILE_PREVIEW_BYTES } from '../../packages/protocol/rpc.ts';
import { MAX_IMAGE_BYTES } from '../../packages/protocol/images.ts';
import { onLocaleChange, t } from './i18n.ts';
import { renderMarkdown } from './markdown.ts';
import { workspaceIcon } from './workspace-icons.ts';

/**
 * The read-only workspace panel.
 *
 * The conversation says what the agent is doing; this says *where* it is doing it. A file tree and a preview
 * are two views of one workspace, and both are answered by the Host rather than read here: `files.list` and
 * `files.read` go through the same `Workspace` containment rule the model's own tools run under, so the tree
 * can only ever offer a path the agent could open and the preview can only read one it could read. A reader
 * in this process would be a second copy of that rule on the wrong side of the trust boundary.
 *
 * Nothing here writes: selecting a row reads a file, and there is no verb in this module that changes the
 * workspace.
 */
export function setupWorkspace() {
  function required<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing element: ${id}`);
    return value as T;
  }
  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = '',
    className = '',
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  }
  const panel = required('workspace-panel');
  const location = required('workspace-location');
  const tree = required('workspace-tree');
  const preview = required('workspace-preview');
  const previewBody = required('workspace-preview-body');
  const toggle = required<HTMLButtonElement>('open-workspace');
  const refreshButton = required<HTMLButtonElement>('workspace-refresh');
  const closeButton = required<HTMLButtonElement>('workspace-close');
  const fullscreenButton = required<HTMLButtonElement>('workspace-fullscreen');
  const resizeHandle = required('workspace-resize');
  const tabs = required('workspace-tabs');
  const tooltip = required('workspace-tooltip');
  /** One answer per directory, keyed by its workspace-relative path; `''` is the root. */
  const listings = new Map<string, WorkspaceListing>();
  /** Why a directory could not be read, kept apart from "still reading" — the two are different answers. */
  const failures = new Map<string, string>();
  /** The directories the reader has opened. The root is always open, so the panel is never blank. */
  const expanded = new Set<string>(['']);
  let workspace = '';
  /**
   * Which workspace every answer belongs to.
   *
   * Bumped on a workspace change and captured by each request, so an old workspace's answer cannot appear
   * under the new project's name. Listing refresh rounds and individual file tokens are tracked separately.
   */
  let generation = 0;
  /**
   * Which refresh every listing belongs to.
   *
   * Kept apart from `generation` because a refresh invalidates the tree and not the open file: bumping the
   * workspace counter here would also abandon a preview read in flight, leaving that pane on "reading" for a
   * file nobody is waiting for any more.
   */
  let listingRound = 0;
  let open = false;
  let fullscreen = false;
  let selected: string | null = null;
  interface FileTab {
    path: string;
    shown: WorkspacePreview | null;
    error: string | null;
    reading: boolean;
    token: number;
    scrollTop: number;
  }
  const files = new Map<string, FileTab>();
  let width = Math.min(560, window.innerWidth * 0.42);
  let treeScroll = 0;

  function hint(button: HTMLElement, label: string): void {
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = label;
  }
  function widthLimits(): { min: number; max: number } {
    const available =
      window.innerWidth <= 1000 ? window.innerWidth - 24 : window.innerWidth - 272 - 320;
    return { min: Math.min(320, Math.max(0, available)), max: Math.max(0, available) };
  }
  function paintWidth(): void {
    const { min, max } = widthLimits();
    const actual = Math.round(Math.min(max, Math.max(min, width)));
    document.body.style.setProperty('--workspace-width', `${actual}px`);
    resizeHandle.setAttribute('aria-valuemin', String(Math.round(min)));
    resizeHandle.setAttribute('aria-valuemax', String(Math.round(max)));
    resizeHandle.setAttribute('aria-valuenow', String(actual));
  }

  const markdownActions = {
    async copy(text: string) {
      const reply = await window.yuantu.invoke({ type: 'copyText', text });
      if (!reply.ok) throw new Error(reply.error);
    },
    async open(url: string) {
      const reply = await window.yuantu.invoke({ type: 'openLink', url });
      if (!reply.ok) throw new Error(reply.error);
    },
  };

  function paintLayout(): void {
    panel.hidden = !open;
    document.body.dataset.workspaceView = !open ? 'closed' : fullscreen ? 'fullscreen' : 'open';
    toggle.setAttribute('aria-expanded', String(open));
    fullscreenButton.setAttribute('aria-pressed', String(fullscreen));
    hint(
      fullscreenButton,
      t(fullscreen ? 'workspace.exitFullscreen' : 'workspace.fullscreenTitle'),
    );
    fullscreenButton.replaceChildren(workspaceIcon(fullscreen ? 'restore' : 'fullscreen'));
    resizeHandle.hidden = fullscreen;
    tooltip.hidden = true;
    paintWidth();
    // The chat stays mounted and keeps its running state and scroll position. It cannot take keyboard
    // focus while the reading surface covers the window.
    required('chat-page').inert = fullscreen;
    required('chat-sidebar').inert = fullscreen;
    if (fullscreen) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
    }
  }
  function setFullscreen(next: boolean): void {
    fullscreen = open && next;
    paintLayout();
    fullscreenButton.focus();
  }
  function paintLocation(): void {
    const separator = workspace.includes('\\') ? '\\' : '/';
    const path =
      selected && workspace
        ? `${workspace.replace(/[\\/]$/, '')}${separator}${selected.replaceAll('/', separator)}`
        : (selected ?? workspace);
    location.textContent = path;
    location.title = path;
    location.setAttribute('aria-label', t('workspace.pathLabel'));
  }

  function bytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  function fileName(path: string): string {
    return path.split('/').pop() || path;
  }
  function unsupported(reason: WorkspacePreview['reason']): string {
    if (reason === 'too-large')
      return t('workspace.unsupported.too-large', { limit: bytes(MAX_IMAGE_BYTES) });
    if (reason === 'not-a-file') return t('workspace.unsupported.not-a-file');
    if (reason === 'binary') return t('workspace.unsupported.binary');
    // A reason this build does not know still has to say something true: the Host said the file cannot be
    // shown, and guessing *why* would be this side inventing a fact about the bytes.
    return t('workspace.unsupported.other');
  }

  /**
   * The rows of one directory, or the reason there are none yet.
   *
   * A directory that is expanded but not yet loaded renders as a note rather than as an empty list: "正在读取"
   * and "空目录" are different answers about the workspace, and a tree that showed the second for the first
   * would be reporting a folder as empty while it was still being read.
   */
  function listNode(path: string): HTMLElement {
    const list = element('ul', '', 'workspace-list');
    const listing = listings.get(path);
    if (!listing) {
      list.append(element('li', failures.get(path) ?? t('workspace.loading'), 'workspace-note'));
      return list;
    }
    if (!listing.entries.length) {
      list.append(element('li', t('workspace.emptyDirectory'), 'workspace-note'));
      return list;
    }
    for (const entry of listing.entries) {
      const item = element('li', '', 'workspace-entry');
      item.append(entryButton(entry));
      if (entry.kind === 'directory' && expanded.has(entry.path)) item.append(listNode(entry.path));
      list.append(item);
    }
    if (listing.truncated)
      list.append(
        element(
          'li',
          t('workspace.truncated', { count: listing.entries.length }),
          'workspace-note',
        ),
      );
    return list;
  }
  function entryButton(entry: WorkspaceEntry): HTMLButtonElement {
    const button = element('button', '', 'workspace-entry-button');
    button.type = 'button';
    const glyph = element('span', '', 'workspace-entry-glyph');
    glyph.append(
      workspaceIcon(
        entry.kind === 'directory'
          ? expanded.has(entry.path)
            ? 'folder-open'
            : 'folder'
          : /\.(?:md|markdown|mdown)$/i.test(entry.path)
            ? 'markdown'
            : 'file',
      ),
    );
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph, element('span', entry.name, 'workspace-entry-name'));
    // The full relative path, because the tree elides the directories above it and a tooltip is the only
    // place a reader can see where a file actually is.
    button.title = entry.path;
    if (entry.kind === 'directory') {
      button.setAttribute('aria-expanded', String(expanded.has(entry.path)));
      button.addEventListener('click', () => toggleDirectory(entry.path));
    } else {
      // The row being previewed says so, so the tree and the preview pane cannot disagree about which file
      // is on screen.
      button.setAttribute('aria-current', String(selected === entry.path));
      button.addEventListener('click', () => void showFile(entry.path));
    }
    return button;
  }
  function paintTree(): void {
    const scroll = tree.scrollTop;
    tree.replaceChildren(listNode(''));
    tree.scrollTop = scroll;
  }

  function paintStatic(): void {
    panel.setAttribute('aria-label', t('workspace.title'));
    toggle.replaceChildren(workspaceIcon('expand'));
    hint(toggle, t('workspace.openTitle'));
    refreshButton.replaceChildren(workspaceIcon('refresh'));
    hint(refreshButton, t('workspace.refreshTitle'));
    closeButton.replaceChildren(workspaceIcon('collapse'));
    hint(closeButton, t('workspace.closeTitle'));
    resizeHandle.setAttribute('aria-label', t('workspace.resize'));
    tabs.setAttribute('aria-label', t('workspace.tabs'));
    tree.setAttribute('aria-label', t('workspace.treeLabel'));
    preview.setAttribute('aria-label', t('workspace.imageAlt'));
    paintLocation();
    paintLayout();
    paintTabs();
  }

  function paintTabs(): void {
    const treeTab = element('button', '', 'workspace-tab');
    treeTab.type = 'button';
    treeTab.id = 'workspace-tree-tab';
    treeTab.setAttribute('role', 'tab');
    treeTab.setAttribute('aria-controls', 'workspace-tree');
    treeTab.setAttribute('aria-selected', String(selected === null));
    treeTab.tabIndex = selected === null ? 0 : -1;
    treeTab.append(workspaceIcon('folder'), element('span', t('workspace.open')));
    treeTab.addEventListener('click', backToTree);
    const nodes: HTMLElement[] = [treeTab];
    for (const file of files.values()) {
      const item = element('div', '', 'workspace-file-tab');
      item.dataset.path = file.path;
      item.classList.toggle('active', selected === file.path);
      const button = element('button', '', 'workspace-tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', 'workspace-preview');
      button.setAttribute('aria-selected', String(selected === file.path));
      button.tabIndex = selected === file.path ? 0 : -1;
      button.title = file.path;
      button.append(
        workspaceIcon(/\.(?:md|markdown|mdown)$/i.test(file.path) ? 'markdown' : 'file'),
        element('span', fileName(file.path)),
      );
      button.addEventListener('click', () => activate(file.path, true));
      const close = element('button', '', 'workspace-tab-close');
      close.type = 'button';
      hint(close, t('workspace.closeTab', { name: fileName(file.path) }));
      close.append(workspaceIcon('close'));
      close.addEventListener('click', () => closeTab(file.path));
      item.append(button, close);
      nodes.push(item);
    }
    // Replacing the strip should not silently drop focus from a toolbar control.
    const focusedTab = tabs.contains(document.activeElement);
    tabs.replaceChildren(...nodes);
    if (focusedTab) focusTab();
    const current = tabs.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    (current?.closest('.workspace-file-tab') ?? current)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }
  function focusTab(): void {
    const button = tabs.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function savePosition(): void {
    const file = selected === null ? undefined : files.get(selected);
    if (file) file.scrollTop = previewBody.scrollTop;
    else if (selected === null) treeScroll = tree.scrollTop;
  }
  function activate(path: string | null, focus = false): void {
    savePosition();
    selected = path;
    paintTabs();
    paintPreview();
    paintTree();
    tree.scrollTop = treeScroll;
    if (path !== null) previewBody.scrollTop = files.get(path)?.scrollTop ?? 0;
    if (focus) focusTab();
  }
  function closeTab(path: string): void {
    const paths = [...files.keys()];
    const index = paths.indexOf(path);
    const wasActive = selected === path;
    savePosition();
    files.delete(path);
    if (wasActive) {
      activate(paths[index + 1] ?? paths[index - 1] ?? null, true);
    } else {
      paintTabs();
      focusTab();
    }
  }

  /**
   * The file on screen, or the honest reason there is none.
   *
   * Each of the three shapes the Host can answer with is painted as itself: decoded text for text, the bytes
   * as an image for an image, and a sentence naming the reason for everything else. Rendering unsupported
   * bytes as text is the failure this avoids — replacement characters look like a file's content.
   */
  function paintPreview(): void {
    const tab = selected === null ? undefined : files.get(selected);
    const shown = tab?.shown ?? null;
    const reading = tab?.reading ?? false;
    const readError = tab?.error ?? null;
    const active = selected !== null;
    preview.hidden = !active;
    tree.hidden = active;
    paintLocation();
    const markdown = shown?.kind === 'text' && /\.(?:md|markdown|mdown)$/i.test(selected ?? '');
    preview.setAttribute('aria-label', selected ?? t('workspace.imageAlt'));
    if (selected === null) return;
    if (reading && shown === null) {
      const status = element('p', t('workspace.previewing'), 'workspace-note');
      status.setAttribute('role', 'status');
      previewBody.replaceChildren(status);
      return;
    }
    if (readError !== null || shown === null) {
      // A reply that carried no preview is reported as a failure rather than left as an empty pane: an empty
      // pane reads as an empty file, which is a claim about the file rather than about the answer.
      previewBody.replaceChildren(
        element(
          'p',
          t('workspace.error', { message: readError ?? t('workspace.unsupported.other') }),
          'workspace-note',
        ),
      );
      return;
    }
    const file = shown;
    function showContent(content: HTMLElement): void {
      if (file.truncated && file.kind === 'text') {
        const note = element(
          'p',
          t('workspace.shownOfTotal', {
            shown: bytes(FILE_PREVIEW_BYTES),
            total: bytes(file.bytes),
          }),
          'workspace-note',
        );
        previewBody.replaceChildren(note, content);
      } else previewBody.replaceChildren(content);
    }
    if (file.kind === 'image' && file.data && file.mimeType) {
      const image = element('img', '', 'workspace-preview-image');
      // A data URL rather than a file:// path: the renderer has no filesystem access, and `img-src 'self'
      // data:` in the page's CSP is exactly the allowance this needs — `file:` is not.
      image.src = `data:${file.mimeType};base64,${file.data}`;
      image.alt = t('workspace.imageAlt');
      showContent(image);
      return;
    }
    if (file.kind === 'text') {
      const text = file.text ?? '';
      if (markdown && text) {
        // Metadata is not the document's first heading. The shared DOM renderer never executes
        // file-authored HTML or loads remote images.
        const body = text.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, '');
        const document = renderMarkdown(body, markdownActions);
        document.classList.add('workspace-preview-markdown');
        showContent(document);
        return;
      }
      showContent(
        text
          ? element('pre', text, 'workspace-preview-text')
          : element('p', t('workspace.emptyFile'), 'workspace-note'),
      );
      return;
    }
    previewBody.replaceChildren(
      element('p', unsupported(file.reason), 'workspace-note workspace-preview-unsupported'),
    );
  }

  /**
   * Read one directory and paint what it holds.
   *
   * The answer is dropped when the workspace or the generation moved on while it was in flight; a listing
   * that arrived late would otherwise be added to the cache under a path that now means something else.
   */
  async function loadDirectory(path: string): Promise<void> {
    const at = generation;
    const round = listingRound;
    const reply = await window.yuantu.files(path ? { type: 'list', path } : { type: 'list' });
    if (at !== generation || round !== listingRound) return;
    if (reply.ok && 'listing' in reply) {
      listings.set(path, reply.listing);
      failures.delete(path);
    } else if (!reply.ok) {
      failures.set(path, reply.error);
    }
    if (open) paintTree();
  }
  function toggleDirectory(path: string): void {
    if (expanded.delete(path)) {
      paintTree();
      return;
    }
    expanded.add(path);
    paintTree();
    if (!listings.has(path)) void loadDirectory(path);
  }
  async function showFile(path: string): Promise<void> {
    const fromTree = tree.contains(document.activeElement);
    let file = files.get(path);
    const fresh = !file;
    if (!file) {
      file = {
        path,
        shown: null,
        error: null,
        reading: false,
        token: 0,
        scrollTop: 0,
      };
      files.set(path, file);
    }
    activate(path);
    if (fromTree) focusTab();
    if (fresh) await readFileTab(file);
  }
  async function readFileTab(file: FileTab): Promise<void> {
    const token = ++file.token;
    const at = generation;
    file.reading = true;
    file.error = null;
    // Retain the current document during refresh, including scroll position.
    if (selected === file.path && !file.shown) paintPreview();
    try {
      const reply = await window.yuantu.files({ type: 'read', path: file.path });
      // Identity matters: closing and reopening the same path creates a different tab.
      if (at !== generation || files.get(file.path) !== file || token !== file.token) return;
      file.shown = reply.ok && 'preview' in reply ? reply.preview : null;
      file.error = reply.ok ? null : reply.error;
    } catch (error) {
      if (at !== generation || files.get(file.path) !== file || token !== file.token) return;
      file.shown = null;
      file.error = error instanceof Error ? error.message : String(error);
    }
    file.reading = false;
    if (selected === file.path) {
      savePosition();
      paintPreview();
      previewBody.scrollTop = file.scrollTop;
    }
  }
  function backToTree(): void {
    const previous = selected;
    activate(null);
    // Back to the row the reader came from, so the tree does not silently start again from the top for
    // someone navigating by keyboard. It is repainted rather than reused, so the row is looked up by path.
    const row = previous
      ? tree.querySelector<HTMLButtonElement>(
          `.workspace-entry-button[title="${CSS.escape(previous)}"]`,
        )
      : null;
    (row ?? tree).focus();
  }
  function setOpen(next: boolean): void {
    endDrag();
    open = next;
    if (!open) fullscreen = false;
    paintLayout();
    if (open && !listings.has('')) void loadDirectory('');
  }
  /**
   * Re-read the tree, keeping the reader where they were.
   *
   * Every open directory is re-read rather than only the root: the panel exists to show what the agent just
   * wrote, and a refresh that collapsed the tree would make the reader walk back down to the same file.
   */
  function refresh(): void {
    listingRound++;
    listings.clear();
    failures.clear();
    paintTree();
    if (open) for (const path of expanded) void loadDirectory(path);
    // The open preview is re-read as well: the tree is most often refreshed to see what the agent just wrote,
    // and a pane left on the previous bytes would show stale content that looks current.
    savePosition();
    for (const file of files.values()) void readFileTab(file);
  }

  toggle.addEventListener('click', () => setOpen(!open));
  closeButton.addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  refreshButton.addEventListener('click', refresh);
  fullscreenButton.addEventListener('click', () => setFullscreen(!fullscreen));
  tabs.addEventListener('keydown', (event) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab')
      return;
    const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'Delete' && selected !== null) {
      event.preventDefault();
      closeTab(selected);
      return;
    } else return;
    event.preventDefault();
    buttons[next]?.click();
    focusTab();
  });
  let drag: { id: number; x: number; width: number } | null = null;
  function endDrag(): void {
    if (!drag) return;
    const id = drag.id;
    drag = null;
    document.body.classList.remove('workspace-resizing');
    if (resizeHandle.hasPointerCapture(id)) resizeHandle.releasePointerCapture(id);
  }
  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || fullscreen) return;
    event.preventDefault();
    width = panel.getBoundingClientRect().width;
    drag = { id: event.pointerId, x: event.clientX, width };
    resizeHandle.setPointerCapture(event.pointerId);
    document.body.classList.add('workspace-resizing');
    paintLayout();
    resizeHandle.focus();
  });
  resizeHandle.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const { min, max } = widthLimits();
    width = Math.min(max, Math.max(min, drag.width + drag.x - event.clientX));
    paintWidth();
  });
  resizeHandle.addEventListener('pointerup', endDrag);
  resizeHandle.addEventListener('pointercancel', endDrag);
  resizeHandle.addEventListener('lostpointercapture', endDrag);
  resizeHandle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = widthLimits();
    const actual = panel.getBoundingClientRect().width;
    width =
      event.key === 'Home'
        ? min
        : event.key === 'End'
          ? max
          : Math.min(max, Math.max(min, actual + (event.key === 'ArrowLeft' ? 24 : -24)));
    paintLayout();
  });
  window.addEventListener('resize', () => {
    endDrag();
    paintWidth();
    tooltip.hidden = true;
  });
  window.addEventListener('blur', endDrag);
  function showHint(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    const control = target.closest<HTMLElement>('[data-tooltip]');
    if (!control || (control instanceof HTMLButtonElement && control.disabled)) return;
    tooltip.textContent = control.dataset.tooltip ?? '';
    tooltip.hidden = false;
    const bounds = control.getBoundingClientRect();
    const size = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - size.width - 8, bounds.right - size.width))}px`;
    tooltip.style.top = `${Math.min(window.innerHeight - size.height - 8, bounds.bottom + 8)}px`;
  }
  document.addEventListener('pointerover', (event) => showHint(event.target));
  document.addEventListener('focusin', (event) => showHint(event.target));
  document.addEventListener('pointerout', () => {
    tooltip.hidden = true;
  });
  document.addEventListener('focusout', () => {
    tooltip.hidden = true;
  });
  document.addEventListener('click', () => {
    tooltip.hidden = true;
  });
  document.addEventListener(
    'scroll',
    () => {
      tooltip.hidden = true;
    },
    true,
  );
  window.addEventListener('yuantu-settings-open', () => {
    if (fullscreen) {
      fullscreen = false;
      paintLayout();
    }
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Escape steps back rather than out: with a file open, closing the whole panel would throw away the tree
    // position the reader navigated to. Stopping here keeps the other Escape handlers (the statistics
    // popovers, the background popover) from acting on a key the panel has already answered.
    event.stopPropagation();
    event.preventDefault();
    if (fullscreen) setFullscreen(false);
    else if (selected !== null) backToTree();
    else {
      setOpen(false);
      toggle.focus();
    }
  });
  onLocaleChange(() => {
    savePosition();
    paintStatic();
    paintTree();
    paintPreview();
    if (selected !== null) previewBody.scrollTop = files.get(selected)?.scrollTop ?? 0;
  });
  paintStatic();
  paintTree();
  paintPreview();
  return {
    /**
     * Which workspace the panel is showing.
     *
     * A different workspace discards every cached listing, the open file and the expansion state: all of them
     * describe the directory that was replaced. The root is re-read immediately so an open panel does not sit
     * on the previous project's files.
     */
    update(next: string): void {
      if (next === workspace) return;
      workspace = next;
      generation++;
      listings.clear();
      failures.clear();
      expanded.clear();
      expanded.add('');
      selected = null;
      files.clear();
      treeScroll = 0;
      fullscreen = false;
      paintLayout();
      paintTree();
      paintPreview();
      paintTabs();
      if (open && workspace) void loadDirectory('');
    },
  };
}
