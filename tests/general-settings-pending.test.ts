/**
 * The general settings form's save button, and what a *failed* save does to it.
 *
 * A refusal (`{ok:false}`) always released the form: it is an ordinary reply on the ordinary path. A **rejected
 * promise** is the other failure — `ipcRenderer.invoke` rejects when the main-process handler throws or the
 * channel is gone — and `await` on it threw out of the submit listener before anything reset `pending`. Every
 * control stayed disabled for the rest of the window's life, the button among them, with the word "正在保存…"
 * frozen beside them: the only way to save a setting was to restart the app.
 *
 * `tests/settings.smoke.mjs` cannot see any of this: it drives `dist/desktop/renderer.js`, which was built
 * before this source, and this batch does not build. So the real `setupGeneralSettings` is driven here over the
 * smallest document its own code paths name — the same approach `tests/task-confirm-selection.test.ts` uses.
 * The pointer-and-pixels half stays with the smoke.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t as text } from '../apps/desktop/i18n.ts';
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
  save: FakeNode;
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
  const feedback = create('general-settings-feedback');
  const save = create('general-settings-save', 'button');
  return { document: new FakeDocument(ids), form, save, feedback, language, appearance, fontSize };
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
  form: FakeNode;
  save: FakeNode;
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
  return {
    form: page.form,
    save: page.save,
    feedback: page.feedback,
    appearance: page.appearance,
    bridge,
  };
}
/** Fire the form's submit as a click on the save button does, and wait for the handler to finish. */
async function submit(page: Page): Promise<void> {
  await page.form.fire('submit', { preventDefault() {} }).catch(() => {});
  await flush();
}
/** Change one control, which is what makes the save button usable at all. */
function change(page: Page, value: string): void {
  page.appearance.value = value;
  void page.appearance.fire('change');
}

test('a save whose promise rejects releases the form, and the next attempt still saves', async (t) => {
  const page = open(t);
  await flush();
  assert.equal(page.save.disabled, true, 'nothing has changed yet, so there is nothing to save');
  change(page, 'dark');
  assert.equal(page.save.disabled, false, 'a change is saveable');
  // The failure this case is about: the IPC call itself rejects rather than answering `{ok:false}`.
  page.bridge.queue(Promise.reject(new Error('IPC 通道中断')));
  await submit(page);
  assert.equal(
    page.save.disabled,
    false,
    'a rejected save must leave the form usable: `pending` has to be released on every path',
  );
  assert.equal(
    page.appearance.disabled,
    false,
    'the controls are not locked by a save that never answered',
  );
  assert.equal(page.feedback.hidden, false, 'the failure is said out loud');
  assert.notEqual(
    page.feedback.textContent,
    text('general.saving'),
    'the form is not left claiming it is still saving',
  );
  assert.equal(page.feedback.classList.contains('error'), true);
  assert.match(
    page.feedback.textContent,
    /IPC 通道中断/,
    'the reason reaches the person who clicked',
  );
  // The half that matters most: the button really can save again.
  await submit(page);
  assert.equal(page.bridge.saves.length, 2, 'the second click reached the bridge');
  assert.equal(page.feedback.textContent, text('general.saved'));
  assert.equal(
    page.bridge.saves[1]!.type === 'save' && page.bridge.saves[1]!.settings.appearance,
    'dark',
  );
  assert.equal(page.save.disabled, true, 'the saved value is now what is persisted');
});

test('a refusal is a different failure: the ordinary reply path still releases the form', async (t) => {
  const page = open(t);
  await flush();
  change(page, 'light');
  // `{ok:false}` is a resolved answer, so this path was never the broken one; it is here so the two cannot be
  // confused for each other or for the rejection above.
  page.bridge.queue(Promise.resolve<UiSettingsReply>({ ok: false, error: '无效的通用设置' }));
  await submit(page);
  assert.equal(page.feedback.textContent, '无效的通用设置');
  assert.equal(page.feedback.classList.contains('error'), true);
  // The refusal puts the form back to what was persisted, so the button is disabled because there is nothing to
  // save any more — not because a `pending` flag is stuck. Changing a control again is what tells the two apart.
  assert.equal(page.appearance.disabled, false, 'a refusal does not lock the controls');
  assert.equal(page.save.disabled, true, 'the form was reverted, so nothing is pending');
  change(page, 'dark');
  assert.equal(page.save.disabled, false, 'and it can be saved again');
});
