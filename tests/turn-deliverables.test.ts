import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { storeFixture } from './temp-fixture.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { PresentedFile } from '../packages/protocol/deliverables.ts';

const file = (description: string): PresentedFile => ({
  path: 'report.md',
  description,
  bytes: 10,
  sha256: 'a'.repeat(64),
  at: '2026-10-29T00:00:00Z',
});

test('legacy presentation logs without run events retain each visible question interval', async (t) => {
  const { store, session } = await storeFixture(t, 'yuantu-legacy-deliverables-');
  store.append(session.id, { role: 'user', content: 'first question' });
  store.recordEvent(session.id, 'deliverable.presented', { files: [file('first')] });
  store.append(session.id, {
    role: 'user',
    content: '<runtime-context source="x">state</runtime-context>',
  });
  store.append(session.id, { role: 'assistant', content: 'first answer', toolCalls: [] });
  store.append(session.id, { role: 'user', content: 'second question' });
  store.recordEvent(session.id, 'deliverable.presented', { files: [file('second')] });
  store.append(session.id, { role: 'assistant', content: 'second answer', toolCalls: [] });
  assert.deepEqual(
    store.turnDeliverables(session.id).map((entry) => [entry.description, entry.afterIndex]),
    [
      ['first', 2],
      ['second', 4],
    ],
  );
});

test('turn deliverables preserve repeated paths across runs and survive reopening the log', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-turn-deliverables-'));
  const db = path.join(root, 'sessions.sqlite');
  let store = new SessionStore(db);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  for (const [runId, description] of [
    ['r1', 'first'],
    ['r2', 'second'],
  ]) {
    store.append(session.id, { role: 'user', content: description! });
    store.recordEvent(session.id, 'run.started', { runId });
    store.recordEvent(session.id, 'deliverable.presented', { files: [file(description!)] });
    store.append(session.id, { role: 'assistant', content: description!, toolCalls: [] });
    store.recordEvent(session.id, 'run.finished', { runId, status: 'completed' });
  }
  const read = () =>
    store.stateOf<{ files: PresentedFile[] }>('turnDeliverables', session.id).files;
  assert.deepEqual(
    read().map((entry) => [entry.description, entry.runId, entry.afterIndex]),
    [
      ['first', 'r1', 1],
      ['second', 'r2', 3],
    ],
  );
  assert.deepEqual(
    store.deliverables(session.id).map((entry) => entry.description),
    ['second'],
  );
  store.close();
  store = new SessionStore(db);
  assert.deepEqual(
    read().map((entry) => entry.description),
    ['first', 'second'],
  );
});

test('a running presentation has no final position, replaces within its run, and settles on interruption', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-turn-interrupt-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'make a report' });
  store.recordEvent(session.id, 'run.started', { runId: 'r1' });
  store.recordEvent(session.id, 'deliverable.presented', { files: [file('draft')] });
  store.recordEvent(session.id, 'deliverable.presented', { files: [file('final')] });
  let files = store.stateOf<{ files: PresentedFile[] }>('turnDeliverables', session.id).files;
  assert.equal(files.length, 1);
  assert.equal(files[0]?.description, 'final');
  assert.equal(files[0]?.afterIndex, undefined);
  store.append(session.id, {
    role: 'user',
    content: '<runtime-context source="x">state</runtime-context>',
  });
  store.append(session.id, {
    role: 'tool',
    toolCallId: 'present',
    content: 'presented',
    isError: false,
  });
  store.recordEvent(session.id, 'run.interrupted', { runId: 'r1' });
  files = store.stateOf<{ files: PresentedFile[] }>('turnDeliverables', session.id).files;
  assert.equal(files[0]?.afterIndex, 2);
});
