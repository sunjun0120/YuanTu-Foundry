import test from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_NAMES, SlotRegistry, type SlotName } from '../apps/desktop/ui/slot-registry.ts';

type Contexts = {
  'composer.above': { workspace: string };
  'sidebar.right': { workspace: string };
  'message.actions': { message: string };
  'message.footer': { message: string };
  'tool.result.extra': { message: string };
};
const labelled = (id: string, order?: number) => ({ id, order, render: () => id });

test('the window offers the five typed extension positions', () => {
  assert.deepEqual([...SLOT_NAMES].sort(), [
    'composer.above',
    'message.actions',
    'message.footer',
    'sidebar.right',
    'tool.result.extra',
  ]);
  const types = (registry: SlotRegistry<Contexts, string>) => {
    registry.register('sidebar.right', {
      id: 'wrong',
      // @ts-expect-error Message and panel contexts cannot be interchanged.
      render: (context: { message: string }) => context.message,
    });
    registry.register('message.actions', { id: 'valid', render: (context) => context.message });
  };
  assert.equal(typeof types, 'function');
});

test('explicit order sorts contributions and ties preserve registration order', () => {
  const registry = new SlotRegistry<Contexts, string>();
  registry.register('composer.above', labelled('late', 20));
  registry.register('composer.above', labelled('first', 10));
  registry.register('composer.above', labelled('second', 10));
  assert.deepEqual(
    registry.contributions('composer.above').map((entry) => entry.id),
    ['first', 'second', 'late'],
  );
});

test('frozen snapshots preserve surviving contribution identities', () => {
  const registry = new SlotRegistry<Contexts, string>();
  registry.register('composer.above', labelled('kept'));
  const before = registry.contributions('composer.above');
  const remove = registry.register('composer.above', labelled('new'));
  assert.equal(Object.isFrozen(before), true);
  assert.equal(before.length, 1);
  assert.equal(registry.contributions('composer.above')[0], before[0]);
  remove();
  assert.equal(registry.contributions('composer.above')[0], before[0]);
});

test('duplicate ids are rejected; an old disposer cannot remove a replacement', () => {
  const registry = new SlotRegistry<Contexts, string>();
  const contribution = labelled('same');
  const first = registry.register('composer.above', contribution);
  assert.throws(() => registry.register('composer.above', contribution), /Duplicate/);
  first();
  const replacement = registry.register('composer.above', contribution);
  first();
  assert.equal(registry.size('composer.above'), 1);
  replacement();
  replacement();
  assert.equal(registry.size('composer.above'), 0);
});

test('subscriptions are per slot and registration disposal only publishes once', () => {
  const registry = new SlotRegistry<Contexts, string>();
  let composer = 0;
  let footer = 0;
  const unsubscribe = registry.subscribe('composer.above', () => composer++);
  registry.subscribe('message.footer', () => footer++);
  const remove = registry.register('composer.above', labelled('new'));
  assert.equal(composer, 1);
  assert.equal(footer, 0);
  assert.equal(registry.revision('composer.above'), 1);
  remove();
  remove();
  assert.equal(composer, 2);
  unsubscribe();
  unsubscribe();
  registry.register('composer.above', labelled('later'));
  assert.equal(composer, 2);
});

test('unknown slots and empty ids fail at registration', () => {
  const registry = new SlotRegistry<Contexts, string>();
  assert.throws(
    () => registry.register('composer.below' as SlotName, labelled('typo')),
    /Unknown slot/,
  );
  assert.throws(() => registry.register('composer.above', labelled('')), /empty contribution id/);
});
