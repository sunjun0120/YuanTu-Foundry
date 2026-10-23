import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cachedStatement } from '../packages/storage/statement-cache.ts';
import { storeFixture } from './temp-fixture.ts';

test('a statement is prepared once per connection and reused', () => {
  const first = new DatabaseSync(':memory:');
  const second = new DatabaseSync(':memory:');
  try {
    const sql = 'SELECT ? AS value';
    assert.equal(cachedStatement(first, sql), cachedStatement(first, sql));
    // Another connection has its own: a statement belongs to the connection that prepared it.
    assert.notEqual(cachedStatement(first, sql), cachedStatement(second, sql));
    assert.equal(cachedStatement(first, sql).get(7)?.value, 7);
  } finally {
    first.close();
    second.close();
  }
});

test('recording events does not prepare SQL again for every event', async (t) => {
  const { store, session } = await storeFixture(t, 'yuantu-statement-cache-');
  let prepared = 0;
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    prepared++;
    return original.call(this, sql);
  } as typeof original;
  t.after(() => {
    DatabaseSync.prototype.prepare = original;
  });
  store.recordEvent(session.id, 'todo.written', { todos: [] });
  store.lastSeq(session.id);
  const warm = prepared;
  for (let index = 0; index < 50; index++) {
    store.recordEvent(session.id, 'todo.written', { todos: [] });
    store.lastSeq(session.id);
  }
  assert.ok(prepared - warm <= 5, `prepared ${prepared - warm} statements for 50 events`);
});
