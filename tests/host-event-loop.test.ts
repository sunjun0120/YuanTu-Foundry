import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoopMonitor, type LoopStall } from '../apps/agent-host/event-loop-health.ts';

const busy = (ms: number): void => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Hold the thread, as a synchronous query or directory walk would.
  }
};

test('a late probe below the threshold is not a stall', () => {
  const reported: LoopStall[] = [];
  const monitor = new EventLoopMonitor({
    thresholdMs: 100,
    activity: () => ({ sessions: [], operations: 0, requests: [] }),
    report: (stall) => reported.push(stall),
  });
  assert.equal(monitor.observe(99), undefined);
  assert.equal(monitor.observe(Number.NaN), undefined);
  assert.deepEqual(reported, []);
  assert.deepEqual(monitor.snapshot().stalls, []);
});

test('a stall records what the Host was doing at that moment', () => {
  const reported: LoopStall[] = [];
  const monitor = new EventLoopMonitor({
    thresholdMs: 100,
    activity: () => ({ sessions: ['a', 'b'], operations: 1, requests: ['context.compact'] }),
    report: (stall) => reported.push(stall),
  });
  const stall = monitor.observe(340.6);
  assert.ok(stall);
  assert.equal(stall.durationMs, 341);
  assert.deepEqual(stall.sessions, ['a', 'b']);
  assert.equal(stall.operations, 1);
  assert.deepEqual(stall.requests, ['context.compact']);
  assert.deepEqual(reported, [stall]);
  assert.deepEqual(monitor.snapshot().stalls, [stall]);
});

test('only the most recent stalls are kept, and a failing reporter or activity is contained', () => {
  const monitor = new EventLoopMonitor({
    thresholdMs: 10,
    activity: () => {
      throw new Error('state torn down');
    },
    report: () => {
      throw new Error('EPIPE');
    },
  });
  for (let index = 0; index < 25; index++) monitor.observe(10 + index);
  const stalls = monitor.snapshot().stalls;
  assert.equal(stalls.length, 20);
  assert.equal(stalls.at(-1)?.durationMs, 34);
  assert.deepEqual(stalls[0]?.sessions, []);
});

test('a real synchronous stretch is caught by the probe and the histogram', async () => {
  const reported: LoopStall[] = [];
  const monitor = new EventLoopMonitor({
    thresholdMs: 80,
    probeMs: 20,
    activity: () => ({ sessions: ['s1'], operations: 0, requests: [] }),
    report: (stall) => reported.push(stall),
  });
  monitor.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    busy(250);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const health = monitor.snapshot();
    assert.ok(reported.length >= 1, 'the stall was reported');
    assert.ok(reported[0]!.durationMs >= 80);
    assert.deepEqual(reported[0]!.sessions, ['s1']);
    assert.ok(health.delay.max >= 80, `max delay ${health.delay.max}`);
    assert.equal(health.thresholdMs, 80);
  } finally {
    monitor.stop();
  }
});
