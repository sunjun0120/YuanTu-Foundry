import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { userStateDirectory } from '../platform/user-state.ts';
import { ftsIndexText, ftsMatchQuery } from '../formats/fts-text.ts';
import { parseSetting } from '../protocol/settings.ts';
import path from 'node:path';
import { resourceText } from '../resources/files.ts';

const DOCUMENT_CHUNK_CHARS = 1600;
const DOCUMENT_CHUNK_OVERLAP = 200;
/**
 * `index`, moved back one unit when it would fall between the two halves of a surrogate pair.
 *
 * Chunks are cut at fixed UTF-16 offsets, and an emoji or a rare Han character outside the BMP is two units: a cut
 * between them left a lone surrogate at the end of one chunk and the start of the next, which renders as a
 * replacement glyph and makes neither half searchable. Moving back keeps the whole character in the earlier chunk;
 * the 200-unit overlap means nothing is lost from the later one.
 */
function codePointBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const unit = text.charCodeAt(index);
  const previous = text.charCodeAt(index - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
    ? index - 1
    : index;
}

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
/**
 * Size and mtime of a pinned document, or `null` when it cannot be stat'ed.
 *
 * A null answer means "ask the expensive way": the caller falls through to `pinDocument`, which has the real
 * error handling and the digest check. This function is allowed to be incurious — it exists to avoid work, never
 * to decide that something is fine.
 */
function statSource(root: string, relative: string): { size: number; mtimeMs: number } | null {
  try {
    const stats = statSync(path.resolve(root, documentPath(relative)));
    return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}
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
  const configured = parseSetting(process.env, 'YUANTU_KNOWLEDGE_DB');
  return typeof configured === 'string'
    ? configured
    : path.join(userStateDirectory(), 'knowledge.sqlite');
}
/** What one pinned document's last refresh attempt learned about its freshness. */
export interface KnowledgeDocumentFreshness {
  path: string;
  /** When this document's indexed content was last written. */
  lastIndexedAt: string;
  stale: boolean;
  /** Why the refresh failed, when it did. The old content is still searchable. */
  error?: string;
  /** When the most recent failed refresh happened. */
  failedAt?: string;
}

/** Whether every pinned document was re-read successfully for a search, and which were not. */
export interface KnowledgeFreshness {
  stale: boolean;
  checkedAt: string;
  documents: KnowledgeDocumentFreshness[];
}

export class KnowledgeStore {
  private db: DatabaseSync;
  /** Size and mtime of each document as it was when last indexed, keyed by scope and path. */
  private verified = new Map<string, { size: number; mtimeMs: number }>();
  /** Documents whose last refresh failed, keyed by scope and path; cleared by the next successful read. */
  private refreshFailures = new Map<string, { path: string; error: string; at: string }>();
  private refreshChecks = { verified: 0, reread: 0 };
  constructor(file = defaultKnowledgePath()) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // NORMAL under WAL, as the session store does: durable to the last checkpoint, never corrupt.
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
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
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title,content,tokenize='unicode61');`);
    this.reindexLegacyFts();
  }
  /**
   * Replace the raw-copy triggers of earlier builds with an index this class writes itself.
   *
   * The index holds the segmented form of each row (see `ftsIndexText`), which SQL cannot compute, so
   * `pinDocument`/`unpinDocument` write `knowledge_fts` beside `knowledge_items` in the same transaction instead
   * of a trigger copying the columns verbatim. A trigger's presence is the evidence that the index was written the
   * old way — by a build before this one, or by an older build that reopened the file after it and recreated its
   * triggers — so finding one is what drops them and rebuilds the whole index from the rows.
   */
  private reindexLegacyFts(): void {
    const legacy = () =>
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('knowledge_ai','knowledge_ad','knowledge_au')",
        )
        .all().length > 0;
    if (!legacy()) return;
    this.transaction(() => {
      // Asked again under the write lock: another process may have rebuilt it while this one waited.
      if (!legacy()) return;
      this.db.exec(`DROP TRIGGER IF EXISTS knowledge_ai; DROP TRIGGER IF EXISTS knowledge_ad;
        DROP TRIGGER IF EXISTS knowledge_au; DELETE FROM knowledge_fts;`);
      const insert = this.db.prepare(
        'INSERT INTO knowledge_fts(rowid,title,content) VALUES(?,?,?)',
      );
      for (const row of this.db
        .prepare('SELECT rowid AS rid,title,content FROM knowledge_items')
        .all())
        insert.run(
          Number(row.rid),
          ftsIndexText(String(row.title)),
          ftsIndexText(String(row.content)),
        );
    });
  }
  /** Remove a document's chunks and their index rows together; the index has no trigger to do it. */
  private deleteChunks(id: string): void {
    this.db
      .prepare(
        'DELETE FROM knowledge_fts WHERE rowid IN (SELECT rowid FROM knowledge_items WHERE document_id=?)',
      )
      .run(id);
    this.db.prepare('DELETE FROM knowledge_items WHERE document_id=?').run(id);
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
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /**
         * A failed `COMMIT` has already ended the transaction, and SQLite answers the `ROLLBACK` with
         * "cannot rollback - no transaction is active" — which would replace the failure that actually
         * happened with a misleading one. The event journal guards its rollback for the same reason.
         */
      }
      throw error;
    }
  }
  /**
   * Memories are no longer written here: the markdown files in packages/knowledge/memory.ts
   * are the source of truth. Rows created by earlier versions stay in the table and remain
   * searchable, which is why reads still understand kind='memory'.
   */
  listDocuments(root: string): PinnedDocument[] {
    /**
     * One query, not N+1.
     *
     * Counting chunks used to be a second query per document, so a list whose entire job is "these are the
     * pinned documents" cost one round trip per row — and `list_memories` calls it on every listing, while
     * `refreshDocuments` calls it before every search. The count comes from a join with a group by instead.
     */
    return this.db
      .prepare(
        `SELECT d.path AS path, d.updated_at AS updated_at, count(i.rowid) AS chunks
           FROM knowledge_documents d
           LEFT JOIN knowledge_items i ON i.document_id = d.id
          WHERE d.scope=?
          GROUP BY d.id
          ORDER BY d.path`,
      )
      .all(canonical(root))
      .map((row) => ({
        path: String(row.path),
        updatedAt: String(row.updated_at),
        chunks: Number(row.chunks),
      }));
  }
  /** How many chunks one pinned document holds, without listing every document to find out. */
  private chunkCount(id: string): number {
    return Number(
      this.db.prepare('SELECT count(*) AS n FROM knowledge_items WHERE document_id=?').get(id)?.n ??
        0,
    );
  }
  pinDocument(root: string, relative: string): PinnedDocument {
    const scope = canonical(root),
      file = documentPath(relative);
    const content = resourceText(scope, file);
    if (!content.trim()) throw new Error('Document is empty');
    const digest = createHash('sha256').update(content).digest('hex');
    const id = idFor(scope, file),
      now = new Date().toISOString();
    /**
     * The unchanged case is decided *before* the write transaction, and that ordering is the point.
     *
     * `search` refreshes every pinned document before it ranks anything, so this runs once per document per
     * query. Reading the digest first and returning here costs one SELECT. Opening `BEGIN IMMEDIATE` first
     * costs the database's single writer, once per document, for a search that changed nothing — and the
     * previous version then answered from `listDocuments`, which was one further query per document on top.
     *
     * The digest is re-read inside the transaction rather than trusted from here: another process may have
     * indexed this same content while this one was reading the file, and the file may have been rewritten in
     * between — in which case the write below is still correct, and the re-check only avoids doing it twice.
     */
    const stored = this.db
      .prepare('SELECT digest,updated_at FROM knowledge_documents WHERE id=? AND scope=?')
      .get(id, scope);
    if (stored?.digest === digest)
      return { path: file, updatedAt: String(stored.updated_at), chunks: this.chunkCount(id) };
    return this.transaction(() => {
      const current = this.db
        .prepare('SELECT digest,updated_at FROM knowledge_documents WHERE id=? AND scope=?')
        .get(id, scope);
      if (current?.digest === digest)
        return { path: file, updatedAt: String(current.updated_at), chunks: this.chunkCount(id) };
      if (!current) {
        const count = this.db
          .prepare('SELECT count(*) AS n FROM knowledge_documents WHERE scope=?')
          .get(scope)!.n as number;
        if (count >= 64) throw new Error('Document limit reached (64)');
      }
      this.deleteChunks(id);
      this.db
        .prepare(
          'INSERT INTO knowledge_documents(id,scope,path,digest,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,updated_at=excluded.updated_at',
        )
        .run(id, scope, file, digest, now);
      let chunks = 0;
      for (
        let offset = 0;
        offset < content.length;
        offset += DOCUMENT_CHUNK_CHARS - DOCUMENT_CHUNK_OVERLAP
      ) {
        const chunk = content.slice(
          codePointBoundary(content, offset),
          codePointBoundary(content, offset + DOCUMENT_CHUNK_CHARS),
        );
        const { lastInsertRowid } = this.db
          .prepare(
            "INSERT INTO knowledge_items(id,scope,kind,title,content,source,document_id,updated_at) VALUES(?,?,'document',?,?,?,?,?)",
          )
          .run(`${id}:${chunks}`, scope, file, chunk, file, id, now);
        this.db
          .prepare('INSERT INTO knowledge_fts(rowid,title,content) VALUES(?,?,?)')
          .run(lastInsertRowid, ftsIndexText(file), ftsIndexText(chunk));
        chunks++;
        // A chunk that reached the end leaves nothing new: the next window would only repeat its overlap.
        if (offset + DOCUMENT_CHUNK_CHARS >= content.length) break;
      }
      return { path: file, updatedAt: now, chunks };
    });
  }
  unpinDocument(root: string, relative: string): void {
    const scope = canonical(root),
      id = idFor(scope, documentPath(relative));
    this.transaction(() => {
      this.deleteChunks(id);
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
   *
   * A document whose size and mtime are what they were when it was last indexed is skipped
   * outright, which is the difference between a search costing a stat per document and a search
   * costing a *read* per document. `pinDocument` already avoided the write for unchanged content,
   * but it decided that after reading the whole file, so asking the same question twice still paid
   * for the corpus twice. The digest check inside `pinDocument` remains the authority — this is a
   * cheaper question asked first, and the maps below are dropped on any failure so a document that
   * cannot be re-read is retried rather than remembered as verified.
   */
  private refreshDocuments(root: string): void {
    const scope = canonical(root);
    const present = new Set<string>();
    for (const document of this.listDocuments(root)) {
      const key = `${scope}\u0000${document.path}`;
      present.add(key);
      const known = this.verified.get(key);
      if (known) {
        const current = statSource(root, document.path);
        if (current && current.size === known.size && current.mtimeMs === known.mtimeMs) {
          this.refreshChecks.verified++;
          this.refreshFailures.delete(key);
          continue;
        }
      }
      try {
        this.pinDocument(root, document.path);
        this.refreshChecks.reread++;
        const current = statSource(root, document.path);
        if (current) this.verified.set(key, current);
        else this.verified.delete(key);
        this.refreshFailures.delete(key);
      } catch (error) {
        this.verified.delete(key);
        if (this.documentMissing(root, document.path)) {
          this.unpinDocument(root, document.path);
          this.refreshFailures.delete(key);
        } else {
          /**
           * Keep serving the old chunks, but do not pretend they are current. The next search reports this
           * failure as result-level freshness, so a stale document cannot be mistaken for an unchanged one —
           * including when the query matches nothing and the old content is invisible.
           */
          this.refreshFailures.set(key, {
            path: document.path,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            at: new Date().toISOString(),
          });
        }
      }
    }
    // A failure recorded for a document that is no longer pinned is about a source this search does not use.
    for (const key of this.refreshFailures.keys())
      if (key.startsWith(`${scope}\u0000`) && !present.has(key)) this.refreshFailures.delete(key);
  }

  /**
   * Freshness of the pinned documents, after the refresh that `search` performs.
   *
   * This is result-level, not item-level: a stale document must be reported even when it did not match the
   * query, because "no results" is exactly the answer a caller could otherwise mistake for "nothing changed".
   */
  freshness(root: string): KnowledgeFreshness {
    const scope = canonical(root);
    const documents = this.listDocuments(root).map((document) => {
      const failure = this.refreshFailures.get(`${scope}\u0000${document.path}`);
      return {
        path: document.path,
        lastIndexedAt: document.updatedAt,
        stale: Boolean(failure),
        ...(failure ? { error: failure.error, failedAt: failure.at } : {}),
      } satisfies KnowledgeDocumentFreshness;
    });
    return {
      stale: documents.some((document) => document.stale),
      checkedAt: new Date().toISOString(),
      documents,
    };
  }
  /**
   * What the last refreshes did, so "an unchanged document is not read twice" is a measured
   * claim rather than a description of the code.
   */
  refreshCounts(): { verified: number; reread: number } {
    return { ...this.refreshChecks };
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
    // Words are segmented the way the index is (see `ftsIndexText`), so a Chinese word matches inside a
    // sentence and two separated words match the same chunk.
    const match = ftsMatchQuery(q, 8) ?? `"${ftsIndexText(q).replaceAll('"', '""')}"`;
    // Ranking happens in SQL. The previous version took `LIMIT 120` with no ORDER BY and only then
    // scored title (+4) and content (+2) in JS, ordered by `updatedAt` for ties. Two consequences:
    // the window's contents were decided by the query plan (rows come back in `document_id` hash
    // order, so which documents survived was arbitrary), and FTS5 relevance was never consulted at
    // all. bm25() now supplies real relevance — weighted toward the title column — the explicit
    // title substring test still runs first so a title naming the whole query wins, and `updated_at`
    // is demoted to a final tie-break instead of deciding between equally-scored documents.
    //
    // `chunk_rank` keeps the best-scoring chunk per document: 1600-character windows overlap by 200
    // characters to retain boundary context. Without deduplication a long file could occupy several slots.
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
