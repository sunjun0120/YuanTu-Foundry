/**
 * A goal and a completion contract, when a session carries both.
 *
 * They are two statements of the same thing at different strengths. A goal is the model's own objective with a
 * round count and a lifecycle; a contract names the criteria and holds the evidence. Until this existed, `complete`
 * was a lifecycle transition with nothing behind it — a run could declare an objective achieved and no part of the
 * runtime disagreed. These tests pin the three rules that keep the stronger statement in charge:
 *
 * 1. a bound goal may not be closed while the contract is unverified, and the refusal names the next action;
 * 2. a goal the contract does not describe is left alone — an unbound goal keeps its old behaviour rather than
 *    being held retroactively to criteria nobody wrote;
 * 3. once the contract verifies, the kernel closes a bound and still-active goal itself, without paying for one
 *    more model request whose only possible output is a tool call the runtime has already made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/catalog/index.ts';
import { newGoal } from '../packages/protocol/goals.ts';
import type { Provider } from '../packages/protocol/index.ts';
import { reply, toolCall as call, scriptedProvider } from './provider-fixture.ts';

const AT = '2026-01-01T00:00:00.000Z';

const OBJECTIVE = 'Produce the marker';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-completion-recovery-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, tools, session: store.create(root) };
}

/** A contract that passes only once `marker.txt` holds `ok`, which the test controls. */
const acceptance = [
  {
    description: 'marker file matches',
    met: false,
    check: { id: 'marker', kind: 'file-contains' as const, path: 'marker.txt', expected: 'ok' },
  },
];

test('a bound goal cannot be closed while its contract is unverified', async (t) => {
  const { store, tools, session } = await fixture(t);
  // The marker is missing, so the contract cannot pass — the point of the test.
  const task = store.createTask(session.id, {
    title: OBJECTIVE,
    acceptance,
  });
  const toolResults: string[] = [];
  let rounds = 0;
  const provider: Provider = {
    async complete() {
      rounds++;
      if (rounds === 1) return call('g1', 'create_goal', { objective: OBJECTIVE });
      if (rounds === 2) return call('g2', 'update_goal', { action: 'complete' });
      return reply('I could not finish it.');
    },
  };
  const agent = new Agent({ store, tools, approve: async () => true, provider });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'Do the work' });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.completion?.state, 'needs_review');
  const goal = store.goal(session.id);
  assert.equal(goal?.status, 'active', 'the refusal left the goal exactly as it was');
  for (const message of store.messages(session.id))
    if (message.role === 'tool' && message.toolCallId === 'g2') toolResults.push(message.content);
  assert.equal(toolResults.length, 1);
  assert.match(toolResults[0]!, /completion contract/i);
  assert.match(toolResults[0]!, /has not verified yet/i);
  assert.doesNotMatch(
    toolResults[0]!,
    /definitionHash|contractId/,
    'the refusal names no internal identity',
  );
});

test('a goal the contract does not describe is not held to it', async (t) => {
  const { store, tools, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'A different piece of work',
    acceptance,
  });
  // A goal about something else entirely. Closing it is the user's business, not this contract's.
  store.recordEvent(session.id, 'goal.changed', {
    action: 'create',
    goal: newGoal({ objective: 'Something unrelated' }, AT),
  });
  let rounds = 0;
  const provider: Provider = {
    async complete() {
      /**
       * The goal is closed once, and then the model *stops calling tools*.
       *
       * A round only ends when the model answers without a tool call — that is what a run's loop waits for — so a
       * fixture that keeps returning `update_goal` would never reach a verification round at all. The repair loop
       * is exercised by the two plain answers that follow: same failure, no progress, so it stops.
       */
      rounds++;
      return rounds === 1
        ? call('g1', 'update_goal', { action: 'complete' })
        : reply('Nothing more to do.');
    },
  };
  const agent = new Agent({ store, tools, approve: async () => true, provider });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'Do the work' });
  assert.equal(store.goal(session.id)?.status, 'completed');
  assert.equal(result.status, 'needs_review', 'the contract is what the run is judged by');
  assert.equal(result.completion?.reason, 'repeated-failure');
});

test('a verified contract closes a bound goal without another model request', async (t) => {
  const { root, store, tools, session } = await fixture(t);
  await writeFile(path.join(root, 'marker.txt'), 'ok');
  const task = store.createTask(session.id, { title: OBJECTIVE, acceptance });
  // The goal was left active by an earlier round: exactly the state a successful run starts in.
  store.recordEvent(session.id, 'goal.changed', {
    action: 'create',
    goal: newGoal({ objective: OBJECTIVE }, AT),
  });
  let rounds = 0;
  const provider: Provider = {
    async complete() {
      rounds++;
      return reply('The marker is in place.');
    },
  };
  const agent = new Agent({ store, tools, approve: async () => true, provider });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'Do the work' });

  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.completion?.state, 'verified');
  assert.equal(rounds, 1, 'closing the goal cost no extra model request');
  assert.equal(store.goal(session.id)?.status, 'completed');
  // The closure is a goal change like any other, so a reopened window reads it back from the log. The `round`
  // between them is the admission the run itself spent, which is what the goal's own budget counts.
  const changes = store
    .events(session.id)
    .filter((event) => event.type === 'goal.changed')
    .map((event) => event.data.action);
  assert.deepEqual(changes, ['create', 'round', 'complete']);
});

test('a paused goal is the user’s, and a verified contract does not reopen or close it', async (t) => {
  const { root, store, tools, session } = await fixture(t);
  await writeFile(path.join(root, 'marker.txt'), 'ok');
  const task = store.createTask(session.id, { title: OBJECTIVE, acceptance });
  store.recordEvent(session.id, 'goal.changed', {
    action: 'create',
    goal: { ...newGoal({ objective: OBJECTIVE }, AT), status: 'paused' },
  });
  const provider = scriptedProvider(reply('Done.'));
  const agent = new Agent({ store, tools, approve: async () => true, provider });
  const result = await agent.run({ sessionId: session.id, taskId: task.id, prompt: 'Do the work' });
  assert.equal(result.completion?.state, 'verified');
  assert.equal(
    store.goal(session.id)?.status,
    'paused',
    'pausing is the user’s decision, not a run’s',
  );
});
