/**
 * Releasing a resident child: what `dispose` waits for, what it repeats, and who owns a release that failed.
 *
 * `disposeAll` is the parent run's last action, so its mistakes are the expensive kind: a turn that is still
 * unwinding when its tools close finds its own registry gone; a single failing close that stops the loop leaves
 * every deeper activation resident forever; and a release whose promise nobody looks at turns a failed cleanup
 * into a process-killing unhandled rejection at exactly the moment the run is trying to stop. The contract these
 * tests pin down is small enough to state:
 *
 * - `dispose` blocks new turns, aborts what is in flight, then *waits* for that turn to finish unwinding before
 *   it closes anything.
 * - A successful release happens once, and concurrent callers wait on that one attempt.
 * - A *failed* close is not cached as a release: the activation is still unreleased, so a later `dispose` tries
 *   again (that is the close owner's decision to make, and retrying is what "still owned" means here).
 * - Eviction and expiry hand their release to the residency, which observes the result immediately and reports
 *   it from `disposeAll` instead of dropping it.
 * - `disposeAll` releases everything, deepest first, and reports every failure as one `AggregateError` — it does
 *   not stop at the first one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SubAgentResidency,
  type ResidentTurnResult,
} from '../packages/core/subagents/residency.ts';

const idle: ResidentTurnResult = {
  usage: { inputTokens: 1, outputTokens: 1 },
  text: 'done',
  status: 'completed',
  rounds: 1,
  toolCalls: 0,
};
const idleTurn = async () => idle;

function activation(
  residency: SubAgentResidency,
  id: string,
  overrides: {
    depth?: number;
    turn?: () => Promise<ResidentTurnResult>;
    close?: () => Promise<void>;
  } = {},
) {
  return residency.open({
    id,
    childSessionId: `child-${id}`,
    parentSessionId: 'parent',
    objective: id,
    depth: overrides.depth ?? 1,
    turn: overrides.turn ?? idleTurn,
    ...(overrides.close ? { close: overrides.close } : {}),
  });
}

test('dispose waits for the turn in flight before it closes the tools', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closeCalls = 0;
  let unwound = false;
  const residency = new SubAgentResidency();
  const child = activation(residency, 'parked', {
    turn: async () => {
      await gate;
      unwound = true;
      return idle;
    },
    close: async () => {
      closeCalls++;
    },
  });
  const turn = child.run('work', false);
  const disposal = child.dispose();
  // The turn is still parked. Releasing the tools now would close the registry underneath a turn that is still
  // running, which is the ordering the whole cleanup path depends on.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 0, 'the tools were closed while the turn was still in flight');
  release();
  await disposal;
  assert.equal(unwound, true);
  await turn;
  assert.equal(closeCalls, 1);
});

test('a successful dispose is idempotent and concurrent callers share one attempt', async () => {
  let closeCalls = 0;
  let releaseClose = () => {};
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const residency = new SubAgentResidency();
  const child = activation(residency, 'once', {
    close: async () => {
      closeCalls++;
      await closeGate;
    },
  });
  const first = child.dispose();
  const second = child.dispose();
  const third = child.dispose();
  assert.equal(second, first, 'concurrent callers wait on the same release, not three of them');
  assert.equal(third, first);
  releaseClose();
  await Promise.all([first, second, third]);
  assert.equal(closeCalls, 1);
  await child.dispose();
  assert.equal(closeCalls, 1, 'a release that already succeeded is not repeated');
  assert.equal(child.status, 'disposed');
  await assert.rejects(child.run('again', false), /disposed/);
});

test('a close that failed is retried instead of being cached as a release', async () => {
  const failure = new Error('the tool registry would not close');
  let attempts = 0;
  const residency = new SubAgentResidency();
  const child = activation(residency, 'retry', {
    close: async () => {
      attempts++;
      if (attempts === 1) throw failure;
    },
  });
  await assert.rejects(child.dispose(), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
  await child.dispose();
  assert.equal(attempts, 2, 'the failed release is still owned, so the next dispose tries again');
  await child.dispose();
  assert.equal(attempts, 2, 'and the attempt that succeeded is the one that is cached');
});

test('a turn that failed does not become the failure of its release', async () => {
  const failure = new Error('the turn failed');
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closeCalls = 0;
  const residency = new SubAgentResidency();
  const child = activation(residency, 'failed-turn', {
    turn: async () => {
      await gate;
      throw failure;
    },
    close: async () => {
      closeCalls++;
    },
  });
  const turn = child.run('work', false).catch((error: unknown) => error);
  const disposal = child.dispose();
  release();
  await disposal;
  assert.equal(closeCalls, 1, 'the release still happened');
  assert.equal(await turn, failure, 'and the turn kept its own outcome');
});

test('disposeAll attempts every activation despite one failure', async () => {
  const closes: string[] = [];
  const failure = new Error('the grandchild tools refused to close');
  const residency = new SubAgentResidency({ maxResident: 8 });
  activation(residency, 'root-child', {
    depth: 1,
    close: async () => void closes.push('root-child'),
  });
  activation(residency, 'grandchild', {
    depth: 2,
    close: async () => {
      closes.push('grandchild');
      throw failure;
    },
  });
  activation(residency, 'child-2', {
    depth: 1,
    close: async () => void closes.push('child-2'),
  });
  await assert.rejects(residency.disposeAll(), (error: unknown) => {
    assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${String(error)}`);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.deepEqual(
    closes,
    ['grandchild', 'root-child', 'child-2'],
    'the first failure did not stop the releases behind it',
  );
  assert.equal(residency.size, 0);
});

test('errors from idle eviction and expiry are observed, not left unhandled', async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const evictedFailure = new Error('the evicted tools refused to close');
  const expiredFailure = new Error('the expired tools refused to close');
  // One residency exercises both unload paths: opening at the cap evicts the least recently used idle child, and
  // the TTL expiry releases the one that is left.
  const residency = new SubAgentResidency({ maxResident: 1, idleTtlMs: 5 });
  const evicted = activation(residency, 'evicted', {
    close: async () => {
      throw evictedFailure;
    },
  });
  await evicted.run('one', false);
  const expiring = activation(residency, 'expiring', {
    close: async () => {
      throw expiredFailure;
    },
  });
  await expiring.run('one', false);
  assert.equal(residency.size, 1, 'the cap held');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(residency.reapIdle(), 1, 'the idle child expired');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    unhandled,
    [],
    'a failed release belongs to the residency to report, not to the process to crash on',
  );
  await assert.rejects(residency.disposeAll(), (error: unknown) => {
    assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${String(error)}`);
    assert.deepEqual(new Set(error.errors), new Set([evictedFailure, expiredFailure]));
    return true;
  });
  assert.deepEqual(
    unhandled,
    [],
    'reporting them did not turn them back into unhandled rejections',
  );
});

test('a turn asked for while the previous one is still finishing waits for it', async () => {
  /**
   * A turn keeps working after its run ends (an isolated child exports its result), and a message that arrives then
   * starts a new turn. Started at once, the two overlapped and the first one's cleanup marked the live second turn
   * idle — so `interrupt` missed it and `dispose` closed its tools under it.
   */
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let concurrent = 0;
  let peak = 0;
  const order: string[] = [];
  const residency = new SubAgentResidency();
  const child = activation(residency, 'queued', {
    turn: async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      order.push(`start ${order.length}`);
      if (order.length === 1) await firstGate;
      concurrent--;
      return idle;
    },
  });
  const first = child.run('one', false);
  const second = child.run('two', false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(order.length, 1, 'the second turn did not start while the first was live');
  assert.equal(child.status, 'running');
  releaseFirst();
  await first;
  await second;
  assert.equal(peak, 1, 'the two turns never overlapped');
  assert.equal(child.status, 'idle');
});

test('a queued turn that is interrupted or disposed never starts', async () => {
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let starts = 0;
  const residency = new SubAgentResidency();
  const child = activation(residency, 'stopped', {
    turn: async () => {
      starts++;
      if (starts === 1) await firstGate;
      return idle;
    },
  });
  const first = child.run('one', false);
  const queued = child.run('two', false);
  assert.equal(child.interrupt(), true);
  releaseFirst();
  await first;
  await assert.rejects(queued, /Interrupted by the parent agent/);
  assert.equal(starts, 1, 'the interrupted queued turn did not start');
  assert.equal(child.status, 'idle');

  let releaseThird = () => {};
  const thirdGate = new Promise<void>((resolve) => {
    releaseThird = resolve;
  });
  const parked = activation(residency, 'disposed', {
    turn: async () => {
      await thirdGate;
      return idle;
    },
  });
  const running = parked.run('one', false);
  const waiting = parked.run('two', false);
  const disposal = parked.dispose();
  releaseThird();
  await running;
  await assert.rejects(waiting, /disposed/);
  await disposal;
});
