import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * Prepared statements kept per connection, for the SQL the store runs on every event.
 *
 * `db.prepare` parses and compiles its SQL each time, and the journal used to call it for every recorded event,
 * every `PRAGMA data_version` check and every hydration read — synchronous work on the Host's one event loop,
 * paid again for text that never changes. A statement is reusable as long as one call finishes with it before
 * the next begins, which `get`, `run` and `all` do; a caller that `iterate`s must prepare its own, because a
 * second use of the same statement mid-iteration would reset it.
 *
 * Keyed by connection so a closed store's statements go with it, and bounded per connection because a few
 * callers build their SQL (an `IN` list sized to its arguments); past the bound the oldest is dropped and simply
 * prepared again when next asked for.
 */
const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
const MAX_STATEMENTS_PER_CONNECTION = 128;

export function cachedStatement(db: DatabaseSync, sql: string): StatementSync {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    if (cache.size >= MAX_STATEMENTS_PER_CONNECTION) cache.delete(cache.keys().next().value!);
    cache.set(sql, statement);
  }
  return statement;
}
