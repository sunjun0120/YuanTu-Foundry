/**
 * The interface's combination point: who is in a slot, in what order, and how they leave.
 *
 * These cases are deliberately about the *composition* rather than about any one panel. The panels themselves
 * are covered where they live and by the desktop smoke, which drives the real DOM in the real window; what had
 * no test — and no owner — until now is the ordering and lifecycle rules that a contributed view depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_NAMES,
  SlotRegistry,
  mountSlot,
  type SlotContexts,
  type SlotName,
} from '../apps/desktop/slots.ts';

/** Every slot carries a string here: the per-slot context types are the registry's contract, not its subject. */
type TestSlots = SlotContexts & Record<SlotName, string>;

/**
 * The smallest document the mount actually uses: create an element, append, remove, and read the children back.
 *
 * A real DOM library would be a dependency this project does not otherwise have, and the surface being pinned
 * here is four methods wide. The real document is exercised by `tests/desktop.smoke.mjs`, so this double is not
 * standing in for the browser — it is standing in for "a container that can hold children".
 */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly tagName: string;
  className = '';
  private parent: FakeElement | undefined;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent?.remove(node);
      node.parent = this;
      this.children.push(node);
    }
    this.children.splice(0, 0);
  }
  remove(node?: FakeElement): void {
    const target = node ?? this;
    if (target.parent) {
      const index = target.parent.children.indexOf(target);
      if (index >= 0) target.parent.children.splice(index, 1);
      target.parent = undefined;
    }
  }
  /** Every descendant's text, in document order — the assertion surface for "what is in this slot". */
  text(): string[] {
    return this.children.flatMap((child) => child.text());
  }
}
class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
}
const document_ = new FakeDocument() as unknown as Document;
/** A contribution that writes its label into its frame, the way a panel writes its content. */
const labelled = (label: string, order?: number) => ({
  ...(order === undefined ? {} : { order }),
  render: (frame: HTMLElement) => {
    // A contribution owns its frame and may be rendered repeatedly, so it replaces what it drew rather than
    // appending to it — the same rule a panel follows when it re-renders on every state change.
    const element = frame as unknown as FakeElement;
    element.children.length = 0;
    element.children.push(labelElement(label));
  },
});
const labelElement = (label: string): FakeElement => {
  const element = new FakeElement('span');
  element.className = label;
  return element;
};
/** Read a frame's labels: the mount's own bookkeeping must not leak into what a slot shows. */
const labelsOf = (container: FakeElement): string[] =>
  container.children.flatMap((frame) => frame.children.map((child) => child.className));

test('the window offers exactly the slots the design named', () => {
  assert.deepEqual([...SLOT_NAMES].sort(), [
    'composer.above',
    'message.actions',
    'message.footer',
    'sidebar.right',
    'tool.result.extra',
  ]);
});

test('a contribution renders where it was registered, in registration order', () => {
  const registry = new SlotRegistry<TestSlots>();
  const container = new FakeElement('div');
  registry.register('composer.above', labelled('first'));
  registry.register('composer.above', labelled('second'));
  const mount = mountSlot(
    document_,
    container as unknown as HTMLElement,
    registry,
    'composer.above',
  );
  mount.render('ctx');
  assert.deepEqual(labelsOf(container), ['first', 'second']);
  assert.deepEqual(
    registry.contributions('composer.above').map((entry) => entry.order ?? 0),
    [0, 0],
    'ties keep arrival order',
  );
});

test('order decides, and it decides for the render rather than for the registration', () => {
  const registry = new SlotRegistry<TestSlots>();
  const container = new FakeElement('div');
  registry.register('sidebar.right', labelled('late', 20));
  registry.register('sidebar.right', labelled('early', 10));
  const mount = mountSlot(
    document_,
    container as unknown as HTMLElement,
    registry,
    'sidebar.right',
  );
  mount.render('ctx');
  assert.deepEqual(labelsOf(container), ['early', 'late']);
  // A later arrival with an earlier order takes its place in front, which is what "stable and explicit" means.
  registry.register('sidebar.right', labelled('first', 5));
  mount.render('ctx');
  assert.deepEqual(labelsOf(container), ['first', 'early', 'late']);
});

test('disposing a registration removes exactly that contribution', () => {
  const registry = new SlotRegistry<TestSlots>();
  const container = new FakeElement('div');
  const disposeFirst = registry.register('composer.above', labelled('first'));
  registry.register('composer.above', labelled('second'));
  const mount = mountSlot(
    document_,
    container as unknown as HTMLElement,
    registry,
    'composer.above',
  );
  mount.render('ctx');
  assert.deepEqual(labelsOf(container), ['first', 'second']);
  disposeFirst();
  disposeFirst(); // idempotent: a double unload must not remove somebody else's panel
  assert.equal(registry.size('composer.above'), 1);
  mount.render('ctx');
  assert.deepEqual(labelsOf(container), ['second']);
});

test('re-rendering a slot does not stack copies of its panels', () => {
  const registry = new SlotRegistry<TestSlots>();
  const container = new FakeElement('div');
  registry.register('composer.above', labelled('once'));
  const mount = mountSlot(
    document_,
    container as unknown as HTMLElement,
    registry,
    'composer.above',
  );
  mount.render('ctx');
  mount.render('ctx');
  mount.render('ctx');
  assert.deepEqual(labelsOf(container), ['once'], 'three renders, one panel');
});

test('a mount is reversible: disposing it leaves the container as it was found', () => {
  const registry = new SlotRegistry<TestSlots>();
  const container = new FakeElement('div');
  registry.register('composer.above', labelled('panel'));
  const mount = mountSlot(
    document_,
    container as unknown as HTMLElement,
    registry,
    'composer.above',
  );
  mount.render('ctx');
  assert.equal(container.children.length, 1);
  mount.dispose();
  assert.equal(container.children.length, 0);
  // And the registry is untouched by the mount: another carrier can mount the same slot somewhere else.
  assert.equal(registry.size('composer.above'), 1);
});

test('an unknown slot name is refused instead of silently kept', () => {
  const registry = new SlotRegistry<TestSlots>();
  assert.throws(
    () => registry.register('composer.below' as SlotName, labelled('typo')),
    /Unknown slot: composer\.below/,
  );
  assert.equal(registry.size('composer.above'), 0);
});

test('a reader receives a frozen snapshot it cannot reorder', () => {
  const registry = new SlotRegistry<TestSlots>();
  registry.register('message.actions', labelled('only'));
  const snapshot = registry.contributions('message.actions');
  // The next render reads the registry again, so a caller that could sort or splice the array it was handed
  // would be editing the composition of every later render from the outside.
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => (snapshot as unknown as unknown[]).push(labelled('intruder')), TypeError);
  assert.equal(registry.size('message.actions'), 1);
});

test('re-rendering with the same contributions keeps the frames it already built', () => {
  const registry = new SlotRegistry<TestSlots>();
  const container = new FakeElement('div');
  registry.register('composer.above', labelled('kept'));
  const mount = mountSlot(
    document_,
    container as unknown as HTMLElement,
    registry,
    'composer.above',
  );
  mount.render('ctx');
  const first = container.children[0];
  assert.ok(first);
  mount.render('ctx');
  // Rebuilding the frame replaces the node a panel is living in. In the real window that is where an input
  // inside a slot loses its focus and a scrolled list jumps back to the top on every re-render, so the frame
  // is created once and rebuilt only when the set of contributions actually changed.
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], first, 'the frame was rebuilt for an unchanged set');
});

test('a slot name reaches the DOM as one class that can be selected', () => {
  const registry = new SlotRegistry<TestSlots>();
  const container = new FakeElement('div');
  registry.register('tool.result.extra', labelled('one'));
  const mount = mountSlot(
    document_,
    container as unknown as HTMLElement,
    registry,
    'tool.result.extra',
  );
  mount.render('ctx');
  // The dot in a slot name is a namespace separator, not part of a class: leaving it in produces
  // `slot slot-tool.result.extra`, which is three class tokens, and no stylesheet can select the frame.
  assert.equal(container.children[0]?.className, 'slot slot-tool-result-extra');
});
