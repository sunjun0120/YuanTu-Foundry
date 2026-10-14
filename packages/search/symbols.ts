/**
 * Whole-file symbol analysis: what a source file declares, imports and exports.
 *
 * The outline this replaces read the first 32 KiB of each file and skipped anything over 512 KiB, so a symbol
 * defined past the head of a long file simply did not exist as far as the agent was concerned — and neither did
 * any file past the four hundredth. Here the *whole* file is analysed, and the bounds that remain are stated:
 * a file over {@link MAX_SYMBOL_FILE_BYTES} is skipped as `skipped` rather than silently truncated, and a parse
 * that runs past its deadline is reported as partial.
 *
 * The analysis is line-anchored and dependency-free, and it says so: it is a heuristic, not a parser. TypeScript
 * is a development dependency of this repository, so an AST-based implementation would work in a test and be
 * missing from a packaged build — the honest move is the heuristic plus a record of what produced it, not an
 * import that only resolves in the checkout.
 */
// The compiler's *types* only. The runtime module is loaded dynamically below, because a packaged build may not
// carry it; this import is erased, and it exists so the AST walk can name the node types it visits.
import type * as TypeScript from 'typescript';
import { type FileEntry, type FileFingerprint, type SymbolRecord } from './types.ts';

/** Largest file a symbol pass will read. Above this the file is reported skipped, never half-read. */
export const MAX_SYMBOL_FILE_BYTES = 8 * 1024 * 1024;
/** How long one file's analysis may take. Exceeding it keeps whatever was found and marks the file partial. */
export const SYMBOL_PARSE_TIMEOUT_MS = 2_000;

interface OutlineRule {
  kind: string;
  pattern: RegExp;
}

/**
 * Line-anchored declarations per extension, deliberately shallow.
 *
 * Nested members and locals are not outlined: the point is "where does this live", and a map of every local
 * variable would be a worse answer to that question, not a better one.
 */
const OUTLINE_RULES: Record<string, OutlineRule[]> = {
  '.ts': [
    {
      kind: 'class',
      pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(?<name>[\w$]+)/,
    },
    { kind: 'interface', pattern: /^\s*(?:export\s+)?(?:default\s+)?interface\s+(?<name>[\w$]+)/ },
    { kind: 'type', pattern: /^\s*(?:export\s+)?type\s+(?<name>[\w$]+)/ },
    { kind: 'enum', pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+(?<name>[\w$]+)/ },
    {
      kind: 'function',
      pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(?<name>[\w$]+)/,
    },
    { kind: 'const', pattern: /^\s*export\s+(?:default\s+)?const\s+(?<name>[\w$]+)/ },
    { kind: 'namespace', pattern: /^\s*(?:export\s+)?(?:declare\s+)?namespace\s+(?<name>[\w$]+)/ },
  ],
  '.py': [
    { kind: 'class', pattern: /^class\s+(?<name>\w+)/ },
    { kind: 'function', pattern: /^(?:async\s+)?def\s+(?<name>\w+)/ },
  ],
  '.go': [
    { kind: 'function', pattern: /^func\s+(?:\([^)]*\)\s*)?(?<name>\w+)/ },
    { kind: 'type', pattern: /^type\s+(?<name>\w+)/ },
  ],
  '.rs': [
    { kind: 'function', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(?<name>\w+)/ },
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
  '.cpp': [{ kind: 'type', pattern: /^\s*(?:class|struct|enum)\s+(?<name>\w+)/ }],
};
for (const alias of ['.js', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts'])
  OUTLINE_RULES[alias] = OUTLINE_RULES['.ts']!;
OUTLINE_RULES['.hpp'] = OUTLINE_RULES['.cpp']!;
OUTLINE_RULES['.cc'] = OUTLINE_RULES['.cpp']!;
OUTLINE_RULES['.h'] = OUTLINE_RULES['.c']!;

/** Extensions this module can outline, mapped to the language name a record carries. */
const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'shell',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
};

/** The language of a path, or `undefined` when this module has no outline for it. */
export function languageOf(file: string): string | undefined {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  return LANGUAGES[extension];
}

/** True when a path is one this module can outline. */
export function isOutlineable(file: string): boolean {
  return languageOf(file) !== undefined;
}

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[\w$*{},\s]+?\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*from\s+([\w.$]+)\s+import\b/gm,
  /^\s*import\s+([\w.$]+)\s*$/gm,
  /^\s*use\s+([\w:]+)/gm,
];
const EXPORT_PATTERN =
  /^\s*export\s+(?:default\s+)?(?:abstract\s+|async\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+(?<name>[\w$]+)/;
const EXPORT_LIST_PATTERN = /^\s*export\s*\{([^}]*)\}/;

/** Module specifiers a file imports, in first-seen order. */
export function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) if (match[1]) found.push(match[1]);
  }
  return [...new Set(found)];
}

/** Names a file exports, in first-seen order. */
export function exportsOf(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split('\n')) {
    const named = EXPORT_PATTERN.exec(line);
    if (named?.groups?.name) {
      found.push(named.groups.name);
      continue;
    }
    const listed = EXPORT_LIST_PATTERN.exec(line);
    if (!listed?.[1]) continue;
    for (const piece of listed[1].split(',')) {
      const name = piece
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) found.push(name);
    }
  }
  return [...new Set(found)];
}

/**
 * Lines the declaration body spans, by brace counting from the declaration line.
 *
 * An estimate, and labelled as one: it is the brace matching a reader would do, which is right for the
 * overwhelming majority of code and never claims more than "this is where the block seems to end". A declaration
 * whose own line opens no block ends on that line — the `{` in the *next* line is a different statement's, which
 * is the mistake that turns `export const a = 1;` followed by `export { a };` into a two-line declaration.
 */
export function blockEnd(lines: readonly string[], start: number): number {
  if (!(lines[start] ?? '').includes('{')) return start + 1;
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    for (const char of line) {
      if (char === '{') {
        depth++;
        opened = true;
      } else if (char === '}') depth--;
    }
    if (opened && depth <= 0) return index + 1;
  }
  return start + 1;
}

/**
 * Analyses one file's text.
 *
 * `fingerprint` is copied onto every record so a reader can tell which version of the file a symbol came from
 * without a second stat, and so an index entry can be checked against the file it claims to describe.
 */
export function analyzeSymbols(
  source: string,
  path: string,
  language: string,
  fingerprint: FileFingerprint,
): SymbolRecord[] {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  const rules = OUTLINE_RULES[extension] ?? [];
  const lines = source.split('\n');
  const imports = importsOf(source);
  const exports = exportsOf(source);
  const symbols: SymbolRecord[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    for (const rule of rules) {
      const match = rule.pattern.exec(line);
      if (!match?.groups?.name) continue;
      symbols.push({
        path,
        name: match.groups.name,
        kind: rule.kind,
        startLine: index + 1,
        endLine: blockEnd(lines, index),
        language,
        imports,
        exports,
        fingerprint,
      });
      break;
    }
  }
  return symbols;
}

/** The record shape for a file that could not be analysed, kept so a caller can say why it is missing. */
export interface SkippedFile {
  path: string;
  reason: 'too-large' | 'unreadable' | 'unsupported';
}

/** True when a file is too large for a symbol pass. */
export function tooLarge(entry: Pick<FileEntry, 'fingerprint'>): boolean {
  return entry.fingerprint.size > MAX_SYMBOL_FILE_BYTES;
}

/** Which of the two analyses produced a file's records. Recorded so nothing claims to be an AST result. */
export type SymbolParser = 'ast' | 'heuristic';

/**
 * The TypeScript compiler, when this build can resolve it.
 *
 * The compiler is a runtime dependency and travels with packaged builds. Embedders with incomplete installations
 * still get a recorded heuristic result rather than taking `repo_map` down. Resolved once, cached; absent means the line-anchored
 * analysis runs instead, which is less exact about where a declaration *ends* and identical about what it is
 * called and where it starts. The packaged asset check separately requires the compiler to be present.
 */
type TypeScriptModule = typeof import('typescript');
let compiler: TypeScriptModule | null | undefined;

async function loadCompiler(): Promise<TypeScriptModule | null> {
  if (compiler !== undefined) return compiler;
  try {
    compiler = (await import('typescript')) as TypeScriptModule;
  } catch {
    compiler = null;
  }
  return compiler;
}

/** Analyses a file with the best parser this build has, and says which one that was. */
export async function analyzeSymbolsWithParser(
  source: string,
  path: string,
  language: string,
  fingerprint: FileFingerprint,
): Promise<{ symbols: SymbolRecord[]; parser: SymbolParser }> {
  if (language === 'typescript' || language === 'javascript') {
    const ts = await loadCompiler();
    if (ts) {
      try {
        return { symbols: astSymbols(ts, source, path, language, fingerprint), parser: 'ast' };
      } catch {
        // A file the compiler refuses is still a file the scanner can read; fall through rather than failing.
      }
    }
  }
  return { symbols: analyzeSymbols(source, path, language, fingerprint), parser: 'heuristic' };
}

/**
 * Declarations, imports and exports from the compiler's own syntax tree.
 *
 * The advantage over the line-anchored scan is exactly where a declaration *ends*: a function whose body closes
 * forty lines down, an interface with a multi-line member list, a `const` whose initialiser spans a call chain.
 * The brace counter guesses those from the text; the tree knows them, and a symbol's span is what a later reader
 * uses to decide whether a hit is inside it.
 *
 * Two passes: every import and export first, so each record carries the whole file's lists rather than whichever
 * of them happened to appear above it.
 */
function astSymbols(
  ts: TypeScriptModule,
  source: string,
  path: string,
  language: string,
  fingerprint: FileFingerprint,
): SymbolRecord[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  const exports = new Set<string>();
  const lineOf = (position: number): number =>
    file.getLineAndCharacterOfPosition(position).line + 1;
  const isExported = (node: { modifiers?: readonly { kind: number }[] }): boolean =>
    (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  const collectEdges = (node: TypeScript.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      imports.add(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imports.add(node.moduleSpecifier.text);
      if (node.exportClause && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements) exports.add(element.name.text);
    }
    ts.forEachChild(node, collectEdges);
  };
  collectEdges(file);

  const symbols: SymbolRecord[] = [];
  const record = (kind: string, name: string, node: TypeScript.Node, exported: boolean): void => {
    if (exported) exports.add(name);
    symbols.push({
      path,
      name,
      kind,
      startLine: lineOf(node.getStart(file)),
      endLine: lineOf(node.getEnd()),
      language,
      imports: [...imports],
      exports: [...exports],
      fingerprint,
    });
  };
  /**
   * Top-level declarations only, and that is the whole shape of the walk.
   *
   * `forEachChild` over the entire tree would also collect every local `const` inside every function body — an
   * outline that answers "where does this live" with a hundred answers per file, most of them a variable nobody
   * can reach. A namespace's own block is the one place worth descending into, because its members *are*
   * declarations at the level the outline describes.
   */
  const visitStatement = (node: TypeScript.Node): void => {
    const exported = isExported(node as { modifiers?: readonly { kind: number }[] });
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      if (node.name)
        record(ts.isClassDeclaration(node) ? 'class' : 'interface', node.name.text, node, exported);
    } else if (ts.isFunctionDeclaration(node)) {
      if (node.name) record('function', node.name.text, node, exported);
    } else if (ts.isEnumDeclaration(node)) {
      record('enum', node.name.text, node, exported);
    } else if (ts.isTypeAliasDeclaration(node)) {
      record('type', node.name.text, node, exported);
    } else if (ts.isModuleDeclaration(node)) {
      if (ts.isIdentifier(node.name)) record('namespace', node.name.text, node, exported);
      if (node.body && ts.isModuleBlock(node.body))
        for (const statement of node.body.statements) visitStatement(statement);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          // The statement's span, not the declarator's: the initialiser is part of what the declaration is.
          record('const', declaration.name.text, node, exported);
    }
  };
  for (const statement of file.statements) visitStatement(statement);
  /**
   * Back-filled, so every record carries the whole file's lists.
   *
   * `record` runs while the walk is still going, so a record made before a later `export` was seen would carry a
   * shorter list than the one made after it — the same file described two ways depending on where a declaration
   * sat. The lists are a property of the *file*, so they are written once, at the end, to every record.
   */
  for (const symbol of symbols) {
    symbol.imports = [...imports];
    symbol.exports = [...exports];
  }
  return symbols;
}
