import { readdirSync, readSync, openSync, closeSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Tool, ToolContext } from '../protocol/index.ts';
import { isCredentialFileName } from './credential-paths.ts';
import { withRetrievalMetadata } from './retrieval-metadata.ts';
import { CursorStore, CursorInvalidError, queryHashOf } from '../search/cursor.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * They only read — a path argument chooses what is read, never whether anything is written — so the promise
 * is the same for every argument and is stated once here instead of once per tool. A tool that can write, or
 * that mutates state this run owns (the checklist, a job, the language server session), does not get this
 * name: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;

/**
 * A structural outline of the workspace: which files exist and what each one declares.
 *
 * The point is to let the agent see the terrain before it starts reading files, which `list_files`
 * (a flat path list) and `search_files` (literal/regex) cannot express. Two sources feed it:
 *
 * - A dependency-free heuristic scan that always works, needs no language server and no network, and
 *   is what the agent is told about the workspace. Prompt assembly must not perform server round
 *   trips, so what is announced is heuristic-only by design.
 * - The language server's own `workspace/symbol`, used when a server is *already running* and the
 *   caller asks for a symbol by name. It is more accurate than a regex scan, but it is never started
 *   implicitly, so the tool degrades to the heuristic index instead of paying a server startup.
 */

/** Directories never worth outlining, mirroring the search-files exclusions. */
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.yuantu',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
]);
/** Files larger than this are skipped: an outline of a generated bundle is noise. */
const MAX_FILE_BYTES = 512 * 1024;
/** Only the head of a file is scanned; declarations are overwhelmingly near the top. */
const MAX_READ_BYTES = 32 * 1024;
const DEFAULT_MAX_FILES = 400;
const DEFAULT_SYMBOLS_PER_FILE = 12;
/** Default budget for the outline injected into the system prompt. */
export const REPO_MAP_PROMPT_BUDGET = 2_400;

interface OutlineRule {
  kind: string;
  pattern: RegExp;
}
/**
 * Line-anchored patterns per extension. Deliberately shallow: matching nested members and locals
 * would bloat the outline, and the agent can read a file or ask the language server for detail.
 */
const OUTLINE_RULES: Record<string, OutlineRule[]> = {
  '.ts': [
    {
      kind: 'class',
      pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(?<name>[\w$]+)/,
    },
    {
      kind: 'interface',
      pattern: /^\s*(?:export\s+)?(?:default\s+)?interface\s+(?<name>[\w$]+)/,
    },
    { kind: 'type', pattern: /^\s*(?:export\s+)?type\s+(?<name>[\w$]+)/ },
    { kind: 'enum', pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+(?<name>[\w$]+)/ },
    {
      kind: 'function',
      pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(?<name>[\w$]+)/,
    },
    {
      kind: 'const',
      pattern: /^\s*export\s+(?:default\s+)?const\s+(?<name>[\w$]+)/,
    },
    { kind: 'namespace', pattern: /^\s*(?:export\s+)?(?:declare\s+)?namespace\s+(?<name>[\w$]+)/ },
  ],
  '.js': [],
  '.py': [
    { kind: 'class', pattern: /^class\s+(?<name>\w+)/ },
    { kind: 'function', pattern: /^(?:async\s+)?def\s+(?<name>\w+)/ },
  ],
  '.go': [
    { kind: 'function', pattern: /^func\s+(?:\([^)]*\)\s*)?(?<name>\w+)/ },
    { kind: 'type', pattern: /^type\s+(?<name>\w+)/ },
  ],
  '.rs': [
    {
      kind: 'function',
      pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(?<name>\w+)/,
    },
    {
      kind: 'type',
      pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+(?<name>\w+)/,
    },
    { kind: 'impl', pattern: /^\s*impl(?:<[^>]*>)?\s+(?<name>[\w:<>]+)/ },
  ],
  '.java': [
    {
      kind: 'type',
      pattern:
        /^\s*(?:public|private|protected|static|final|abstract|sealed|\s)*\s*(?:class|interface|enum|record)\s+(?<name>\w+)/,
    },
  ],
  '.kt': [
    {
      kind: 'type',
      pattern:
        /^\s*(?:public|private|protected|internal|open|abstract|sealed|data|\s)*\s*(?:class|interface|object|enum class)\s+(?<name>\w+)/,
    },
    {
      kind: 'function',
      pattern: /^\s*(?:public|private|protected|internal|suspend|inline|\s)*\s*fun\s+(?<name>\w+)/,
    },
  ],
  '.cs': [
    {
      kind: 'type',
      pattern:
        /^\s*(?:public|private|protected|internal|static|abstract|sealed|partial|\s)*\s*(?:class|interface|struct|enum|record)\s+(?<name>\w+)/,
    },
  ],
  '.rb': [
    { kind: 'class', pattern: /^\s*class\s+(?<name>[\w:]+)/ },
    { kind: 'module', pattern: /^\s*module\s+(?<name>[\w:]+)/ },
    { kind: 'function', pattern: /^\s*def\s+(?<name>[\w?!]+)/ },
  ],
  '.php': [
    {
      kind: 'type',
      pattern: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(?<name>\w+)/,
    },
    {
      kind: 'function',
      pattern: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(?<name>\w+)/,
    },
  ],
  '.sh': [{ kind: 'function', pattern: /^\s*(?:function\s+)?(?<name>[\w.-]+)\s*\(\s*\)\s*\{/ }],
  '.swift': [
    {
      kind: 'type',
      pattern:
        /^\s*(?:public\s+|private\s+|internal\s+|final\s+)*(?:class|struct|enum|protocol|actor)\s+(?<name>\w+)/,
    },
    {
      kind: 'function',
      pattern: /^\s*(?:public\s+|private\s+|internal\s+|static\s+)*func\s+(?<name>\w+)/,
    },
  ],
  '.c': [{ kind: 'type', pattern: /^\s*(?:typedef\s+)?(?:struct|enum|union)\s+(?<name>\w+)/ }],
  '.h': [],
  '.cpp': [{ kind: 'type', pattern: /^\s*(?:class|struct|enum)\s+(?<name>\w+)/ }],
};
// JavaScript shares the TypeScript rules, and the C/C++ headers reuse their implementation's rules.
OUTLINE_RULES['.js'] = OUTLINE_RULES['.ts']!;
OUTLINE_RULES['.jsx'] = OUTLINE_RULES['.ts']!;
OUTLINE_RULES['.tsx'] = OUTLINE_RULES['.ts']!;
OUTLINE_RULES['.mjs'] = OUTLINE_RULES['.ts']!;
OUTLINE_RULES['.cjs'] = OUTLINE_RULES['.ts']!;
OUTLINE_RULES['.mts'] = OUTLINE_RULES['.ts']!;
OUTLINE_RULES['.cts'] = OUTLINE_RULES['.ts']!;
OUTLINE_RULES['.hpp'] = OUTLINE_RULES['.cpp']!;
OUTLINE_RULES['.cc'] = OUTLINE_RULES['.cpp']!;
OUTLINE_RULES['.rbw'] = OUTLINE_RULES['.rb']!;

export interface RepoSymbol {
  kind: string;
  name: string;
  line: number;
  container?: string;
}
export interface RepoFile {
  path: string;
  symbols: RepoSymbol[];
}
export interface RepoMap {
  files: RepoFile[];
  /** Files whose extension is outlineable and that were actually scanned. */
  scannedFiles: number;
  /** True when the file cap or the read cap cut the scan short. */
  truncated: boolean;
}
export interface RepoMapOptions {
  maxFiles?: number;
  symbolsPerFile?: number;
}

function isIgnored(name: string): boolean {
  return (
    IGNORED_DIRECTORIES.has(name.toLowerCase()) ||
    /^\.env/i.test(name) ||
    isCredentialFileName(name)
  );
}
/** Reads at most `MAX_READ_BYTES` from a regular file, returning '' for anything unreadable. */
function readHead(file: string): string | null {
  let descriptor: number | undefined;
  try {
    const stats = statSync(file);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
    descriptor = openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(Math.min(MAX_READ_BYTES, Math.max(1, stats.size)));
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    // A NUL byte means binary (or UTF-16); skip it rather than outline mojibake.
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Nothing useful to do if the descriptor is already gone. */
      }
    }
  }
}
function outline(text: string, rules: OutlineRule[], limit: number): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length && symbols.length < limit; index++) {
    const line = lines[index]!;
    for (const rule of rules) {
      const match = rule.pattern.exec(line);
      if (!match?.groups?.name) continue;
      symbols.push({ kind: rule.kind, name: match.groups.name, line: index + 1 });
      break;
    }
  }
  return symbols;
}
/**
 * Walks the workspace and outlines every supported source file, sorted by path so the same tree always
 * produces the same map. Symlinks are not followed: a link out of the workspace would outline files
 * the agent is not allowed to read.
 */
export function buildRepoMap(root: string, options: RepoMapOptions = {}): RepoMap {
  return outlineRepoFiles(scanRepoFiles(root, options.maxFiles ?? DEFAULT_MAX_FILES), options);
}

interface RepoScan {
  files: { absolute: string; relative: string; rules: OutlineRule[] }[];
  key: string;
  truncated: boolean;
}

/** The cache and builder inspect the same bounded set of source files, without reading their contents. */
function scanRepoFiles(root: string, maxFiles: number): RepoScan {
  const files: RepoScan['files'] = [];
  const fingerprint = createHash('sha256');
  const maxDirectories = Math.max(DEFAULT_MAX_FILES, maxFiles) * 4;
  let directories = 0;
  let stopped = false;
  let truncated = false;
  const walk = (directory: string, relative: string, depth: number): void => {
    if (stopped) return;
    // Empty or unsupported-only trees must not make a per-round freshness check unbounded.
    if (depth > 64 || directories >= maxDirectories) {
      truncated = true;
      if (directories >= maxDirectories) stopped = true;
      return;
    }
    directories++;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (stopped) return;
      if (entry.isSymbolicLink() || isIgnored(entry.name)) continue;
      const child = path.join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child, childRelative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const rules = OUTLINE_RULES[path.extname(entry.name).toLowerCase()];
      if (!rules) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        stopped = true;
        return;
      }
      try {
        const stats = lstatSync(child);
        if (!stats.isFile()) continue;
        fingerprint.update(
          JSON.stringify([
            childRelative,
            stats.size,
            stats.mtimeMs,
            stats.ctimeMs,
            stats.ino,
            stats.mode,
          ]),
        );
      } catch {
        fingerprint.update(JSON.stringify([childRelative, 'unreadable']));
      }
      files.push({ absolute: child, relative: childRelative, rules });
    }
  };
  walk(root, '', 0);
  fingerprint.update(String(truncated));
  return { files, key: fingerprint.digest('hex'), truncated };
}

function outlineRepoFiles(scan: RepoScan, options: RepoMapOptions = {}): RepoMap {
  const perFile = options.symbolsPerFile ?? DEFAULT_SYMBOLS_PER_FILE;
  const files: RepoFile[] = [];
  for (const file of scan.files) {
    const head = readHead(file.absolute);
    if (head === null) continue;
    const symbols = outline(head, file.rules, perFile);
    if (symbols.length) files.push({ path: file.relative, symbols });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, scannedFiles: scan.files.length, truncated: scan.truncated };
}
/**
 * Renders the map within a character budget, degrading instead of overflowing: symbols first, then
 * file paths only, then a hard cut at a line boundary with a notice. A prompt section that silently
 * eats the context window is worse than one that admits it was trimmed.
 */
export function formatRepoMap(map: RepoMap, budgetChars = REPO_MAP_PROMPT_BUDGET): string {
  if (!map.files.length) return '';
  const withSymbols = map.files
    .map(
      (file) =>
        `${file.path}: ${file.symbols
          .map(
            (symbol) =>
              `${symbol.kind} ${symbol.container ? `${symbol.container}.` : ''}${symbol.name}:${symbol.line}`,
          )
          .join(', ')}`,
    )
    .join('\n');
  if (withSymbols.length <= budgetChars) return withSymbols;
  const pathsOnly = map.files
    .map((file) => `${file.path} (${file.symbols.length} symbols)`)
    .join('\n');
  const text = pathsOnly.length <= budgetChars ? pathsOnly : pathsOnly.slice(0, budgetChars);
  const clipped = text.length < pathsOnly.length || withSymbols.length > budgetChars;
  const lines = text.split('\n');
  if (clipped && pathsOnly.length > budgetChars) lines.pop();
  return lines.join('\n') + '\n[outline trimmed; use repo_map or lsp_symbols for detail]';
}
/**
 * The outline as the conversation is told it, cached per workspace.
 *
 * Rebuilding on every call would re-read hundreds of file heads for text that changes only when the tree
 * changes, so the map is memoised against the paths and metadata of the bounded source-file inventory.
 * Unchanged calls only inspect metadata; changed calls re-read file heads. That memo makes it affordable to
 * ask once per round, since the caller announces the outline into the conversation rather than the system prompt
 * (`packages/core/runtime-context.ts`) and the announcement has to notice the round that changed the tree.
 * `YUANTU_REPO_MAP=off` disables it entirely for callers that would rather spend those tokens elsewhere.
 */
const cache = new Map<string, { key: string; map: RepoMap; budgetChars: number; text: string }>();
export function repoMapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUANTU_REPO_MAP !== 'off';
}
export function repoMapContext(root: string, budgetChars = REPO_MAP_PROMPT_BUDGET): string {
  if (!repoMapEnabled()) return '';
  const scan = scanRepoFiles(root, DEFAULT_MAX_FILES);
  const cached = cache.get(root);
  if (cached && cached.key === scan.key && cached.budgetChars === budgetChars) return cached.text;
  const map = cached?.key === scan.key ? cached.map : outlineRepoFiles(scan);
  const text = formatRepoMap(map, budgetChars);
  cache.set(root, { key: scan.key, map, budgetChars, text });
  return text;
}
export function resetRepoMapCache(): void {
  cache.clear();
}
/** Symbol search backed by an already-running language server, when one exists. */
export type WorkspaceSymbolSearch = (
  query: string,
  language: string | undefined,
  signal: AbortSignal,
) => Promise<{ path: string; line?: number; kind: string; name: string; container?: string }[]>;

/**
 * The symbol index, as this module is allowed to see it.
 *
 * Structural rather than imported so that `repo-map.ts` keeps working — and keeps its prompt-section caller
 * working — in a build with no index at all. The search service satisfies it; a test can too, with three lines.
 */
export interface SymbolIndexSource {
  symbols(input: {
    query: string;
    path?: string;
    language?: string;
    limit: number;
    cursor?: string | null;
    signal: AbortSignal;
  }): Promise<{
    symbols: {
      path: string;
      name: string;
      kind: string;
      startLine: number;
      endLine: number;
    }[];
    coverage: unknown;
    sourceVersion: string | null;
    nextCursor: string | null;
    freshness: string;
  }>;
  ready?(): Promise<void>;
}

export function repoMapTools(
  root: string,
  searchWorkspaceSymbols?: WorkspaceSymbolSearch,
  index?: SymbolIndexSource,
): Tool[] {
  const lspCursors = new CursorStore();
  return [
    {
      name: 'repo_map',
      isConcurrencySafe: parallelRead,
      description:
        'Structural outline of the workspace and its declarations. Pass query to search symbol names, limit to bound the page, and the returned nextCursor as cursor with the same query to continue. Results report index freshness and scan coverage. An already-running language server is preferred for a first-page lookup.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          cursor: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(args: Record<string, unknown>, context: ToolContext) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const cursor = typeof args.cursor === 'string' ? args.cursor : null;
        const lspCursor = cursor?.startsWith('lsp:') ?? false;
        if (cursor && (!query || (!lspCursor && !index)))
          throw new Error(
            'cursor-invalid: a symbol cursor requires the same query and symbol index',
          );
        const limit =
          typeof args.limit === 'number' && Number.isSafeInteger(args.limit) ? args.limit : 60;
        if (!query) {
          const text = formatRepoMap(buildRepoMap(root), 8_000);
          /**
           * The bounded map keeps its own limits, and now says which ones they are.
           *
           * `coverage.complete` is false here because this listing is bounded by a file cap and a head-of-file
           * scan — the very limits S4 exists to work around. Saying so is the honest version of a listing that
           * has always been partial without mentioning it.
           */
          return {
            isError: false,
            content: withRetrievalMetadata(text || 'No outlineable source files found', {
              coverage: {
                complete: false,
                reasons: ['file-limit', 'line-limit'],
                entriesVisited: 0,
                filesConsidered: 0,
                filesScanned: 0,
                partialFiles: 0,
                unreadableFiles: 0,
                bytesRead: null,
              },
              sourceVersion: null,
              nextCursor: null,
              freshness: 'unknown',
            }),
          };
        }
        context.signal.throwIfAborted();
        // Prefer the language server: it reports real declarations, not regex guesses.
        if (lspCursor && !searchWorkspaceSymbols)
          throw new CursorInvalidError('the language server is unavailable');
        if (searchWorkspaceSymbols && (!cursor || lspCursor)) {
          try {
            const queryHash = queryHashOf({ kind: 'lsp-symbols', query });
            const previous = lspCursor
              ? lspCursors.take(cursor!.slice(4), { workspace: root, queryHash })
              : null;
            const hits = await searchWorkspaceSymbols(query, undefined, context.signal);
            context.signal.throwIfAborted();
            const sourceVersion = createHash('sha256').update(JSON.stringify(hits)).digest('hex');
            if (previous && previous.sourceVersion !== sourceVersion)
              throw new CursorInvalidError('language-server declarations changed');
            if (hits?.length || previous) {
              const start = previous ? (previous.after?.index ?? -1) + 1 : 0;
              const page = hits.slice(start, start + limit);
              const nextCursor =
                start + page.length < hits.length
                  ? 'lsp:' +
                    lspCursors.issue({
                      workspace: root,
                      queryHash,
                      sourceVersion,
                      after: { path: '', line: 0, index: start + page.length - 1 },
                      witness: null,
                    })
                  : null;
              return {
                isError: false,
                content: withRetrievalMetadata(
                  page
                    .map(
                      (hit) =>
                        `${hit.path}${hit.line === undefined ? '' : `:${hit.line}`} ${hit.kind} ${hit.container ? `${hit.container}.` : ''}${hit.name}`,
                    )
                    .join('\n'),
                  {
                    coverage: { complete: true, reasons: [], bytesRead: null },
                    sourceVersion,
                    nextCursor,
                    freshness: 'validated',
                  },
                ),
              };
            }
          } catch (error) {
            context.signal.throwIfAborted();
            if (lspCursor) {
              if (error instanceof CursorInvalidError) throw error;
              throw new CursorInvalidError(
                'the language server could not refresh its declarations',
              );
            }
            /* No running server, or it failed: fall through to the index, then to the heuristic scan. */
          }
        }
        /**
         * The index answers the whole declared scope.
         *
         * This is the change that matters for a large repository: the heuristic scan reads the first 32KiB of
         * the first 400 files, so a symbol in the body of a long file, or in any file past the four hundredth,
         * simply did not exist for this tool. The index is built from whole files.
         */
        if (index) {
          const page = await index.symbols({ query, limit, cursor, signal: context.signal });
          /**
           * A hit from a list that is not current still goes out — with the freshness beside it.
           *
           * The alternative is worse in both directions: withholding a hit the index does have is a worse answer
           * than a hit whose age is stated, and returning it silently would let a line number that moved read as
           * the current one. The metadata line carries the same value in machine-readable form.
           */
          const note =
            (page.freshness === 'validated'
              ? ''
              : `\n[symbol index: ${page.freshness}; this list may lag recent writes]`) +
            ((page.coverage as { complete?: boolean }).complete === false
              ? '\n[symbol analysis is incomplete; this list does not cover every source file]'
              : '');
          if (page.symbols.length)
            return {
              isError: false,
              content: withRetrievalMetadata(
                page.symbols
                  .map(
                    (symbol) => `${symbol.path}:${symbol.startLine} ${symbol.kind} ${symbol.name}`,
                  )
                  .join('\n') + note,
                {
                  coverage: page.coverage,
                  sourceVersion: page.sourceVersion,
                  nextCursor: page.nextCursor,
                  freshness: page.freshness,
                },
              ),
            };
          /**
           * A zero from an index that is not current is not a zero.
           *
           * This is the rule the whole round is about, applied to symbols: "no symbols match" may only be said
           * about a list that was checked against the files as they are. While one is being rebuilt, the honest
           * answer is that there is no answer yet.
           */
          if (page.freshness === 'building' || page.freshness === 'stale')
            return {
              isError: false,
              content: withRetrievalMetadata(
                `The symbol index is still being built, so no answer can be given for "${query}" yet. ` +
                  'Ask again in a moment; this is not evidence that the symbol does not exist.',
                {
                  coverage: page.coverage,
                  sourceVersion: page.sourceVersion,
                  nextCursor: null,
                  freshness: page.freshness,
                },
              ),
            };
          return {
            isError: false,
            content: withRetrievalMetadata(
              (page.coverage as { complete?: boolean }).complete === false
                ? `No symbols match "${query}" in the scanned portion; symbol analysis is incomplete.`
                : `No symbols match "${query}" in the indexed scope.`,
              {
                coverage: page.coverage,
                sourceVersion: page.sourceVersion,
                nextCursor: null,
                freshness: page.freshness,
              },
            ),
          };
        }
        const lowered = query.toLowerCase();
        const matches = buildRepoMap(root)
          .files.flatMap((file) =>
            file.symbols
              .filter((symbol) => symbol.name.toLowerCase().includes(lowered))
              .map((symbol) => `${file.path}:${symbol.line} ${symbol.kind} ${symbol.name}`),
          )
          .slice(0, limit);
        return {
          isError: false,
          content: matches.length
            ? matches.join('\n')
            : `No symbols match "${query}". Start a language server with lsp_start for an exact index.`,
        };
      },
    },
  ];
}
