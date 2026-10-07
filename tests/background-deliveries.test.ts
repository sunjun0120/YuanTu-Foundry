import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import {
  backgroundState,
  reconcileBackground,
  setBackgroundPolicy,
  admitBackground,
  finishBackground,
} from '../packages/core/background-deliveries.ts';

test('durable completion identities, collection, admission and budget survive projection rebuilds', () => {
  const store = new SessionStore(':memory:');
  try {
    const id = store.create(process.cwd()).id;
    store.recordEvent(id, 'command.started', { id: 'job' });
    store.recordEvent(id, 'command.settled', { id: 'job', status: 'completed' });
    store.recordEvent(id, 'command.settled', { id: 'job', status: 'completed' });
    reconcileBackground(store, id);
    reconcileBackground(store, id);
    assert.equal(backgroundState(store, id).deliveries.length, 1);
    assert.equal(admitBackground(store, id), undefined);
    setBackgroundPolicy(store, id, { mode: 'auto', paused: false, maxWakeups: 1, maxRunMs: 1000 });
    const admitted = admitBackground(store, id)!;
    assert.equal(admitted.ids.length, 1);
    assert.equal(backgroundState(store, id).policy.used, 1);
    assert.equal(admitBackground(store, id), undefined);
    finishBackground(store, id, admitted.ids, 'completed');
    assert.equal(backgroundState(store, id).deliveries[0]!.state, 'processed');
    setBackgroundPolicy(store, id, { mode: 'auto', paused: false, maxWakeups: 1, maxRunMs: 1000 });
    store.recordEvent(id, 'command.started', { id: 'next' });
    store.recordEvent(id, 'command.settled', { id: 'next', status: 'failed' });
    reconcileBackground(store, id);
    assert.equal(admitBackground(store, id), undefined);
    store.recordEvent(id, 'command.collected', { ids: ['next'] });
    reconcileBackground(store, id);
    assert.equal(backgroundState(store, id).deliveries[1]!.reason, 'collected');
  } finally {
    store.close();
  }
});

test('child follow-up outcomes are distinct and cancelled work only notifies', () => {
  const store = new SessionStore(':memory:');
  try {
    const id = store.create(process.cwd()).id;
    store.recordEvent(id, 'subagent.assigned', { id: 'child', childSessionId: 'session' });
    store.recordEvent(id, 'subagent.finished', {
      id: 'child',
      sessionId: 'session',
      status: 'completed',
    });
    store.recordEvent(id, 'subagent.collected', { ids: ['child'] });
    store.recordEvent(id, 'subagent.finished', {
      id: 'child',
      sessionId: 'session',
      status: 'completed',
    });
    store.recordEvent(id, 'command.started', { id: 'killed' });
    store.recordEvent(id, 'command.settled', { id: 'killed', status: 'cancelled' });
    reconcileBackground(store, id);
    assert.deepEqual(
      backgroundState(store, id).deliveries.map((x) => x.state),
      ['processed', 'pending', 'pending'],
    );
    setBackgroundPolicy(store, id, { mode: 'auto', paused: false, maxWakeups: 2, maxRunMs: 1000 });
    assert.equal(admitBackground(store, id)!.ids.length, 1);
    setBackgroundPolicy(
      store,
      id,
      { mode: 'auto', paused: true, maxWakeups: 2, maxRunMs: 1000 },
      true,
    );
    assert.equal(admitBackground(store, id), undefined);
  } finally {
    store.close();
  }
});

test('event observers receive only committed events, isolated from listener errors and mutation', () => {
  const store = new SessionStore(':memory:');
  try {
    const id = store.create(process.cwd()).id;
    const observed: string[] = [];
    const off = store.observeEvents(
      (event) => {
        observed.push(String(event.data.id));
        event.data.id = 'modified';
        throw Error('listener');
      },
      new Set(['command.started']),
    );
    // The transaction seam is exercised independently of cache presence.
    const transaction = (store as unknown as { transaction<T>(fn: () => T): T }).transaction.bind(
      store,
    );
    assert.throws(() =>
      transaction(() => {
        store.recordEvent(id, 'command.started', { id: 'rolled-back' });
        throw Error('rollback');
      }),
    );
    assert.deepEqual(observed, []);
    transaction(() => store.recordEvent(id, 'command.started', { id: 'committed' }));
    assert.deepEqual(observed, ['committed']);
    assert.equal(store.events(id).at(-1)!.data.id, 'committed');
    off();
    store.recordEvent(id, 'command.started', { id: 'after' });
    assert.deepEqual(observed, ['committed']);
  } finally {
    store.close();
  }
});

test('restart retains acceptance and spent budget; explicit reset does not replay an accepted result', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'yuantu-wake-'));
  const file = path.join(root, 'sessions.sqlite');
  let store = new SessionStore(file);
  try {
    const id = store.create(root).id;
    store.recordEvent(id, 'command.started', { id: 'one' });
    store.recordEvent(id, 'command.settled', { id: 'one', status: 'completed' });
    setBackgroundPolicy(store, id, { mode: 'auto', paused: false, maxWakeups: 1, maxRunMs: 1000 });
    assert.ok(admitBackground(store, id));
    store.close();
    store = new SessionStore(file);
    assert.equal(backgroundState(store, id).policy.used, 1);
    assert.equal(backgroundState(store, id).deliveries[0]?.state, 'admitted');
    assert.equal(admitBackground(store, id), undefined);
    setBackgroundPolicy(
      store,
      id,
      { mode: 'auto', paused: false, maxWakeups: 1, maxRunMs: 1000 },
      true,
    );
    assert.equal(admitBackground(store, id), undefined);
    store.recordEvent(id, 'command.started', { id: 'unsafe' });
    store.recordEvent(id, 'command.settled', {
      id: 'unsafe',
      status: 'failed',
      cleanupConfirmed: false,
    });
    assert.equal(admitBackground(store, id), undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('repeated child completion frames with the same durable child run create one obligation', () => {
  const store = new SessionStore(':memory:');
  try {
    const id = store.create(process.cwd()).id;
    store.recordEvent(id, 'subagent.assigned', { id: 'task', childSessionId: 'child' });
    for (let i = 0; i < 2; i++)
      store.recordEvent(id, 'subagent.finished', {
        id: 'task',
        sessionId: 'child',
        childRunId: 'turn-1',
        status: 'completed',
      });
    assert.equal(reconcileBackground(store, id).deliveries.length, 1);
    store.recordEvent(id, 'subagent.collected', { ids: ['child'] });
    store.recordEvent(id, 'subagent.finished', {
      id: 'task',
      sessionId: 'child',
      childRunId: 'turn-2',
      status: 'completed',
    });
    assert.deepEqual(
      reconcileBackground(store, id).deliveries.map((d) => d.state),
      ['processed', 'pending'],
    );
  } finally {
    store.close();
  }
});
