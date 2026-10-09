import type { DatabaseSync } from 'node:sqlite';
import type { Usage } from '../protocol/index.ts';
import type { SessionEventType } from './events.ts';
import type { Session } from './session-schema.ts';
import { hashesIn } from './session-blobs.ts';

/**
 * What a person may do to a session *after* it exists: rename it, let a model name it, and delete it.
 *
 * All three mutate something a run may be using, so all three ask the same question first — `assertMutable`
 * refuses a session with an active run, or one whose file restoration is in flight, because both are cases where
 * history is being written by somebody else. Deletion goes further and takes the whole lineage: a sub-agent
 * session is not an independent conversation, so leaving one behind on a hidden id would strand a session whose
 * parent no longer exists.
 *
 * The store is borrowed through a port, and two of its members are *operations on mutable state* rather than
 * references to it: `dropLogCache` and `dropPendingAppends` say "the cached rows for this session are no longer
 * valid", which is the only thing this module knows about them. A raw reference would let it reach into the
 * store's caches, which is the coupling this split exists to remove.
 */
export interface SessionLifecyclePort {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  get(id: string): Session;
  recordEvent(
    id: string,
    type: SessionEventType,
    data: Record<string, unknown>,
    stored?: Record<string, unknown>,
  ): void;
  /** Drops a session's folded transcript and any buffered append: it is being rewritten or removed. */
  dropLogCache(id: string): void;
  dropPendingAppends(id: string): void;
}

/** What a host may change about a session after it exists; `SessionStore` forwards to this. */
export class SessionLifecycle {
  private readonly port: SessionLifecyclePort;

  constructor(port: SessionLifecyclePort) {
    this.port = port;
  }

  private assertMutable(id: string): Session {
    const session = this.port.get(id);
    if (session.activeRun)
      throw new Error(
        'Session is running or interrupted; finish or recover it before changing history',
      );
    if (
      this.port.db
        .prepare("SELECT 1 FROM file_changes WHERE session_id=? AND status='undoing'")
        .get(id)
    )
      throw new Error('File restoration is busy');
    return session;
  }
  rename(id: string, title: string): Session {
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.trim().length > 120 ||
      /[\x00-\x1f\x7f]/.test(title)
    )
      throw new Error('Session title must contain 1 to 120 visible characters');
    return this.port.transaction(() => {
      this.assertMutable(id);
      this.port.db
        .prepare("UPDATE sessions SET title=?,title_source='manual' WHERE id=?")
        .run(title.trim(), id);
      return this.port.get(id);
    });
  }
  /**
   * Whether a model-generated title may still replace this session's own.
   *
   * True only while the session is still on its `fallback` title. The read is the cheap half of the pair below;
   * the write is the half that actually decides, because it repeats the condition inside the `UPDATE`.
   */
  canGenerateTitle(id: string): boolean {
    this.port.get(id);
    return Boolean(
      this.port.db.prepare("SELECT 1 FROM sessions WHERE id=? AND title_source='fallback'").get(id),
    );
  }
  /**
   * Apply a model-generated title, unless a person has named the session in the meantime.
   *
   * The condition is checked in SQL rather than in this function so a rename that lands while the model call is
   * in flight always wins: `changes === 1` is the only evidence that *this* write is the one that took, and it is
   * returned rather than assumed.
   *
   * `usage` is what the title call cost. It is a real model call, so the session's statistics fold it in through
   * `session.title.generated` — the same treatment a compaction's summary request gets — and it is not a run, so
   * no run budget is charged for it. The event is only written when the title actually took: a refused write
   * charged to the session would be a cost reported for something that did not happen.
   */
  setGeneratedTitle(id: string, title: string, usage?: Usage): boolean {
    const clean = title.trim();
    if (!clean || clean.length > 120 || /[\x00-\x1f\x7f]/.test(clean)) return false;
    // The title and the event that accounts for the model call that produced it are one fact: a rename that
    // took while its usage record failed would report a session named by a call nobody paid for, and the
    // reverse would charge for a title that was refused. Both are written in one transaction, so a failure
    // leaves the fallback title and no event — see `tests/storage-audit-repairs.test.ts`.
    return this.port.transaction(() => {
      this.port.get(id);
      const took =
        this.port.db
          .prepare(
            "UPDATE sessions SET title=?,title_source='generated' WHERE id=? AND title_source='fallback'",
          )
          .run(clean, id).changes === 1;
      if (took)
        this.port.recordEvent(id, 'session.title.generated', {
          title: clean,
          ...(usage ? { usage } : {}),
        });
      return took;
    });
  }
  delete(id: string): void {
    this.port.transaction(() => {
      this.assertMutable(id);
      // A sub-agent session is not an independent conversation: leaving it behind would strand a
      // hidden session whose parent no longer exists. Descendants are removed without the mutability
      // check, because an interrupted child must never block deleting the session the user asked to
      // delete.
      const descendants: string[] = [];
      for (let level = [id]; level.length;) {
        const next: string[] = [];
        for (const parent of level)
          for (const child of this.port.db
            // Only delegated children: a session fork points at its source too, and deleting a
            // conversation must never delete a copy someone else is working in.
            .prepare(
              'SELECT id FROM sessions WHERE parent_session_id=? AND fork_message_count IS NULL',
            )
            .all(parent))
            next.push(String(child.id));
        descendants.push(...next);
        level = next;
      }
      for (const sessionId of [...descendants.reverse(), id]) this.deleteSessionRows(sessionId);
    });
  }
  private deleteSessionRows(id: string): void {
    // The session and its log are about to stop existing, so neither its fold nor its unwritten appends
    // may outlive them: a later flush would write rows for a session that is gone.
    this.port.dropLogCache(id);
    this.port.dropPendingAppends(id);
    // Which bytes this session was the last to mention is only answerable *before* its rows go, so the
    // addresses are collected first and the blobs are dropped afterwards if nothing else still names them.
    const referenced = this.sessionHashes(id);
    for (const table of [
      'file_changes',
      'messages',
      'run_stream_checkpoints',
      'runs',
      'session_events',
      'task_attempts',
      'tasks',
    ])
      this.port.db.prepare('DELETE FROM ' + table + ' WHERE session_id=?').run(id);
    this.port.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    for (const hash of referenced)
      if (!this.blobReferenced(hash))
        this.port.db.prepare('DELETE FROM attachment_blobs WHERE hash=?').run(hash);
  }
  /** Every content address the session's rows and log entries name. */
  private sessionHashes(id: string): Set<string> {
    const hashes = new Set<string>();
    const rows = [
      ...this.port.db.prepare('SELECT body AS json FROM messages WHERE session_id=?').all(id),
      ...this.port.db.prepare('SELECT data AS json FROM session_events WHERE session_id=?').all(id),
    ];
    for (const row of rows) {
      try {
        hashesIn(JSON.parse(String(row.json)), hashes);
      } catch {
        // A row that no longer parses names nothing; it is not this path's job to report it.
      }
    }
    return hashes;
  }
  /**
   * Whether any row or log entry still names this address.
   *
   * The `LIKE` narrows the candidates to rows that contain the digest *at all*, and those few are then read
   * as JSON — a hash appearing in prose therefore keeps a blob alive rather than being mistaken for a
   * reference. It runs on session deletion only, which is why a scan is an honest price for not maintaining a
   * second copy of "who refers to what" that could drift from the rows themselves.
   */
  private blobReferenced(hash: string): boolean {
    const candidates = [
      ...this.port.db
        .prepare("SELECT body AS json FROM messages WHERE body LIKE '%'||?||'%'")
        .all(hash),
      ...this.port.db
        .prepare("SELECT data AS json FROM session_events WHERE data LIKE '%'||?||'%'")
        .all(hash),
    ];
    for (const row of candidates) {
      const found = new Set<string>();
      try {
        hashesIn(JSON.parse(String(row.json)), found);
      } catch {
        continue;
      }
      if (found.has(hash)) return true;
    }
    return false;
  }
}
