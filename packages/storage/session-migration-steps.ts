/**
 * The individual schema upgrades, one function per step, each a no-op on a database already past it.
 *
 * `SessionMigrations` owns the order and the transaction; these own only what a step does to the tables.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Message, RunResult, SubAgentSummary, Usage } from '../protocol/index.ts';
import { redactSecrets } from '../platform/redact.ts';
import { ftsIndexText } from '../formats/fts-text.ts';
import { messageEventType } from './events.ts';

/** The connection a migration borrows: the database and the transaction wrapper around it. */
export interface SessionMigrationPort {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
}

/** Whether a table exists in this database. Migrations read tables this build no longer creates. */
export function hasTable(port: SessionMigrationPort, name: string): boolean {
  return (
    port.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !==
    undefined
  );
}

/**
 * The migration that makes Chinese, Japanese and Korean text searchable (see `ftsIndexText`).
 *
 * The projection is re-segmented from the column itself rather than re-derived from `body`: the column is
 * already the conversational text, while the body is the blob that carries base64 images. Segmenting is
 * idempotent, so a row the v10 backfill just wrote in the new form is left exactly as it is, and only a row
 * whose text changes is written — the update trigger then re-indexes that row and no other.
 */
export function migrateSegmentedSearchText(port: SessionMigrationPort, fromVersion: number): void {
  if (fromVersion >= 31) return;
  const rows = port.db
    .prepare("SELECT seq,search_text AS text FROM messages WHERE search_text<>''")
    .all();
  const update = port.db.prepare('UPDATE messages SET search_text=? WHERE seq=?');
  for (const row of rows) {
    const text = String(row.text);
    const segmented = ftsIndexText(text);
    if (segmented !== text) update.run(segmented, Number(row.seq));
  }
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
export function migrateMachineTitledSessions(
  port: SessionMigrationPort,
  fromVersion: number,
): void {
  if (fromVersion >= 23) return;
  port.db
    .prepare(
      "UPDATE sessions SET title='' WHERE title_source='fallback' AND (title LIKE '<runtime-context %' OR title LIKE '<compacted-summary>%')",
    )
    .run();
}

/**
 * The migration that gave every checkpoint the identity of the fold that wrote it.
 *
 * The column has to change type as well as meaning: it held one global integer and now holds a digest, and
 * SQLite's INTEGER affinity would turn a hex digest into a number. There is nothing to copy — checkpoints are
 * derived data by definition, so the migration is "drop it and let the schema above recreate it", and every
 * session folds once more from the log, which is where a checkpoint's contents come from anyway.
 */
export function migrateProjectionCheckpointIdentity(
  port: SessionMigrationPort,
  fromVersion: number,
): void {
  if (fromVersion >= 22) return;
  if (!hasTable(port, 'projection_checkpoints')) return;
  port.db.exec('DROP TABLE projection_checkpoints');
  port.db.exec(`
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
export function migratePlanAbandoned(port: SessionMigrationPort, fromVersion: number): void {
  if (fromVersion >= 22) return;
  if (!hasTable(port, 'plans')) return;
  port.db.exec(`
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

/**
 * The adjacent migration that records what a compaction cost.
 *
 * The summary request is a model call the user pays for, but its usage only ever existed as a local
 * variable — so a session's statistics disagreed with the bill exactly for the sessions that compact the
 * most. Recording it in the write-through table as well as the log keeps the two views reconcilable, which
 * is what the statistics projection is checked against.
 */
export function migrateContextCheckpointUsage(
  port: SessionMigrationPort,
  fromVersion: number,
): void {
  if (fromVersion >= 17) return;
  if (!hasTable(port, 'context_checkpoints')) return;
  const columns = port.db.prepare('PRAGMA table_info(context_checkpoints)').all();
  if (columns.some((column) => String(column.name) === 'usage')) return;
  port.db.exec('ALTER TABLE context_checkpoints ADD COLUMN usage TEXT');
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
export function migrateCompactionSurface(port: SessionMigrationPort, fromVersion: number): void {
  if (fromVersion >= 18) return;
  // A fresh database never created the table, so there is nothing to drop and nothing to report: this
  // migration is only ever visible on a database written before it.
  if (!hasTable(port, 'context_checkpoints')) return;
  const insert = port.db.prepare(
    'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
  );
  const at = new Date().toISOString();
  let backfilled = 0;
  const rows = port.db
    .prepare(
      'SELECT session_id AS sessionId,covered_messages AS coveredMessages,summary,usage FROM context_checkpoints',
    )
    .all();
  for (const row of rows) {
    const sessionId = String(row.sessionId);
    const recorded = port.db
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
  port.db.exec('DROP TABLE context_checkpoints');
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
export function migrateDropSubAgentAssignments(
  port: SessionMigrationPort,
  fromVersion: number,
): void {
  if (fromVersion >= 16) return;
  if (!hasTable(port, 'subagent_assignments')) return;
  port.db.exec('DROP TABLE subagent_assignments');
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
export function migrateSubAgentCards(port: SessionMigrationPort, fromVersion: number): void {
  if (fromVersion >= 15) return;
  // The table only exists in databases written before v16; a fresh one has no assignments to carry over.
  if (!hasTable(port, 'subagent_assignments')) return;
  const insert = port.db.prepare(
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
      port.db.prepare('SELECT parent_session_id FROM sessions WHERE id=?').get(childSessionId)
        ?.parent_session_id ?? '',
    );
  const assignments = port.db
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
  for (const run of port.db
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
    const latest = port.db
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
export function migrateSessionLog(port: SessionMigrationPort, fromVersion: number): void {
  if (fromVersion >= 14) return;
  const rows = port.db
    .prepare('SELECT seq, session_id AS sessionId, body FROM messages ORDER BY seq')
    .all();
  const insert = port.db.prepare(
    'INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)',
  );
  const at = new Date().toISOString();
  for (const row of rows) {
    let message: Message;
    try {
      message = JSON.parse(String(row.body)) as Message;
    } catch {
      /**
       * A body that no longer parses is skipped, and this is the difference between one lost message and a
       * lost workspace.
       *
       * The whole upgrade runs in a single transaction that writes `PRAGMA user_version` at its end, so a
       * throw here rolls the version back too: the next open re-runs this same migration and fails
       * identically, for every session in the database, not only the one with the damaged row. The sibling
       * backfills already take this position — `migrateSubAgentCards` drops an unparseable result and the
       * FTS rebuild leaves such a body unsearchable — and the row is left untouched in `messages`, so the
       * cost is a message missing from the *folded* log, which a later repair can still recover.
       */
      continue;
    }
    insert.run(String(row.sessionId), messageEventType(message), JSON.stringify({ message }), at);
  }
  // Runs and compaction checkpoints are durable facts too, and a projection that folds the log would
  // otherwise report an upgraded session as never having run, or as never having compacted. The backfill
  // is grouped per fact type rather than interleaved by wall-clock time: within each group the order is
  // exact, and the transcript — the one order that has to be exact — is exact because `messages.seq` is.
  for (const row of port.db
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
    /**
     * Guarded for the same reason as the message loop above: one damaged result must not make the database
     * unopenable. The run still *finishes* — `status` is its own column and leaving the run open would make
     * an upgraded session report a turn that never ended, which the abandoned-run reconciliation would then
     * try to settle — but the fields that exist only inside the result are dropped when it cannot be read.
     */
    let result: RunResult | undefined;
    try {
      result = JSON.parse(String(row.result)) as RunResult;
    } catch {
      /* Contributing no usage, statistics or error is the whole of the loss. */
    }
    insert.run(
      String(row.sessionId),
      'run.finished',
      JSON.stringify({
        runId: String(row.id),
        status: String(row.status),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.statistics ? { statistics: result.statistics } : {}),
        ...(result?.error ? { error: redactSecrets(result.error).slice(0, 600) } : {}),
      }),
      String(row.startedAt),
    );
  }
  // The table only exists in a database written before schema v18 dropped it; a fresh one has no
  // checkpoints to backfill, and asking for a table that was never created is an error rather than an
  // empty result.
  if (hasTable(port, 'context_checkpoints'))
    for (const row of port.db
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
