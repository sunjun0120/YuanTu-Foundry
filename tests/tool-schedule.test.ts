/**
 * The sibling-call scheduler: which calls may overlap, and how many at once.
 *
 * The loop used to `await` every tool call in turn, so a message naming four independent reads paid for four
 * round trips of waiting. Overlapping them is only safe for calls whose tool promised it, and the two
 * properties that make the overlap invisible everywhere else are what these tests pin: outcomes come back in
 * model order whatever order they finished in, and nothing is left running when the call returns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupToolCalls, runBounded } from '../packages/core/tool-schedule.ts';
import type { ToolCall } from '../packages/protocol/index.ts';

const call = (id: string): ToolCall => ({ id, name: 'read_file', arguments: { path: id } });
const modes =
  (parallel: Record<string, true>) =>
  (tool: ToolCall): 'parallel' | 'exclusive' =>
    parallel[tool.id] ? 'parallel' : 'exclusive';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('consecutive parallel calls share a group and every exclusive one is a barrier', () => {
  const calls = ['a', 'b', 'c', 'd', 'e'].map(call);
  const groups = groupToolCalls(calls, modes({ a: true, b: true, d: true, e: true }));
  assert.deepEqual(
    groups.map((group) => group.map((entry) => entry.id)),
    [['a', 'b'], ['c'], ['d', 'e']],
  );
  // A single call, and a call list that is entirely exclusive, both keep their own order.
  assert.deepEqual(groupToolCalls([call('a')], modes({ a: true })).length, 1);
  assert.deepEqual(
    groupToolCalls([call('a'), call('b')], modes({})).map((group) => group.length),
    [1, 1],
  );
  assert.deepEqual(groupToolCalls([], modes({})), []);
  // The same call list with everything parallel is one group: adjacency, not a partition by kind.
  assert.deepEqual(
    groupToolCalls(calls, modes({ a: true, b: true, c: true, d: true, e: true })).length,
    1,
  );
});

test('the pool starts in order, keeps to its limit, and replenishes as calls settle', async () => {
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const durations = [80, 20, 20, 60];
  const begun = Date.now();
  const outcomes = await runBounded(durations, 2, async (ms, index) => {
    started.push(index);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(ms);
    inFlight--;
    return index;
  });
  const elapsed = Date.now() - begun;
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
  );
  assert.deepEqual(started, [0, 1, 2, 3], 'started in input order');
  assert.equal(peak, 2, 'never more than the limit');
  // Rolling, not fixed windows: 3 starts while 0 is still running (0 and 1, then 2 when 1 settles), so the
  // total is bounded by the slowest call plus one short one rather than by the sum of each pair.
  assert.ok(elapsed < 80 + 60 + 20, `rolling pool, took ${elapsed}ms`);
});

test('a limit of one is strictly serial', async () => {
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  await runBounded([1, 2, 3], 1, async (value) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    order.push(`start ${value}`);
    await sleep(5);
    order.push(`end ${value}`);
    inFlight--;
    return value;
  });
  assert.equal(peak, 1);
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
});

test('outcomes are positional even when the first call finishes last', async () => {
  const finished: string[] = [];
  const outcomes = await runBounded([60, 5, 5], 3, async (ms, index) => {
    await sleep(ms);
    finished.push(`call ${index}`);
    return `result ${index}`;
  });
  assert.equal(finished.at(-1), 'call 0', 'the slow first call really did finish last');
  assert.deepEqual([...finished.slice(0, 2)].sort(), ['call 1', 'call 2']);
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : outcome.status)),
    ['result 0', 'result 1', 'result 2'],
  );
});

test('a stop refuses new starts, awaits what is running, and reports the rest as skipped', async () => {
  let started = 0;
  let stop = false;
  const outcomes = await runBounded(
    [1, 2, 3, 4],
    2,
    async (value) => {
      started++;
      await sleep(10);
      if (value === 1) stop = true;
      return value;
    },
    () => stop,
  );
  // Item 1 stops the pool; item 2 was already in flight and is awaited; 3 and 4 never begin.
  assert.equal(started, 2);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'fulfilled', 'skipped', 'skipped'],
  );
  assert.deepEqual(outcomes[2], { status: 'skipped' });
});

test('a rejection does not stop the siblings, and quiescence still holds', async () => {
  let running = 0;
  let peak = 0;
  const outcomes = await runBounded([1, 2, 3], 3, async (value) => {
    running++;
    peak = Math.max(peak, running);
    await sleep(value === 1 ? 30 : 10);
    running--;
    if (value === 1) throw new Error('boom');
    return value;
  });
  assert.equal(peak, 3, 'all three really were in flight when one failed');
  assert.equal(outcomes[0]!.status, 'rejected');
  assert.match(String((outcomes[0] as { reason: Error }).reason.message), /boom/);
  assert.deepEqual(
    outcomes
      .slice(1)
      .map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : outcome.status)),
    [2, 3],
  );
  assert.equal(running, 0, 'every started call settled before the pool returned');
});
