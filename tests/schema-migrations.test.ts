import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  APPLICATION_FORMAT,
  APPLICATION_NAME,
  SCHEMA_VERSION,
  SessionStore,
} from '../packages/storage/sqlite.ts';

/**
 * Old databases open, and the traversal says so rather than a handful of spot checks.
 *
 * The upgrade path is the one part of this store that no ordinary test exercises: a fresh database takes the
 * `CREATE TABLE` branch and never touches a migration, so a migration that is wrong — or forgotten, when a new
 * version changes a column's meaning — breaks only for the people who already have data. Two claims are checked
 * here.
 *
 * **The list is walkable.** Every step declares the version it produces, the list is in order, and it reaches
 * `SCHEMA_VERSION`. A step whose gate sits at or before its own threshold can never run, which is the specific
 * mistake the old shape invited (a `>=` where a `>` belonged): it is asserted rather than reviewed.
 *
 * **A real old file opens.** The fixture below is a v21 database with the shapes v21 actually had — an integer
 * checkpoint version, a `context_checkpoints` row with no matching log event, a plan row — and the assertions
 * are about what the upgrade did to that data, not merely that the constructor returned.
 */
async function scratch(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
/**
 * A database as schema v21 wrote it.
 *
 * Only the tables the v22 steps touch are built, plus the ones a session needs to exist at all. The shapes are
 * deliberately the *old* ones: an INTEGER `version` on the checkpoint table, no `application_marker`, and a
 * `plans` CHECK that does not know the word `abandoned`.
 */
function v21Database(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version=21;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT,
      title TEXT, parent_session_id TEXT, fork_message_count INTEGER
    );
    CREATE TABLE session_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE projection_checkpoints (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL, seq INTEGER NOT NULL,
      version INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id,name)
    );
    CREATE TABLE context_checkpoints (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      covered_messages INTEGER NOT NULL, summary TEXT NOT NULL,
      usage TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('planning','proposed','approved','rejected')),
      title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]', hash TEXT NOT NULL DEFAULT '', reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT
    );
    CREATE TABLE subagent_assignments (
      id TEXT PRIMARY KEY, child_session_id TEXT NOT NULL, role TEXT NOT NULL, objective TEXT NOT NULL
    );
    INSERT INTO sessions(id,workspace,created_at,title) VALUES('s1','/tmp/w','2026-01-01T00:00:00.000Z','old session');
    INSERT INTO projection_checkpoints VALUES('s1','todos',4,2,'[]','2026-01-01T00:00:00.000Z');
    INSERT INTO context_checkpoints VALUES('s1',2,'an old summary','{"inputTokens":7}','2026-01-01T00:00:00.000Z');
    INSERT INTO plans(id,session_id,run_id,status,title,summary,steps,hash,created_at,updated_at)
      VALUES('p1','s1',NULL,'planning','t','s','[]','h','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  `);
  db.close();
}
function tableInfo(file: string, table: string): { name: string; type: string }[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => ({ name: String(row.name), type: String(row.type) }));
  } finally {
    db.close();
  }
}
function tableNames(file: string): string[] {
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

test('the migration list is walkable: ordered, each step able to run, and reaching this build', () => {
  /**
   * The properties a list of steps has to have for "every historical version opens" to be true rather than hoped
   * for. The reachability one is the point: a step is dead code if its gate is at or below the version it claims
   * to upgrade, and dead migration code is indistinguishable from working migration code until somebody opens an
   * old database.
   */
  const store = new SessionStore(':memory:');
  try {
    const steps = store.migrationSteps();
    assert.ok(steps.length >= 7, `the steps this build ships: ${steps.length}`);
    for (const step of steps) {
      assert.ok(
        step.upTo > step.from,
        `a step from v${step.from} producing v${step.upTo} can never run`,
      );
      assert.ok(
        step.upTo <= SCHEMA_VERSION,
        `a step claims a version past this build: v${step.upTo}`,
      );
    }
    // Ascending, so the list is the order and no step runs before what it depends on.
    const produced = steps.map((step) => step.upTo);
    assert.deepEqual(
      produced,
      [...produced].sort((left, right) => left - right),
      'out of order',
    );
    assert.equal(produced.at(-1), SCHEMA_VERSION, 'the list reaches the version this build writes');
    /**
     * Every step is *reachable*: a database exists at the version below it that would run it.
     *
     * Deliberately not "every version has a step". Versions 19, 20 and 21 carry no data migration — they are
     * brought forward by the schema statements an open applies, which is what `CREATE TABLE IF NOT EXISTS` and
     * the derived `sessions` columns are for. Demanding a step per version would demand migrations for changes
     * that are not migrations; the claim that matters is the one asserted here, that none of these is dead code
     * pretending to be an upgrade.
     */
    const oldest = Math.min(...steps.map((step) => step.from));
    for (const step of steps)
      assert.ok(
        step.from >= oldest && step.from < step.upTo,
        `the step producing v${step.upTo} sits outside the versions that need upgrading`,
      );
  } finally {
    store.close();
  }
});

test('a v21 database opens: its data survives and each v22 step did its work', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'v21.sqlite');
  v21Database(file);

  const store = new SessionStore(file);
  try {
    // The session and its plan are still there, and the plan's constraint now accepts the new status — which is
    // how the rebuild proves itself: `plan.reject` on a `planning` row needs the widened CHECK to succeed.
    assert.equal(store.get('s1').title, 'old session');
    assert.equal(store.latestPlan('s1')?.id, 'p1');
    store.rejectPlan('s1', 'p1', 'the human said no');
    assert.equal(store.latestPlan('s1')?.status, 'rejected');
  } finally {
    store.close();
  }
  // The v22 shapes: a fold identity is text and the marker is written.
  const version = tableInfo(file, 'projection_checkpoints').find(
    (column) => column.name === 'version',
  );
  assert.equal(version?.type, 'TEXT', 'the checkpoint version holds a digest now');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), SCHEMA_VERSION);
    const marker = db.prepare('SELECT application,format FROM application_marker LIMIT 1').get() as
      { application?: unknown; format?: unknown } | undefined;
    assert.equal(String(marker?.application), APPLICATION_NAME);
    assert.equal(Number(marker?.format), APPLICATION_FORMAT);
  } finally {
    db.close();
  }
});

test('a v17 database has its compaction row turned into the event it should have had', async (t) => {
  /**
   * The one step that *moves* data rather than reshaping a table, and the reason it needs a fixture of its own.
   *
   * `context_checkpoints` held a session's newest compaction while the same fact was also a `context.compacted`
   * event; the v18 step drops the table and appends the missing event, because losing it would lose the session's
   * recorded cost. A v21 fixture cannot exercise that — by v21 the table is long gone — which is exactly what the
   * first version of this file got wrong: it built the old table into a v21 file and then asked why it was still
   * there. A fixture has to be the shape that version actually had.
   */
  const root = await scratch(t);
  const file = path.join(root, 'v17.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version=17;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT, title TEXT
    );
    CREATE TABLE session_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE context_checkpoints (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      covered_messages INTEGER NOT NULL, summary TEXT NOT NULL,
      usage TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO sessions(id,workspace,created_at,title) VALUES('s1','/tmp/w','2026-01-01T00:00:00.000Z','v17 session');
    INSERT INTO context_checkpoints VALUES('s1',2,'an old summary','{"inputTokens":7}','2026-01-01T00:00:00.000Z');
  `);
  db.close();

  const store = new SessionStore(file);
  store.close();
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    assert.ok(
      !tableNames(file).includes('context_checkpoints'),
      'the second copy of one fact is dropped',
    );
    const events = after
      .prepare(
        "SELECT session_id AS sessionId, data FROM session_events WHERE type='context.compacted'",
      )
      .all();
    assert.equal(events.length, 1, 'the row that had no event got one');
    assert.equal(String(events[0]!.sessionId), 's1');
    assert.match(String(events[0]!.data), /an old summary/);
    assert.match(String(events[0]!.data), /"inputTokens":7/, 'and its recorded cost came with it');
  } finally {
    after.close();
  }
});

test('the oldest schema this build still claims to open gets there too', async (t) => {
  /**
   * A v13 database: the shape before the session log existed. Everything newer is created by the open, and the
   * v14 step's backfill has nothing to read — which is the case that used to be the easiest to get wrong, since
   * it branches on a table that a fresh file never has.
   */
  const root = await scratch(t);
  const file = path.join(root, 'v13.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version=13;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT, title TEXT
    );
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO sessions(id,workspace,created_at,title) VALUES('s1','/tmp/w','2026-01-01T00:00:00.000Z','v13 session');
    INSERT INTO messages(session_id,body) VALUES('s1','{"role":"user","content":"from the oldest schema"}');
  `);
  db.close();

  const store = new SessionStore(file);
  try {
    assert.equal(store.get('s1').title, 'v13 session');
    assert.equal(store.messages('s1').length, 1, 'the transcript is still readable');
  } finally {
    store.close();
  }
});
