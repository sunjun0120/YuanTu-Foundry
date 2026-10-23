/**
 * The workspace tree's directory reads: what a *failed* one shows, and which answer is allowed to win.
 *
 * `files.list` has two failure shapes and the panel only ever understood one of them. A refusal came back as
 * `{ok:false}` and was drawn ("why a directory could not be read, kept apart from still reading"). A **rejected
 * promise** — `ipcRenderer.invoke` rejects when the main-process handler throws or the channel is gone — was
 * never caught: `void loadDirectory(path)` dropped the rejection on the floor and left the directory on the
 * panel's "正在读取…" note for as long as the window lived, with nothing said and nothing to click.
 *
 * The other half is identity. A listing is written into the cache under the path it was asked for, so the
 * workspace counter and the refresh round are what keep a superseded answer out — but two reads of the *same*
 * directory can be in flight at once (expand, collapse, expand again while the first is unanswered), and the
 * older one used to overwrite the newer one on arrival.
 *
 * `tests/desktop.smoke.mjs` drives `dist/desktop/renderer.js`, which was built before this source and is not
 * rebuilt in this batch, so the real `setupWorkspace` is driven here over a hand-written document — the same
 * approach `tests/task-confirm-selection.test.ts` uses. Pointer, drag and pixel behaviour stays with the smoke.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FilesCommand, FilesReply } from '../apps/desktop/files-contract.ts';
import type { WorkspaceEntry, WorkspaceListing } from '../packages/protocol/rpc.ts';
import { setLocale } from '../apps/desktop/i18n.ts';
import { setupWorkspace } from '../apps/desktop/renderer-workspace.ts';

/** One element: the properties, attributes and listeners this module actually touches. */
class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly styleValues: Record<string, string> = {};
  readonly style = {
    setProperty: (name: string, value: string) => {
      this.styleValues[name] = value;
    },
  };
  private readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();
  parent: FakeNode | null = null;
  textContent = '';
  className = '';
  hidden = false;
  disabled = false;
  inert = false;
  id = '';
  title = '';
  tabIndex = 0;
  type = '';
  value = '';
  src = '';
  alt = '';
  scrollTop = 0;
  namespaceURI = '';
  readonly nodeType = 1;
  get classList() {
    return {
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name);
        else this.classes.delete(name);
        return on;
      },
      add: (name: string) => void this.classes.add(name),
      remove: (name: string) => void this.classes.delete(name),
      contains: (name: string) => this.classes.has(name),
    };
  }
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) node.parent = this;
    this.children.push(...nodes);
  }
  prepend(...nodes: FakeNode[]): void {
    for (const node of nodes) node.parent = this;
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...nodes);
  }
  contains(node: unknown): boolean {
    return node === this || this.descendants().includes(node as FakeNode);
  }
  /** Every descendant, in document order. */
  descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.descendants().filter((node) => matchesSelector(node, selector));
  }
  closest(selector: string): FakeNode | null {
    let node: FakeNode | null = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
  }
  addEventListener(type: string, listener: (event?: unknown) => unknown): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  /** Dispatch as the page does, and hand back what the listener returned so a rejection stays observable. */
  fire(type: string, event?: unknown): Promise<unknown> {
    const listeners = this.listeners.get(type) ?? [];
    return Promise.resolve(listeners[0]?.(event));
  }
  focus(): void {}
  scrollIntoView(): void {}
  getBoundingClientRect(): { width: number; height: number; right: number; bottom: number } {
    return { width: 400, height: 20, right: 400, bottom: 20 };
  }
  hasPointerCapture(): boolean {
    return false;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
}
/** The selector surface the module uses: `[name="value"]` pairs and class names, together. */
function matchesSelector(node: FakeNode, selector: string): boolean {
  const parts = selector.match(/\[[\w-]+="[^"]*"\]|\.[\w-]+/g);
  if (!parts) return false;
  return parts.every((part) => {
    // Both spellings of a class: `className` as the module writes it, and `classList` where it toggles one.
    if (part.startsWith('.'))
      return node.className.split(/\s+/).includes(part.slice(1)) || node.classes.has(part.slice(1));
    const match = /\[([\w-]+)="([^"]*)"\]/.exec(part)!;
    return node.getAttribute(match[1]!) === match[2];
  });
}
class FakeDocument {
  readonly nodeType = 9;
  readonly documentElement = new FakeNode('html');
  readonly body = new FakeNode('body');
  activeElement: FakeNode | null = null;
  private readonly ids = new Map<string, FakeNode>();
  constructor(ids: Map<string, FakeNode>) {
    this.ids = ids;
  }
  createElement(tag: string): FakeNode {
    return new FakeNode(tag);
  }
  createElementNS(namespaceURI: string, tag: string): FakeNode {
    const node = new FakeNode(tag);
    node.namespaceURI = namespaceURI;
    return node;
  }
  getElementById(id: string): FakeNode | null {
    return this.ids.get(id) ?? null;
  }
  addEventListener(): void {}
  createTreeWalker(): { nextNode: () => null } {
    return { nextNode: () => null };
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
}
/** The ids `index.html` gives the workspace panel, and nothing besides. */
function workspacePage(): {
  document: FakeDocument;
  tree: FakeNode;
  toggle: FakeNode;
  refresh: FakeNode;
} {
  const ids = new Map<string, FakeNode>();
  const create = (id: string, tag = 'div'): FakeNode => {
    const node = new FakeNode(tag);
    ids.set(id, node);
    return node;
  };
  create('workspace-panel');
  create('workspace-location');
  const tree = create('workspace-tree');
  create('workspace-preview');
  create('workspace-preview-body');
  const toggle = create('open-workspace', 'button');
  const refresh = create('workspace-refresh', 'button');
  create('workspace-close', 'button');
  create('workspace-fullscreen', 'button');
  create('workspace-resize');
  create('workspace-tabs');
  create('workspace-tooltip');
  create('chat-page');
  create('chat-sidebar');
  return { document: new FakeDocument(ids), tree, toggle, refresh };
}
interface PendingRequest {
  command: FilesCommand;
  path: string;
  resolve: (reply: FilesReply) => void;
  reject: (error: Error) => void;
}
/** The Host half: directory answers the test decides, held until it says so. */
class FakeHost {
  readonly requests: PendingRequest[] = [];
  readonly directories = new Map<string, string[]>();
  readonly refusals = new Map<string, string>();
  /** When set, an answer waits for `resolve`/`reject`; otherwise it arrives immediately. */
  deferred = false;
  entry(name: string): WorkspaceEntry {
    const clean = name.replace(/\/$/, '');
    return { name: clean, path: clean, kind: name.endsWith('/') ? 'directory' : 'file' };
  }
  replyFor(path: string): FilesReply {
    const refusal = this.refusals.get(path);
    if (refusal !== undefined) return { ok: false, error: refusal };
    const entries = (this.directories.get(path) ?? []).map((name) => this.entry(name));
    const listing: WorkspaceListing = { path, entries, truncated: false };
    return { ok: true, listing };
  }
  readonly files = (command: FilesCommand): Promise<FilesReply> => {
    const path = command.path ?? '';
    const promise = new Promise<FilesReply>((resolve, reject) => {
      this.requests.push({ command, path, resolve, reject });
      if (!this.deferred) resolve(this.replyFor(path));
    });
    return promise;
  };
  readonly invoke = (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true });
  get window(): Record<string, unknown> {
    return {
      innerWidth: 1400,
      innerHeight: 900,
      addEventListener: () => {},
      yuantu: { files: this.files, invoke: this.invoke },
    };
  }
}
function installDom(document_: FakeDocument, window_: unknown): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    document: globals.document,
    window: globals.window,
    Node: globals.Node,
    NodeFilter: globals.NodeFilter,
    Element: globals.Element,
    HTMLElement: globals.HTMLElement,
    HTMLButtonElement: globals.HTMLButtonElement,
    MutationObserver: globals.MutationObserver,
    CSS: globals.CSS,
  };
  globals.document = document_;
  globals.window = window_;
  globals.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_NODE: 9 };
  globals.NodeFilter = { SHOW_TEXT: 4 };
  globals.Element = FakeNode;
  globals.HTMLElement = FakeNode;
  globals.HTMLButtonElement = FakeNode;
  // i18n installs a document walker for the language changes it observes; this double is not a document to walk.
  globals.MutationObserver = class {
    observe(): void {}
  };
  globals.CSS = { escape: (value: string) => value };
  return () => Object.assign(globals, previous);
}
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
/** Every piece of text under a node, in document order — what a person reading the panel sees. */
function textOf(node: FakeNode): string {
  return [node.textContent, ...node.children.map(textOf)].join(' ');
}
/** The tree's row for one entry, as the module drew it. */
function entryButton(tree: FakeNode, name: string): FakeNode {
  const button = tree
    .querySelectorAll('.workspace-entry-button')
    .find((candidate) => textOf(candidate).includes(name));
  assert.ok(button, `the tree has a row for ${name}: ${textOf(tree)}`);
  return button;
}
function open(
  t: test.TestContext,
  page: ReturnType<typeof workspacePage>,
  host: FakeHost,
): ReturnType<typeof setupWorkspace> {
  const restore = installDom(page.document, host.window);
  t.after(restore);
  setLocale('zh-CN');
  return setupWorkspace();
}

test('a rejected directory read is shown, and the directory can be read again', async (t) => {
  // The rejection is the whole point: `void loadDirectory(path)` used to drop it, so what the panel showed was a
  // directory that was permanently "正在读取…" and a rejection nobody ever saw.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const page = workspacePage();
  const host = new FakeHost();
  host.directories.set('', ['src/']);
  host.deferred = true;
  open(t, page, host);
  void page.toggle.fire('click');
  await flush();
  assert.equal(host.requests.length, 1, 'opening the panel asks for the root');
  host.requests[0]!.reject(new Error('IPC 通道中断'));
  // One microtask, not a flushed tick: the panel's own answer to the rejection is what is asserted here, and it
  // lands in the same turn the rejection propagates in — before the window could report it as unhandled.
  await Promise.resolve();
  const failed = textOf(page.tree);
  assert.match(failed, /IPC 通道中断/, 'the failure reaches the person looking at the tree');
  assert.doesNotMatch(failed, /正在读取/, 'a read that failed is not still reading');
  await flush();
  assert.deepEqual(
    unhandled,
    [],
    'the page answered the rejection instead of leaving it to the window',
  );
  // Retry, the way a person would: the refresh button re-reads every open directory.
  host.deferred = false;
  void page.refresh.fire('click');
  await flush();
  assert.match(textOf(page.tree), /src/, 'the retry shows what is there');
  assert.doesNotMatch(textOf(page.tree), /IPC 通道中断/, 'and the failure is gone');
});

test('a refusal and a rejection are reported through the same note', async (t) => {
  const page = workspacePage();
  const host = new FakeHost();
  host.refusals.set('', '目录不可读');
  open(t, page, host);
  void page.toggle.fire('click');
  await flush();
  // The refusal path is the one that always worked; the rejection above is drawn in exactly the same place, so
  // the two failure shapes cannot be told apart by where they appear.
  assert.match(textOf(page.tree), /目录不可读/);
});

test('an older answer for the same directory cannot overwrite a newer one', async (t) => {
  const page = workspacePage();
  const host = new FakeHost();
  host.directories.set('', ['sub/']);
  host.directories.set('sub', ['stale.txt']);
  host.deferred = true;
  open(t, page, host);
  void page.toggle.fire('click');
  await flush();
  host.requests[0]!.resolve(host.replyFor(''));
  await flush();
  // Expand, collapse, expand again while the first read is still unanswered: two requests for one directory.
  void entryButton(page.tree, 'sub').fire('click');
  await flush();
  void entryButton(page.tree, 'sub').fire('click');
  await flush();
  void entryButton(page.tree, 'sub').fire('click');
  await flush();
  assert.deepEqual(
    host.requests.map((request) => request.path),
    ['', 'sub', 'sub'],
  );
  // The directory gained a file between the two reads. The newer answer arrives first, and the older one — which
  // describes a state that no longer exists — arrives late and must not win.
  host.directories.set('sub', ['new.txt']);
  host.requests[2]!.resolve(host.replyFor('sub'));
  await flush();
  host.requests[1]!.resolve({
    ok: true,
    listing: { path: 'sub', entries: [host.entry('stale.txt')], truncated: false },
  });
  await flush();
  const text = textOf(page.tree);
  assert.match(text, /new\.txt/);
  assert.doesNotMatch(text, /stale\.txt/, 'the superseded answer is dropped, not written last');
});

test('answers for two directories may arrive in any order', async (t) => {
  const page = workspacePage();
  const host = new FakeHost();
  host.directories.set('', ['a/', 'b/']);
  host.directories.set('a', ['a1.txt']);
  host.directories.set('b', ['b1.txt']);
  host.deferred = true;
  open(t, page, host);
  void page.toggle.fire('click');
  await flush();
  host.requests[0]!.resolve(host.replyFor(''));
  await flush();
  void entryButton(page.tree, 'a').fire('click');
  await flush();
  void entryButton(page.tree, 'b').fire('click');
  await flush();
  // B answers before A, which is the ordinary case for two Host round trips; each is written under its own path.
  host.requests[2]!.resolve(host.replyFor('b'));
  await flush();
  host.requests[1]!.resolve(host.replyFor('a'));
  await flush();
  const text = textOf(page.tree);
  assert.match(text, /a1\.txt/);
  assert.match(text, /b1\.txt/);
});

test('being told the same workspace again neither re-reads nor clears the tree', async (t) => {
  // The panel is told one thing — the workspace path — and nothing else: `FilesCommand` carries no session, and
  // `renderer.ts` calls `update(context.workspace)` every frame. So a second call with the same path is a
  // no-op by design, and there is no session-scoped state here that a session switch could invalidate: the
  // listing, the open tabs and the expanded rows are all facts about a directory in one workspace.
  const page = workspacePage();
  const host = new FakeHost();
  host.directories.set('', ['a.txt']);
  const view = open(t, page, host);
  void page.toggle.fire('click');
  await flush();
  assert.equal(host.requests.length, 1);
  assert.match(textOf(page.tree), /a\.txt/);
  view.update('');
  await flush();
  assert.equal(host.requests.length, 1, 'the same workspace is not re-read');
  assert.match(textOf(page.tree), /a\.txt/, 'and what is already drawn stays drawn');
});

test('an answer that arrives after a refresh or a workspace change is dropped', async (t) => {
  const page = workspacePage();
  const host = new FakeHost();
  host.directories.set('', ['before.txt']);
  host.deferred = true;
  const view = open(t, page, host);
  void page.toggle.fire('click');
  await flush();
  // A refresh invalidates the round: the answer that was in flight describes a tree that is being replaced.
  void page.refresh.fire('click');
  await flush();
  host.requests[0]!.resolve(host.replyFor(''));
  await flush();
  assert.doesNotMatch(textOf(page.tree), /before\.txt/, 'a superseded round is not written');
  // A different workspace is the other identity, and the request still in flight belongs to the project that is
  // gone: the panel is told the workspace path and nothing else, so that path is what "belongs to" means here.
  const oldWorkspace = host.requests[1]!;
  view.update('/other');
  await flush();
  const newWorkspace = host.requests[2]!;
  host.directories.set('', ['after.txt']);
  newWorkspace.resolve(host.replyFor(''));
  await flush();
  assert.match(textOf(page.tree), /after\.txt/, 'the new workspace is read');
  oldWorkspace.resolve({
    ok: true,
    listing: { path: '', entries: [host.entry('stale.txt')], truncated: false },
  });
  await flush();
  assert.doesNotMatch(
    textOf(page.tree),
    /stale\.txt/,
    'the previous workspace’s answer is not written under the new one',
  );
});
