import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createShutdown, serveHost } from '../apps/agent-host/lifecycle.ts';
import type { HostContext } from '../apps/agent-host/state.ts';

function host(dispose: () => Promise<void>) {
  const closed: string[] = [];
  const ctx = {
    closing: false,
    active: new Map(),
    approvals: new Map(),
    questions: new Map(),
    tasks: new Set(),
    announced: new Set(),
    stopObservingBackground() {},
    scheduler: { start() {}, stop() {} },
    queueWake() {},
    residency: { disposeAll: dispose },
    carrier: {
      async attach() {
        return (async function* () {})();
      },
      close() {
        closed.push('carrier');
      },
    },
    terminals: {
      async closeAllAndWait() {
        closed.push('terminals');
      },
    },
    background: {
      async close() {
        closed.push('background');
      },
    },
    store: {
      close() {
        closed.push('store');
      },
    },
    hooks: {
      async close() {
        closed.push('hooks');
      },
    },
  } as unknown as HostContext;
  return { ctx, closed };
}

test('Host shutdown waits for resident finalizers before closing its store', async () => {
  let release!: () => void;
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { ctx, closed } = host(async () => {
    started();
    await pending;
  });
  const serving = serveHost(ctx);
  try {
    await admitted;
    await setImmediate();
    assert.equal(closed.includes('carrier'), true, 'the carrier closes to unblock input');
    assert.equal(closed.includes('store'), false, 'resident finalizers still own the store');
  } finally {
    release();
    await serving;
  }
  assert.deepEqual(closed, ['carrier', 'terminals', 'background', 'store', 'hooks']);
});

test('Host shutdown reports resident cleanup failure and still releases other resources', async (t) => {
  const failure = new Error('resident release refused');
  const reports: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    reports.push(String(chunk));
    return true;
  });
  const { ctx, closed } = host(async () => {
    throw failure;
  });
  await assert.rejects(
    serveHost(ctx),
    (error: unknown) => error instanceof AggregateError && error.errors.includes(failure),
  );
  assert.match(reports.join(''), /resident.*cleanup.*failed.*resident release refused/i);
  assert.deepEqual(closed, ['carrier', 'terminals', 'background', 'store', 'hooks']);
});

test('repeated shutdown signals start resident cleanup only once', async () => {
  let calls = 0;
  const { ctx, closed } = host(async () => {
    calls++;
  });
  const shutdown = createShutdown(ctx);
  shutdown();
  shutdown();
  await setImmediate();
  assert.equal(calls, 1);
  assert.deepEqual(closed, ['carrier']);
});

for (const seam of ['attach', 'terminals', 'store'] as const) {
  test(`Host keeps both the resident and ${seam} failure while closing remaining resources`, async (t) => {
    const residentFailure = new Error('resident release refused');
    const otherFailure = new Error(`${seam} refused`);
    t.mock.method(process.stderr, 'write', () => true);
    const { ctx, closed } = host(async () => {
      throw residentFailure;
    });
    if (seam === 'attach')
      t.mock.method(ctx.carrier, 'attach', async () => {
        throw otherFailure;
      });
    else if (seam === 'terminals')
      t.mock.method(ctx.terminals, 'closeAllAndWait', async () => {
        closed.push('terminals');
        throw otherFailure;
      });
    else
      t.mock.method(ctx.store, 'close', () => {
        closed.push('store');
        throw otherFailure;
      });
    await assert.rejects(
      serveHost(ctx),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.includes(residentFailure) &&
        error.errors.includes(otherFailure),
    );
    assert.deepEqual(closed, ['carrier', 'terminals', 'background', 'store', 'hooks']);
  });
}
