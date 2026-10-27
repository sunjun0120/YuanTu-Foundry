import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewRegistry } from '../apps/desktop/ui/view-registry.ts';

test('replacing a view cannot be undone by the previous registration disposer', () => {
  const registry = createViewRegistry<string>();
  const view = registry.view('settings');
  const snapshots: (string | null)[] = [];
  const unsubscribe = view.subscribe(() => snapshots.push(view.getSnapshot()));
  const first = registry.register('settings', 'first');
  const second = registry.register('settings', 'second');
  first();
  first();
  assert.equal(view.getSnapshot(), 'second');
  second();
  second();
  assert.equal(view.getSnapshot(), null);
  assert.deepEqual(snapshots, ['first', 'second', null]);
  unsubscribe();
});

test('views subscribe independently and registry disposal clears active views exactly once', () => {
  const registry = createViewRegistry<string>();
  const chat = registry.view('chat');
  assert.equal(registry.view('chat'), chat);
  let count = 0;
  chat.subscribe(() => count++);
  const release = registry.register('chat', 'draft');
  registry.register('settings', 'form');
  assert.equal(count, 1);
  registry.clear();
  registry.clear();
  release();
  assert.equal(count, 2);
  assert.equal(chat.getSnapshot(), null);
  assert.equal(registry.view('settings').getSnapshot(), null);
});
