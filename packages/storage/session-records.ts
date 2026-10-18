import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Session } from './session-schema.ts';

export interface SessionRecordsPort {
  readonly db: DatabaseSync;
  /** Reads go through the store so buffered appends are written before a row is described. */
  flush(id?: string): void;
  get(id: string): Session;
}

const SESSION_COLUMNS =
  'id,workspace,created_at AS createdAt,active_run AS activeRun,title,parent_session_id AS parentSessionId';

/** The `sessions` rows themselves: creating one, reading one, and listing a parent's delegated children. */
export class SessionRecords {
  private readonly port: SessionRecordsPort;

  constructor(port: SessionRecordsPort) {
    this.port = port;
  }

  /**
   * A delegated child's session. `parent_session_id` records the lineage, and both lineage columns
   * were already present (v11) for features that had not been built yet: a sub-agent child is a
   * session with a parent **and no fork count**, while a session fork (still unimplemented) is a
   * session with a parent **and** a fork count. Every predicate below relies on that distinction,
   * because the two relationships must not share behaviour: a child is hidden from `list()` and dies
   * with its parent, whereas a fork is an independent conversation that must survive the original.
   */
  create(workspace: string, parentSessionId?: string): Session {
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    if (parentSessionId !== undefined) {
      const parent = this.port.get(parentSessionId);
      if (path.resolve(workspace) !== parent.workspace)
        throw new Error('A child session must share its parent workspace');
    }
    this.port.db
      .prepare('INSERT INTO sessions(id,workspace,created_at,parent_session_id) VALUES(?,?,?,?)')
      .run(id, path.resolve(workspace), createdAt, parentSessionId ?? null);
    return this.port.get(id);
  }

  get(id: string): Session {
    // Reading a session is reading its title, and a title written by an unwritten append is still the
    // session's title. The buffered messages go first so that what a reader is told is what is recorded.
    this.port.flush(id);
    const row = this.port.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id=?`).get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    return row as unknown as Session;
  }

  /**
   * Sessions a sub-agent ran in, oldest first. They are excluded from `list()` so the user's session
   * list stays a list of conversations, but their transcripts stay in the store for auditing.
   */
  childSessions(parentSessionId: string): Session[] {
    this.port.get(parentSessionId);
    return this.port.db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE parent_session_id=? AND fork_message_count IS NULL ORDER BY created_at,rowid`,
      )
      .all(parentSessionId) as unknown as Session[];
  }
}
