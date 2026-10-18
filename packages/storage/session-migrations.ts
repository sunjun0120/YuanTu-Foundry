import type { Message } from '../protocol/index.ts';
import { createDatabaseBackup, type BackupPolicy } from './database-maintenance.ts';
import { createCurrentSessionSchema, createLookupIndexes } from './session-current-schema.ts';
import {
  APPLICATION_ID,
  APPLICATION_NAME,
  APPLICATION_FORMAT,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
  SESSION_DATABASE_POLICY,
  messageSearchText,
} from './session-schema.ts';

import {
  hasTable,
  migrateCompactionSurface,
  migrateContextCheckpointUsage,
  migrateDropSubAgentAssignments,
  migrateMachineTitledSessions,
  migratePlanAbandoned,
  migrateProjectionCheckpointIdentity,
  migrateSegmentedSearchText,
  migrateSessionLog,
  migrateSubAgentCards,
  type SessionMigrationPort,
} from './session-migration-steps.ts';

export type { SessionMigrationPort } from './session-migration-steps.ts';

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
    /**
     * `synchronous=NORMAL` is per connection, so it is set on every open. In WAL mode it syncs at checkpoints
     * rather than at every commit: a power loss can lose the last commits, never corrupt the file, which is the
     * trade SQLite documents as the right one for WAL. The default (FULL) paid an fsync per commit, and a run
     * commits at every step boundary and every batch of messages.
     */
    this.port.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;',
    );
    /**
     * A file with no tables at all is not a version of this schema — it is the absence of one.
     *
     * The distinction is the whole point of this branch. Every migration step below describes a *change*, and a
     * change applied to nothing is not a no-op: the step that gave projection checkpoints their fold identity
     * dropped the table the statements below had just created and printed `dropped projection_checkpoints`, so a
     * brand-new database announced that it had discarded data. A file that holds no table of ours (and, because
     * the identity check above already ran, no table of anybody else's either) has nothing to carry forward.
     *
     * The test is "no tables", not "version 0": a database written before this build stamped versions is also
     * version 0 and *does* have data, and it must still walk the chain.
     */
    const empty = version === 0 && this.userTables().length === 0;
    if (empty) {
      /**
       * The new-database entry: the current schema, the identity and the version, in one transaction.
       *
       * No migration step runs and no backup is taken, because there is nothing to migrate and nothing to lose.
       * The shape this produces is the shape a migrated database reaches — that equality is what the parity
       * regression in `tests/schema-migrations.test.ts` asserts, and it is the only thing keeping these two
       * entries honest about being the same schema.
       */
      this.port.transaction(() => {
        createCurrentSessionSchema(this.port.db);
        this.claimApplication();
        this.port.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      });
      return;
    }
    /**
     * The upgrade path, unchanged: the base shape every historical version shares, then the derived columns, the
     * search index and the data steps that bring a file written by an older build forward.
     *
     * It stays as it is on purpose. A database that already exists cannot be re-created with the statements in
     * `./session-current-schema.ts` — `CREATE TABLE IF NOT EXISTS` would skip the tables it already has and the
     * columns it is missing would never appear — so the current shape has to be reached by *adding* to what is
     * there. The two entries are compared, not merged.
     */
    this.port.db.exec(`
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
      -- Sub-agent workspace isolation (schema v29). Created here as well as in the current-schema entry: an
      -- existing database has to *gain* these tables, while a new one declares them, and the parity regression
      -- in tests/schema-migrations.test.ts is what keeps the two definitions identical. No data step accompanies
      -- them — a session written before isolation has no binding, and the honest reading of such a session is the
      -- synthesised shared binding the store returns on read, not a row this migration would have invented.
      CREATE TABLE IF NOT EXISTS workspace_bindings (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        parent_session_id TEXT,
        project_root TEXT NOT NULL,
        execution_root TEXT NOT NULL,
        repository_root TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('shared','worktree')),
        snapshot_id TEXT,
        base_commit TEXT,
        state TEXT NOT NULL CHECK(state IN ('preparing','ready','blocked','archiving','archived','removing','removed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_bindings_session ON workspace_bindings(session_id);
      CREATE INDEX IF NOT EXISTS workspace_bindings_state ON workspace_bindings(state,created_at);
      CREATE TABLE IF NOT EXISTS workspace_operation_leases (
        binding_id TEXT PRIMARY KEY REFERENCES workspace_bindings(id) ON DELETE CASCADE,
        owner_pid INTEGER NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        source_root TEXT NOT NULL,
        source_head TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        base_tree TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_results (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        comparison_tree TEXT NOT NULL,
        result_tree TEXT NOT NULL,
        digest TEXT NOT NULL,
        paths TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ready','unsupported','applying','applied','conflict','superseded')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_results_parent ON workspace_results(parent_session_id,created_at);
      CREATE INDEX IF NOT EXISTS workspace_results_child ON workspace_results(child_session_id,status);
      CREATE INDEX IF NOT EXISTS workspace_results_binding ON workspace_results(binding_id,created_at,id);
      CREATE TABLE IF NOT EXISTS workspace_apply_receipts (
        id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        target_binding_id TEXT NOT NULL,
        change_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(result_id,digest,target_binding_id)
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
      /**
       * When the run's owner process started (epoch ms), so a pid the system has since handed to another process
       * is not mistaken for the owner (see `deadOwner`). Null on rows written before it was recorded, which are
       * judged by the pid alone, as they always were.
       */
      const runColumns = new Set(
        this.port.db
          .prepare('PRAGMA table_info(runs)')
          .all()
          .map((row) => row.name),
      );
      if (!runColumns.has('owner_started_at'))
        this.port.db.exec('ALTER TABLE runs ADD COLUMN owner_started_at INTEGER');
      // After the derived columns above: `sessions_parent` names one of them.
      createLookupIndexes(this.port.db);
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

  /**
   * Every table in this file that is not one of SQLite's own, in name order.
   *
   * Two questions are answered from it: whether the file holds anything at all (the difference between a brand
   * new database and one written before this build stamped versions), and whether what it holds is ours. Both
   * read `sqlite_master` directly, because at the top of `initialize` the only query that can be trusted is one
   * that answers for a foreign file as readily as for ours.
   */
  private userTables(): string[] {
    return this.port.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
  }

  /** Tables in this file that this build does not create — the evidence that the file is somebody else's. */
  private foreignTables(): string[] {
    const ours = new Set<string>(SCHEMA_TABLES);
    return this.userTables().filter((name) => !ours.has(name));
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
      { from: 13, upTo: 14, run: (from) => migrateSessionLog(this.port, from) },
      { from: 14, upTo: 15, run: (from) => migrateSubAgentCards(this.port, from) },
      { from: 15, upTo: 16, run: (from) => migrateDropSubAgentAssignments(this.port, from) },
      { from: 16, upTo: 17, run: (from) => migrateContextCheckpointUsage(this.port, from) },
      { from: 17, upTo: 18, run: (from) => migrateCompactionSurface(this.port, from) },
      { from: 21, upTo: 22, run: (from) => migratePlanAbandoned(this.port, from) },
      { from: 21, upTo: 22, run: (from) => migrateProjectionCheckpointIdentity(this.port, from) },
      { from: 22, upTo: 23, run: (from) => migrateMachineTitledSessions(this.port, from) },
      // A reader compatibility fence: v23 cannot interpret durable program outcomes.
      { from: 23, upTo: 24, run: () => {} },
      { from: 24, upTo: 25, run: () => {} },
      { from: 25, upTo: 26, run: () => {} },
      { from: 26, upTo: 27, run: () => {} },
      // Old readers must not launch automatic work while ignoring its durable authority.
      { from: 27, upTo: 28, run: () => {} },
      // A reader compatibility fence: v28 cannot interpret a durable workspace binding, and a run that ignored
      // one would write into a directory it was never given (see the workspace_bindings tables above).
      { from: 28, upTo: 29, run: () => {} },
      // Older hosts do not honour the cross-process workspace cleanup lease.
      { from: 29, upTo: 30, run: () => {} },
      { from: 30, upTo: 31, run: (from) => migrateSegmentedSearchText(this.port, from) },
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

  private hasTable(name: string): boolean {
    return hasTable(this.port, name);
  }
}
