/**
 * The general settings form saves every change as it is made, and what a *failed* save does to it.
 *
 * A refusal (`{ok:false}`) is an ordinary reply on the ordinary path. A **rejected promise** is the other
 * failure — `ipcRenderer.invoke` rejects when the main-process handler throws or the channel is gone — and an
 * `await` on it that threw before anything reset the in-flight flag would swallow every later change for the
 * rest of the window's life. Either way the form must go back to what is persisted and say why.
 *
 * `tests/settings.smoke.mjs` cannot see any of this: it drives `dist/desktop/renderer.js`, which was built
 * before this source. So the real `setupGeneralSettings` is driven here over the smallest document its own
 * code paths name — the same approach `tests/task-confirm-selection.test.ts` uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../apps/desktop/i18n.ts';
import type {
  UiSettings,
  UiSettingsCommand,
  UiSettingsReply,
} from '../apps/desktop/ui-settings.ts';
import { setupGeneralSettings } from '../apps/desktop/renderer-general-settings.ts';

/** One element: the properties, attributes and listeners this page's code actually uses. */
class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly options: FakeNode[] = [];
  readonly classes = new Set<string>();
  private readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();
  private readonly registered = new Map<string, FakeNode[]>();
  textContent = '';
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  checked = false;
  id = '';
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
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
  /**
   * The first child, which one label of this form is written through (`labels[0].firstChild.textContent`).
   *
   * A real element's first child can be a text node; here it is the child that was appended, which is all the
   * code under test reads.
   */
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  /** The page's structure, declared once: the module looks these selectors up, so the double answers them. */
  register(selector: string, ...nodes: FakeNode[]): this {
    this.registered.set(selector, nodes);
    return this;
  }
  querySelector(selector: string): FakeNode | null {
    return this.registered.get(selector)?.[0] ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.registered.get(selector) ?? [];
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
  /**
   * Dispatch as the page does, and hand back what the listener returned.
   *
   * The handler under test is `async`, so its promise is the page's own rejection to handle: awaiting it here is
   * what keeps *this test* from turning the old defect into an unhandled rejection of its own.
   */
  fire(type: string, event?: unknown): Promise<unknown> {
    const listeners = this.listeners.get(type) ?? [];
    return Promise.resolve(listeners[0]?.(event));
  }
}
class FakeDocument {
  readonly nodeType = 9;
  readonly documentElement = new FakeNode('html');
  /** No body, so i18n's language walk does not install a MutationObserver over this double. */
  readonly body: FakeNode | null = null;
  private readonly ids: Map<string, FakeNode>;
  constructor(ids: Map<string, FakeNode>) {
    this.ids = ids;
  }
  createElement(tag: string): FakeNode {
    return new FakeNode(tag);
  }
  getElementById(id: string): FakeNode | null {
    return this.ids.get(id) ?? null;
  }
  createTreeWalker(): { nextNode: () => null } {
    return { nextNode: () => null };
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
}
/** The ids and structure `index.html` gives the general settings page, and nothing besides. */
function generalSettingsPage(): {
  document: FakeDocument;
  form: FakeNode;
  feedback: FakeNode;
  language: FakeNode;
  appearance: FakeNode;
  fontSize: FakeNode;
} {
  const ids = new Map<string, FakeNode>();
  const create = (id: string, tag = 'div'): FakeNode => {
    const node = new FakeNode(tag);
    ids.set(id, node);
    return node;
  };
  const page = create('settings-page');
  page.register('.settings-sidebar h1', new FakeNode('h1'));
  page.register('.settings-sidebar nav', new FakeNode('nav'));
  create('general-settings-title', 'h2');
  create('general-settings', 'button');
  const content = create('general-settings-content');
  content.register('.settings-page-header p', new FakeNode('p'));
  const form = create('general-settings-form', 'form');
  form.register(
    'label',
    ...[0, 1, 2].map(() => {
      const label = new FakeNode('label');
      label.append(new FakeNode('span'));
      return label;
    }),
  );
  form.register('small', new FakeNode('small'), new FakeNode('small'), new FakeNode('small'));
  const select = (id: string, count: number): FakeNode => {
    const node = create(id, 'select');
    for (let index = 0; index < count; index++) node.options.push(new FakeNode('option'));
    return node;
  };
  const language = select('ui-language', 2);
  const appearance = select('ui-appearance', 3);
  const fontSize = select('ui-font-size', 3);
  create('ui-notifications-title', 'span');
  create('ui-notifications', 'input');
  create('ui-notifications-note', 'small');
  const feedback = create('general-settings-feedback');
  return { document: new FakeDocument(ids), form, feedback, language, appearance, fontSize };
}
function installDom(document_: FakeDocument, window_: unknown): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    document: globals.document,
    window: globals.window,
    Node: globals.Node,
    NodeFilter: globals.NodeFilter,
    Element: globals.Element,
    MutationObserver: globals.MutationObserver,
  };
  globals.document = document_;
  globals.window = window_;
  globals.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_NODE: 9 };
  globals.NodeFilter = { SHOW_TEXT: 4 };
  globals.Element = FakeNode;
  globals.MutationObserver = class {
    observe(): void {}
  };
  return () => Object.assign(globals, previous);
}
/**
 * The main-process bridge this page talks to.
 *
 * `get` always answers with what was persisted; `save` answers with whatever the test queued, or — if nothing
 * was queued — with the settings it was handed, which is what a real save does.
 */
class FakeBridge {
  readonly saves: UiSettingsCommand[] = [];
  private readonly persisted: UiSettings = {
    language: 'zh-CN',
    appearance: 'system',
    fontSize: 'medium',
    notifications: true,
  };
  private queued: Promise<UiSettingsReply> | null = null;
  queue(reply: Promise<UiSettingsReply>): void {
    this.queued = reply;
  }
  readonly uiSettings = (command: UiSettingsCommand): Promise<UiSettingsReply> => {
    if (command.type === 'get')
      return Promise.resolve({ ok: true, kind: 'settings', settings: { ...this.persisted } });
    this.saves.push(command);
    const queued =
      this.queued ??
      Promise.resolve<UiSettingsReply>({ ok: true, kind: 'settings', settings: command.settings });
    this.queued = null;
    return queued;
  };
}
/** Let every promise the handler created settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
interface Page {
  feedback: FakeNode;
  appearance: FakeNode;
  bridge: FakeBridge;
}
function open(t: test.TestContext): Page {
  const page = generalSettingsPage();
  const bridge = new FakeBridge();
  const restore = installDom(page.document, { yuantu: { uiSettings: bridge.uiSettings } });
  t.after(restore);
  // After the document, not before: the module registers a locale listener, and a *previous* test's listener is
  // still registered here — `setLocale` with no document installed would reach it and read through `undefined`.
  setLocale('zh-CN');
  setupGeneralSettings();
  return { feedback: page.feedback, appearance: page.appearance, bridge };
}
/** Change one control, which saves it, and wait for the save to finish. */
async function change(page: Page, value: string): Promise<void> {
  page.appearance.value = value;
  await page.appearance.fire('change').catch(() => {});
  await flush();
}

test('a change saves itself without a save button', async (t) => {
  const page = open(t);
  await flush();
  assert.equal(page.bridge.saves.length, 0, 'loading the page saves nothing');
  await change(page, 'dark');
  assert.equal(page.bridge.saves.length, 1);
  assert.equal(
    page.bridge.saves[0]!.type === 'save' && page.bridge.saves[0]!.settings.appearance,
    'dark',
  );
  assert.equal(page.feedback.hidden, true, 'a successful save says nothing');
});

test('a save whose promise rejects reverts the form, and the next change still saves', async (t) => {
  const page = open(t);
  await flush();
  // The failure this case is about: the IPC call itself rejects rather than answering `{ok:false}`.
  page.bridge.queue(Promise.reject(new Error('IPC 通道中断')));
  await change(page, 'dark');
  assert.equal(page.appearance.value, 'system', 'the form shows what is stored, not the lost edit');
  assert.equal(page.appearance.disabled, false, 'the controls are not locked');
  assert.equal(page.feedback.hidden, false, 'the failure is said out loud');
  assert.equal(page.feedback.classList.contains('error'), true);
  assert.match(page.feedback.textContent, /IPC 通道中断/, 'the reason reaches the person');
  // The half that matters most: a later change really is saved.
  await change(page, 'dark');
  assert.equal(page.bridge.saves.length, 2, 'the second change reached the bridge');
  assert.equal(page.feedback.hidden, true, 'the error clears once a save succeeds');
  assert.equal(page.appearance.value, 'dark');
});

test('a refusal is a different failure: the ordinary reply path reverts too', async (t) => {
  const page = open(t);
  await flush();
  page.bridge.queue(Promise.resolve<UiSettingsReply>({ ok: false, error: '无效的通用设置' }));
  await change(page, 'light');
  assert.equal(page.feedback.textContent, '无效的通用设置');
  assert.equal(page.feedback.classList.contains('error'), true);
  assert.equal(page.appearance.value, 'system', 'the refused value is not left on screen');
  await change(page, 'dark');
  assert.equal(page.bridge.saves.length, 2, 'and it can be saved again');
});

test('a change made while a save is in flight is sent after it, not lost', async (t) => {
  const page = open(t);
  await flush();
  let answer!: (reply: UiSettingsReply) => void;
  page.bridge.queue(new Promise((resolve) => (answer = resolve)));
  page.appearance.value = 'light';
  const first = page.appearance.fire('change');
  page.appearance.value = 'dark';
  await page.appearance.fire('change');
  assert.equal(page.bridge.saves.length, 1, 'one save at a time');
  answer({
    ok: true,
    kind: 'settings',
    settings: { language: 'zh-CN', appearance: 'light', fontSize: 'medium', notifications: true },
  });
  await first;
  await flush();
  assert.equal(page.bridge.saves.length, 2);
  assert.equal(
    page.bridge.saves[1]!.type === 'save' && page.bridge.saves[1]!.settings.appearance,
    'dark',
  );
  assert.equal(page.appearance.value, 'dark', 'the newer edit stays on screen');
});
