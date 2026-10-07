import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resourceText } from '../resources/files.ts';

export interface KnowledgeItem {
  id: string;
  kind: 'memory' | 'document';
  scope: 'global' | 'workspace';
  title: string;
  content: string;
  source: string;
  version: number;
  updatedAt: string;
}
export interface PinnedDocument {
  path: string;
  updatedAt: string;
  chunks: number;
}
const extensions = new Set(
  'md markdown txt ts tsx js jsx mjs cjs json jsonl yaml yml toml py java go rs c h cpp hpp cs css html htm vue sql sh ps1'.split(
    ' ',
  ),
);
const canonical = (root: string) => realpathSync(root);
const idFor = (root: string, file: string) =>
  createHash('sha256')
    .update(root + '\0' + file)
    .digest('hex');
const validate = (value: string, label: string, max: number) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw new Error(`Invalid ${label}; maximum ${max} characters`);
  return value.trim();
};
function documentPath(relative: string): string {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.length > 240 ||
    path.isAbsolute(relative) ||
    relative.includes('\\')
  )
    throw new Error('Invalid document path');
  const parts = relative.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.startsWith('.') ||
        ['node_modules', 'dist', 'build', 'coverage'].includes(part.toLowerCase()),
    )
  )
    throw new Error('Document path is excluded');
  const name = parts.at(-1)!;
  if (/^(credentials?|secrets?|id_(rsa|ed25519))(\.|$)|\.(pem|p12|pfx|key|sqlite|db)$/i.test(name))
    throw new Error('Sensitive document cannot be indexed');
  if (!extensions.has(name.split('.').at(-1)!.toLowerCase()))
    throw new Error('Only UTF-8 text or code documents can be indexed');
  return relative;
}
const item = (row: Record<string, unknown>): KnowledgeItem => ({
  id: String(row.id),
  kind: row.kind as KnowledgeItem['kind'],
  scope: row.scope === '' ? 'global' : 'workspace',
  title: String(row.title),
  content: String(row.content),
  source: String(row.source),
  version: Number(row.version),
  updatedAt: String(row.updated_at),
});
export function defaultKnowledgePath(): string {
  return process.env.YUANTU_KNOWLEDGE_DB || path.join(os.homedir(), '.yuantu', 'knowledge.sqlite');
}
export class KnowledgeStore {
  private db: DatabaseSync;
  constructor(file = defaultKnowledgePath()) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS knowledge_items (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('memory','document')),
        title TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, document_id TEXT,
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_scope ON knowledge_items(scope,kind,document_id);
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE(scope,path)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title,content,tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_items BEGIN
        INSERT INTO knowledge_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_items BEGIN
        DELETE FROM knowledge_fts WHERE rowid=old.rowid; END;
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_items BEGIN
        DELETE FROM knowledge_fts WHERE rowid=old.rowid;
        INSERT INTO knowledge_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content); END;`);
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /**
   * Memories are no longer written here: the markdown files in packages/knowledge/memory.ts
   * are the source of truth. Rows created by earlier versions stay in the table and remain
   * searchable, which is why reads still understand kind='memory'.
   */
  listDocuments(root: string): PinnedDocument[] {
    return this.db
      .prepare('SELECT path,updated_at,id FROM knowledge_documents WHERE scope=? ORDER BY path')
      .all(canonical(root))
      .map((row) => ({
        path: String(row.path),
        updatedAt: String(row.updated_at),
        chunks: Number(
          this.db
            .prepare('SELECT count(*) AS n FROM knowledge_items WHERE document_id=?')
            .get(String(row.id))!.n,
        ),
      }));
  }
  pinDocument(root: string, relative: string): PinnedDocument {
    const scope = canonical(root),
      file = documentPath(relative);
    const content = resourceText(scope, file);
    if (!content.trim()) throw new Error('Document is empty');
    const digest = createHash('sha256').update(content).digest('hex');
    const id = idFor(scope, file),
      now = new Date().toISOString();
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT digest FROM knowledge_documents WHERE id=?').get(id);
      if (existing?.digest === digest)
        return this.listDocuments(scope).find((value) => value.path === file)!;
      if (!existing) {
        const count = this.db
          .prepare('SELECT count(*) AS n FROM knowledge_documents WHERE scope=?')
          .get(scope)!.n as number;
        if (count >= 64) throw new Error('Document limit reached (64)');
      }
      this.db.prepare('DELETE FROM knowledge_items WHERE document_id=?').run(id);
      this.db
        .prepare(
          'INSERT INTO knowledge_documents(id,scope,path,digest,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,updated_at=excluded.updated_at',
        )
        .run(id, scope, file, digest, now);
      let chunks = 0;
      for (let offset = 0; offset < content.length; offset += 1400) {
        this.db
          .prepare(
            "INSERT INTO knowledge_items(id,scope,kind,title,content,source,document_id,updated_at) VALUES(?,?,'document',?,?,?,?,?)",
          )
          .run(`${id}:${chunks}`, scope, file, content.slice(offset, offset + 1600), file, id, now);
        chunks++;
      }
      return { path: file, updatedAt: now, chunks };
    });
  }
  unpinDocument(root: string, relative: string): void {
    const scope = canonical(root),
      id = idFor(scope, documentPath(relative));
    this.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_items WHERE document_id=?').run(id);
      this.db.prepare('DELETE FROM knowledge_documents WHERE id=? AND scope=?').run(id, scope);
    });
  }
  /**
   * Re-reads every pinned document so searches see current content. A failed re-read must NOT
   * delete the index entry: `pinDocument` also throws for transient or recoverable conditions
   * (file locked, EACCES, a brief non-UTF-8 write, a document that grew past the 32KB read
   * limit), and silently unpinning on those discarded the document permanently with no error.
   * The entry is only dropped when the source file is genuinely gone, or when the stored path
   * is no longer a valid document path.
   */
  private refreshDocuments(root: string): void {
    for (const document of this.listDocuments(root)) {
      try {
        this.pinDocument(root, document.path);
      } catch {
        if (this.documentMissing(root, document.path)) this.unpinDocument(root, document.path);
      }
    }
  }
  private documentMissing(root: string, relative: string): boolean {
    let resolved: string;
    try {
      resolved = path.resolve(root, documentPath(relative));
    } catch {
      return true;
    }
    try {
      return !statSync(resolved).isFile();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only a genuinely absent path counts as "gone". EACCES/EBUSY/EMFILE and friends are
      // transient: keep serving the existing entry and retry on the next refresh.
      return code === 'ENOENT' || code === 'ENOTDIR';
    }
  }
  search(root: string, query: string, limit = 8): KnowledgeItem[] {
    const scope = canonical(root),
      q = validate(query, 'knowledge query', 200);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new Error('Invalid knowledge result limit');
    this.refreshDocuments(scope);
    const words = [...q.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => match[0]!).slice(0, 8);
    const match = words.length
      ? words.map((word) => `"${word}"`).join(' AND ')
      : `"${q.replaceAll('"', '""')}"`;
    // Ranking happens in SQL. The previous version took `LIMIT 120` with no ORDER BY and only then
    // scored title (+4) and content (+2) in JS, ordered by `updatedAt` for ties. Two consequences:
    // the window's contents were decided by the query plan (rows come back in `document_id` hash
    // order, so which documents survived was arbitrary), and FTS5 relevance was never consulted at
    // all. bm25() now supplies real relevance — weighted toward the title column — the explicit
    // title substring test still runs first because unicode61 tokenisation does not match a CJK
    // phrase as a substring, and `updated_at` is demoted to a final tie-break instead of deciding
    // between equally-scored documents.
    //
    // `chunk_rank` keeps the best-scoring chunk per document: a document is split into 1600-char
    // chunks, so without it one long file could occupy several of the requested result slots.
    const rows = this.db
      .prepare(
        `WITH hits AS (
           SELECT rowid AS rid, bm25(knowledge_fts, 4.0, 1.0) AS rank
           FROM knowledge_fts WHERE knowledge_fts MATCH ?
         ),
         ranked AS (
           SELECT k.*,
             (CASE WHEN instr(lower(k.title),lower(?))>0 THEN 0 ELSE 1 END) AS title_rank,
             COALESCE(h.rank, 1e18) AS bm25_rank
           FROM knowledge_items k
           LEFT JOIN hits h ON h.rid = k.rowid
           WHERE (k.scope=? OR k.scope='') AND (
             instr(lower(k.title),lower(?))>0 OR instr(lower(k.content),lower(?))>0 OR h.rid IS NOT NULL)
         ),
         best AS (
           SELECT r.*, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(r.document_id, r.id)
             ORDER BY r.title_rank, r.bm25_rank,
               (CASE WHEN r.kind='memory' THEN 0 ELSE 1 END), r.updated_at DESC
           ) AS chunk_rank
           FROM ranked r
         )
         SELECT * FROM best WHERE chunk_rank = 1
         ORDER BY title_rank, bm25_rank,
           (CASE WHEN kind='memory' THEN 0 ELSE 1 END), updated_at DESC
         LIMIT ?`,
      )
      .all(match, q, scope, q, q, limit);
    return rows.map(item);
  }
}
