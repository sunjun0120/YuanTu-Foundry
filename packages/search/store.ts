/**
 * The source index: what each file declares, kept beside a fingerprint of the file it came from.
 *
 * Two decisions are load-bearing.
 *
 * **It is a separate database from the session's.** Source symbols are derived data about a *workspace*: they
 * survive a session, they belong to no conversation, and rebuilding them must never risk a session log. The file
 * lives under `.yuantu/search/`, which the file tools already refuse to read or write.
 *
 * **An unusable database downgrades instead of failing.** SQLite can be corrupt, can hold a schema written by a
 * newer build, and can live on a volume that refuses writes. None of those is a reason for `repo_map` to stop
 * answering — so persistence is best-effort and the index is memory-first: the rows this process built are
 * always queryable, and the database is a cache that survives a restart when it can.
 *
 * Every row carries the size and mtime of the file it describes. That is what makes a stale row detectable
 * rather than merely old, and it is why `freshness` is computed rather than assumed.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { FileFingerprint, Freshness, SymbolRecord } from './types.ts';

/** One indexed file: its declarations, the imports and exports they share, and what it looked like. */
export interface IndexedFile {
  path: string;
  language: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 of the bytes that were analysed, so a rewrite the metadata cannot see is still detectable. */
  sha256: string;
  symbols: { name: string; kind: string; startLine: number; endLine: number }[];
  imports: string[];
  exports: string[];
}

/** What a query answers with, and how much the answer can be trusted. */
export interface SymbolQueryResult {
  symbols: SymbolRecord[];
  freshness: Freshness;
  sourceVersion: string | null;
}

/** Bumped when the on-disk shape changes; a database written by a newer build is refused rather than read. */
export const INDEX_SCHEMA_VERSION = 1;

export interface SourceIndexOptions {
  /** Where `index.sqlite` lives, or `null` for a purely in-memory index. */
  directory: string | null;
  /** Rows a single generation may hold, so a runaway tree cannot exhaust memory. */
  maxFiles?: number;
}

export class SourceIndex {
  private files = new Map<string, IndexedFile>();
  private database: DatabaseSync | null = null;
  private generation = 0;
  private state: Freshness = 'unknown';
  private current = 0;
  private maxFiles: number;
  private directory: string | null;
  /** Whether the database has been opened yet, and whether opening it worked. */
  private attempted = false;
  private usable = false;
  private closed = false;

  private constructor(options: SourceIndexOptions) {
    this.directory = options.directory ?? null;
    this.maxFiles = options.maxFiles ?? 200_000;
  }

  static open(options: SourceIndexOptions): SourceIndex {
    return new SourceIndex(options);
  }

  /**
   * Opens the database on first use, downgrading to memory when it cannot be used.
   *
   * *First use*, not construction, and that distinction is not a micro-optimisation: a registry is built for
   * every run, and opening a SQLite file — and creating a WAL beside it — for a run that never asks a symbol
   * question leaves a database handle and two files in a workspace nobody queried. Deferring means a workspace is
   * touched by this index exactly when something reads or builds one.
   *
   * Every failure here is the same decision: keep working. A read-only volume, a corrupt file, a schema from a
   * future build — the symbols this process can compute are still worth having, and refusing to answer because a
   * cache was unwritable would be trading a working feature for a tidy directory.
   */
  ensure(): void {
    if (this.attempted || this.closed) return;
    this.attempted = true;
    if (!this.directory) return;
    let database: DatabaseSync | null = null;
    try {
      mkdirSync(this.directory, { recursive: true });
      database = new DatabaseSync(path.join(this.directory, 'index.sqlite'));
      database.exec('PRAGMA journal_mode = WAL');
      database.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const version = database
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('schema_version') as { value?: string } | undefined;
      if (version?.value && Number(version.value) > INDEX_SCHEMA_VERSION) {
        // Written by a newer build. Reading it would be guessing at a shape this code does not know.
        database.close();
        return;
      }
      database.exec(
        'CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, language TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, sha256 TEXT NOT NULL, generation INTEGER NOT NULL)',
      );
      database.exec(
        'CREATE TABLE IF NOT EXISTS symbols (path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, generation INTEGER NOT NULL)',
      );
      database.exec(
        'CREATE TABLE IF NOT EXISTS edges (path TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, generation INTEGER NOT NULL)',
      );
      database.exec(`CREATE INDEX IF NOT EXISTS symbols_name ON symbols (name)`);
      database
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(INDEX_SCHEMA_VERSION));
    } catch {
      try {
        database?.close();
      } catch {
        /* Nothing useful to do with a database that cannot even be closed. */
      }
      return;
    }
    this.database = database;
    this.usable = true;
    this.load();
  }

  /** True once the database has actually been opened and is being written to. */
  get persistent(): boolean {
    return this.usable;
  }

  /** The rows already on disk, so a restart does not pay for a rebuild it does not need. */
  private load(): void {
    if (!this.database) return;
    try {
      const rows = this.database
        .prepare('SELECT path, language, size, mtime_ms, sha256 FROM files')
        .all() as {
        path: string;
        language: string;
        size: number;
        mtime_ms: number;
        sha256: string;
      }[];
      const symbolRows = this.database
        .prepare('SELECT path, name, kind, start_line, end_line FROM symbols')
        .all() as {
        path: string;
        name: string;
        kind: string;
        start_line: number;
        end_line: number;
      }[];
      const edgeRows = this.database.prepare('SELECT path, kind, value FROM edges').all() as {
        path: string;
        kind: string;
        value: string;
      }[];
      for (const row of rows)
        this.files.set(row.path, {
          path: row.path,
          language: row.language,
          size: row.size,
          mtimeMs: row.mtime_ms,
          sha256: row.sha256,
          symbols: [],
          imports: [],
          exports: [],
        });
      for (const row of symbolRows) {
        const file = this.files.get(row.path);
        file?.symbols.push({
          name: row.name,
          kind: row.kind,
          startLine: row.start_line,
          endLine: row.end_line,
        });
      }
      for (const row of edgeRows) {
        const file = this.files.get(row.path);
        if (!file) continue;
        (row.kind === 'import' ? file.imports : file.exports).push(row.value);
      }
      const meta = this.database
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('generation') as { value?: string } | undefined;
      this.generation = meta?.value ? Number(meta.value) || 0 : 0;
      // Rows exist but nobody has checked them against the files this run: the picture is remembered, not
      // verified, and it says so.
      this.state = this.files.size ? 'stale' : 'unknown';
    } catch {
      this.files.clear();
      this.state = 'unknown';
    }
  }

  /** Starts a new generation. A generation is published only when it is complete. */
  begin(): number {
    this.ensure();
    this.current = this.generation + 1;
    return this.current;
  }

  /** Publishes the generation being built, once every file in it has been written. */
  commit(): number {
    this.generation = this.current;
    this.state = 'validated';
    this.ensure();
    try {
      this.database
        ?.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('generation', String(this.generation));
    } catch {
      /* The rows are already queryable; a lost generation counter costs one rebuild after a restart. */
    }
    return this.generation;
  }

  /** Records one file's analysis. Best-effort persistence, always-present memory. */
  put(file: IndexedFile): void {
    if (this.files.size >= this.maxFiles && !this.files.has(file.path)) return;
    this.files.set(file.path, file);
    if (!this.database) return;
    try {
      this.database.prepare('DELETE FROM symbols WHERE path = ?').run(file.path);
      this.database.prepare('DELETE FROM edges WHERE path = ?').run(file.path);
      this.database
        .prepare(
          'INSERT OR REPLACE INTO files (path, language, size, mtime_ms, sha256, generation) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(file.path, file.language, file.size, file.mtimeMs, file.sha256, this.current);
      const symbol = this.database.prepare(
        'INSERT INTO symbols (path, name, kind, start_line, end_line, generation) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const entry of file.symbols)
        symbol.run(file.path, entry.name, entry.kind, entry.startLine, entry.endLine, this.current);
      const edge = this.database.prepare(
        'INSERT INTO edges (path, kind, value, generation) VALUES (?, ?, ?, ?)',
      );
      for (const value of file.imports) edge.run(file.path, 'import', value, this.current);
      for (const value of file.exports) edge.run(file.path, 'export', value, this.current);
    } catch {
      // The row stays in memory for this process; the next generation tries the database again.
    }
  }

  /** Forgets one path — a file that was deleted or renamed away. */
  remove(relative: string): void {
    this.files.delete(relative);
    if (!this.database) return;
    try {
      this.database.prepare('DELETE FROM symbols WHERE path = ?').run(relative);
      this.database.prepare('DELETE FROM edges WHERE path = ?').run(relative);
      this.database.prepare('DELETE FROM files WHERE path = ?').run(relative);
    } catch {
      /* As above: memory is the authority while this process runs. */
    }
  }

  /** The fingerprint an index row claims for a path, or `null` when the path is not indexed. */
  fingerprintOf(relative: string): FileFingerprint | null {
    const file = this.files.get(relative);
    if (!file) return null;
    // The digest the index computed from the bytes it analysed, so a caller can compare content rather than
    // metadata when it needs to.
    return { size: file.size, mtimeMs: file.mtimeMs, sha256: file.sha256 };
  }

  /** True when the stored row still matches the file as it is now, by metadata. */
  isFresh(relative: string, fingerprint: FileFingerprint): boolean {
    const stored = this.files.get(relative);
    return (
      stored !== undefined &&
      stored.size === fingerprint.size &&
      stored.mtimeMs === fingerprint.mtimeMs
    );
  }

  /** The digest the index holds for a path, or `null` when there is no row. */
  digestOf(relative: string): string | null {
    return this.files.get(relative)?.sha256 ?? null;
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  size(): number {
    return this.files.size;
  }

  /** Marks the index as no longer describing the tree, without throwing anything away. */
  markStale(): void {
    if (this.state === 'validated') this.state = 'stale';
  }

  markBuilding(): void {
    this.state = 'building';
  }

  freshness(): Freshness {
    return this.state;
  }

  sourceVersion(): string | null {
    return this.generation ? `index:${String(this.generation)}` : null;
  }

  /**
   * Symbol lookup by name substring, ordered by path bytes and then by line.
   *
   * A substring match rather than a prefix one because that is what `repo_map`'s query has always done, and the
   * order is the workspace's own so two runs with the same tree answer identically.
   */
  query(query: string | null, limit: number, language?: string): SymbolRecord[] {
    const needle = query?.toLowerCase() ?? null;
    const found: SymbolRecord[] = [];
    for (const file of this.files.values()) {
      if (language && file.language !== language) continue;
      for (const symbol of file.symbols) {
        if (needle && !symbol.name.toLowerCase().includes(needle)) continue;
        found.push({
          path: file.path,
          name: symbol.name,
          kind: symbol.kind,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          language: file.language,
          imports: file.imports,
          exports: file.exports,
          fingerprint: { size: file.size, mtimeMs: file.mtimeMs, sha256: file.sha256 },
        });
      }
    }
    found.sort((left, right) => {
      const byPath = Buffer.compare(
        Buffer.from(left.path, 'utf8'),
        Buffer.from(right.path, 'utf8'),
      );
      return byPath !== 0 ? byPath : left.startLine - right.startLine;
    });
    return found.slice(0, limit);
  }

  /** Every indexed file's outline, for the bounded prompt map. */
  outlines(): SymbolRecord[] {
    return this.query(null, Number.MAX_SAFE_INTEGER);
  }

  close(): void {
    this.closed = true;
    try {
      this.database?.close();
    } catch {
      /* Closing a database that is already gone is not a failure worth reporting. */
    }
    this.database = null;
  }
}
