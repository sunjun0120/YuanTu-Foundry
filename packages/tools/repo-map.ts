import { readdirSync, readSync, openSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolContext } from '../protocol/index.ts';

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
  return IGNORED_DIRECTORIES.has(name) || name.startsWith('.env');
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
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const perFile = options.symbolsPerFile ?? DEFAULT_SYMBOLS_PER_FILE;
  const files: RepoFile[] = [];
  let scannedFiles = 0;
  let truncated = false;
  const walk = (directory: string, relative: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || isIgnored(entry.name)) continue;
      const child = path.join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child, childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      const rules = OUTLINE_RULES[path.extname(entry.name).toLowerCase()];
      if (!rules) continue;
      if (scannedFiles >= maxFiles) {
        truncated = true;
        return;
      }
      scannedFiles++;
      const head = readHead(child);
      if (head === null) continue;
      const symbols = outline(head, rules, perFile);
      if (symbols.length) files.push({ path: childRelative, symbols });
    }
  };
  walk(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, scannedFiles, truncated };
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
 * changes, so the result is memoised against a cheap fingerprint: the newest mtime and the file count of the
 * directories involved. That memo is what makes it affordable to ask once per round — which is what the caller
 * does, since the outline is announced into the conversation rather than placed in the system prompt
 * (`packages/core/runtime-context.ts`) and the announcement has to notice the round that changed the tree.
 * `YUANTU_REPO_MAP=off` disables it entirely for callers that would rather spend those tokens elsewhere.
 */
const cache = new Map<string, { key: string; text: string }>();
export function repoMapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YUANTU_REPO_MAP !== 'off';
}
export function repoMapContext(root: string, budgetChars = REPO_MAP_PROMPT_BUDGET): string {
  if (!repoMapEnabled()) return '';
  const key = repoMapFingerprint(root);
  const cached = cache.get(root);
  if (cached && cached.key === key) return cached.text;
  const text = formatRepoMap(buildRepoMap(root), budgetChars);
  cache.set(root, { key, text });
  return text;
}
export function resetRepoMapCache(): void {
  cache.clear();
}
/** A cheap "has the tree changed" signal: newest mtime over the top two directory levels. */
function repoMapFingerprint(root: string): string {
  let newest = 0;
  let count = 0;
  const visit = (directory: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      count++;
      try {
        newest = Math.max(newest, statSync(path.join(directory, entry.name)).mtimeMs);
      } catch {
        /* A file that vanished mid-walk still changes the fingerprint via the count. */
      }
      if (depth < 2 && entry.isDirectory() && !entry.isSymbolicLink())
        visit(path.join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return `${count}:${newest}`;
}

/** Symbol search backed by an already-running language server, when one exists. */
export type WorkspaceSymbolSearch = (
  query: string,
  language: string | undefined,
  signal: AbortSignal,
) => Promise<{ path: string; line?: number; kind: string; name: string; container?: string }[]>;

export function repoMapTools(root: string, searchWorkspaceSymbols?: WorkspaceSymbolSearch): Tool[] {
  return [
    {
      name: 'repo_map',
      isConcurrencySafe: parallelRead,
      description:
        'Structural outline of the workspace: every source file and the symbols it declares. Use it to find where something lives before reading files. Pass query to search symbol names; when a language server is already running the search uses its index instead of a text scan.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(args: Record<string, unknown>, context: ToolContext) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const limit =
          typeof args.limit === 'number' && Number.isSafeInteger(args.limit) ? args.limit : 60;
        if (!query) {
          const text = formatRepoMap(buildRepoMap(root), 8_000);
          return {
            isError: false,
            content: text || 'No outlineable source files found',
          };
        }
        context.signal.throwIfAborted();
        // Prefer the language server: it reports real declarations, not regex guesses.
        if (searchWorkspaceSymbols) {
          try {
            const hits = await searchWorkspaceSymbols(query, undefined, context.signal);
            if (hits?.length)
              return {
                isError: false,
                content: hits
                  .slice(0, limit)
                  .map(
                    (hit) =>
                      `${hit.path}${hit.line === undefined ? '' : `:${hit.line}`} ${hit.kind} ${hit.container ? `${hit.container}.` : ''}${hit.name}`,
                  )
                  .join('\n'),
              };
          } catch {
            /* No running server, or it failed: fall through to the heuristic index. */
          }
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
