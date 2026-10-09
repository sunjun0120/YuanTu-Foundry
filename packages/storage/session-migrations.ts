import type { DatabaseSync } from 'node:sqlite';
import type { Message, RunResult, SubAgentSummary, Usage } from '../protocol/index.ts';
import { redactSecrets } from '../core/errors.ts';
import { createDatabaseBackup, type BackupPolicy } from './database-maintenance.ts';
import { messageEventType } from './events.ts';
import {
  APPLICATION_ID,
  APPLICATION_NAME,
  APPLICATION_FORMAT,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
  SESSION_DATABASE_POLICY,
  messageSearchText,
} from './session-schema.ts';

export interface SessionMigrationPort {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
}

/** Initializes and upgrades the borrowed connection without owning its maintenance lock. */
export class SessionMigrations {
  private readonly port: SessionMigrationPort;
  constructor(port: SessionMigrationPort) {
    this.port = port;
  }

  initialize(file: string, options: { backupRetention?: BackupPolicy }): void {
    this.port.db.exec('PRAGMA busy_timeout=5000');
    /**
     * Whose file is this? Answered before a single table of ours is interpreted.
     *
     * Three states, and each needs a different answer. A file that says it is ours is ours. A file that says it
     * is somebody else's — by marker row or by the `application_id` pragma — is refused by name, because the
     * alternative is our `CREATE TABLE IF NOT EXISTS` statements landing on top of a stranger's schema and a
     * later query failing to find one of our columns. A file that says nothing is either brand new or older than
     * this check; the second case is a database we wrote before we said so, and refusing it would strand the
     * users this is meant to protect — so the ambiguity is resolved by the only evidence available: a file that
     * already holds *our* tables is ours, and one that holds tables but none of ours is not.
     */
    const claimed = Number(
      this.port.db.prepare('PRAGMA application_id').get()?.application_id ?? 0,
    );
    if (claimed !== 0 && claimed !== APPLICATION_ID)
      throw this.notOurs(file, `application_id ${claimed}`);
    const marker = this.marker();
    if (marker) {
      if (marker.application !== APPLICATION_NAME)
        throw this.notOurs(file, `the marker row says "${marker.application}"`);
      if (Number(marker.format) > APPLICATION_FORMAT)
        throw this.notOurs(
          file,
          `marker format ${marker.format}, newer than this build's ${APPLICATION_FORMAT}`,
        );
    } else if (this.hasTable('sessions')) {
      // Our table, no marker: a database this build wrote before the marker existed. Claimed below.
    } else {
      const foreign = this.foreignTables();
      if (foreign.length)
        throw this.notOurs(
          file,
          `it holds tables this build did not create: ${foreign.join(', ')}`,
        );
    }
    const version = Number(this.port.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      this.port.db.close();
      throw new Error(`Unsupported session database version: ${version}`);
    }
    if (file !== ':memory:' && version < SCHEMA_VERSION && this.hasTable('sessions')) {
      try {
        createDatabaseBackup(
          this.port.db,
          file,
          SESSION_DATABASE_POLICY,
          'migration',
          options.backupRetention,
        );
      } catch (error) {
        throw new Error(
          'Migration stopped because its backup failed: ' + (error as Error).message,
          { cause: error },
        );
      }
    }
    this.port.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      -- The file's own answer to "whose database is this", read before any of our tables are interpreted.
      -- A row rather than PRAGMA application_id, which this runtime's SQLite binding applies to the connection
      -- only and never writes to the header (see APPLICATION_ID).
      CREATE TABLE IF NOT EXISTS application_marker (
        application TEXT PRIMARY KEY,
        format INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq);
      -- Image bytes, content-addressed (schema v21). A message row and its message.* log entry carry a
      -- hash plus a mime type instead of the base64, so the same picture costs one row instead of one copy
      -- per mention. Rows written before v21 keep their inline bytes and are read exactly as they are; the
      -- migration therefore creates an empty table and moves nothing.
      CREATE TABLE IF NOT EXISTS attachment_blobs (
        hash TEXT PRIMARY KEY, mime_type TEXT NOT NULL, bytes BLOB NOT NULL,
        size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_events_session ON session_events(session_id,seq);
      -- Who is writing each session right now (see SessionLease). Ephemeral presence: taken by beginRun,
      -- renewed by the run loop, released when the run finishes, and reclaimed only through the dead-owner
      -- path. Never expired by age, so it is not a second source of truth about a run's status.
      CREATE TABLE IF NOT EXISTS session_leases (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        renewed_at TEXT NOT NULL,
        renewals INTEGER NOT NULL DEFAULT 0,
        compacting_run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner_pid INTEGER NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL, result TEXT
      );
      CREATE TABLE IF NOT EXISTS run_stream_checkpoints (
        run_id TEXT NOT NULL REFERENCES runs(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS file_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT,
        change TEXT NOT NULL, before_bytes BLOB, after_bytes BLOB NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS changes_session ON file_changes(session_id,seq);
      -- Folded projection state, kept between processes. seq is how far into the session log it has been
      -- folded; version holds the identity of the fold that wrote it (see projectionFoldIdentity), so state
      -- written by a different fold of the same projection is ignored rather than continued.
      CREATE TABLE IF NOT EXISTS projection_checkpoints (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        seq INTEGER NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,name)
      );
      CREATE TABLE IF NOT EXISTS file_change_files (
        change_id TEXT NOT NULL REFERENCES file_changes(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, path TEXT NOT NULL,
        before_bytes BLOB, after_bytes BLOB,
        PRIMARY KEY(change_id,ordinal), UNIQUE(change_id,path)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        verification TEXT,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_session ON tasks(session_id,created_at,id);
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('planning','proposed','approved','rejected','abandoned')),
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        steps TEXT NOT NULL DEFAULT '[]',
        hash TEXT NOT NULL DEFAULT '',
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS plans_session ON plans(session_id,created_at DESC,id);
      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        prompt TEXT,
        baselines TEXT,
        verification TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(task_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS task_attempts_task ON task_attempts(task_id,ordinal);
      CREATE TABLE IF NOT EXISTS task_step_checkpoints (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_step_checkpoints_task ON task_step_checkpoints(task_id,seq);
      CREATE TABLE IF NOT EXISTS task_effects (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','completed','reviewed')),
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS task_effects_pending ON task_effects(task_id,status);
      CREATE TABLE IF NOT EXISTS task_approvals (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
        approval TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );

    `);
    this.port.transaction(() => {
      const columns = new Set(
        this.port.db
          .prepare('PRAGMA table_info(sessions)')
          .all()
          .map((row) => row.name),
      );
      if (!columns.has('title'))
        this.port.db.exec("ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''");
      /**
       * Where a session's title came from, which is what makes "may a model name this session" answerable in SQL.
       *
       * A session starts `fallback` (named from its first user message) and may be renamed to `generated` by the
       * title generator exactly once. A rename by a person writes `manual` and wins from then on: the generator's
       * `UPDATE` carries `WHERE title_source='fallback'`, so a title typed while the model call was in flight is
       * never overwritten — checking the condition in TypeScript would leave a window between the read and the
       * write, and that window is exactly when a person types.
       */
      if (!columns.has('title_source')) {
        this.port.db.exec(
          "ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'fallback'",
        );
        // A title from an older database may have been edited by its owner. Leave those names alone.
        this.port.db.exec("UPDATE sessions SET title_source='manual' WHERE title<>''");
      }
      if (!columns.has('parent_session_id'))
        this.port.db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
      if (!columns.has('fork_message_count'))
        this.port.db.exec('ALTER TABLE sessions ADD COLUMN fork_message_count INTEGER');
      const taskColumns = new Set(
        this.port.db
          .prepare('PRAGMA table_info(tasks)')
          .all()
          .map((row) => row.name),
      );
      if (!taskColumns.has('verification'))
        this.port.db.exec('ALTER TABLE tasks ADD COLUMN verification TEXT');
      if (!taskColumns.has('definition_attempt_floor'))
        this.port.db.exec(
          'ALTER TABLE tasks ADD COLUMN definition_attempt_floor INTEGER NOT NULL DEFAULT 0',
        );
      if (!taskColumns.has('trigger'))
        this.port.db.exec('ALTER TABLE tasks ADD COLUMN trigger TEXT');
      if (!taskColumns.has('trigger_revision'))
        this.port.db.exec('ALTER TABLE tasks ADD COLUMN trigger_revision TEXT');
      if (!taskColumns.has('current_delivery_id'))
        this.port.db.exec('ALTER TABLE tasks ADD COLUMN current_delivery_id TEXT');
      if (!taskColumns.has('next_run_at'))
        this.port.db.exec('ALTER TABLE tasks ADD COLUMN next_run_at TEXT');
      if (!taskColumns.has('last_run_at'))
        this.port.db.exec('ALTER TABLE tasks ADD COLUMN last_run_at TEXT');
      if (!taskColumns.has('last_trigger_error'))
        this.port.db.exec('ALTER TABLE tasks ADD COLUMN last_trigger_error TEXT');
      const attemptColumns = new Set(
        this.port.db
          .prepare('PRAGMA table_info(task_attempts)')
          .all()
          .map((row) => row.name),
      );
      if (!attemptColumns.has('trigger'))
        this.port.db.exec(
          "ALTER TABLE task_attempts ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual'",
        );
      if (!attemptColumns.has('resume'))
        this.port.db.exec('ALTER TABLE task_attempts ADD COLUMN resume INTEGER NOT NULL DEFAULT 0');
      // Session search index (v10). The projection column is filled by `append`, and the triggers keep
      // the FTS index in step for every write path, including the backfill below.
      const messageColumns = new Set(
        this.port.db
          .prepare('PRAGMA table_info(messages)')
          .all()
          .map((row) => row.name),
      );
      const needsBackfill = !messageColumns.has('search_text');
      if (needsBackfill)
        this.port.db.exec("ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
      // The triggers must exist before the backfill below, because that backfill fills the projection
      // and lets the update trigger mirror each row into the index.
      this.port.db
        .exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(search_text, tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
          WHEN new.search_text <> '' BEGIN
          INSERT INTO messages_fts(rowid,search_text) VALUES(new.seq,new.search_text); END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid=old.seq; END;
        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF search_text ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid=old.seq;
          INSERT INTO messages_fts(rowid,search_text)
            SELECT new.seq,new.search_text WHERE new.search_text <> ''; END;`);
      if (needsBackfill) {
        const rows = this.port.db.prepare('SELECT seq, body FROM messages').all();
        const update = this.port.db.prepare(
          "UPDATE messages SET search_text=? WHERE seq=? AND search_text=''",
        );
        for (const row of rows) {
          let text = '';
          try {
            text = messageSearchText(JSON.parse(String(row.body)) as Message);
          } catch {
            /* A body that no longer parses simply stays unsearchable. */
          }
          if (text) update.run(text, Number(row.seq));
        }
      }
      for (const step of this.migrations()) step.run(version);
      this.claimApplication();
      this.port.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  }

  /**
   * The marker row, when the file carries one.
   *
   * Read before the schema is applied, which is why it does not go through `hasTable`: at that point the table
   * may be ours, somebody else's, or absent, and the query has to be the one that answers rather than throws.
   *
   * `format` is coerced because this binding hands INTEGER columns back as BigInt, and a BigInt form of a number
   * is not the number: `{format: 1n}` would silently fail every `> APPLICATION_FORMAT` comparison that matters.
   */
  private marker(): { application: string; format: number } | undefined {
    try {
      const row = this.port.db
        .prepare('SELECT application,format FROM application_marker LIMIT 1')
        .get() as { application?: unknown; format?: unknown } | undefined;
      if (!row) return undefined;
      return { application: String(row.application), format: Number(row.format) };
    } catch {
      // No such table: a file that has never been claimed. Not an error — it is the state every database
      // written before the marker existed is in, and the caller decides what that means.
      return undefined;
    }
  }

  /** Tables in this file that this build does not create — the evidence that the file is somebody else's. */
  private foreignTables(): string[] {
    const ours = new Set<string>(SCHEMA_TABLES);
    return this.port.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name))
      .filter((name) => !ours.has(name));
  }

  /** The refusal, in one place so every path names the file and the evidence the same way. */
  private notOurs(file: string, evidence: string): Error {
    this.port.db.close();
    return new Error(
      `${file} belongs to another application (${evidence}); refusing to write this session database`,
    );
  }

  /** Writes the marker row when the file lacks one, so the next open has an answer that does not need inference. */
  private claimApplication(): void {
    if (this.marker()) return;
    this.port.db
      .prepare('INSERT INTO application_marker(application,format,created_at) VALUES(?,?,?)')
      .run(APPLICATION_NAME, APPLICATION_FORMAT, new Date().toISOString());
    this.port.db.exec(
      `PRAGMA application_id=${APPLICATION_ID}`,
    ); /* Read back by this and future builds; not portable, see APPLICATION_ID. */
  }

  /**
   * The upgrade a database written by an older build goes through, as a list rather than as a run of statements.
   *
   * Every entry used to be one more line in the constructor plus a `fromVersion` guard inside its own method, so
   * "what happens when an old database is opened" was answerable only by reading the constructor and then seven
   * methods. That shape had two costs, and both were paid: the order was invisible, and a step whose guard was
   * wrong (a `>=` where a `>` belonged) would silently skip its work on exactly the databases that needed it.
   *
   * Here each step says once what it costs — the version it exists for — and the list is the order. `SCHEMA_TABLES`
   * and this list are the two halves of "every historical version opens": the schema brings a file up to date,
   * and these bring its *data* along.
   *
   * The steps keep their own `fromVersion` guard, because each one already refused a *different* upstream version
   * (`v14` for the log, `v15` for cards, `v17` for the checkpoint usage) and collapsing those into `upTo` would
   * lose the reason. `upTo` is the version the step produces, and a test asserts `upTo > from` for every entry:
   * a step whose gate is at or before its threshold is one that can never run.
   */
  private migrations(): {
    /** The oldest schema that still needs this step. */
    from: number;
    /** The version this step produces; `SCHEMA_VERSION` for the newest. */
    upTo: number;
    run(fromVersion: number): void;
  }[] {
    return [
      { from: 13, upTo: 14, run: (from) => this.migrateSessionLog(from) },
      { from: 14, upTo: 15, run: (from) => this.migrateSubAgentCards(from) },
      { from: 15, upTo: 16, run: (from) => this.migrateDropSubAgentAssignments(from) },
      { from: 16, upTo: 17, run: (from) => this.migrateContextCheckpointUsage(from) },
      { from: 17, upTo: 18, run: (from) => this.migrateCompactionSurface(from) },
      { from: 21, upTo: 22, run: (from) => this.migratePlanAbandoned(from) },
      { from: 21, upTo: 22, run: (from) => this.migrateProjectionCheckpointIdentity(from) },
      { from: 22, upTo: 23, run: (from) => this.migrateMachineTitledSessions(from) },
      // A reader compatibility fence: v23 cannot interpret durable program outcomes.
      { from: 23, upTo: 24, run: () => {} },
      { from: 24, upTo: 25, run: () => {} },
      { from: 25, upTo: 26, run: () => {} },
      { from: 26, upTo: 27, run: () => {} },
      // Old readers must not launch automatic work while ignoring its durable authority.
      { from: 27, upTo: 28, run: () => {} },
    ];
  }

  /**
   * The upgrade path as data, for a caller that wants to check it rather than run it.
   *
   * Exposed because the property worth testing here is a property of the *list* — ordered, reachable, reaching
   * this build — and a test cannot assert that about a run of statements it cannot see.
   */
  migrationSteps(): { from: number; upTo: number }[] {
    return this.migrations().map(({ from, upTo }) => ({ from, upTo }));
  }

  /** Whether a table exists in this database. Migrations read tables this build no longer creates. */
  private hasTable(name: string): boolean {
    return (
      this.port.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name) !== undefined
    );
  }

  /**
   * The migration that un-names the sessions a machine message named.
   *
   * The fallback title is "the first user message", and a runtime snapshot or a compaction summary is a user
   * message the runtime wrote to itself — so a session could be called `<runtime-context source="memory">
   * Machine-written snapshot …`, which is what the sidebar showed. The title is blanked rather than recomputed:
   * the message it should have come from is the first one a *person* wrote, and the next append names the
   * session from it (a blank title is the only one that may be retitled). A session nobody has asked anything
   * stays blank, which is the truth about it.
   */
  private migrateMachineTitledSessions(fromVersion: number): void {
    if (fromVersion >= 23) return;
    this.port.db
      .prepare(
        "UPDATE sessions SET title='' WHERE title_source='fallback' AND (title LIKE '<runtime-context %' OR title LIKE '<compacted-summary>%')",
      )
      .run();
  }

  /**
   * The adjacent migration that records what a compaction cost.
   *
   * The summary request is a model call the user pays for, but its usage only ever existed as a local
   * variable — so a session's statistics disagreed with the bill exactly for the sessions that compact the
   * most. Recording it in the write-through table as well as the log keeps the two views reconcilable, which
   * is what the statistics projection is checked against.
   */
  /**
   * The migration that gave every checkpoint the identity of the fold that wrote it.
   *
   * The column has to change type as well as meaning: it held one global integer and now holds a digest, and
   * SQLite's INTEGER affinity would turn a hex digest into a number. There is nothing to copy — checkpoints are
   * derived data by definition, so the migration is "drop it and let the schema above recreate it", and every
   * session folds once more from the log, which is where a checkpoint's contents come from anyway.
   */
  private migrateProjectionCheckpointIdentity(fromVersion: number): void {
    if (fromVersion >= 22) return;
    if (!this.hasTable('projection_checkpoints')) return;
    this.port.db.exec('DROP TABLE projection_checkpoints');
    this.port.db.exec(`
      CREATE TABLE projection_checkpoints (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        seq INTEGER NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,name)
      );`);
    console.error(
      '[session log] dropped projection_checkpoints (version is a fold identity now, not a global integer)',
    );
  }

  /**
   * The migration that let a plan say it was abandoned.
   *
   * The status vocabulary lives in a `CHECK`, and SQLite cannot widen one in place, so this is the rebuild the
   * platform requires: create the table with the new constraint, copy every row, swap. Nothing is reinterpreted —
   * an old `planning` row stays `planning` until the convergence that settles its run moves it — so the migration
   * is about the *constraint*, not about the data. The index is recreated because dropping the table drops it.
   */
  private migratePlanAbandoned(fromVersion: number): void {
    if (fromVersion >= 22) return;
    if (!this.hasTable('plans')) return;
    this.port.db.exec(`
      ALTER TABLE plans RENAME TO plans_previous;
      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('planning','proposed','approved','rejected','abandoned')),
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        steps TEXT NOT NULL DEFAULT '[]',
        hash TEXT NOT NULL DEFAULT '',
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT
      );
      INSERT INTO plans(id,session_id,run_id,status,title,summary,steps,hash,reason,created_at,updated_at,approved_at)
        SELECT id,session_id,run_id,status,title,summary,steps,hash,reason,created_at,updated_at,approved_at FROM plans_previous;
      DROP TABLE plans_previous;
      CREATE INDEX IF NOT EXISTS plans_session ON plans(session_id,created_at DESC,id);
    `);
  }

  private migrateContextCheckpointUsage(fromVersion: number): void {
    if (fromVersion >= 17) return;
    if (!this.hasTable('context_checkpoints')) return;
    const columns = this.port.db.prepare('PRAGMA table_info(context_checkpoints)').all();
    if (columns.some((column) => String(column.name) === 'usage')) return;
    this.port.db.exec('ALTER TABLE context_checkpoints ADD COLUMN usage TEXT');
  }

  /**
   * The adjacent migration that made a compaction a log op.
   *
   * `context_checkpoints` used to be the read path for "what is the model shown", while the same compaction
   * was also recorded as a `context.compacted` event — the table by the writing call, the event by the same
   * call since v14 and by the v14 backfill before that. Two copies of one fact is how the two start to
   * disagree, and they already had: the row held only the *newest* summary's usage, while the log and the
   * statistics projection accumulate every compaction's. The table is dropped, so the surface a reader
   * derives comes from the log alone. A session that somehow has a row without its event — written by a
   * build between v14 and this one — gets the event it should have had, appended last, which is where it
   * belongs: the single row always held the newest compaction.
   */
  private migrateCompactionSurface(fromVersion: number): void {
    if (fromVersion >= 18) return;
    // A fresh database never created the table, so there is nothing to drop and nothing to report: this
    // migration is only ever visible on a database written before it.
    if (!this.hasTable('context_checkpoints')) return;
    const insert = this.port.db.prepare(
      'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
    );
    const at = new Date().toISOString();
    let backfilled = 0;
    const rows = this.port.db
      .prepare(
        'SELECT session_id AS sessionId,covered_messages AS coveredMessages,summary,usage FROM context_checkpoints',
      )
      .all();
    for (const row of rows) {
      const sessionId = String(row.sessionId);
      const recorded = this.port.db
        .prepare("SELECT 1 FROM session_events WHERE session_id=? AND type='context.compacted'")
        .get(sessionId);
      if (recorded) continue;
      let usage: Usage | undefined;
      try {
        usage = row.usage ? (JSON.parse(String(row.usage)) as Usage) : undefined;
      } catch {
        /* An unreadable usage simply contributes no cost, the same as a checkpoint written without one. */
      }
      insert.run(
        sessionId,
        'context.compacted',
        JSON.stringify({
          coveredMessages: Number(row.coveredMessages),
          summary: String(row.summary),
          ...(usage ? { usage } : {}),
        }),
        at,
      );
      backfilled++;
    }
    this.port.db.exec('DROP TABLE context_checkpoints');
    console.error(
      '[session log] dropped context_checkpoints (compaction is a log op now)' +
        (backfilled ? `, backfilled ${backfilled} checkpoint(s)` : ''),
    );
  }

  /**
   * The adjacent migration that drops `subagent_assignments`.
   *
   * The table was the card-restoration mechanism before cards became a projection, and the previous step
   * copied its contents into the parent's log. Dropping it is the point of the step: keeping a second copy
   * of a fact that no longer reads from it is exactly how the two copies start to disagree. A database
   * written before the table existed skips this, and a fresh database never creates it.
   */
  private migrateDropSubAgentAssignments(fromVersion: number): void {
    if (fromVersion >= 16) return;
    if (!this.hasTable('subagent_assignments')) return;
    this.port.db.exec('DROP TABLE subagent_assignments');
    console.error('[session log] dropped subagent_assignments (cards are a projection now)');
  }

  /**
   * The adjacent migration that moved sub-agent cards onto the log.
   *
   * A database written before v15 kept a child's identity in `subagent_assignments` (so a crashed parent's
   * card could still be restored) and took its outcome from the parent's stored run result. Cards are now a
   * fold of the parent's log, so an upgraded session needs those facts as events — otherwise every older
   * session would show no sub-agent cards at all, and a child left interrupted by a crash would vanish from
   * the UI that exists to show it.
   */
  private migrateSubAgentCards(fromVersion: number): void {
    if (fromVersion >= 15) return;
    // The table only exists in databases written before v16; a fresh one has no assignments to carry over.
    if (!this.hasTable('subagent_assignments')) return;
    const insert = this.port.db.prepare(
      'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
    );
    const at = new Date().toISOString();
    let interrupted = 0;
    let finished = 0;
    // Identity first, then outcome, then interruption: the order the runtime writes them in, and therefore
    // the order the fold expects. An outcome that arrived before its own assignment would be overwritten by
    // it and the card would look like it never ran.
    const parentOf = (childSessionId: string): string =>
      String(
        this.port.db
          .prepare('SELECT parent_session_id FROM sessions WHERE id=?')
          .get(childSessionId)?.parent_session_id ?? '',
      );
    const assignments = this.port.db
      .prepare(
        'SELECT child_session_id AS childSessionId,id,role,objective FROM subagent_assignments ORDER BY rowid',
      )
      .all();
    for (const row of assignments) {
      const childSessionId = String(row.childSessionId);
      const parent = parentOf(childSessionId);
      if (!parent) continue;
      insert.run(
        parent,
        'subagent.assigned',
        JSON.stringify({
          id: String(row.id),
          role: String(row.role),
          objective: String(row.objective),
          childSessionId,
        }),
        at,
      );
    }
    // A finished child's summary lives in the parent's stored run result; without it an upgraded session
    // would show every old child as still running.
    for (const run of this.port.db
      .prepare('SELECT id,session_id AS sessionId,result FROM runs WHERE result IS NOT NULL')
      .all()) {
      let summaries: SubAgentSummary[] = [];
      try {
        const parsed = JSON.parse(String(run.result)) as RunResult;
        summaries = Array.isArray(parsed.subagents) ? parsed.subagents : [];
      } catch {
        // A damaged historical result simply contributes no cards.
      }
      for (const summary of summaries) {
        finished++;
        insert.run(
          String(run.sessionId),
          'subagent.finished',
          JSON.stringify({
            runId: String(run.id),
            id: summary.id,
            sessionId: summary.sessionId,
            role: summary.role,
            objective: summary.objective,
            status: summary.status,
            rounds: summary.rounds,
            toolCalls: summary.toolCalls,
            usage: summary.usage,
            ...(summary.report ? { report: summary.report } : {}),
            ...(summary.error ? { error: summary.error } : {}),
          }),
          at,
        );
      }
    }
    for (const row of assignments) {
      const childSessionId = String(row.childSessionId);
      const parent = parentOf(childSessionId);
      if (!parent) continue;
      const latest = this.port.db
        .prepare(
          'SELECT status FROM runs WHERE session_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',
        )
        .get(childSessionId);
      if (String(latest?.status ?? '') !== 'interrupted') continue;
      interrupted++;
      insert.run(
        parent,
        'subagent.interrupted',
        JSON.stringify({
          childSessionId,
          reason: 'Interrupted; inspect the child transcript and current state before retrying.',
        }),
        at,
      );
    }
    console.error(
      `[session log] backfilled ${assignments.length} sub-agent assignment(s)` +
        (finished ? `, ${finished} outcome(s)` : '') +
        (interrupted ? `, ${interrupted} interrupted` : '') +
        ' into schema v15',
    );
  }

  /**
   * The adjacent migration that introduced the session log.
   *
   * A database written before v14 has messages but no events, and the message projection reads events —
   * so an upgrade has to *backfill* the log from the rows that exist rather than start an empty log and
   * report every existing session as having no history at all. One step, one direction, self-contained:
   * the same shape every later format change should take, so nobody has to reason about an arbitrary
   * jump between versions.
   */
  private migrateSessionLog(fromVersion: number): void {
    if (fromVersion >= 14) return;
    const rows = this.port.db
      .prepare('SELECT seq, session_id AS sessionId, body FROM messages ORDER BY seq')
      .all();
    const insert = this.port.db.prepare(
      'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
    );
    const at = new Date().toISOString();
    for (const row of rows) {
      const message = JSON.parse(String(row.body)) as Message;
      insert.run(String(row.sessionId), messageEventType(message), JSON.stringify({ message }), at);
    }
    // Runs and compaction checkpoints are durable facts too, and a projection that folds the log would
    // otherwise report an upgraded session as never having run, or as never having compacted. The backfill
    // is grouped per fact type rather than interleaved by wall-clock time: within each group the order is
    // exact, and the transcript — the one order that has to be exact — is exact because `messages.seq` is.
    for (const row of this.port.db
      .prepare(
        'SELECT id,session_id AS sessionId,owner_pid AS ownerPid,status,started_at AS startedAt,result FROM runs ORDER BY started_at,rowid',
      )
      .all()) {
      insert.run(
        String(row.sessionId),
        'run.started',
        JSON.stringify({ runId: String(row.id), ownerPid: Number(row.ownerPid) }),
        String(row.startedAt),
      );
      if (row.result === null) continue;
      const result = JSON.parse(String(row.result)) as RunResult;
      insert.run(
        String(row.sessionId),
        'run.finished',
        JSON.stringify({
          runId: String(row.id),
          status: String(row.status),
          usage: result.usage,
          ...(result.statistics ? { statistics: result.statistics } : {}),
          ...(result.error ? { error: redactSecrets(result.error).slice(0, 600) } : {}),
        }),
        String(row.startedAt),
      );
    }
    // The table only exists in a database written before schema v18 dropped it; a fresh one has no
    // checkpoints to backfill, and asking for a table that was never created is an error rather than an
    // empty result.
    if (this.hasTable('context_checkpoints'))
      for (const row of this.port.db
        .prepare(
          'SELECT session_id AS sessionId,covered_messages AS coveredMessages,summary FROM context_checkpoints',
        )
        .all())
        insert.run(
          String(row.sessionId),
          'context.compacted',
          JSON.stringify({
            coveredMessages: Number(row.coveredMessages),
            summary: String(row.summary),
          }),
          at,
        );
    if (rows.length)
      console.error(`[session log] backfilled ${rows.length} message event(s) into schema v14`);
  }
}
