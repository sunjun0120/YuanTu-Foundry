/**
 * The shared search service: one index, one update path, one lifetime, per workspace.
 *
 * Everything expensive lives here rather than in the tool that asks for it. A symbol index is built once and read
 * many times, and a search tool is constructed per run while the tree it searches outlives the run — so the
 * index is owned by a service that outlives the tools, ref-counted so the last registry to release it is the one
 * that closes the database, and never the first.
 *
 * Three properties are worth stating because they are what the tests check.
 *
 * - **A build never publishes half of itself.** Rows are written as they are produced, but the *generation* is
 *   only committed once every file in the batch has been written or explicitly skipped. A query during a build
 *   gets `building` and a partial answer, never a `validated` one.
 * - **Staleness is computed, not assumed.** A row carries the size and mtime of the file it describes, and a
 *   reconcile pass checks each one; a changed file is re-analysed, a deleted file loses its row. What the
 *   fingerprint cannot see — a same-size rewrite inside one timestamp tick — is exactly why the state is called
 *   `validated` rather than `exact`.
 * - **Closing waits.** `close()` cancels the running build, waits for it to settle, drops the cursors and closes
 *   the database. Nothing is left holding a file handle or a timer, and no cursor survives the process.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import {
  SEARCH_MAX_ENTRIES,
  SEARCH_TIMEOUT_MS,
  collectInventory,
  iterateInventory,
} from './inventory.ts';
import { readRange as readFileRange } from './lines.ts';
import {
  analyzeSymbolsWithParser,
  isOutlineable,
  languageOf,
  MAX_SYMBOL_FILE_BYTES,
  tooLarge,
} from './symbols.ts';
import { SourceIndex } from './store.ts';
import {
  CursorInvalidError,
  CursorStore,
  queryHashOf,
  type CursorState,
  type CursorWitness,
} from './cursor.ts';
import { isSensitive, scanText } from './text.ts';
import {
  emptyCoverage,
  markStop,
  type Coverage,
  type FileEntry,
  type Freshness,
  type InvalidateReason,
  type InventoryOptions,
  type InventoryResult,
  type RangeRead,
  type SearchBackend,
  type SearchOptions,
  type SearchPage,
  type SymbolPage,
  type SymbolRecord,
  type WorkspaceAccess,
} from './types.ts';
import type { ToolContext } from '../protocol/index.ts';

/** A page of a listing: what `list_files` shows, and what a cursor continues. */
export interface ListingPage {
  files: FileEntry[];
  coverage: Coverage;
  nextCursor: string | null;
  sourceVersion: string | null;
}

export interface SymbolQueryInput {
  query: string;
  path?: string;
  language?: string;
  limit: number;
  cursor?: string | null;
  signal: AbortSignal;
}

export interface ContinueInput {
  cursor: string;
  kind: 'listing' | 'symbols';
  options: {
    path?: string;
    include?: string[];
    exclude?: string[];
    query?: string;
    language?: string;
  };
  limit: number;
  signal: AbortSignal;
}

export interface SearchServiceOptions {
  /** Where the index database lives. `null` keeps it in memory; the tool layer passes the internal directory. */
  indexDirectory?: string | null;
  /** Files a listing hands back by default, and the ceiling a caller may ask for. */
  listingLimit?: number;
  maxListingLimit?: number;
}

export const DEFAULT_LISTING_LIMIT = 1_000;
export const MAX_LISTING_LIMIT = 1_000;
export const MAX_SYMBOL_LIMIT = 200;

export class WorkspaceSearchService {
  readonly access: WorkspaceAccess;
  readonly root: string;
  private index: SourceIndex;
  private cursors = new CursorStore();
  private refs = 1;
  private closed = false;
  private cancelledBuild = false;
  private build: Promise<void> | null = null;
  private started = false;
  private dirty = new Set<string>();
  private listingLimit: number;
  private maxListingLimit: number;
  private lastCoverage: Coverage = emptyCoverage();
  private inventoryFingerprints = new Map<string, { size: number; mtimeMs: number }>();
  /** Which analysis produced each indexed file's rows, so the claim can be checked rather than assumed. */
  private parsers = new Map<string, 'ast' | 'heuristic'>();

  /** The parser a file's rows came from, or `undefined` when it is not indexed. */
  parserOf(relative: string): 'ast' | 'heuristic' | undefined {
    return this.parsers.get(relative);
  }

  constructor(access: WorkspaceAccess, options: SearchServiceOptions = {}) {
    this.access = access;
    this.root = access.root;
    this.index = SourceIndex.open({ directory: options.indexDirectory ?? null });
    this.listingLimit = options.listingLimit ?? DEFAULT_LISTING_LIMIT;
    this.maxListingLimit = options.maxListingLimit ?? MAX_LISTING_LIMIT;
  }

  /** The index's directory as the tool layer spells it, or `null` for an in-memory index. */
  get persistent(): boolean {
    return this.index.persistent;
  }

  /** Enumeration with the workspace's standard budgets. */
  async inventory(input: Partial<InventoryOptions> = {}): Promise<InventoryResult> {
    return collectInventory(this.access, this.inventoryOptions(input));
  }

  /**
   * One page of a listing, with a cursor when there is more behind it.
   *
   * The cursor is issued from the *last returned* file, so the next page starts strictly after it. A listing a
   * caller can page through is what makes "there are more files" actionable rather than merely true.
   */
  async listingPage(
    input: {
      path?: string;
      include?: string[];
      exclude?: string[];
      limit?: number;
      cursor?: string | null;
    },
    signal: AbortSignal,
  ): Promise<ListingPage> {
    const limit = clamp(input.limit ?? this.listingLimit, 1, this.maxListingLimit);
    const after = input.cursor ? this.spendCursor(input.cursor, input, 'listing') : null;
    const options = this.inventoryOptions({
      path: input.path ?? '.',
      include: input.include ?? [],
      exclude: input.exclude ?? [],
      signal,
    });
    const files: FileEntry[] = [];
    let nextCursor: string | null = null;
    const boundary = after?.path ?? null;
    let started = after === null;
    const stream = iterateInventory(this.access, options);
    for await (const file of stream) {
      if (!started) {
        // The boundary is a path, so a file that appeared earlier in the walk cannot shift the window.
        if (file.path === boundary) started = true;
        continue;
      }
      if (files.length >= limit) {
        const last = files[files.length - 1]!;
        nextCursor = this.cursors.issue({
          workspace: this.root,
          queryHash: this.listingHash(input),
          sourceVersion: this.sourceVersion(),
          after: { path: last.path, line: 0 },
          witness: witnessOf(last),
        });
        break;
      }
      files.push(file);
    }
    /**
     * A cursor whose boundary file is gone cannot be continued, and must not be answered with an empty page.
     *
     * The boundary is what makes the window stable — the walk resumes *after* it rather than at an offset — so a
     * boundary that no longer exists used to end the walk with nothing found: an empty page, `complete: true`
     * and no next cursor, which reads to the model as "there is nothing more in this workspace". The anchor is
     * the cursor's own premise, so losing it is a stale cursor, and that is the answer the caller already knows
     * how to act on.
     */
    if (!started)
      throw new CursorInvalidError('the page boundary no longer exists; start the listing again');
    return {
      files,
      coverage: stream.coverage(),
      nextCursor,
      sourceVersion: this.sourceVersion(),
    };
  }

  /**
   * A text search.
   *
   * The fast backend is used only where it answers the same question: a case-sensitive literal. Everything else —
   * regex, an insensitive literal, a smart query with a capital in it — stays on the built-in engine, because
   * those are the cases where a program with different matching rules would quietly disagree.
   */
  async search(
    options: SearchOptions,
    backend?: SearchBackend,
    context?: ToolContext,
    scope: Pick<Partial<InventoryOptions>, 'path' | 'include' | 'exclude'> = {},
  ): Promise<SearchPage> {
    const deadline = Math.min(options.deadlineMs ?? Infinity, Date.now() + options.timeoutMs);
    options = { ...options, deadlineMs: deadline };
    const listing = {
      path: scope.path ?? '.',
      include: scope.include ?? [],
      exclude: scope.exclude ?? [],
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      deadlineMs: options.deadlineMs,
    };
    if (
      backend &&
      context &&
      options.mode === 'literal' &&
      isSensitive(options) &&
      (await backend.available())
    ) {
      const inventory = await this.inventory(listing);
      if (Date.now() >= deadline)
        return scanText(this.access, fromFiles(inventory.files), options, () => inventory.coverage);
      return backend.search(
        {
          files: inventory.files,
          options,
          inventory: () => inventory.coverage,
          // The fallback scans only the files the backend could not answer for. The coverage it is handed is
          // the enumeration's, not the backend's: a scan of a partial file list must not come back complete.
          fallback: (files, coverage) =>
            scanText(this.access, fromFiles(files), options, () => coverage),
        },
        context,
      );
    }
    const stream = iterateInventory(this.access, this.inventoryOptions(listing));
    return scanText(this.access, stream, options, () => stream.coverage());
  }

  /** The symbol index's answer, building it when nobody has yet. */
  async symbols(input: SymbolQueryInput): Promise<SymbolPage> {
    input.signal.throwIfAborted();
    // Opening is deferred until a symbol question is actually asked: a registry that never asks one leaves the
    // workspace untouched, which is what keeps a per-run tool set from creating a database per run.
    this.index.ensure();
    /**
     * A stale index heals in the background, and the answer says which it is.
     *
     * Something recorded that paths changed — a tool write, a watch event — so the rows may describe content that
     * is gone. Rebuilding here rather than on the next `ready()` is what keeps a *stale* answer from being the
     * permanent answer. An already-stale or unopened index builds in the background; `freshness` tells the caller
     * its answer may lag. For a validated index we first check metadata and wait cancellably for any external
     * changes to be reconciled, so a command write cannot silently reuse the old declarations as validated.
     */
    if (!this.started || this.index.freshness() !== 'validated') this.startBuild(input.path ?? '.');
    else if (!this.build) await this.reconcile(false, input.signal);
    if (input.cursor && this.freshness() !== 'validated')
      throw new CursorInvalidError('symbol index is being rebuilt');
    const limit = clamp(input.limit, 1, MAX_SYMBOL_LIMIT);
    const after = input.cursor ? this.spendCursor(input.cursor, input, 'symbols') : null;
    const all = this.index.query(input.query || null, Number.MAX_SAFE_INTEGER, input.language);
    const start =
      after === null
        ? 0
        : after.index !== undefined
          ? after.index + 1
          : (() => {
              const found = all.findIndex((symbol) => comparePosition(symbol, after) > 0);
              return found === -1 ? all.length : found;
            })();
    const symbols = all.slice(start, start + limit);
    const last = symbols[symbols.length - 1];
    const nextCursor =
      start + symbols.length < all.length && last
        ? this.cursors.issue({
            workspace: this.root,
            queryHash: this.symbolHash(input),
            sourceVersion: this.sourceVersion(),
            after: { path: last.path, line: last.startLine, index: start + symbols.length - 1 },
            // A symbol page cannot name one file as its witness: the next page depends on every row it is about to
            // skip. The reconcile pass is what keeps those rows true, and `freshness` is what reports it.
            witness: null,
          })
        : null;
    return {
      symbols,
      coverage: this.lastCoverage,
      sourceVersion: this.sourceVersion(),
      nextCursor,
      freshness: this.freshness(),
    };
  }

  /** The next page of a listing or a symbol query. */
  async continueSearch(input: ContinueInput): Promise<SymbolPage | ListingPage> {
    if (input.kind === 'listing')
      return this.listingPage(
        { ...input.options, limit: input.limit, cursor: input.cursor },
        input.signal,
      );
    return this.symbols({
      query: input.options.query ?? '',
      path: input.options.path,
      language: input.options.language,
      limit: input.limit,
      cursor: input.cursor,
      signal: input.signal,
    });
  }

  /** Reads a range through the same path policy as every other read. */
  async readRange(
    relative: string,
    startLine: number,
    endLine: number,
    signal: AbortSignal,
    allowSpill = false,
  ): Promise<RangeRead> {
    return readFileRange(this.access, relative, startLine, endLine, signal, allowSpill);
  }

  /**
   * Records that paths changed.
   *
   * No rebuild happens here. A watch event, a tool write and a periodic check all arrive at the same place — a
   * set of paths — and reconciling them is the next query's job, which keeps a burst of writes from starting a
   * burst of builds.
   */
  async invalidate(input: { paths: string[]; reason: InvalidateReason }): Promise<void> {
    for (const changed of input.paths) this.dirty.add(changed);
    this.index.markStale();
    this.cursors.invalidate(input.paths);
  }

  /** Waits for the running build, then reconciles the index against the files as they are now. */
  async ready(options: { hash?: boolean } = {}): Promise<void> {
    this.index.ensure();
    if (!this.started) this.startBuild('.');
    await this.build?.catch(() => {});
    await this.reconcile(options.hash ?? false);
  }

  freshness(): Freshness {
    if (this.build) return 'building';
    return this.index.freshness();
  }

  sourceVersion(): string | null {
    return this.index.sourceVersion();
  }

  size(): number {
    // Reading the size of a persisted index means reading the index: this is the one accessor that opens the
    // stored rows, so `freshness` can stay a cheap question with no I/O behind it.
    this.index.ensure();
    return this.index.size();
  }

  cursorCount(): number {
    return this.cursors.size();
  }

  /**
   * Releases one reference, closing everything when it was the last.
   *
   * The order is the whole of the resource policy: cancel and settle the build first, then drop the cursors, then
   * close the database. Closing a database under a running build is how a half-written generation gets published
   * by whatever query comes next.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.refs--;
    if (this.refs > 0) return;
    this.closed = true;
    this.cancelledBuild = true;
    await this.build?.catch(() => {});
    this.build = null;
    this.cursors.clear();
    this.index.close();
  }

  /** Takes another reference. Used by the shared registry, never by a caller that built its own service. */
  retain(): void {
    if (this.closed) throw new Error('Search service is closed');
    this.refs++;
  }

  /**
   * Ends the service regardless of outstanding references.
   *
   * `close()` is reference-counted, so a registry that wants to drop a shared service has to stop pretending to
   * hold a reference first: `retain()` + `close()` cancels out and leaves the database open.
   */
  async forceClose(): Promise<void> {
    if (this.closed) return;
    this.refs = 1;
    await this.close();
  }

  refCount(): number {
    return this.refs;
  }

  private inventoryOptions(input: Partial<InventoryOptions>): InventoryOptions {
    return {
      path: input.path ?? '.',
      include: input.include ?? [],
      exclude: input.exclude ?? [],
      maxEntries: input.maxEntries ?? SEARCH_MAX_ENTRIES,
      maxFiles: input.maxFiles === undefined ? null : input.maxFiles,
      timeoutMs: input.timeoutMs ?? SEARCH_TIMEOUT_MS,
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      // A default that cannot be cancelled: `AbortSignal.abort()` here would abort every build the moment it
      // started, which is exactly the bug this line replaces.
      signal: input.signal ?? new AbortController().signal,
    };
  }

  private spendCursor(
    token: string,
    input: {
      path?: string;
      include?: string[];
      exclude?: string[];
      language?: string;
      query?: string;
    },
    kind: 'listing' | 'symbols',
  ): CursorState['after'] {
    const state = this.cursors.take(token, {
      workspace: this.root,
      queryHash: kind === 'listing' ? this.listingHash(input) : this.symbolHash(input),
    });
    if (kind === 'symbols' && state.sourceVersion !== this.sourceVersion())
      throw new CursorInvalidError('the indexed source changed since this cursor was issued');
    return state.after;
  }

  private listingHash(input: { path?: string; include?: string[]; exclude?: string[] }): string {
    return queryHashOf({
      kind: 'listing',
      path: input.path ?? '.',
      include: input.include ?? [],
      exclude: input.exclude ?? [],
    });
  }

  private symbolHash(input: { query?: string; path?: string; language?: string }): string {
    return queryHashOf({
      kind: 'symbols',
      query: input.query,
      path: input.path ?? '.',
      language: input.language ?? '',
    });
  }

  private startBuild(relativePath: string): void {
    if (this.build || this.closed) return;
    this.started = true;
    this.index.markBuilding();
    this.build = this.runBuild(relativePath)
      .catch(() => {
        // A build that failed must not leave the index looking like one that is still running: `building` is a
        // promise to answer soon, and there is nothing left to wait for here.
        this.index.markStale();
      })
      .finally(() => {
        this.build = null;
      });
  }

  private async runBuild(relativePath: string): Promise<void> {
    this.index.begin();
    const { files, coverage } = await collectInventory(
      this.access,
      this.inventoryOptions({ path: relativePath }),
    );
    /**
     * Whether the *walk* finished, read before this build folds its own per-file refusals into `coverage`.
     *
     * `coverage.complete` answers two questions at once — did every path get enumerated, and was every file
     * analysed in full — and only the first one decides whether an indexed path that this build did not see is
     * really gone. A file too large to outline is still a file that was visited.
     */
    const enumerated = coverage.complete;
    this.lastCoverage = coverage;
    this.inventoryFingerprints = new Map(
      files
        .filter((file) => languageOf(file.path) && isOutlineable(file.path))
        .map((file) => [
          file.path,
          { size: file.fingerprint.size, mtimeMs: file.fingerprint.mtimeMs },
        ]),
    );
    const seen = new Set<string>();
    for (const file of files) {
      if (this.cancelledBuild || this.closed) return;
      seen.add(file.path);
      const language = languageOf(file.path);
      if (!language || !isOutlineable(file.path)) continue;
      if (tooLarge(file)) {
        this.index.remove(file.path);
        this.parsers.delete(file.path);
        coverage.partialFiles++;
        markStop(coverage, 'byte-limit');
        continue;
      }
      try {
        const bytes = await readFile(file.absolutePath);
        coverage.bytesRead = (coverage.bytesRead ?? 0) + bytes.length;
        const after = await lstat(file.absolutePath);
        if (
          bytes.length > MAX_SYMBOL_FILE_BYTES ||
          after.size !== file.fingerprint.size ||
          after.mtimeMs !== file.fingerprint.mtimeMs ||
          bytes.length !== after.size
        ) {
          this.index.remove(file.path);
          this.parsers.delete(file.path);
          this.inventoryFingerprints.delete(file.path);
          coverage.partialFiles++;
          markStop(coverage, bytes.length > MAX_SYMBOL_FILE_BYTES ? 'byte-limit' : 'changed');
          continue;
        }
        const source = bytes.toString('utf8');
        const digest = createHash('sha256').update(bytes).digest('hex');
        /**
         * The best parser this build has, and no claim about which one that was.
         *
         * With the TypeScript compiler resolvable, TS/JS declarations get their exact spans from the syntax tree;
         * without it — a packaged build that does not carry the compiler — the line-anchored analysis answers,
         * because a missing optional module must not take `repo_map` down. Either way the bound on a pathological
         * file is its *size*, which `tooLarge` enforces above, not a wall-clock deadline: both analyses are
         * linear in the file's length.
         */
        const analysis = await analyzeSymbolsWithParser(source, file.path, language, {
          size: file.fingerprint.size,
          mtimeMs: file.fingerprint.mtimeMs,
          sha256: digest,
        });
        const symbols = analysis.symbols;
        this.parsers.set(file.path, analysis.parser);
        this.index.put({
          path: file.path,
          language,
          size: file.fingerprint.size,
          mtimeMs: file.fingerprint.mtimeMs,
          sha256: digest,
          symbols: symbols.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
          })),
          imports: symbols[0]?.imports ?? [],
          exports: symbols[0]?.exports ?? [],
        });
        coverage.filesScanned++;
      } catch {
        this.index.remove(file.path);
        this.parsers.delete(file.path);
        this.inventoryFingerprints.delete(file.path);
        coverage.unreadableFiles++;
        markStop(coverage, 'read-error');
      }
    }
    if (this.cancelledBuild || this.closed) return;
    /**
     * A build that did not enumerate the whole tree cannot speak for the rows it never reached.
     *
     * The prune below deletes every indexed path this inventory did not name, which is the right reading of an
     * enumeration that *completed* — and a lie when it stopped at the deadline or the entry cap, because a file
     * nobody visited is not a file that is gone. `reconcile` already refuses this exact work on this exact
     * evidence (`!inventory.coverage.complete`); a build is the unattended path, so it is the one that has to be
     * careful. Leaving the state unvalidated is what makes the next query rebuild instead of trusting a shrunken
     * index.
     */
    if (!enumerated) {
      // Nothing is committed, so the index stays at `building` — not `validated` — and the next query starts a
      // build of its own instead of trusting a generation this one could not finish.
      return;
    }
    // A path-scoped build is not evidence about any other path: pruning on it would delete every row outside
    // the scope, and the next full reconcile would have to put them back.
    if (relativePath === '.')
      for (const known of this.index.paths())
        if (!seen.has(known)) {
          this.index.remove(known);
          this.parsers.delete(known);
        }
    this.index.commit();
  }

  /**
   * Re-checks the indexed rows against the files, which is what makes `validated` a checked claim.
   *
   * Metadata-first, because a stat per indexed file is the cheap half of the question. With `hash`, a row whose
   * size and mtime still match is checked *again* by content digest — the case a metadata fingerprint cannot see,
   * which is a rewrite of the same length inside one filesystem timestamp tick. That is the expensive half, so it
   * is asked for rather than assumed: a periodic full hash of every source file is a background cost a caller
   * should be able to schedule.
   */
  private async reconcile(hash: boolean, signal?: AbortSignal): Promise<void> {
    if (this.closed) return;
    const stale = new Set<string>(this.dirty);
    this.dirty.clear();
    // Enumeration also detects new files; checking only existing rows would miss every new declaration.
    const inventory = await this.inventory({ ...(signal ? { signal } : {}) });
    if (!inventory.coverage.complete) {
      this.lastCoverage = {
        ...this.lastCoverage,
        complete: false,
        reasons: [...new Set([...this.lastCoverage.reasons, ...inventory.coverage.reasons])],
        entriesVisited: inventory.coverage.entriesVisited,
        filesConsidered: inventory.coverage.filesConsidered,
      };
      this.index.markStale();
      return;
    }
    const current = new Map(
      inventory.files
        .filter((file) => languageOf(file.path) && isOutlineable(file.path))
        .map((file) => [file.path, file.fingerprint]),
    );
    for (const [relative, actual] of current) {
      const expected = this.inventoryFingerprints.get(relative);
      if (!expected || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs)
        stale.add(relative);
    }
    for (const relative of this.inventoryFingerprints.keys())
      if (!current.has(relative)) stale.add(relative);
    for (const known of this.index.paths()) {
      const expected = this.index.fingerprintOf(known);
      if (!expected) continue;
      const actual = current.get(known) ?? null;
      if (!actual || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
        stale.add(known);
        continue;
      }
      if (!hash) continue;
      const digest = await digestOfFile(this.access, known).catch(() => null);
      if (!digest || digest !== this.index.digestOf(known)) stale.add(known);
    }
    if (!stale.size) return;
    this.startBuild('.');
    if (!signal) await this.build;
    else await waitForBuild(this.build!, signal);
  }
}

/** A caller can leave while the shared rebuild continues for the next caller. */
async function waitForBuild(build: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      build.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * The process-wide service per workspace, ref-counted.
 *
 * A registry is rebuilt for every run, so a service acquired per registry would rebuild the index per run — the
 * cost this exists to avoid. The map is keyed by the canonical root, which is what makes two registries over one
 * workspace share an index and two workspaces never share one.
 */
const shared = new Map<string, WorkspaceSearchService>();

export function acquireSearchService(
  access: WorkspaceAccess,
  options: SearchServiceOptions = {},
): WorkspaceSearchService {
  const existing = shared.get(access.root);
  if (existing) {
    existing.retain();
    return existing;
  }
  const service = new WorkspaceSearchService(access, options);
  shared.set(access.root, service);
  return service;
}

export async function releaseSearchService(service: WorkspaceSearchService): Promise<void> {
  await service.close();
  if (service.refCount() <= 0) shared.delete(service.root);
}

/** Drops every shared service. For tests and for a host that is shutting down. */
export async function closeAllSearchServices(): Promise<void> {
  for (const [root, service] of [...shared]) {
    shared.delete(root);
    await service.forceClose();
  }
}

/** `list_files`'s limit, clamped to what the tool promises. */
function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function witnessOf(file: FileEntry): CursorWitness {
  return { path: file.path, size: file.fingerprint.size, mtimeMs: file.fingerprint.mtimeMs };
}

/** Ordering by path bytes and then by line, the same order every page is built in. */
function comparePosition(symbol: SymbolRecord, after: { path: string; line: number }): number {
  const byPath = Buffer.compare(Buffer.from(symbol.path, 'utf8'), Buffer.from(after.path, 'utf8'));
  return byPath !== 0 ? byPath : symbol.startLine - after.line;
}

/** SHA-256 of a file's bytes, for the reconcile pass a caller asked to be exhaustive. */
async function digestOfFile(access: WorkspaceAccess, relative: string): Promise<string> {
  const bytes = await readFile(await access.resolve(relative));
  return createHash('sha256').update(bytes).digest('hex');
}

async function* fromFiles(files: Iterable<FileEntry>): AsyncGenerator<FileEntry> {
  for (const file of files) yield file;
}
