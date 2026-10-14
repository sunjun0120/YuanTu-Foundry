/**
 * The retrieval contracts: coverage, budgets, results, fingerprints and cursors.
 *
 * This module is the single place that says what "no matches" means. Two different facts used to be spelled the
 * same way — a complete scan that found nothing, and a bounded scan that stopped early and found nothing — so a
 * caller could not tell "the workspace does not contain this" from "I did not look everywhere". Every result that
 * leaves this package carries a `Coverage`, and `complete` is only true when the declared path scope, filters and
 * exclusions were enumerated to EOF inside every budget.
 *
 * The package deliberately has no runtime dependency on `core`, `tools`, `storage`, `mcp` or `office`: path
 * admission arrives as {@link WorkspaceAccess} and process execution as an injected starter, so the search
 * engine can be tested with a temporary directory and nothing else.
 */
import type { ToolContext } from '../protocol/index.ts';

/**
 * Why a scan stopped before it could prove a complete answer.
 *
 * The list is closed on purpose: a caller renders one sentence per reason, and a free-form string would let a
 * new stopping condition reach a client that has no wording for it. `changed` is the honest reason for a file
 * that was rewritten under the scan; `read-error` for one that could not be read at all.
 */
export type ScanStop =
  | 'entry-limit'
  | 'file-limit'
  | 'byte-limit'
  | 'time-limit'
  | 'result-limit'
  | 'line-limit'
  | 'read-error'
  | 'changed';

/**
 * Every stopping condition, as a value.
 *
 * The type above is the compile-time list and this is the runtime one, because a JSON Schema has to name them
 * and a tool result crosses a process boundary where types do not exist. Both are written here so a new reason
 * that is added to one and forgotten in the other is visible in a single file rather than in a validator's
 * silence.
 */
export const SCAN_STOPS: readonly ScanStop[] = [
  'entry-limit',
  'file-limit',
  'byte-limit',
  'time-limit',
  'result-limit',
  'line-limit',
  'read-error',
  'changed',
];

/**
 * The declared shape of a coverage value.
 *
 * A declaration rather than a validator: it is compiled by the same Ajv the tool input schemas are, and a
 * payload that does not match it is a defect the tool-output test catches rather than a card that silently
 * draws nothing.
 */
export const COVERAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    complete: {
      type: 'boolean',
      description:
        'True only when the declared path, filters and exclusions were enumerated to EOF inside every budget.',
    },
    reasons: {
      type: 'array',
      items: { type: 'string', enum: [...SCAN_STOPS] },
      description: 'Why the scan stopped early. Empty exactly when complete is true.',
    },
    entriesVisited: { type: 'integer', minimum: 0 },
    filesConsidered: { type: 'integer', minimum: 0 },
    filesScanned: { type: 'integer', minimum: 0 },
    partialFiles: { type: 'integer', minimum: 0 },
    unreadableFiles: { type: 'integer', minimum: 0 },
    bytesRead: {
      type: ['integer', 'null'],
      minimum: 0,
      description: 'Real bytes read, or null when the backend cannot report them.',
    },
  },
  required: [
    'complete',
    'reasons',
    'entriesVisited',
    'filesConsidered',
    'filesScanned',
    'partialFiles',
    'unreadableFiles',
    'bytesRead',
  ],
  additionalProperties: false,
};

/**
 * How much of the requested scope a scan actually covered.
 *
 * `complete` is a claim about the *declared* scope — the path, the include/exclude filters and the credential
 * exclusions — never about the whole machine. `bytesRead` is `null` when the backend cannot report real bytes
 * (ripgrep does not), because a file's size is an estimate and an estimate must not be dressed as a measurement.
 */
export interface Coverage {
  complete: boolean;
  reasons: ScanStop[];
  /** Directory entries examined, including ones the filters rejected. */
  entriesVisited: number;
  /** Files that passed path admission and the include/exclude filters. */
  filesConsidered: number;
  /** Files read to EOF, or that the external backend confirmed it processed completely. */
  filesScanned: number;
  /** Files whose content was only partly examined (a clipped line, a byte or time cut). */
  partialFiles: number;
  /** Files that could not be read at all. */
  unreadableFiles: number;
  bytesRead: number | null;
}

/** One match, as data. The text is already cut to the display cap. */
export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/**
 * One page of results, with everything a caller needs to say how much of the answer it is holding.
 *
 * `outputTruncated` is about the *payload*: hits were found but did not fit the character budget, so the list is
 * shorter than the scan's own result limit. It is separate from `coverage.complete` because the two failures
 * need different remedies — one says "narrow the query", the other "narrow the scope".
 */
export interface SearchPage {
  matches: SearchHit[];
  coverage: Coverage;
  outputTruncated: boolean;
  nextCursor: string | null;
  sourceVersion: string | null;
}

/**
 * What a file looked like when it was enumerated.
 *
 * `sha256` is `null` for a metadata-only fingerprint. The distinction is load-bearing: size and mtime are cheap
 * and let a stale cache be discarded, but they are not proof the bytes are unchanged — a same-size rewrite
 * inside one timestamp tick is invisible to them. Only a non-null digest may be treated as content evidence.
 */
export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  sha256: string | null;
}

export interface FileEntry {
  path: string;
  absolutePath: string;
  fingerprint: FileFingerprint;
}

/** How much work enumeration may do before it must stop and say so. */
export interface InventoryOptions {
  path: string;
  include: string[];
  exclude: string[];
  maxEntries: number;
  maxFiles: number | null;
  timeoutMs: number;
  /** Internal shared deadline across enumeration and scanning; not a renewed per-stage budget. */
  deadlineMs?: number;
  signal: AbortSignal;
}

/** How much work a text scan may do before it must stop and say so. */
export interface SearchOptions {
  query: string;
  mode: 'literal' | 'regex';
  caseMode: 'sensitive' | 'insensitive' | 'smart';
  maxResults: number;
  maxOutputChars: number;
  maxScanBytes: number;
  timeoutMs: number;
  /** Internal shared deadline across preparation, enumeration, backend and fallback. */
  deadlineMs?: number;
  signal: AbortSignal;
}

/**
 * What the search engine is allowed to know about a workspace.
 *
 * `resolve` mirrors `Workspace.resolve`, but the second parameter is `allowSpill` rather than `allowNew`: the
 * adapter must forward it explicitly (`(relative, allowSpill = false) => workspace.resolve(relative, false,
 * allowSpill)`), because binding the second positional argument would silently turn a spill permission into a
 * permission to name a file that does not exist.
 */
export interface WorkspaceAccess {
  root: string;
  resolve(relative: string, allowSpill?: boolean): Promise<string>;
  isExcluded(relative: string, kind: 'file' | 'directory'): boolean;
}

/**
 * A file slice read from the real file, with the file's true length.
 *
 * `totalLines` is the complete count, never the number of lines the scan happened to see before the requested
 * window. A reader that cannot finish counting must fail rather than answer with a prefix count — the bug this
 * replaces printed "128002 lines" for a 130001-line file and returned an empty slice for a line that exists.
 */
export interface RangeRead {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  truncated: boolean;
  fileFingerprint: FileFingerprint;
  /**
   * The file's decoded text ends with a newline (false for an empty file).
   *
   * Carried because the numbered text form has always shown the empty element a trailing newline splits off, and
   * the payload must not: `totalLines` counts lines, and a reader that wants to reproduce that numbering needs to
   * know whether the element exists. Only ever true from a read that reached EOF.
   */
  endsWithNewline: boolean;
}

/** Enumeration plus its coverage, for callers that want the whole list at once. */
export interface InventoryResult {
  files: FileEntry[];
  coverage: Coverage;
}

/** How current an index's picture of the workspace is. */
export type Freshness = 'validated' | 'building' | 'stale' | 'unknown';

/** One declaration found in one file, with the imports and exports the file carries. */
export interface SymbolRecord {
  path: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  language: string;
  imports: string[];
  exports: string[];
  fingerprint: FileFingerprint;
}

/** A page of symbol results. */
export interface SymbolPage {
  symbols: SymbolRecord[];
  coverage: Coverage;
  sourceVersion: string | null;
  nextCursor: string | null;
  freshness: Freshness;
}

/** Why an index entry was invalidated. */
export type InvalidateReason = 'watch' | 'reconcile' | 'tool-write';

export function emptyCoverage(): Coverage {
  return {
    complete: true,
    reasons: [],
    entriesVisited: 0,
    filesConsidered: 0,
    filesScanned: 0,
    partialFiles: 0,
    unreadableFiles: 0,
    bytesRead: 0,
  };
}

/** Records a stopping condition once and marks the coverage incomplete. */
export function markStop(coverage: Coverage, reason: ScanStop): void {
  coverage.complete = false;
  if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
}

/**
 * The result of an enumeration that may not have finished, exposing its coverage while it is still running.
 *
 * `complete` is only true once the walk reached EOF inside every budget; a pull that stopped early leaves it
 * false, so a consumer that abandons the stream half way cannot mistake what it saw for the whole tree.
 */
export interface InventoryStream extends AsyncIterable<FileEntry> {
  coverage(): Coverage;
}

/**
 * What a fast backend is given, and what it owes back.
 *
 * A backend is injected rather than imported because executing a program is a policy decision: this package
 * holds no execution environment, no sandbox handle and no list of trusted programs. The tool assembly layer
 * supplies one, and a deployment that has no verified program simply supplies none.
 *
 * `fallback` is not optional in spirit. It is the built-in scanner, applied to the files the fast backend did
 * not cover — a batch that failed, a file whose match arrived in a form the backend cannot vouch for. Without it
 * there is no honest answer for those files, and returning the part that arrived is the false-complete result
 * this package exists to remove.
 */
export interface SearchBackendInput {
  files: readonly FileEntry[];
  options: SearchOptions;
  /** Live enumeration coverage, so a search that never enumerated everything cannot report otherwise. */
  inventory: () => Coverage;
  fallback: (files: readonly FileEntry[], coverage: Coverage) => Promise<SearchPage>;
}

export interface SearchBackend {
  /** One short name for diagnostics and measurements. */
  readonly name: string;
  /** True when this backend can be used at all here — a verified program, a working execution policy. */
  available(): Promise<boolean>;
  search(input: SearchBackendInput, context: ToolContext): Promise<SearchPage>;
}
