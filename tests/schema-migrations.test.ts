import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { riskWorker } from './risk-concurrency.ts';
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

test('concurrent old-library openers do not repeat a migration after obtaining the lock', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'sessions.sqlite');
  v21Database(file);
  const first = riskWorker('migration', file, root, '', path.join(root, 'first'));
  const second = riskWorker('migration', file, root, '', path.join(root, 'second'));
  try {
    await Promise.all([first.ready(), second.ready()]);
    await first.release();
    await first.migrating();
    await second.release();
    await setTimeout(200);
    await assert.rejects(access(path.join(root, 'second.migrating')), { code: 'ENOENT' });
    await first.commit();
    assert.deepEqual(await first.result, { ok: true });
    await second.migrating();
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO projection_checkpoints VALUES(?,?,?,?,?,?)').run(
      's1',
      'concurrent-sentinel',
      1,
      'current-fold',
      '{}',
      '2026-10-10',
    );
    db.close();
    await second.commit();
    assert.deepEqual(await second.result, { ok: true });
    const reopened = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        reopened
          .prepare('SELECT version FROM projection_checkpoints WHERE name=?')
          .get('concurrent-sentinel')?.version,
        'current-fold',
        'the second opener must preserve state written after the first migration',
      );
      assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
      assert.equal(
        reopened.prepare('SELECT title FROM sessions WHERE id=?').get('s1')?.title,
        'old session',
      );
      assert.equal(reopened.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      reopened.close();
    }
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
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
/**
 * The structural shape of a database, as something two files can be compared by.
 *
 * Deliberately not the stored `sql` text of each object. A column an upgrade added with `ADD COLUMN` lives at
 * the end of the table while the stored `CREATE TABLE` text still shows the list the *base* schema wrote, and
 * that is what a migrated database is supposed to look like — so a text comparison would fail on exactly the
 * files this is meant to certify, and pass only on ones that needed no upgrade. What is compared is what a
 * reader can observe: which objects exist, the column set with each column's declared type/not-null/default/pk,
 * the foreign keys, and the indexes with the columns they cover. Data, rowids and timestamps are excluded.
 *
 * Column *order* is excluded for the same reason as the text: an older file reaches the current column set by
 * appending, so its order is its history. The store names every column it reads or writes.
 */
function shapeOf(file: string): Record<string, Record<string, string[]> | string[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const objects = db
      .prepare(
        "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all()
      .map((row) => `${String(row.type)}:${String(row.name)}`);
    const columns: Record<string, string[]> = {};
    const foreignKeys: Record<string, string[]> = {};
    const indexes: Record<string, string[]> = {};
    for (const name of tableNames(file)) {
      columns[name] = db
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map(
          (row) =>
            `${String(row.name)} ${String(row.type)} notnull=${Number(row.notnull)} ` +
            `default=${row.dflt_value === null ? 'null' : String(row.dflt_value)} pk=${Number(row.pk)}`,
        )
        .sort();
      foreignKeys[name] = db
        .prepare(`PRAGMA foreign_key_list(${name})`)
        .all()
        .map(
          (row) =>
            `${String(row.from)}->${String(row.table)}.${row.to === null ? '-' : String(row.to)} ` +
            `${String(row.on_update)}/${String(row.on_delete)}`,
        )
        .sort();
      for (const index of db.prepare(`PRAGMA index_list(${name})`).all()) {
        const indexName = String(index.name);
        const covered = db
          .prepare(`PRAGMA index_info(${indexName})`)
          .all()
          .map((row) => String(row.name))
          .join(',');
        // An auto-index's identity is the constraint it serves, not its generated name.
        const key = `${name}.${indexName.startsWith('sqlite_autoindex') ? covered : indexName}`;
        indexes[key] = [`${covered} unique=${Number(index.unique)} origin=${String(index.origin)}`];
      }
    }
    return { objects, columns, foreignKeys, indexes };
  } finally {
    db.close();
  }
}
/** Runs `body` with `console.error` captured, so a test can assert what was announced rather than hide it. */
function captureErrors<T>(body: () => T): { value: T; messages: string[] } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map((argument) => String(argument)).join(' '));
  };
  try {
    return { value: body(), messages };
  } finally {
    console.error = original;
  }
}
/**
 * A database as an early version wrote it: `user_version` is still 0, because builds before this one did not
 * stamp it at all, and the tables are the older shapes that the upgrade has to carry forward.
 */
function versionZeroDatabase(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT
    );
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      body TEXT NOT NULL
    );
    CREATE INDEX messages_session ON messages(session_id,seq);
    CREATE TABLE projection_checkpoints (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL, seq INTEGER NOT NULL,
      version INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id,name)
    );
    INSERT INTO sessions(id,workspace,created_at) VALUES('s1','/tmp/w','2026-01-01T00:00:00.000Z');
    INSERT INTO messages(session_id,body) VALUES('s1','{"role":"user","content":"an older transcript"}');
    INSERT INTO projection_checkpoints VALUES('s1','todos',1,2,'[]','2026-01-01T00:00:00.000Z');
  `);
  db.close();
}

test('an empty database initializes without the legacy checkpoint warning', async (t) => {
  /**
   * The defect this pins: a file that had just been created from nothing was walked through every historical
   * step, and the step that gives projection checkpoints their fold identity found the table the same function
   * had created a moment earlier, dropped it as if it held an old integer, and said so on the console. Nothing
   * was lost — the table never held a row — but the message says data was discarded, and the difference between
   * "nothing was lost" and "nothing was there to lose" is one nobody should have to establish by reading source.
   *
   * `console.error` is captured rather than left alone: the claim is that the message is not produced, and
   * silencing the stream would make the same test pass while the message was still written.
   */
  const root = await scratch(t);
  const file = path.join(root, 'fresh.sqlite');
  const { messages: warnings } = captureErrors(() => {
    const store = new SessionStore(file);
    const session = store.create(root);
    store.append(session.id, { role: 'user', content: 'the first message' });
    store.recordEvent(session.id, 'run.started', { runId: 'run-1', ownerPid: process.pid });
    store.recordEvent(session.id, 'run.finished', { runId: 'run-1', status: 'completed' });
    store.createTask(session.id, { title: 'a durable task' });
    store.saveProjectionCheckpoints(session.id);
    store.close();
    // A second open is the ordinary path over a file this build wrote, and it must be silent too.
    const reopened = new SessionStore(file);
    assert.equal(reopened.messages(session.id).length, 1);
    assert.equal(reopened.listTasks(session.id).length, 1);
    assert.deepEqual(
      reopened.events(session.id).map((event) => event.type),
      ['message.user', 'run.started', 'run.finished'],
    );
    reopened.close();
    return session.id;
  });
  assert.ok(
    !warnings.some((message) => message.includes('dropped projection_checkpoints')),
    `a database that was never migrated announced migration work: ${warnings.join(' | ')}`,
  );
  assert.deepEqual(warnings, [], 'a brand-new database has nothing to announce');
  // In-memory is the other empty file, and it takes the same branch.
  const memory = captureErrors(() => {
    const store = new SessionStore(':memory:');
    store.close();
    return store;
  });
  assert.deepEqual(
    memory.messages,
    [],
    'an empty in-memory database has nothing to announce either',
  );
});

test('version zero with sessions still migrates, and still reports the checkpoint it dropped', async (t) => {
  /**
   * The other half of the same distinction, and the reason the new branch is keyed on "no tables" instead of on
   * the version number. A database written before this build stamped versions is also `user_version = 0`, and it
   * *does* hold data that has to be carried forward — so it must still walk the chain, and the warning about the
   * checkpoint table it genuinely discards must still be emitted. A fix that silenced the message for both cases
   * would be indistinguishable from one that deleted the migration.
   */
  const root = await scratch(t);
  const file = path.join(root, 'unversioned.sqlite');
  versionZeroDatabase(file);
  const { messages } = captureErrors(() => {
    const store = new SessionStore(file);
    store.close();
  });
  assert.ok(
    messages.some((message) => message.includes('dropped projection_checkpoints')),
    `the checkpoint table really was discarded and should say so: ${messages.join(' | ')}`,
  );
  assert.equal(
    messages.some((message) => message.includes('backfilled 1 message event')),
    true,
    `the v14 log backfill ran for the message that was there: ${messages.join(' | ')}`,
  );

  // Inspected before a reader ever folds this session: `close()` checkpoints the sessions it read, so a count
  // taken after the reads below would be counting rows this process wrote, not rows the migration left.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), SCHEMA_VERSION);
    const version = db
      .prepare("SELECT type FROM pragma_table_info('projection_checkpoints') WHERE name='version'")
      .get()?.type;
    assert.equal(String(version), 'TEXT', 'the fold identity replaced the global integer');
    assert.equal(
      Number(db.prepare('SELECT count(*) AS n FROM projection_checkpoints').get()?.n),
      0,
      'a checkpoint is derived data and is not carried across the identity change',
    );
    // The column the base schema does not declare: it arrives as an `ADD COLUMN`, and the FTS backfill that
    // follows it is what proves the search index was built after the column existed.
    assert.equal(
      String(
        db.prepare("SELECT name FROM pragma_table_info('messages') WHERE name='search_text'").get()
          ?.name,
      ),
      'search_text',
    );
    assert.equal(
      Number(
        db
          .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'transcript'")
          .get()?.n,
      ),
      1,
      'the backfill found the message and the triggers put it in the index',
    );
  } finally {
    db.close();
  }

  const store = new SessionStore(file);
  try {
    assert.equal(store.get('s1').workspace, '/tmp/w');
    assert.equal(store.messages('s1')[0]?.content, 'an older transcript');
    assert.deepEqual(
      store.events('s1').map((event) => event.type),
      ['message.user'],
      'the transcript reached the log through the v14 backfill',
    );
  } finally {
    store.close();
  }
});

test('a new database and a migrated one reach the same schema', async (t) => {
  /**
   * The claim the two entries make jointly, and the only thing keeping them from drifting apart.
   *
   * `createCurrentSessionSchema` writes the current shape directly; an existing file reaches it through the base
   * schema plus `ADD COLUMN`s and data steps. Neither can check the other on its own, and a column forgotten in
   * one of them is invisible until a reader asks a fresh database for it.
   */
  const root = await scratch(t);
  const freshFile = path.join(root, 'fresh.sqlite');
  const migratedFile = path.join(root, 'migrated.sqlite');
  versionZeroDatabase(migratedFile);
  const fresh = new SessionStore(freshFile);
  fresh.close();
  const migrated = new SessionStore(migratedFile);
  migrated.close();

  const freshShape = shapeOf(freshFile);
  const migratedShape = shapeOf(migratedFile);
  assert.deepEqual(freshShape.objects, migratedShape.objects, 'the same objects exist in both');
  assert.ok(
    (migratedShape.objects as string[]).includes('trigger:messages_au'),
    'the migrated database has the search triggers too',
  );
  assert.deepEqual(
    Object.keys(freshShape.columns as Record<string, string[]>).sort(),
    Object.keys(migratedShape.columns as Record<string, string[]>).sort(),
  );
  for (const table of Object.keys(freshShape.columns as Record<string, string[]>))
    assert.deepEqual(
      (freshShape.columns as Record<string, string[]>)[table],
      (migratedShape.columns as Record<string, string[]>)[table],
      `${table}: the two entries declare the same columns`,
    );
  assert.deepEqual(freshShape.foreignKeys, migratedShape.foreignKeys, 'and the same references');
  assert.deepEqual(freshShape.indexes, migratedShape.indexes, 'and the same indexes');
});

test('a version from the future is refused, and the file is not touched', async (t) => {
  // The guard the new branch is inserted after: a file this build cannot interpret must be refused before any
  // statement of ours runs, including the current-schema statements that would otherwise create our tables in
  // somebody's newer database.
  const root = await scratch(t);
  const file = path.join(root, 'future.sqlite');
  const store = new SessionStore(file);
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  db.close();
  const before = shapeOf(file);
  assert.throws(() => new SessionStore(file), /Unsupported session database version/);
  assert.deepEqual(shapeOf(file), before, 'nothing was created in a file this build cannot read');
});

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

test('a v30 database has its Chinese messages made searchable, and nothing else rewritten', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'v30.sqlite');
  const store = new SessionStore(file);
  const chinese = store.create(root);
  store.append(chinese.id, { role: 'user', content: '我们修复了数据库迁移的问题' });
  const english = store.create(root);
  store.append(english.id, { role: 'user', content: 'the migration is fixed' });
  store.close();
  // What v30 wrote: the projection as plain text, which `unicode61` keeps as one token per clause.
  const old = new DatabaseSync(file);
  try {
    old.exec(
      "UPDATE messages SET search_text=replace(search_text,char(8203),''); PRAGMA user_version=30",
    );
    const phrase = '"​数​据​库​"';
    assert.equal(
      Number(
        old.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(phrase)
          ?.n,
      ),
      0,
      'the fixture reproduces the defect before the upgrade',
    );
  } finally {
    old.close();
  }

  const upgraded = new SessionStore(file);
  try {
    assert.deepEqual(
      upgraded.list('数据库', root).map((session) => session.id),
      [chinese.id],
    );
    assert.deepEqual(
      upgraded.list('migration', root).map((session) => session.id),
      [english.id],
      'Latin text searches exactly as before',
    );
    assert.match(
      upgraded.searchSessions('迁移', { workspace: root }).hits[0]!.matches[0]!.snippet,
      /«迁移»/,
    );
  } finally {
    upgraded.close();
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), SCHEMA_VERSION);
    assert.equal(
      String(
        db.prepare('SELECT search_text FROM messages WHERE session_id=?').get(english.id)
          ?.search_text,
      ),
      'the migration is fixed',
    );
  } finally {
    db.close();
  }
});

test('every connection runs WAL with synchronous=NORMAL, which is set per open rather than stored', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'sync.sqlite');
  for (const open of ['created', 'reopened']) {
    const store = new SessionStore(file);
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      assert.equal(String(db.prepare('PRAGMA journal_mode').get()?.journal_mode), 'wal', open);
      // 1 = NORMAL; the default 2 (FULL) would fsync at every commit.
      assert.equal(Number(db.prepare('PRAGMA synchronous').get()?.synchronous), 1, open);
    } finally {
      store.close();
    }
  }
});
