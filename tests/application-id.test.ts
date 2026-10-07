import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  APPLICATION_FORMAT,
  APPLICATION_ID,
  APPLICATION_NAME,
  SCHEMA_VERSION,
  SessionStore,
} from '../packages/storage/sqlite.ts';

/**
 * The file says what it is.
 *
 * The failure this guards against is the expensive one: our `CREATE TABLE IF NOT EXISTS` statements applied on
 * top of a stranger's SQLite file, discovered later as a query that cannot find one of our columns. So the
 * question has to be answered *before* the first of those statements runs, and the answer has to work for three
 * states — a file of ours, a brand new one, and one that belongs to somebody else.
 *
 * The identity is a marker row rather than SQLite's `PRAGMA application_id` because this runtime's binding will
 * not write that pragma to the file: it applies to the connection and the header keeps its zero. The first test
 * below is that measurement, so the reason for the design is checked rather than remembered.
 */
async function scratch(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-application-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
/** The marker row, or nothing — read without opening the file as a session store. */
function markerOf(file: string): { application: string; format: number } | undefined {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT application,format FROM application_marker LIMIT 1').get() as
      { application?: unknown; format?: unknown } | undefined;
    // Coerced for the same reason `SessionStore.marker` does it: INTEGER columns come back as BigInt here, and
    // `{format: 1}` is not equal to `{format: 1n}`.
    return row ? { application: String(row.application), format: Number(row.format) } : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
function tablesOf(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
}
function columnsOf(file: string, table: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
}

test('PRAGMA application_id is why the identity is a row: this binding never writes it to the file', async (t) => {
  /**
   * The measurement the design rests on, kept as a test because it is a property of the *runtime* rather than of
   * this repository: if a future Node writes that pragma, the note in `sqlite.ts` is stale and somebody should
   * find out from a failing assertion rather than from an archaeology session.
   */
  const root = await scratch(t);
  const file = path.join(root, 'pragma.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t (a TEXT)');
  db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
  db.exec('PRAGMA user_version=7');
  const sameConnection = db.prepare('PRAGMA application_id').get()?.application_id;
  db.close();
  const reopened = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      Number(reopened.prepare('PRAGMA user_version').get()?.user_version),
      7,
      'user_version does persist, so this is about the pragma and not about writing at all',
    );
    assert.equal(
      Number(reopened.prepare('PRAGMA application_id').get()?.application_id),
      0,
      'the pragma does not: the header keeps its zero',
    );
  } finally {
    reopened.close();
  }
  assert.equal(
    Number(sameConnection),
    0,
    'and the connection does not remember it either, which is why nothing depends on it',
  );
});

test('a database this build creates carries the marker, and can be reopened', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'Hello' });
  store.close();

  assert.deepEqual(markerOf(file), { application: APPLICATION_NAME, format: APPLICATION_FORMAT });
  // Reopening is the ordinary path: the check must not refuse our own file.
  const reopened = new SessionStore(file);
  assert.equal(reopened.messages(session.id).length, 1, 'and the session is still there');
  reopened.close();
});

test("another application's database is refused by name, before any of our schema is applied", async (t) => {
  /**
   * Both halves are asserted: the error names the file and the evidence, and the stranger's database is
   * untouched. The second half is what a caller depends on — a check that reported the problem after creating
   * fifty of our tables would be a check that found the problem too late.
   */
  const root = await scratch(t);
  const file = path.join(root, 'not-ours.sqlite');
  const theirs = new DatabaseSync(file);
  theirs.exec(`
    CREATE TABLE their_table (id INTEGER PRIMARY KEY, note TEXT);
    INSERT INTO their_table(note) VALUES('not ours');
  `);
  theirs.close();

  assert.throws(
    () => new SessionStore(file),
    (error: Error) =>
      /belongs to another application \(it holds tables this build did not create: their_table\)/.test(
        error.message,
      ) && error.message.includes(file),
  );
  assert.deepEqual(tablesOf(file), ['their_table'], 'our schema was never applied to their file');
  assert.deepEqual(columnsOf(file, 'their_table'), ['id', 'note']);
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Number(after.prepare('SELECT count(*) AS n FROM their_table').get()?.n), 1);
  } finally {
    after.close();
  }
});

test('a file that carries a different marker application is refused too', async (t) => {
  // The case the marker exists for: a file with a table named like one of ours but a marker that is not ours.
  // The marker is read *before* the schema is interpreted, so the answer does not depend on the table names.
  const root = await scratch(t);
  const file = path.join(root, 'other-marker.sqlite');
  const theirs = new DatabaseSync(file);
  theirs.exec(`
    CREATE TABLE application_marker (application TEXT PRIMARY KEY, format INTEGER NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO application_marker VALUES('some-other-agent', 1, '2026-01-01T00:00:00.000Z');
  `);
  theirs.close();
  assert.throws(
    () => new SessionStore(file),
    /belongs to another application \(the marker row says "some-other-agent"\)/,
  );
});

test('a marker from a newer format is refused rather than interpreted', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'newer-marker.sqlite');
  const store = new SessionStore(file);
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`UPDATE application_marker SET format=${APPLICATION_FORMAT + 1}`);
  db.close();
  assert.throws(() => new SessionStore(file), /marker format 2, newer than this build's 1/);
});

test('a file that says nothing is adopted, and gets the identity plus the current schema', async (t) => {
  /**
   * `0` and no marker is "nobody said" — every database written before this check existed. Refusing those would
   * strand exactly the users the check protects, so the answer is to claim the file, and this asserts that
   * claiming it also brings the schema up to date rather than leaving a half-migrated database behind.
   */
  const root = await scratch(t);
  const file = path.join(root, 'older.sqlite');
  const older = new DatabaseSync(file);
  // The shape of a database written before checkpoints carried a fold identity: the integer column, no marker,
  // and an older schema version.
  older.exec(`
    PRAGMA user_version=21;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT);
    CREATE TABLE projection_checkpoints (
      session_id TEXT NOT NULL, name TEXT NOT NULL, seq INTEGER NOT NULL,
      version INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id,name)
    );
    INSERT INTO projection_checkpoints VALUES('s','todos',1,2,'[]','2026-01-01T00:00:00.000Z');
  `);
  older.close();
  assert.equal(markerOf(file), undefined, 'the fixture really is an unclaimed file');

  const store = new SessionStore(file);
  store.close();
  assert.deepEqual(markerOf(file), { application: APPLICATION_NAME, format: APPLICATION_FORMAT });
  // The migration's own work: the version column holds a digest, so its declared type is TEXT.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const type = db
      .prepare("SELECT type FROM pragma_table_info('projection_checkpoints') WHERE name='version'")
      .get()?.type;
    assert.equal(String(type), 'TEXT');
    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test('a foreign marker is refused even when the file also carries one of our tables', async (t) => {
  // The marker is the answer, not the table names: a file that has both is still somebody else's, and the
  // evidence in the message is the marker rather than a guess from the schema.
  const root = await scratch(t);
  const file = path.join(root, 'mixed.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE application_marker (application TEXT PRIMARY KEY, format INTEGER NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO application_marker VALUES('other', 1, '2026-01-01T00:00:00.000Z');
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
  `);
  db.close();
  assert.throws(() => new SessionStore(file), /the marker row says "other"/);
});
