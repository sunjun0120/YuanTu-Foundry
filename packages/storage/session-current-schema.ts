/**
 * The schema *this* build writes, as one set of statements a caller can apply to a database that has never
 * held anything else.
 *
 * It exists because the migration chain is the wrong tool for a file that is brand new, and using it anyway was
 * a real defect rather than an untidiness. `initialize` used to run the base `CREATE TABLE IF NOT EXISTS`
 * statements and then walk *every* historical step over the result, so a database that had just been created
 * from nothing was immediately "upgraded": the step that gives projection checkpoints their fold identity found
 * the table the same function had created a moment earlier, dropped it as if it held an old integer, recreated
 * it identically, and announced `dropped projection_checkpoints` on the console. Nothing was lost — the table
 * never held a row — but the message says data was discarded, and the only way to know it did not is to have
 * read the code above it. A file with no tables has no data to carry forward, so it needs the current schema
 * and nothing else.
 *
 * **This is the complete current shape, not the base shape.** An existing database is brought forward by
 * `ADD COLUMN` statements in `./session-migrations.ts` — `sessions.title`, `tasks.trigger_revision` and their
 * neighbours were added over several versions — so a definition written for a new file has to declare those
 * columns directly. The two entries are compared rather than shared: `CREATE TABLE IF NOT EXISTS` cannot add a
 * column to a table that already exists, so there is no single text that serves both, and the parity regression
 * in `tests/schema-migrations.test.ts` — a new database against a migrated one, table by table — is what keeps
 * them from drifting apart.
 *
 * Two properties this function deliberately does **not** have:
 *
 * - It does not decide whether the file is ours. The `application_marker` row, the `application_id` pragma and
 *   the "tables this build does not create" check all belong to `SessionMigrations.initialize`, which has
 *   already answered that question before calling this.
 * - It does not stamp a version or take a backup. `user_version` is written by `initialize` inside the same
 *   transaction, and a database with no data in it is not worth a snapshot.
 */
import type { DatabaseSync } from 'node:sqlite';

export function createCurrentSessionSchema(db: DatabaseSync): void {
  db.exec(`
      -- The file's own answer to "whose database is this", read before any of our tables are interpreted.
      -- A row rather than PRAGMA application_id, which this runtime's SQLite binding applies to the connection
      -- only and never writes to the header (see APPLICATION_ID).
      CREATE TABLE application_marker (
        application TEXT PRIMARY KEY,
        format INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      -- title/title_source/parent_session_id/fork_message_count are the derived columns an upgraded database
      -- receives as ADD COLUMN; a new one declares them here, in the order that upgrade leaves them in.
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT,
        title TEXT NOT NULL DEFAULT '', title_source TEXT NOT NULL DEFAULT 'fallback',
        parent_session_id TEXT, fork_message_count INTEGER
      );
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX messages_session ON messages(session_id,seq);
      -- Image bytes, content-addressed (schema v21). A message row and its message.* log entry carry a
      -- hash plus a mime type instead of the base64, so the same picture costs one row instead of one copy
      -- per mention. Rows written before v21 keep their inline bytes and are read exactly as they are.
      CREATE TABLE attachment_blobs (
        hash TEXT PRIMARY KEY, mime_type TEXT NOT NULL, bytes BLOB NOT NULL,
        size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE session_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX session_events_session ON session_events(session_id,seq);
      -- Who is writing each session right now (see SessionLease). Ephemeral presence: taken by beginRun,
      -- renewed by the run loop, released when the run finishes, and reclaimed only through the dead-owner
      -- path. Never expired by age, so it is not a second source of truth about a run's status.
      CREATE TABLE session_leases (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        renewed_at TEXT NOT NULL,
        renewals INTEGER NOT NULL DEFAULT 0,
        compacting_run_id TEXT
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner_pid INTEGER NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL, result TEXT
      );
      CREATE TABLE run_stream_checkpoints (
        run_id TEXT NOT NULL REFERENCES runs(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id,message_id)
      );
      CREATE TABLE file_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT,
        change TEXT NOT NULL, before_bytes BLOB, after_bytes BLOB NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX changes_session ON file_changes(session_id,seq);
      -- Folded projection state, kept between processes. seq is how far into the session log it has been
      -- folded; version holds the identity of the fold that wrote it (see projectionFoldIdentity), so state
      -- written by a different fold of the same projection is ignored rather than continued.
      CREATE TABLE projection_checkpoints (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        seq INTEGER NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,name)
      );
      CREATE TABLE file_change_files (
        change_id TEXT NOT NULL REFERENCES file_changes(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, path TEXT NOT NULL,
        before_bytes BLOB, after_bytes BLOB,
        PRIMARY KEY(change_id,ordinal), UNIQUE(change_id,path)
      );
      -- verification, definition_attempt_floor, trigger, trigger_revision, current_delivery_id, next_run_at,
      -- last_run_at and last_trigger_error are derived by the upgrade; declared here for a new database.
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        verification TEXT,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        definition_attempt_floor INTEGER NOT NULL DEFAULT 0,
        trigger TEXT,
        trigger_revision TEXT,
        current_delivery_id TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_trigger_error TEXT
      );
      CREATE INDEX tasks_session ON tasks(session_id,created_at,id);
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
      CREATE INDEX plans_session ON plans(session_id,created_at DESC,id);
      -- trigger and resume are derived by the upgrade as well.
      CREATE TABLE task_attempts (
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
        trigger TEXT NOT NULL DEFAULT 'manual',
        resume INTEGER NOT NULL DEFAULT 0,
        UNIQUE(task_id,ordinal)
      );
      CREATE INDEX task_attempts_task ON task_attempts(task_id,ordinal);
      CREATE TABLE task_step_checkpoints (
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
      CREATE INDEX task_step_checkpoints_task ON task_step_checkpoints(task_id,seq);
      CREATE TABLE task_effects (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','completed','reviewed')),
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX task_effects_pending ON task_effects(task_id,status);
      CREATE TABLE task_approvals (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
        approval TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      -- Sub-agent workspace isolation (schema v29). Four tables, and the foreign keys are deliberately uneven.
      --
      -- A binding keeps its session as a *nullable* reference rather than a cascade: the row is written in the
      -- preparing state before the child session exists, which is what makes an interrupted allocation a record
      -- this service can still own instead of an orphan directory. project_root is the logical project and
      -- execution_root is what a child's tools actually use — keeping both is what lets a child work somewhere
      -- else while its session still belongs where it always did.
      CREATE TABLE workspace_bindings (
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
      CREATE INDEX workspace_bindings_session ON workspace_bindings(session_id);
      CREATE INDEX workspace_bindings_state ON workspace_bindings(state,created_at);
      CREATE TABLE workspace_operation_leases (
        binding_id TEXT PRIMARY KEY REFERENCES workspace_bindings(id) ON DELETE CASCADE,
        owner_pid INTEGER NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- A frozen input. No session reference at all: one snapshot is shared by every child of a delegation call,
      -- and the whole point of it is that it outlives the sessions built from it.
      CREATE TABLE workspace_snapshots (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        source_root TEXT NOT NULL,
        source_head TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        base_tree TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- A child's exported work. The parent session is a plain id and not a reference, so a result survives the
      -- deletion of the session that produced it: it is the record of what a child changed, and losing it with a
      -- cascade would lose the only description of a directory nobody else has.
      CREATE TABLE workspace_results (
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
      CREATE INDEX workspace_results_parent ON workspace_results(parent_session_id,created_at);
      CREATE INDEX workspace_results_child ON workspace_results(child_session_id,status);
      -- The idempotency key of one import: the same result, the same digest, the same target directory. Written
      -- in the same transaction as the journal entry it names, so "the change exists" and "this result was
      -- imported" cannot disagree, and a repeated request is answered with what already happened.
      CREATE TABLE workspace_apply_receipts (
        id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        target_binding_id TEXT NOT NULL,
        change_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(result_id,digest,target_binding_id)
      );
    `);
  // The session search index. The projection column is filled by `append`, and these triggers keep the index in
  // step for every write path. They are part of "the current schema" rather than of a migration: a database
  // created today has to be searchable, and a database upgraded today has to be searchable in exactly the same
  // way. The upgraded path defines the same three triggers over the same virtual table.
  db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(search_text, tokenize='unicode61');
      CREATE TRIGGER messages_ai AFTER INSERT ON messages
        WHEN new.search_text <> '' BEGIN
        INSERT INTO messages_fts(rowid,search_text) VALUES(new.seq,new.search_text); END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid=old.seq; END;
      CREATE TRIGGER messages_au AFTER UPDATE OF search_text ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid=old.seq;
        INSERT INTO messages_fts(rowid,search_text)
          SELECT new.seq,new.search_text WHERE new.search_text <> ''; END;`);
}
