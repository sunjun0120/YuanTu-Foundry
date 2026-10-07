/**
 * The session-owned todo list.
 *
 * A run shows the user a stream of tool calls and nothing else, and the model has nowhere to state a plan it
 * will keep. `todo_write` is that place: session state, not a task — it has no acceptance checks, no
 * triggers, and never touches the workspace.
 *
 * These tests pin the parts that are easy to get wrong rather than the happy path alone: that the event
 * carries the whole list (so a fold is a replacement and a reload cannot lose the checklist), that a
 * rejected call writes nothing at all, and that the tool answers instead of throwing when no seam is wired.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { todosProjection } from '../packages/storage/projections.ts';
import { SESSION_EVENT_TYPES } from '../packages/storage/events.ts';
import { describeTodoChange } from '../packages/protocol/todos.ts';
import { AGENT_EVENT_TYPES, isTodoItem } from '../packages/protocol/index.ts';
import type {
  AgentEvent,
  ModelResponse,
  Provider,
  TodoItem,
  ToolResult,
} from '../packages/protocol/index.ts';

const reply = (text: string): ModelResponse => ({
  text,
  finishReason: 'stop',
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const list = (...items: [string, TodoItem['status']][]): TodoItem[] =>
  items.map(([content, status], index) => ({ id: `t${index + 1}`, content, status }));
/**
 * The same shape with explicit ids, so a test can build one that the schema accepts but the tool must refuse
 * — a duplicate id, which is the one rule the per-item schema cannot see.
 */
const withIds = (...items: [string, string, TodoItem['status']][]): TodoItem[] =>
  items.map(([id, content, status]) => ({ id, content, status }));
/** Runs a scripted provider to completion and hands back what the session recorded. */
async function run(t: test.TestContext, provider: Provider) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-todo-'));
  const store = new SessionStore(path.join(root, 'sessions.db'));
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  return { store, session, events, result };
}
const toolResults = (store: SessionStore, sessionId: string): string[] =>
  store
    .messages(sessionId)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
test('todo_write replaces the list, and a shorter second call shrinks it', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1)
        return toolCall('t-1', 'todo_write', {
          todos: list(
            ['Read the config', 'in_progress'],
            ['Fix the loader', 'pending'],
            ['Run the tests', 'pending'],
          ),
        });
      if (round === 2)
        return toolCall('t-2', 'todo_write', {
          todos: list(['Run the tests', 'completed']),
        });
      return reply('Done');
    },
  };
  const { store, session } = await run(t, provider);
  // The tool answered a checklist both times, which is the only place the model reads the list back.
  const results = toolResults(store, session.id);
  assert.match(results[0]!, /- \[~\] t1: Read the config/);
  assert.match(results[0]!, /- \[ \] t3: Run the tests/);
  assert.match(results[0]!, /3 item\(s\): 0 completed, 1 in progress, 2 pending\./);
  assert.match(results[1]!, /- \[x\] t1: Run the tests/);
  assert.match(results[1]!, /1 item\(s\): 1 completed, 0 in progress, 0 pending\./);
  // Replace, not merge: the durable list is the shorter one, which is the whole point of "the latest event
  // is the list".
  assert.deepEqual(store.todos(session.id), list(['Run the tests', 'completed']));
});
test('a rejected call writes no event and says why', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      // Duplicate ids cannot be caught by the schema, which sees one item at a time.
      return round === 1
        ? toolCall('dup', 'todo_write', {
            todos: withIds(['same', 'First', 'pending'], ['same', 'Second', 'pending']),
          })
        : reply('Gave up');
    },
  };
  const { store, session } = await run(t, provider);
  assert.match(toolResults(store, session.id)[0]!, /Duplicate todo id "same"/);
  assert.equal(
    store.events(session.id).filter((event) => event.type === 'todo.written').length,
    0,
    'a refused call must not append the event',
  );
  assert.deepEqual(store.todos(session.id), []);
});
test('the schema refuses what the model should never be able to send', async (t) => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    [
      'too many items',
      {
        todos: Array.from({ length: 21 }, (_, i) => ({
          id: `i${i}`,
          content: 'x',
          status: 'pending',
        })),
      },
      /must NOT have more than 20 items/,
    ],
    [
      'over-long content',
      { todos: [{ id: 'a', content: 'x'.repeat(201), status: 'pending' }] },
      /must NOT have more than 200 characters/,
    ],
    [
      'unknown status',
      { todos: [{ id: 'a', content: 'x', status: 'started' }] },
      /must be equal to one of the allowed values/,
    ],
    ['bad id', { todos: [{ id: 'A B', content: 'x', status: 'pending' }] }, /pattern/i],
  ];
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-todo-schema-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const [name, args, expected] of cases) {
    const result: ToolResult = await tools.execute(
      { id: name, name: 'todo_write', arguments: args },
      { signal: new AbortController().signal, approve: async () => true },
    );
    assert.equal(result.isError, true, `${name} must be refused`);
    assert.match(result.content, expected, name);
  }
});
test('no seam wired is an error result, not a throw', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-todo-noseam-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const result = await tools.execute(
    { id: 'x', name: 'todo_write', arguments: { todos: list(['Do it', 'pending']) } },
    { signal: new AbortController().signal, approve: async () => true },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /No todo list is wired into this run/);
});
test('the durable event is the declared one and folds to the latest list', async (t) => {
  const provider: Provider = {
    async complete() {
      return reply('Done');
    },
  };
  const { store, session } = await run(t, provider);
  // Two things a reader has to agree on: the type is declared (or the fold would refuse a log it wrote
  // itself), and it is not ignorable — a reader that skipped it would show a stale checklist.
  assert.ok((SESSION_EVENT_TYPES as readonly string[]).includes('todo.written'));
  assert.ok((AGENT_EVENT_TYPES as readonly string[]).includes('todo.written'));
  const before = store.messages(session.id).length;
  store.recordEvent(session.id, 'todo.written', { todos: list(['First', 'pending']) });
  store.recordEvent(session.id, 'todo.written', { todos: list(['Second', 'completed']) });
  // The fold is total, so a malformed payload keeps the previous list rather than reporting an empty one.
  store.recordEvent(session.id, 'todo.written', { todos: 'not a list' });
  assert.deepEqual(store.todos(session.id), list(['Second', 'completed']));
  assert.equal(
    store.messages(session.id).length,
    before,
    'the checklist is state the user watches, not transcript content',
  );
});
test('the live event is emitted once per accepted call and carries the whole list', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1)
        return toolCall('t-1', 'todo_write', { todos: list(['One', 'in_progress']) });
      if (round === 2) return toolCall('t-2', 'todo_write', { todos: list(['One', 'completed']) });
      return reply('Done');
    },
  };
  const { store, session, events } = await run(t, provider);
  const written = events.filter((event) => event.type === 'todo.written');
  assert.equal(written.length, 2);
  assert.deepEqual(written[0]!.data.todos, list(['One', 'in_progress']));
  assert.deepEqual(written[1]!.data.todos, list(['One', 'completed']));
  // The payload is the list and nothing else: what changed about it is derived from two consecutive events,
  // and a second copy of that fact in the log is how the two copies start to disagree.
  assert.deepEqual(Object.keys(written[0]!.data), ['todos']);
  // The store's fold answers the same question the live consumer computes, which is what lets a reload show
  // the same "since the previous version" line the panel showed while the run was going.
  assert.equal(describeTodoChange(store.todoChange(session.id)!), '~1 updated');
});
test('the projection and the guard agree on what a list item is', () => {
  assert.equal(isTodoItem({ id: 'a', content: 'x', status: 'pending' }), true);
  assert.equal(isTodoItem({ id: 'a', content: 'x', status: 'nope' }), false);
  assert.equal(isTodoItem({ id: 'a', content: 'x' }), false);
  assert.equal(isTodoItem(null), false);
  assert.equal(isTodoItem([{ id: 'a', content: 'x', status: 'pending' }]), false);
  const folded = todosProjection.apply(todosProjection.initial(), {
    seq: 1,
    sessionId: 's',
    type: 'todo.written',
    at: '2026-09-30T00:00:00.000Z',
    data: {
      todos: [
        { id: 'a', content: 'kept', status: 'pending' },
        { id: 'b', content: 'dropped', status: 'invented' },
      ],
    },
  });
  assert.deepEqual(folded, [{ id: 'a', content: 'kept', status: 'pending' }]);
});
