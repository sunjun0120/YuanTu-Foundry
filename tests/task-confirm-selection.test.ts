/**
 * The ticks a person leaves in the task list, and whether they outlive the render that drew them.
 *
 * Manual acceptance is the one place where the interface, not the Host, remembers something between two
 * frames: a run can only be confirmed once the person has said which criteria they checked. That draft used to
 * be a `Set` created inside the card loop, so any rebuild of the list — a new step checkpoint, a new attempt, a
 * language switch — threw the ticks away and left the confirm button either doing nothing or claiming there was
 * nothing to confirm. Nothing about that is visible in a pure helper, so the cases below drive the *real*
 * `setupTasks` render and its real listeners over the smallest document those code paths actually use; the
 * pointer-and-pixels half is the desktop smoke.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Acceptance, Task } from '../packages/protocol/index.ts';
import type { CarrierCommand, CarrierSnapshot } from '../packages/carrier/contract.ts';
import { setLocale } from '../apps/desktop/i18n.ts';
import {
  acceptanceDefinitionKey,
  setupTasks,
  TaskConfirmDrafts,
} from '../apps/desktop/renderer-tasks.ts';

/**
 * The four DOM behaviours `renderer-tasks.ts` uses: create an element, read named properties, append children,
 * and fire the listeners it registered. It is a double for "a container that can hold children and dispatch a
 * `change`", not for a browser; `tests/desktop.smoke.mjs` drives the real document.
 */
class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  private readonly listeners = new Map<string, Array<() => void>>();
  textContent = '';
  className = '';
  hidden = false;
  disabled = false;
  checked = false;
  type = '';
  value = '';
  open = false;
  lang = '';
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  prepend(...nodes: FakeNode[]): void {
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }
  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  setCustomValidity(): void {}
  /** Dispatch as the page would: every listener for the type, in registration order. */
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  click(): void {
    this.fire('click');
  }
  querySelector(selector: string): FakeNode | null {
    return this.descendants().find((node) => matchesSelector(node, selector)) ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.descendants().filter((node) => matchesSelector(node, selector));
  }
  /** Every descendant, in document order. */
  descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}
/** The selector surface the module uses: a tag, a tag with one property, or a class. */
function matchesSelector(node: FakeNode, selector: string): boolean {
  const attribute = /^([a-zA-Z]*)\[([\w-]+)=([^\]]+)\]$/.exec(selector);
  if (attribute) {
    const [, tag, name, value] = attribute;
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    return (node as unknown as Record<string, unknown>)[name!] === value;
  }
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  return node.tagName === selector.toUpperCase();
}
class FakeDocument {
  readonly nodeType = 9;
  readonly documentElement = new FakeNode('html');
  readonly body: FakeNode | null = null;
  private readonly ids = new Map<string, FakeNode>();
  createElement(tag: string): FakeNode {
    return new FakeNode(tag);
  }
  /** The page declares every id this module looks up, so a lookup is a creation on first use. */
  getElementById(id: string): FakeNode {
    const existing = this.ids.get(id);
    if (existing) return existing;
    const created = new FakeNode('div');
    this.ids.set(id, created);
    return created;
  }
  /** i18n walks the document when the language changes; an empty walk is the whole contract here. */
  createTreeWalker(): { nextNode: () => null } {
    return { nextNode: () => null };
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
}
function installDom(): { document: FakeDocument; restore: () => void } {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    document: globals.document,
    Node: globals.Node,
    NodeFilter: globals.NodeFilter,
    Element: globals.Element,
  };
  const document_ = new FakeDocument();
  globals.document = document_;
  globals.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_NODE: 9 };
  globals.NodeFilter = { SHOW_TEXT: 4 };
  globals.Element = FakeNode;
  return { document: document_, restore: () => Object.assign(globals, previous) };
}
function manualAcceptance(): Acceptance[] {
  return [
    { description: 'first manual criterion', met: false },
    {
      description: 'exact file contents',
      met: false,
      check: { id: 'check-1', kind: 'file-exact', path: 'a.txt', expected: 'x' },
    },
    { description: 'second manual criterion', met: false },
  ];
}
function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    title: 'Ship it',
    description: 'do the thing',
    status: 'needs_review',
    acceptance: manualAcceptance(),
    verification: {
      passed: false,
      durationMs: 1,
      checks: [
        { id: 'verify-1', kind: 'manual', passed: false, detail: 'not confirmed', durationMs: 1 },
      ],
    },
    steps: [{ description: 'step one', status: 'completed' }],
    attemptCount: 1,
    latestRunId: 'run-1',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}
function snapshotOf(task: Task | null, sessionId = 'session-1'): CarrierSnapshot {
  return {
    workspace: 'C:\\workspace',
    session: { sessionId, running: false, loading: false },
    tasks: task ? [task] : [],
    taskAttempts: {},
    taskSteps: {},
  } as unknown as CarrierSnapshot;
}
/** The real render, with a `send` that records commands and answers with whatever the test staged. */
function harness() {
  const calls: CarrierCommand[] = [];
  let reply: CarrierSnapshot | null = null;
  const send = (command: CarrierCommand): Promise<CarrierSnapshot | null> => {
    calls.push(command);
    return Promise.resolve(reply);
  };
  return {
    calls,
    render: setupTasks(send),
    reply: (next: CarrierSnapshot | null) => {
      reply = next;
    },
  };
}
function checkboxes(document_: FakeDocument): FakeNode[] {
  return document_.getElementById('task-list').querySelectorAll('input[type=checkbox]');
}
function confirmButton(document_: FakeDocument): FakeNode {
  const button = document_
    .getElementById('task-list')
    .querySelectorAll('button')
    .find((candidate) => candidate.textContent === 'Confirm selected manual results');
  assert.ok(button, 'the confirm button is drawn for a reviewable task with manual criteria');
  return button;
}
function tick(box: FakeNode): void {
  box.checked = true;
  box.fire('change');
}
const checked = (document_: FakeDocument): boolean[] =>
  checkboxes(document_).map((box) => box.checked);

test('manual selections survive a rebuild of the task list', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  const { render } = harness();
  render(snapshotOf(taskFixture()), false);
  const boxes = checkboxes(dom.document);
  assert.equal(boxes.length, 2, 'one box per unmet manual criterion');
  tick(boxes[0]!);
  tick(boxes[1]!);
  // A new step checkpoint changes the render key, so every card is rebuilt from the snapshot.
  render(
    snapshotOf(
      taskFixture({
        steps: [
          { description: 'step one', status: 'completed' },
          { description: 'step two', status: 'in_progress' },
        ],
      }),
    ),
    false,
  );
  assert.deepEqual(
    checked(dom.document),
    [true, true],
    'a rebuild must not silently clear what the person ticked',
  );
});

test('manual selections survive a language switch', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  t.after(() => setLocale('en-US'));
  const { render } = harness();
  render(snapshotOf(taskFixture()), false);
  tick(checkboxes(dom.document)[0]!);
  setLocale('zh-CN');
  render(snapshotOf(taskFixture()), false);
  assert.deepEqual(checked(dom.document), [true, false]);
});

test('the confirm button is disabled while nothing is selected', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  const { render } = harness();
  render(snapshotOf(taskFixture()), false);
  const confirm = confirmButton(dom.document);
  assert.equal(confirm.disabled, true, 'nothing selected must not look clickable');
  tick(checkboxes(dom.document)[0]!);
  assert.equal(confirm.disabled, false);
});

test('confirming sends one command with the selected indices and the latest updatedAt', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  const { calls, render } = harness();
  render(snapshotOf(taskFixture()), false);
  const boxes = checkboxes(dom.document);
  tick(boxes[0]!);
  tick(boxes[1]!);
  render(
    snapshotOf(taskFixture({ steps: [{ description: 'later', status: 'in_progress' }] })),
    false,
  );
  confirmButton(dom.document).click();
  assert.deepEqual(calls, [
    {
      type: 'taskConfirm',
      taskId: 'task-1',
      indices: [0, 2],
      expectedUpdatedAt: '2026-10-10T00:00:00.000Z',
    },
  ]);
});

test('a confirmed criterion leaves the draft once the Host records it as met', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  const { calls, render, reply } = harness();
  render(snapshotOf(taskFixture()), false);
  tick(checkboxes(dom.document)[0]!);
  tick(checkboxes(dom.document)[1]!);
  const confirmed = taskFixture();
  confirmed.acceptance[0]!.met = true;
  confirmed.acceptance[2]!.met = true;
  confirmed.updatedAt = '2026-10-10T00:01:00.000Z';
  reply(snapshotOf(confirmed));
  confirmButton(dom.document).click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(checkboxes(dom.document).length, 0, 'met criteria are not offered again');
  confirmButton(dom.document).click();
  assert.equal(calls.length, 1, 'a met criterion is not confirmed a second time');
});

test('a new run identity drops the draft', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  const { render } = harness();
  render(snapshotOf(taskFixture()), false);
  tick(checkboxes(dom.document)[0]!);
  render(snapshotOf(taskFixture({ latestRunId: 'run-2' })), false);
  assert.deepEqual(checked(dom.document), [false, false]);
});

test('a changed acceptance definition drops the draft', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  const { render } = harness();
  render(snapshotOf(taskFixture()), false);
  tick(checkboxes(dom.document)[0]!);
  const redefined = taskFixture();
  redefined.acceptance[0]!.description = 'a different criterion';
  render(snapshotOf(redefined), false);
  assert.deepEqual(checked(dom.document), [false, false]);
});

test('switching sessions drops the previous session draft', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  const { render } = harness();
  render(snapshotOf(taskFixture()), false);
  tick(checkboxes(dom.document)[0]!);
  render(snapshotOf(taskFixture({ sessionId: 'session-2' }), 'session-2'), false);
  render(snapshotOf(taskFixture()), false);
  assert.deepEqual(checked(dom.document), [false, false]);
});

test('a deleted task leaves no draft behind', async (t) => {
  setLocale('en-US');
  const dom = installDom();
  t.after(dom.restore);
  const { render } = harness();
  render(snapshotOf(taskFixture()), false);
  tick(checkboxes(dom.document)[0]!);
  render(snapshotOf(null), false);
  render(snapshotOf(taskFixture()), false);
  assert.deepEqual(checked(dom.document), [false, false]);
});

test('the acceptance identity follows the criteria but not their confirmed state', () => {
  const acceptance = manualAcceptance();
  const before = acceptanceDefinitionKey(acceptance);
  acceptance[0]!.met = true;
  assert.equal(acceptanceDefinitionKey(acceptance), before, 'confirming must not reset the draft');
  acceptance[0]!.description = 'edited';
  assert.notEqual(acceptanceDefinitionKey(acceptance), before);
  assert.notEqual(
    acceptanceDefinitionKey(acceptance),
    acceptanceDefinitionKey([{ description: 'edited', met: false }]),
  );
});

test('the draft is reused only for the same session, run and definition', () => {
  const drafts = new TaskConfirmDrafts();
  const task = taskFixture();
  drafts.selection('session-1', task).add(0);
  assert.deepEqual([...drafts.selection('session-1', task)], [0]);
  assert.deepEqual([...drafts.selection('session-1', taskFixture({ latestRunId: 'run-2' }))], []);
  assert.deepEqual(
    [...drafts.selection('session-2', task)],
    [],
    'another session is another draft',
  );
});

test('the draft drops an index whose criterion became met', () => {
  const drafts = new TaskConfirmDrafts();
  drafts.selection('session-1', taskFixture()).add(2);
  const met = taskFixture();
  met.acceptance[2]!.met = true;
  assert.deepEqual([...drafts.selection('session-1', met)], []);
});

test('retain keeps only the current session live tasks', () => {
  const drafts = new TaskConfirmDrafts();
  drafts.selection('session-1', taskFixture()).add(0);
  drafts.selection('session-1', taskFixture({ id: 'task-2' })).add(1);
  drafts.selection('session-2', taskFixture()).add(2);
  drafts.retain('session-1', ['task-2']);
  assert.deepEqual([...drafts.selection('session-1', taskFixture())], [], 'a deleted task is gone');
  assert.deepEqual([...drafts.selection('session-1', taskFixture({ id: 'task-2' }))], [1]);
  assert.deepEqual(
    [...drafts.selection('session-2', taskFixture())],
    [],
    'another session is gone',
  );
});
