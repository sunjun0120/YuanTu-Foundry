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
        'SELECT id,session_id AS sessionId,change,status,created_at AS createdAt FROM file_changes WHERE session_id=? ORDER BY seq DESC',
      )
      .all(sessionId)
      .map(
        (row) =>
          ({ ...row, change: JSON.parse(String(row.change)) }) as unknown as StoredFileChange,
      );
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
