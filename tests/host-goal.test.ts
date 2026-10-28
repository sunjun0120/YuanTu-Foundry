import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { connectClient, startHost, waitForStderr } from './host-process-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { newGoal } from '../packages/protocol/goals.ts';

// ---- the Host continues a goal on its own ----

test(
  'an external condition present before round two lets the goal complete and persist its result',
  { timeout: 30_000 },
  async (t) => {
    let workspace = '';
    let step = 0;
    const url = await httpFixture(t, async (body, res) => {
      step++;
      const calls = {
        1: {
          id: 'goal',
          name: 'create_goal',
          input: { objective: 'Copy the trigger to the result', max_goal_rounds: 2 },
        },
        2: { id: 'missing', name: 'read_file', input: { path: 'goal-trigger.txt' } },
        4: { id: 'trigger', name: 'read_file', input: { path: 'goal-trigger.txt' } },
        5: {
          id: 'result',
          name: 'write_file',
          input: { path: 'goal-result.txt', content: 'GOAL-TRIGGER-4471\n' },
        },
        6: {
          id: 'verify',
          name: 'verify_work',
          input: {
            commands: [
              {
                command: process.execPath,
                args: [
                  '-e',
                  "if(require('node:fs').readFileSync('goal-result.txt','utf8')!=='GOAL-TRIGGER-4471\\n')process.exit(1)",
                ],
              },
            ],
            inputs: ['goal-result.txt'],
          },
        },
        7: { id: 'complete', name: 'update_goal', input: { action: 'complete' } },
      };
      if (step === 4) {
        assert.match(JSON.stringify(body.messages), /round 2 of 2/);
        // Release the external condition before the second round's first read, not after the run RPC returns.
        await writeFile(path.join(workspace, 'goal-trigger.txt'), 'GOAL-TRIGGER-4471\n');
      }
      const call = calls[step as keyof typeof calls];
      sendFrames(res, frames(call ? 'Working' : 'Round finished', call ? [call] : []));
    });
    const host = await startHost(t, { YUANTU_BASE_URL: url });
    workspace = host.root;
    const { client } = await connectClient(host);
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    let runs = 0;
    client.subscribe((event) => {
      if (event.type === 'run.started') runs++;
      if (event.type === 'approval.required')
        void client.request('approval.respond', {
          approvalId: String(event.data.approvalId),
          allow: true,
        });
    });
    const session = await client.request('session.create', {});
    const result = await client.run(session.id, 'Wait for the external trigger and copy it');
    assert.equal(result.status, 'completed', result.error);
    assert.equal(runs, 2);
    assert.equal(
      await readFile(path.join(workspace, 'goal-result.txt'), 'utf8'),
      'GOAL-TRIGGER-4471\n',
    );
    const goal = await client.request('goal.get', { sessionId: session.id });
    assert.equal(goal?.status, 'completed');
    assert.equal(goal?.roundsStarted, 2);
  },
);

test('query convergence does not restart itself through an active goal', async (t) => {
  let requests = 0;
  const url = await httpFixture(t, (body, res) => {
    requests++;
    if (requests === 1)
      sendFrames(
        res,
        frames('Goal started', [
          { id: 'goal', name: 'create_goal', input: { objective: 'Inspect missing.txt' } },
        ]),
      );
    else if (!body.tools?.length || requests > 7)
      sendFrames(res, frames('No new information; the file could not be found.'));
    else
      sendFrames(
        res,
        frames('Reading', [
          { id: 'read-' + requests, name: 'read_file', input: { path: 'missing.txt' } },
        ]),
      );
  });
  const host = await startHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  let runs = 0;
  client.subscribe((event) => {
    if (event.type === 'run.started') runs++;
  });
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, '检查 missing.txt');
  assert.equal(result.status, 'completed', result.error);
  assert.equal(runs, 1, 'an unchanged-query conclusion cannot buy automatic goal continuations');
  assert.equal((await client.request('goal.get', { sessionId: session.id }))?.status, 'active');
});
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
    /**
     * The first round does substantive work before it ends.
     *
     * A continuation round that only narrates now stops the loop — a completed round with no real tool activity
     * is not progress, and continuing would buy a model request per round for nothing. This fixture therefore has
     * the round inspect the workspace, which is what a real round continuing a goal would do.
     */
    else if (step === 2)
      sendFrames(
        res,
        frames('Round one is done.', [
          { id: 'inspect-1', name: 'search_files', input: { query: 'migration' } },
        ]),
      );
    else if (step === 3) sendFrames(res, frames('Round one is done.'));
    else if (step === 4)
      sendFrames(
        res,
        frames('Goal complete.', [
          { id: 'goal-2', name: 'update_goal', input: { action: 'complete' } },
        ]),
      );
    else sendFrames(res, frames('Done.'));
  });
  const host = await startHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
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
  const continuationPrompt = prompts.find((prompt) => /round 2 of 256/.test(prompt));
  assert.ok(continuationPrompt, 'the continuation round carried the goal prompt');
  assert.match(continuationPrompt, /Ship the migration/);
  assert.match(host.stderr(), /\[goal\] round 2/);
  // The line is written before the reply is sent, but on another pipe: waiting for it is what makes this an
  // assertion about the Host rather than about which pipe won the race.
  await waitForStderr(host, /\[goal\] stopped after 1 round\(s\): goal/);
  // The goal is durable state, so the round the Host ran wrote itself into the log the client reads back.
  const goal = await client.request('goal.get', { sessionId: session.id });
  assert.equal(goal?.status, 'completed');
});

test('a continuation round that only repeats earlier work does not buy another one', async (t) => {
  let step = 0;
  const url = await httpFixture(t, (_body, res) => {
    step++;
    if (step === 1)
      sendFrames(
        res,
        frames('Creating the goal.', [
          { id: 'goal-1', name: 'create_goal', input: { objective: 'Find the parser' } },
        ]),
      );
    // Every even request reads the same missing file and gets the same answer; every odd one ends the round.
    else if (step % 2 === 0)
      sendFrames(
        res,
        frames('Reading.', [
          { id: `read-${step}`, name: 'read_file', input: { path: 'missing.txt' } },
        ]),
      );
    else sendFrames(res, frames('Still looking.'));
  });
  const host = await startHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  let runs = 0;
  client.subscribe((event) => {
    if (event.type === 'run.started') runs++;
  });
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Find the parser');
  assert.equal(result.status, 'completed', result.error);
  assert.equal(runs, 2, 'one continuation, which learned nothing the first round had not');
  await waitForStderr(host, /\[goal\] stopped after 1 round\(s\): no-progress/);
  // The goal says so too, so the window does not show an active goal that has silently gone quiet.
  const goal = await client.request('goal.get', { sessionId: session.id });
  assert.equal(goal?.status, 'active');
  assert.equal(goal?.standDown?.reason, 'no-progress');
  assert.equal(goal?.standDown?.continuations, 1);
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
  const host = await startHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
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
  const host = await startHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
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
  let workspace = '';
  const host = await startHost(t, { YUANTU_BASE_URL: url }, (dbPath) => {
    const store = new SessionStore(dbPath);
    try {
      const session = store.create(path.dirname(dbPath));
      seeded = session.id;
      workspace = path.dirname(dbPath);
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
  // A definition the run can actually satisfy: a task with no criteria is no longer a vacuous pass, and this
  // test is about the goal loop standing down, not about verification.
  await writeFile(path.join(workspace, 'marker.txt'), 'ok');
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const task = await client.request('task.create', {
    sessionId: seeded,
    title: 'Ship it',
    description: 'Ship the migration',
    acceptance: [
      {
        description: 'marker file matches',
        met: false,
        check: { id: 'marker', kind: 'file-contains', path: 'marker.txt', expected: 'ok' },
      },
    ],
  });
  const result = await client.run(seeded, 'Ship the migration', { taskId: task.id });
  assert.equal(result.status, 'completed', result.error);
  // One round ran and no continuation followed it: a task attempt's evidence would not survive rounds
  // appended outside the attempt that is being verified.
  assert.equal(prompts.length, 1, prompts.join('\n---\n'));
  assert.doesNotMatch(host.stderr(), /\[goal\] round/);
});
