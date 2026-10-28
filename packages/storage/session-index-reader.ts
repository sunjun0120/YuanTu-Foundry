import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, type Session } from './session-schema.ts';
import { SessionSearch, type SessionListPage } from './session-search.ts';

/**
 * Listing another workspace's conversations without owning its database.
 *
 * The desktop searches every project's index at once and must not start a Host per project to do it, so it reads
 * the files directly. That is only safe while the reader and the writer agree on the layout: a database a newer
 * Host migrated, or one an older Host never upgraded, would be read with this build's queries and answer with
 * wrong rows or a raw SQLite error. The version check makes that disagreement an explicit, per-workspace error,
 * and keeping the queries here keeps the schema knowledge inside `storage` instead of spreading it to the app.
 */
export function listSessionsReadOnly(
  file: string,
  query: string,
  workspace: string,
  page: SessionListPage = {},
): Session[] {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version !== SCHEMA_VERSION)
      throw new Error(
        `Session database schema v${version} does not match this build (v${SCHEMA_VERSION}); open the project to upgrade it`,
      );
    const reader: SessionSearch = new SessionSearch({
      db,
      // A read-only reader has no pending appends to write.
      flush() {},
      get(id) {
        const [session] = reader.list('', undefined, { id });
        if (!session) throw new Error(`Session not found: ${id}`);
        return session;
      },
    });
    return reader.list(query, workspace, page);
  } finally {
    db.close();
  }
}
