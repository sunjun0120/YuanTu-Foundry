import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { connectClient, listeningHost, waitForStderr } from './listening-host-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { newGoal } from '../packages/protocol/goals.ts';

// ---- the Host continues a goal on its own ----
//
// The continuation driver is a loop around ordinary runs, and the Host is what a desktop window talks to: the
// window asks for one round and the Host is what decides there is a second one. These tests pin that the
// request which created the goal is also the request that finishes it, over the real protocol, with the
// durable log read back between rounds — and where the loop deliberately stands down.

test('a Host keeps running rounds until the session goal is finished', async (t) => {
  const prompts: string[] = [];
  let step = 0;
  const url = await httpFixture(t, (body, res) => {
    prompts.push(JSON.stringify(body.messages));
    step++;
    if (step === 1)
      sendFrames(
        res,
        frames('Creating the goal.', [
          { id: 'goal-1', name: 'create_goal', input: { objective: 'Ship the migration' } },
        ]),
      );
    else if (step === 2) sendFrames(res, frames('Round one is done.'));
    else if (step === 3)
      sendFrames(
        res,
        frames('Goal complete.', [
          { id: 'goal-2', name: 'update_goal', input: { action: 'complete' } },
        ]),
      );
    else sendFrames(res, frames('Done.'));
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const started: string[] = [];
  const off = client.subscribe((event) => {
    if (event.type === 'run.started') started.push(event.runId);
  });
  t.after(off);
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Ship the migration');
  /**
   * The reply is the round that finished the goal, not the round the request asked for.
   *
   * A window that said "Ship the migration" wants the answer the session arrived at — and it is not losing
   * round one by getting it: the rounds are runs of their own, so the client saw both of them start and both
   * of their messages arrive in the transcript it is rendering.
   */
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'Done.');
  assert.equal(started.length, 2, 'the client witnessed two runs, not one');
  // …and the round nobody asked for was aimed at the same objective and was the last one.
  assert.match(prompts[2]!, /round 2 of 256/);
  assert.match(prompts[2]!, /Ship the migration/);
  assert.match(host.stderr(), /\[goal\] round 2/);
  // The line is written before the reply is sent, but on another pipe: waiting for it is what makes this an
  // assertion about the Host rather than about which pipe won the race.
  await waitForStderr(host, /\[goal\] stopped after 1 round\(s\): goal/);
  // The goal is durable state, so the round the Host ran wrote itself into the log the client reads back.
  const goal = await client.request('goal.get', { sessionId: session.id });
  assert.equal(goal?.status, 'completed');
});

test('a continuation round cannot re-aim the goal the runtime started it for', async (t) => {
  /**
   * A continuation is an ordinary run, so the goal tools are in it — and without a check on who was asking, the
   * model could `edit max_goal_rounds` up from inside a round the runtime had started on its behalf. That is a
   * model widening its own autonomy with the runtime's own loop as the instrument, which is the one thing the
   * goal's round budget must not be answerable to.
   *
   * Reporting is still the model's job, and the round ends the only way it should: by recording the verdict.
   */
  const prompts: string[] = [];
  let step = 0;
  const url = await httpFixture(t, (body, res) => {
    prompts.push(JSON.stringify(body.messages));
    step++;
    if (step === 1)
      sendFrames(
        res,
        frames('Creating the goal.', [
          {
            id: 'goal-1',
            name: 'create_goal',
            input: { objective: 'Ship the migration', max_goal_rounds: 2 },
          },
        ]),
      );
    else if (step === 2) sendFrames(res, frames('Round one is done.'));
    else if (step === 3)
      sendFrames(
        res,
        frames('Raising my own budget.', [
          { id: 'goal-2', name: 'update_goal', input: { action: 'edit', max_goal_rounds: 4096 } },
        ]),
      );
    else if (step === 4)
      sendFrames(
        res,
        frames('Finishing.', [
          { id: 'goal-3', name: 'update_goal', input: { action: 'complete' } },
        ]),
      );
    // The goal is completed by now, so a second `complete` would be refused and the round would never end.
    else sendFrames(res, frames('Done.'));
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const started: string[] = [];
  const off = client.subscribe((event) => {
    if (event.type === 'run.started') started.push(event.runId);
  });
  t.after(off);
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Ship the migration');
  assert.equal(result.status, 'completed', result.error);
  assert.equal(started.length, 2, 'the continuation round did run');
  // The refusal reached the model, in the round it asked from.
  assert.match(String(prompts[3]), /who is in charge of this goal/);
  const goal = await client.request('goal.get', { sessionId: session.id });
  assert.equal(goal?.maxGoalRounds, 2, 'the budget the user agreed to is exactly where it was');
  assert.equal(
    goal?.status,
    'completed',
    'and the round still ended the way the model should end it',
  );
});

test('a goal that has spent its rounds is recorded as blocked, not left looking active', async (t) => {
  /**
   * `active` is what tells the next request to start another round, so a goal whose budget is spent must not be
   * left in that state: the model's next turn and the user's card would both be told more work is coming. The
   * loop reports the exhaustion and the Host records the verdict, durably and on the live feed.
   */
  const changes: { action?: unknown; status?: unknown }[] = [];
  let step = 0;
  const url = await httpFixture(t, (_body, res) => {
    // A counter rather than "have any changes arrived yet": the live feed is asynchronous, and the script has to
    // be a function of the request it is answering.
    if (++step === 1)
      sendFrames(
        res,
        frames('One round is all the budget allows.', [
          {
            id: 'goal-1',
            name: 'create_goal',
            input: { objective: 'Ship the migration', max_goal_rounds: 1 },
          },
        ]),
      );
    else sendFrames(res, frames('That is the whole budget.'));
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const started: string[] = [];
  const off = client.subscribe((event) => {
    if (event.type === 'run.started') started.push(event.runId);
    if (event.type === 'goal.changed')
      changes.push({
        action: event.data.action,
        status: (event.data.goal as { status?: unknown } | undefined)?.status,
      });
  });
  t.after(off);
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Ship the migration');
  assert.equal(result.status, 'completed', result.error);
  assert.equal(started.length, 1, 'a spent budget starts nothing');
  const goal = await client.request('goal.get', { sessionId: session.id });
  assert.equal(goal?.status, 'blocked');
  assert.equal(goal?.roundsStarted, 1);
  assert.match(String(goal?.blockedReason), /Round budget spent: 1\/1/);
  assert.equal(goal?.maxGoalRounds, 1, 'the verdict changes the standing, not the budget');
  assert.deepEqual(changes, [
    { action: 'create', status: 'active' },
    { action: 'blocked', status: 'blocked' },
  ]);
});

test('a task run is not extended by a goal, because its rounds belong to its attempt', async (t) => {
  const prompts: string[] = [];
  const url = await httpFixture(t, (body, res) => {
    prompts.push(JSON.stringify(body.messages));
    sendFrames(res, frames('Task round done.'));
  });
  let seeded = '';
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (dbPath) => {
    const store = new SessionStore(dbPath);
    try {
      const session = store.create(path.dirname(dbPath));
      seeded = session.id;
      // Seeded rather than created by a round: a goal an earlier run left active is exactly the state a task
      // run starts in, and it must not pull the task's attempt along with it.
      store.recordEvent(session.id, 'goal.changed', {
        action: 'create',
        goal: newGoal({ objective: 'Ship the migration' }, new Date().toISOString()),
      });
    } finally {
      store.close();
    }
  });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const task = await client.request('task.create', {
    sessionId: seeded,
    title: 'Ship it',
    description: 'Ship the migration',
  });
  const result = await client.run(seeded, 'Ship the migration', { taskId: task.id });
  assert.equal(result.status, 'completed', result.error);
  // One round ran and no continuation followed it: a task attempt's evidence would not survive rounds
  // appended outside the attempt that is being verified.
  assert.equal(prompts.length, 1, prompts.join('\n---\n'));
  assert.doesNotMatch(host.stderr(), /\[goal\] round/);
});
