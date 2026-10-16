import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { FileChange, FileSnapshot, Message } from '../protocol/index.ts';
import type { Session, StoredFileChange } from './session-schema.ts';

export interface FileChangePort {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  get(id: string): Session;
  append(id: string, message: Message): void;
  prepareFileChangeGroup(sessionId: string, change: FileChange, files: FileSnapshot[]): string;
  markFileChange(id: string, status: StoredFileChange['status']): void;
  fileChangeBytes(sessionId: string, id: string): { before: Buffer | null; after: Buffer };
}

/** File snapshot ownership, grouped writes and undo receipts use the store's transaction. */
export class SessionFileChanges {
  private readonly port: FileChangePort;
  constructor(port: FileChangePort) {
    this.port = port;
  }

  prepareFileChange(
    sessionId: string,
    change: FileChange,
    before: Uint8Array | null,
    after: Uint8Array,
  ): string {
    return this.port.prepareFileChangeGroup(sessionId, change, [
      { path: change.path, before, after },
    ]);
  }

  prepareFileChangeGroup(sessionId: string, change: FileChange, files: FileSnapshot[]): string {
    const session = this.port.get(sessionId),
      id = randomUUID();
    if (!files.length || files.length > 100) throw new Error('Invalid file snapshot group');
    let total = 0;
    const paths = new Set<string>();
    for (const file of files) {
      if (!file.path || paths.has(file.path)) throw new Error('Invalid file snapshot path');
      paths.add(file.path);
      if ((file.before?.byteLength ?? 0) > 20_000_000 || (file.after?.byteLength ?? 0) > 20_000_000)
        throw new Error('Snapshot exceeds 20MB');
      total += (file.before?.byteLength ?? 0) + (file.after?.byteLength ?? 0);
    }
    if (total > 40_000_000) throw new Error('Snapshot group exceeds 40MB');
    return this.port.transaction(() => {
      const first = files[0]!;
      this.port.db
        .prepare(
          "INSERT INTO file_changes(id,session_id,run_id,change,before_bytes,after_bytes,status,created_at) VALUES(?,?,?,?,?,?, 'pending',?)",
        )
        .run(
          id,
          sessionId,
          session.activeRun,
          JSON.stringify({ ...change, id }),
          first.before,
          first.after ?? Buffer.alloc(0),
          new Date().toISOString(),
        );
      const insert = this.port.db.prepare(
        'INSERT INTO file_change_files(change_id,ordinal,path,before_bytes,after_bytes) VALUES(?,?,?,?,?)',
      );
      files.forEach((file, ordinal) => insert.run(id, ordinal, file.path, file.before, file.after));
      return id;
    });
  }

  markFileChange(id: string, status: StoredFileChange['status']): void {
    this.port.db.prepare('UPDATE file_changes SET status=? WHERE id=?').run(status, id);
  }

  completeFileUndo(sessionId: string, id: string, notice: string): void {
    this.port.transaction(() => {
      const row = this.port.db
        .prepare('SELECT status FROM file_changes WHERE session_id=? AND id=?')
        .get(sessionId, id);
      if (row?.status !== 'undoing') throw new Error('File restoration state changed');
      this.port.markFileChange(id, 'undone');
      this.port.append(sessionId, { role: 'user', content: notice });
    });
  }

  fileChanges(sessionId: string): StoredFileChange[] {
    this.port.get(sessionId);
    return this.port.db
      .prepare(
        `WITH timeline AS (
          SELECT type,
            CASE WHEN type IN ('run.started','run.finished','run.interrupted') THEN json_extract(data,'$.runId') END AS runId,
            SUM(CASE WHEN type IN ('message.user','message.assistant','message.tool') THEN 1 ELSE 0 END)
              OVER (ORDER BY seq) - 1 AS messageIndex
          FROM session_events WHERE session_id=?
            AND type IN ('message.user','message.assistant','message.tool','run.started','run.finished','run.interrupted')
        ), endings AS (
          SELECT runId,
            MIN(CASE WHEN type='run.started' THEN messageIndex END) AS startMessageIndex,
            MAX(CASE WHEN type IN ('run.finished','run.interrupted') THEN messageIndex END) AS endMessageIndex FROM timeline
          WHERE runId IS NOT NULL GROUP BY runId
        )
        SELECT f.id,f.session_id AS sessionId,f.run_id AS runId,f.change,f.status,
          f.created_at AS createdAt,
          e.endMessageIndex IS NOT NULL AS runFinished,
          -- Pre-v14 backfill appended all run events after the transcript; those endpoints are not ownership evidence.
          CASE WHEN e.endMessageIndex > e.startMessageIndex THEN e.endMessageIndex END AS endMessageIndex
        FROM file_changes f LEFT JOIN endings e ON e.runId=f.run_id
        WHERE f.session_id=? ORDER BY f.seq DESC`,
      )
      .all(sessionId, sessionId)
      .map((row) => {
        const { runId, runFinished, endMessageIndex, ...rest } = row;
        return {
          ...rest,
          ...(typeof runId === 'string' ? { runId } : {}),
          ...(runFinished ? { runFinished: true } : {}),
          ...(typeof endMessageIndex === 'number' ? { endMessageIndex } : {}),
          change: JSON.parse(String(row.change)),
        } as unknown as StoredFileChange;
      });
  }

  /**
   * Which session's journal holds one change.
   *
   * A recovery pass is given a change id and nothing else: the import that wrote it was interrupted, so the process
   * that knew which session it belonged to is gone, and the id is what the durable receipt recorded. Reading the
   * owner back from the row is therefore the honest lookup rather than a guess — the alternative is a caller that has
   * to already know the answer it is asking for.
   */
  fileChangeOwner(id: string): string | null {
    const row = this.port.db
      .prepare('SELECT session_id AS sessionId FROM file_changes WHERE id=?')
      .get(id) as { sessionId?: unknown } | undefined;
    return row?.sessionId === undefined ? null : String(row.sessionId);
  }

  fileChangeSnapshots(sessionId: string, id: string): FileSnapshot[] {
    const owner = this.port.db
      .prepare('SELECT 1 FROM file_changes WHERE session_id=? AND id=?')
      .get(sessionId, id);
    if (!owner) throw new Error('File change not found in session');
    const rows = this.port.db
      .prepare(
        'SELECT path,before_bytes AS beforeBytes,after_bytes AS afterBytes FROM file_change_files WHERE change_id=? ORDER BY ordinal',
      )
      .all(id);
    if (rows.length)
      return rows.map((row) => ({
        path: String(row.path),
        before: row.beforeBytes === null ? null : Buffer.from(row.beforeBytes as Uint8Array),
        after: row.afterBytes === null ? null : Buffer.from(row.afterBytes as Uint8Array),
      }));
    // A change written before `file_change_files` existed carries its one path in its own row. Reading that row
    // directly — rather than the session's whole change list — is what keeps a damaged sibling row from making
    // this read fail: a diagnostic reader must not parse rows it was never going to look at.
    const row = this.port.db
      .prepare('SELECT change FROM file_changes WHERE session_id=? AND id=?')
      .get(sessionId, id) as { change?: string } | undefined;
    const change: unknown = JSON.parse(String(row?.change));
    if (!change || typeof (change as { path?: unknown }).path !== 'string')
      throw new Error('Invalid persisted file change');
    const bytes = this.port.fileChangeBytes(sessionId, id);
    return [{ path: (change as { path: string }).path, before: bytes.before, after: bytes.after }];
  }

  fileChangeBytes(sessionId: string, id: string): { before: Buffer | null; after: Buffer } {
    const row = this.port.db
      .prepare('SELECT before_bytes,after_bytes FROM file_changes WHERE session_id=? AND id=?')
      .get(sessionId, id);
    if (!row) throw new Error('File change not found in session');
    return {
      before: row.before_bytes === null ? null : Buffer.from(row.before_bytes as Uint8Array),
      after: Buffer.from(row.after_bytes as Uint8Array),
    };
  }
}
