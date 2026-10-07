/**
 * The rounds a goal may start on its own.
 *
 * Until this existed, a goal was only read: the next run in the session was told about it, and nothing ever
 * started that run. These tests pin the three things that make autonomous continuation safe to have at all —
 * *when* it continues, *what* it says, and *what stops it* — because a loop like this one is the difference
 * between "the session keeps working" and "the session spends without anyone watching".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { goalContinuation, runGoalRounds } from '../packages/core/goal-driver.ts';
import type { Goal } from '../packages/protocol/goals.ts';

const goal = (over: Partial<Goal> = {}): Goal => ({
  objective: 'Ship the migration',
  status: 'active',
  roundsStarted: 1,
  maxGoalRounds: 256,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  ...over,
});

test('only an active goal with rounds left asks for another round', () => {
  assert.equal(
    goalContinuation(goal())?.round,
    2,
    'the next round is the one after the ones already taken',
  );
  assert.equal(goalContinuation(null), undefined);
  assert.equal(goalContinuation(undefined), undefined);
  for (const status of ['paused', 'completed', 'blocked'] as const)
    assert.equal(
      goalContinuation(goal({ status })),
      undefined,
      `${status} is an answer, not a pause to continue past`,
    );
  assert.equal(
    goalContinuation(goal({ roundsStarted: 256, maxGoalRounds: 256 })),
    undefined,
    'a spent budget stops the loop even though the goal is still active',
  );
});

test('the continuation carries the objective, the count, and what "keep going" means', () => {
  const continuation = goalContinuation(
    goal({ objective: 'Ship the migration', roundsStarted: 7 }),
  )!;
  assert.match(continuation.prompt, /Ship the migration/);
  assert.match(continuation.prompt, /round 8 of 256/);
  // A run started by a loop has no human turn behind it, so the prompt has to say how to finish — otherwise the
  // model's most likely move is to stop and ask.
  assert.match(continuation.prompt, /do not ask for confirmation/i);
  assert.match(continuation.prompt, /update_goal \{ action: "complete" \}/);
  assert.match(continuation.prompt, /action: "blocked"/);
});

test('the loop continues while the goal asks, and reports why it stopped', async () => {
  let rounds = 0;
  const outcome = await runGoalRounds({
    runOnce: async () => {
      rounds++;
      return { status: 'completed' };
    },
    // The goal stays active for three continuations, then completes itself.
    goalOf: () => goal({ status: rounds >= 3 ? 'completed' : 'active', roundsStarted: 1 + rounds }),
    maxContinuations: 10,
  });
  assert.deepEqual(outcome, { continuations: 3, stopped: 'goal' });
  assert.equal(rounds, 3);
});

test('a round that did not finish stops the loop instead of being retried', async () => {
  for (const status of ['failed', 'cancelled'] as const) {
    let rounds = 0;
    const outcome = await runGoalRounds({
      runOnce: async () => {
        rounds++;
        return { status };
      },
      goalOf: () => goal(),
      maxContinuations: 10,
    });
    assert.deepEqual(outcome, { continuations: 1, stopped: 'run' }, status);
    assert.equal(rounds, 1, 'one broken round is not an invitation to start another');
  }
});

test('the loop has its own bound, because the goal budget is something the model can raise', async () => {
  /**
   * `update_goal` may raise `max_goal_rounds`, so a loop whose only bound is that number is a loop the thing it
   * bounds can extend. The host's own ceiling is the second key, and it is what these tests pin.
   */
  const seen: number[] = [];
  let rounds = 0;
  const outcome = await runGoalRounds({
    runOnce: async () => {
      rounds++;
      return { status: 'completed' };
    },
    // The kernel admits a round when a run starts, which is what advances the count — so the fake advances it
    // too, or every iteration would read the same goal and ask for the same round.
    goalOf: () => goal({ roundsStarted: 1 + rounds }),
    maxContinuations: 4,
    onRound: (continuation) => seen.push(continuation.round),
  });
  assert.deepEqual(outcome, { continuations: 4, stopped: 'rounds' });
  assert.deepEqual(seen, [2, 3, 4, 5]);
});

test('a spent budget is reported so the caller can record it, not left looking active', async () => {
  /**
   * `active` is what tells the next request to start another round, so a goal that will never be continued has
   * to say so — otherwise the model's next turn and the user's card are both told more work is coming. The loop
   * reports it and the caller writes it, because the driver owns no store.
   */
  const exhausted: Goal[] = [];
  let rounds = 0;
  const outcome = await runGoalRounds({
    runOnce: async () => {
      rounds++;
      return { status: 'completed' };
    },
    goalOf: () => goal({ roundsStarted: 1 + rounds, maxGoalRounds: 2 }),
    maxContinuations: 10,
    onExhausted: (value) => exhausted.push(value),
  });
  assert.deepEqual(outcome, { continuations: 1, stopped: 'goal' });
  assert.equal(exhausted.length, 1, 'the verdict is reported once, when the loop stops');
  assert.equal(exhausted[0]!.roundsStarted, 2);
  // A goal that stopped for any *other* reason is not exhausted, and must not be reported as if it were.
  for (const status of ['paused', 'completed', 'blocked'] as const) {
    const reported: Goal[] = [];
    await runGoalRounds({
      runOnce: async () => ({ status: 'completed' }),
      goalOf: () => goal({ status, roundsStarted: 9, maxGoalRounds: 9 }),
      maxContinuations: 3,
      onExhausted: (value) => reported.push(value),
    });
    assert.deepEqual(reported, [], status);
  }
});

test('cancellation stops the loop before it starts another round', async () => {
  const controller = new AbortController();
  let rounds = 0;
  const outcome = await runGoalRounds({
    runOnce: async () => {
      rounds++;
      controller.abort();
      return { status: 'completed' };
    },
    goalOf: () => goal(),
    maxContinuations: 10,
    signal: controller.signal,
  });
  assert.deepEqual(outcome, { continuations: 1, stopped: 'cancelled' });
  assert.equal(rounds, 1);
});
