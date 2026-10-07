/**
 * What a `todo_write` changed about the checklist.
 *
 * The model replaces the whole list on every call, so "the current plan" is the easy half and "how did it get
 * here" is the half nobody can answer from the newest list alone: an item that was dropped, reworded or
 * completed is invisible the moment the new version arrives. These tests pin the four things a plan can do
 * (added, removed, updated, moved) plus the two rules that decide what a reader is *not* told: a shift caused
 * by a deletion is not a move, and an unchanged write is not a change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { describeTodoChange, isEmptyTodoChange, todoDiff } from '../packages/protocol/todos.ts';
import type { TodoItem } from '../packages/protocol/index.ts';

const item = (id: string, content = id, status: TodoItem['status'] = 'pending'): TodoItem => ({
  id,
  content,
  status,
});
async function fixture(t: test.TestContext): Promise<{ store: SessionStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-todo-diff-'));
  const store = new SessionStore(path.join(root, 'sessions.db'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, root };
}

test('the four things a plan can do, each reported once', () => {
  const previous = [
    item('a', 'Read the loader'),
    item('b', 'Fix the parser'),
    item('c', 'Run the tests'),
    item('e', 'An abandoned step'),
  ];
  const next = [
    item('b', 'Fix the parser', 'completed'),
    item('d', 'Add a regression test'),
    item('a', 'Read the loader'),
    item('c', 'Run the whole suite'),
  ];
  const change = todoDiff(previous, next);
  assert.deepEqual(
    change.added.map((todo) => todo.id),
    ['d'],
  );
  assert.deepEqual(
    change.removed.map((todo) => todo.id),
    ['e'],
  );
  // An id is the item: a reworded line is one update, not a removal plus an addition.
  assert.deepEqual(
    change.updated.map((edit) => [edit.id, edit.from, edit.to]),
    [
      [
        'b',
        { content: 'Fix the parser', status: 'pending' },
        { content: 'Fix the parser', status: 'completed' },
      ],
      [
        'c',
        { content: 'Run the tests', status: 'pending' },
        { content: 'Run the whole suite', status: 'pending' },
      ],
    ],
  );
  // `b` and `a` swapped places, so both are reported, with the real indices — the removed item is not counted
  // in the "from" side, which is why `a` is reported as 0 → 2 and not 0 → 2-of-4.
  assert.deepEqual(
    change.moved.map((move) => [move.id, move.from, move.to]),
    [
      ['b', 1, 0],
      ['a', 0, 2],
    ],
  );
  assert.equal(isEmptyTodoChange(change), false);
  assert.equal(describeTodoChange(change), '+1 added, -1 removed, ~2 updated, >2 moved');
});

test('a deletion is a removal, not a move of everything after it', () => {
  // The whole point of comparing surviving items by their place among the survivors: deleting item 2 of 10
  // shortened the list, it did not move items 3–10, and reporting nine moves would bury the one fact worth
  // reading. The same goes for an insertion at the front.
  const previous = [item('a'), item('b'), item('c'), item('d')];
  const deletion = todoDiff(previous, [item('a'), item('c'), item('d')]);
  assert.deepEqual(
    deletion.removed.map((todo) => todo.id),
    ['b'],
  );
  assert.deepEqual(deletion.moved, []);
  assert.equal(describeTodoChange(deletion), '-1 removed');
  const insertion = todoDiff([item('a'), item('b')], [item('new'), item('a'), item('b')]);
  assert.deepEqual(insertion.moved, []);
  assert.equal(describeTodoChange(insertion), '+1 added');
});

test('a reordering is reported for every item whose place changed', () => {
  const change = todoDiff([item('a'), item('b'), item('c')], [item('c'), item('a'), item('b')]);
  // Each of the three sits somewhere else in the order than it did. A minimal-move set would report one and
  // be silent about the other two, which is a smaller number and a worse description of what happened.
  assert.deepEqual(
    change.moved.map((move) => [move.id, move.from, move.to]),
    [
      ['c', 2, 0],
      ['a', 0, 1],
      ['b', 1, 2],
    ],
  );
  assert.equal(describeTodoChange(change), '>3 moved');
  assert.deepEqual(
    todoDiff([item('a'), item('b')], [item('b'), item('a')]).moved.map((move) => move.id),
    ['b', 'a'],
    'a swap moves both lines',
  );
});

test('a write that changes nothing is no change at all, not an empty one', () => {
  const list = [item('a'), item('b', 'b', 'in_progress')];
  assert.deepEqual(todoDiff(list, list), { added: [], removed: [], updated: [], moved: [] });
  assert.equal(isEmptyTodoChange(todoDiff(list, list)), true);
  // `null` rather than an empty string: a caller that only prints when there is something to print has to be
  // able to tell those apart.
  assert.equal(describeTodoChange(todoDiff(list, list)), null);
  const change = todoDiff([], [item('a'), item('b')]);
  assert.equal(describeTodoChange(change), '+2 added');
  assert.equal(describeTodoChange(todoDiff([item('a'), item('b')], [])), '-2 removed');
  assert.equal(describeTodoChange(todoDiff([item('a', 'x')], [item('a', 'y')])), '~1 updated');
});

test('the fold answers the change, and a reload derives it from the log', async (t) => {
  const { store, root } = await fixture(t);
  const session = store.create(root);
  assert.equal(store.todoChange(session.id), null, 'nothing has been written yet');
  store.recordEvent(session.id, 'todo.written', { todos: [item('a'), item('b')] });
  store.recordEvent(session.id, 'todo.written', {
    todos: [item('b', 'b', 'completed'), item('c')],
  });
  const change = store.todoChange(session.id)!;
  assert.deepEqual(
    change.added.map((todo) => todo.id),
    ['c'],
  );
  assert.deepEqual(
    change.removed.map((todo) => todo.id),
    ['a'],
  );
  assert.deepEqual(
    change.updated.map((edit) => edit.id),
    ['b'],
  );
  assert.deepEqual(
    store.todos(session.id).map((todo) => todo.id),
    ['b', 'c'],
    'the list projection and the change projection fold the same events',
  );
  // Both questions a reader can ask are answered by the same fold, so a panel that shows the list and a
  // reload that shows the change cannot disagree about which write they are describing.
  assert.equal(describeTodoChange(change), '+1 added, -1 removed, ~1 updated');
});

test('the change survives a restart, because it is a fold and not client state', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-todo-restart-'));
  const file = path.join(root, 'sessions.db');
  const first = new SessionStore(file);
  const session = first.create(root);
  first.recordEvent(session.id, 'todo.written', { todos: [item('a'), item('b')] });
  first.recordEvent(session.id, 'todo.written', {
    todos: [item('a', 'a', 'in_progress'), item('b', 'Reworded')],
  });
  const live = first.todoChange(session.id)!;
  first.close();
  const second = new SessionStore(file);
  t.after(async () => {
    second.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(second.todoChange(session.id), live);
  assert.equal(describeTodoChange(second.todoChange(session.id)!), '~2 updated');
});
