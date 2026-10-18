/** Argument schemas, response normalisers and prepare steps shared by the language-server tools. */
import path from 'node:path';
import type { FileChange, FileSnapshot, PreparedTool, ToolContext } from '../protocol/index.ts';
import {
  filePreview,
  groupedPreview,
  prepareMutation,
  readMutationBytes,
} from '../tools/file-mutation.ts';
import { Workspace } from '../tools/files.ts';
import { DIAGNOSTIC_TIMEOUT_MS, type LspClient, type LspDiagnostic } from './client.ts';
import type { LspManager } from './manager.ts';
import {
  applyTextEdits,
  pathToUri,
  toDisplayRange,
  toProtocolPosition,
  uriToPath,
  type LspPosition,
  type LspRange,
} from './protocol.ts';
import { resolveServerCommand } from './servers.ts';

export const AFTER_EDIT_TIMEOUT_MS = 1_500;
export const MAX_RESULTS = 50;
const MAX_SYMBOLS = 200;
export const MAX_FILES_PER_CALL = 20;

const SYMBOL_KINDS = [
  'file',
  'module',
  'namespace',
  'package',
  'class',
  'method',
  'property',
  'field',
  'constructor',
  'enum',
  'interface',
  'function',
  'variable',
  'constant',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'key',
  'null',
  'enumMember',
  'struct',
  'event',
  'operator',
  'typeParameter',
] as const;

export const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 } as const;
export const positionProperties = {
  path: pathSchema,
  line: { type: 'integer', minimum: 1 },
  character: { type: 'integer', minimum: 1 },
} as const;
export const positionRequired = ['path', 'line', 'character'];
export const POSITION_NOTE =
  'line is 1-based and matches the numbers read_file prints; character is a 1-based UTF-16 code-unit offset within that line.';

export function severityFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const severity = String(value);
  if (!['error', 'warning', 'information', 'hint'].includes(severity))
    throw new Error('severity must be error, warning, information or hint');
  return severity;
}
export function limitOf(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
    throw new Error(`limit must be an integer from 1 to ${max}`);
  return limit;
}
export function timeoutOf(value: unknown, fallback = DIAGNOSTIC_TIMEOUT_MS): number {
  if (value === undefined) return fallback;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10_000)
    throw new Error('timeout_ms must be an integer from 100 to 10000');
  return timeout;
}
export function formatDiagnostic(diagnostic: LspDiagnostic): string {
  const code = diagnostic.code ? ` [${diagnostic.code}]` : '';
  const source = diagnostic.source ? ` (${diagnostic.source})` : '';
  return `${diagnostic.line}:${diagnostic.character} ${diagnostic.severity}${code}${source} ${diagnostic.message}`;
}
export async function requireClient(manager: LspManager, file: string): Promise<LspClient> {
  const client = await manager.runningForFile(file);
  if (!client)
    throw new Error(
      'No running language server handles this file; call lsp_start with the matching language first',
    );
  return client;
}
export async function preparePosition(
  manager: LspManager,
  workspace: Workspace,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{ file: string; client: LspClient; position: { line: number; character: number } }> {
  const file = await workspace.resolve(String(args.path));
  const client = await requireClient(manager, file);
  const position = toProtocolPosition(args.line, args.character);
  context.signal.throwIfAborted();
  await client.sync(file, context.signal);
  return { file, client, position };
}

interface NormalizedLocation {
  path: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}
export function normalizeLocations(result: unknown, root: string): NormalizedLocation[] {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  const locations: NormalizedLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const value = item as {
      uri?: string;
      range?: LspRange;
      targetUri?: string;
      targetSelectionRange?: LspRange;
      targetRange?: LspRange;
    };
    const uri = value.uri ?? value.targetUri;
    const range = value.range ?? value.targetSelectionRange ?? value.targetRange;
    if (typeof uri !== 'string' || !range?.start) continue;
    const file = uriToPath(uri);
    if (!file) continue;
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    locations.push({
      path: relative.split(path.sep).join('/'),
      ...toDisplayRange({
        start: range.start,
        end: range.end ?? range.start,
      }),
    });
    if (locations.length >= MAX_RESULTS) break;
  }
  return locations;
}
export function hoverText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const contents = (result as { contents?: unknown }).contents;
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string') parts.push(value);
    else if (value && typeof value === 'object' && 'value' in value)
      parts.push(String((value as { value?: unknown }).value ?? ''));
  };
  if (Array.isArray(contents)) contents.forEach(push);
  else push(contents);
  return parts.join('\n').trim().slice(0, 4_000);
}
interface FlatSymbol {
  name: string;
  kind: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  container?: string;
}
export function flattenSymbols(result: unknown, depth = 0, container?: string): FlatSymbol[] {
  if (!Array.isArray(result) || depth > 8) return [];
  const symbols: FlatSymbol[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const value = item as {
      name?: string;
      kind?: number;
      range?: LspRange;
      selectionRange?: LspRange;
      location?: { range?: LspRange };
      children?: unknown[];
      containerName?: string;
    };
    // selectionRange points at the identifier itself, which is where a caller wants to land.
    const range = value.selectionRange ?? value.range ?? value.location?.range;
    if (typeof value.name !== 'string' || !range?.start) continue;
    symbols.push({
      name: value.name,
      kind: SYMBOL_KINDS[Number(value.kind) - 1] ?? 'unknown',
      ...toDisplayRange({ start: range.start, end: range.end ?? range.start }),
      ...((container ?? value.containerName)
        ? { container: container ?? String(value.containerName) }
        : {}),
    });
    if (symbols.length >= MAX_SYMBOLS) break;
    if (Array.isArray(value.children))
      symbols.push(...flattenSymbols(value.children, depth + 1, value.name));
    if (symbols.length >= MAX_SYMBOLS) break;
  }
  return symbols.slice(0, MAX_SYMBOLS);
}
function normalizeEdits(edits: unknown[]): { range: LspRange; newText: string }[] {
  return edits.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as { range?: LspRange; newText?: unknown };
    if (!value.range?.start || typeof value.newText !== 'string') return [];
    return [{ range: value.range, newText: value.newText }];
  });
}
function collectEdits(
  result: unknown,
): { uri: string; edits: { range: LspRange; newText: string }[] }[] {
  if (!result || typeof result !== 'object') return [];
  const value = result as { changes?: Record<string, unknown>; documentChanges?: unknown[] };
  const collected: { uri: string; edits: { range: LspRange; newText: string }[] }[] = [];
  if (Array.isArray(value.documentChanges))
    for (const item of value.documentChanges) {
      const entry = item as { textDocument?: { uri?: string }; edits?: unknown };
      if (typeof entry?.textDocument?.uri === 'string' && Array.isArray(entry.edits)) {
        const edits = normalizeEdits(entry.edits);
        if (edits.length) collected.push({ uri: entry.textDocument.uri, edits });
      }
    }
  if (!collected.length && value.changes && typeof value.changes === 'object')
    for (const [uri, edits] of Object.entries(value.changes))
      if (Array.isArray(edits)) {
        const normalized = normalizeEdits(edits);
        if (normalized.length) collected.push({ uri, edits: normalized });
      }
  return collected;
}

/**
 * The file-level operations a `WorkspaceEdit` may ask for, which this tool does not perform.
 *
 * A `WorkspaceEdit` is a union: `TextDocumentEdit`s, which `collectEdits` above reads, and *resource
 * operations* — `create`, `rename`, `delete` of whole files — which carry a `kind` instead of a
 * `textDocument`. Only the first kind is applied here, and that makes the second kind dangerous rather than
 * merely unsupported: applying a rename's text edits while dropping the move itself leaves the workspace in a
 * state nobody asked for, and the caller is told the rename succeeded. So an edit that asks for one is
 * refused whole.
 */
function resourceOperations(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const changes = (result as { documentChanges?: unknown[] }).documentChanges;
  if (!Array.isArray(changes)) return [];
  const asked = new Set<string>();
  for (const item of changes) {
    const kind = (item as { kind?: unknown } | null)?.kind;
    if (kind === 'create' || kind === 'rename' || kind === 'delete') asked.add(kind);
  }
  return [...asked];
}

/**
 * Turn a server `WorkspaceEdit` into one atomic, journaled, approval-previewed
 * mutation. Every target must resolve inside the workspace and the new contents
 * are computed in memory before anything is written, so a server cannot reach
 * outside the workspace or leave a half-applied edit.
 */
async function prepareWorkspaceEdit(
  workspace: Workspace,
  client: LspClient,
  result: unknown,
  options: { missing: string; outside: string; approval: (files: string[]) => string[] },
): Promise<PreparedTool> {
  const refused = resourceOperations(result);
  if (refused.length)
    throw new Error(
      `The language server's edit also asks to ${refused.join(', ')} a file, and only text edits can be applied here, so nothing was changed. Make the file change with the file tools and ask again.`,
    );
  const edits = collectEdits(result);
  if (!edits.length) throw new Error(options.missing);
  const previews: FileChange[] = [];
  const snapshots: FileSnapshot[] = [];
  for (const entry of edits) {
    const target = uriToPath(entry.uri);
    if (!target) throw new Error(`Unsupported edit target: ${entry.uri}`);
    const relative = path.relative(workspace.root, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(options.outside);
    /**
     * Resolved through the workspace, not merely compared to it.
     *
     * `path.relative` above answers a question about the *string* the server sent, and a server that names a
     * symlink living inside the workspace — pointing at a file elsewhere — passed that test while the read below
     * opened the file the link named. The contents then went into the approval preview, so what leaked was a file
     * the operator never granted. `Workspace.resolve` refuses every symbolic link, in-root ones included, and
     * re-checks the canonical path, so the answer is about the file that will actually be read. A link swapped in
     * after this point is still caught by the post-approval byte recheck inside `prepareMutation`.
     */
    try {
      await workspace.resolve(target);
    } catch (error) {
      throw new Error(`${options.outside}: ${(error as Error).message}`);
    }
    const before = await readMutationBytes(target);
    const source = before.toString('utf8');
    const after = Buffer.from(applyTextEdits(source, entry.edits));
    if (after.equals(before)) continue;
    const key = relative.split(path.sep).join('/');
    previews.push(filePreview(key, source, after.toString('utf8'), 'edit'));
    snapshots.push({ path: key, before, after });
  }
  if (!snapshots.length) throw new Error(options.missing);
  const change = groupedPreview('batch', previews);
  // No change gates here, deliberately: this edit was computed by the language server against the documents it is
  // serving, so it is not the model's memory of a file — the read-before-write policy (see
  // `packages/tools/fs-observation.ts`) has nothing to check. The approval prompt and the post-approval byte
  // recheck inside `prepareMutation` still apply.
  const mutation = prepareMutation(workspace, change, snapshots);
  return {
    change,
    approvalDescription: options.approval(snapshots.map((snapshot) => snapshot.path)).join('\n'),
    async execute(ctx: ToolContext) {
      const applied = await mutation.execute(ctx);
      // The server's copy of these documents is now stale.
      for (const snapshot of snapshots)
        await client
          .refreshDocument(path.join(workspace.root, snapshot.path), ctx.signal)
          .catch(() => undefined);
      return applied;
    },
  };
}

interface CodeActionEntry {
  index: number;
  title: string;
  kind: string;
  preferred: boolean;
  disabled: boolean;
  hasEdit: boolean;
  hasCommand: boolean;
  edit?: unknown;
}

/**
 * A position, plus an optional explicit end. A zero-width range is legal and is
 * what most quick fixes expect, since the server matches the diagnostics it was
 * given rather than the range alone.
 */
function resolveRange(args: Record<string, unknown>): { start: LspPosition; end: LspPosition } {
  const start = toProtocolPosition(args.line, args.character);
  if (args.end_line === undefined) return { start, end: start };
  return { start, end: toProtocolPosition(args.end_line, args.end_character ?? args.character) };
}

/** Diagnostics the server needs in order to compute quick fixes for this range. */
function diagnosticsInRange(
  diagnostics: readonly LspDiagnostic[],
  range: { start: LspPosition; end: LspPosition },
): unknown[] {
  const display = toDisplayRange(range);
  return diagnostics
    .filter(
      (diagnostic) => diagnostic.line <= display.endLine && diagnostic.endLine >= display.line,
    )
    .slice(0, 50)
    .map((diagnostic) => ({
      range: {
        start: { line: diagnostic.line - 1, character: diagnostic.character - 1 },
        end: { line: diagnostic.endLine - 1, character: diagnostic.endCharacter - 1 },
      },
      message: diagnostic.message,
      ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
      ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
    }));
}

function parseCodeActions(result: unknown): CodeActionEntry[] {
  if (!Array.isArray(result)) return [];
  const actions: CodeActionEntry[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const value = item as {
      title?: unknown;
      kind?: unknown;
      edit?: unknown;
      command?: unknown;
      isPreferred?: unknown;
      disabled?: unknown;
    };
    if (typeof value.title !== 'string') continue;
    actions.push({
      index: actions.length + 1,
      title: value.title,
      kind: typeof value.kind === 'string' ? value.kind : '',
      preferred: value.isPreferred === true,
      disabled: value.disabled !== undefined && value.disabled !== null,
      hasEdit: value.edit !== undefined && value.edit !== null,
      hasCommand: value.command !== undefined && value.command !== null,
      ...(value.edit === undefined ? {} : { edit: value.edit }),
    });
  }
  return actions;
}

export async function requestCodeActions(
  client: LspClient,
  file: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CodeActionEntry[]> {
  const range = resolveRange(args);
  const context: Record<string, unknown> = {
    diagnostics: diagnosticsInRange(client.cachedDiagnostics(file), range),
  };
  if (args.kind !== undefined) context.only = [String(args.kind)];
  const result = await client.send(
    'textDocument/codeAction',
    { textDocument: { uri: pathToUri(file) }, range, context },
    signal,
  );
  return parseCodeActions(result);
}

export async function prepareApplyCodeAction(
  manager: LspManager,
  workspace: Workspace,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PreparedTool> {
  const index = Number(args.index);
  if (!Number.isSafeInteger(index) || index < 1)
    throw new Error('index must be the 1-based number reported by lsp_code_action');
  const file = await workspace.resolve(String(args.path));
  const client = await requireClient(manager, file);
  context.signal.throwIfAborted();
  // Settle diagnostics first: quick fixes are computed from them.
  await client.diagnostics(file, context.signal, DIAGNOSTIC_TIMEOUT_MS);
  const actions = await requestCodeActions(client, file, args, context.signal);
  const action = actions.find((entry) => entry.index === index);
  if (!action)
    throw new Error(
      `The language server offered ${actions.length} code action(s) here; index ${index} is out of range. Run lsp_code_action again.`,
    );
  if (action.disabled) throw new Error(`Code action "${action.title}" is disabled by the server`);
  if (!action.hasEdit)
    throw new Error(
      action.hasCommand
        ? `Code action "${action.title}" only carries a server command. Running server commands is not supported, so it cannot be applied.`
        : `Code action "${action.title}" carries no inline edit, so it cannot be applied.`,
    );
  return prepareWorkspaceEdit(workspace, client, action.edit, {
    missing: `Code action "${action.title}" produced no effective edits`,
    outside: 'This code action would modify files outside the workspace',
    approval: (files) => [
      `Apply code action: ${action.title}${action.kind ? ` (${action.kind})` : ''}`,
      `Files (${files.length}): ${files.join(', ')}`,
      'Applied atomically through the file journal, so it can be undone.',
    ],
  });
}

export interface WorkspaceSymbolEntry {
  path: string;
  line?: number;
  character?: number;
  kind: string;
  name: string;
  container?: string;
}

/**
 * Shared with the repo-map so both surfaces parse `workspace/symbol` identically. `root` scopes the
 * results, and entries outside it are dropped rather than leaking absolute paths.
 */
export function parseWorkspaceSymbols(
  result: unknown,
  root: string,
  limit: number,
): WorkspaceSymbolEntry[] {
  if (!Array.isArray(result)) return [];
  const symbols: WorkspaceSymbolEntry[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const value = item as {
      name?: unknown;
      kind?: unknown;
      containerName?: unknown;
      location?: { uri?: unknown; range?: LspRange };
    };
    if (typeof value.name !== 'string') continue;
    const uri = value.location?.uri;
    if (typeof uri !== 'string') continue;
    const file = uriToPath(uri);
    if (!file) continue;
    const relative = path.relative(root, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const range = value.location?.range;
    const position = range?.start ? toDisplayRange(range) : undefined;
    symbols.push({
      path: relative.split(path.sep).join('/'),
      ...(position ? { line: position.line, character: position.character } : {}),
      kind: SYMBOL_KINDS[Number(value.kind) - 1] ?? 'unknown',
      name: value.name,
      ...(typeof value.containerName === 'string' && value.containerName
        ? { container: value.containerName }
        : {}),
    });
    if (symbols.length >= limit) break;
  }
  return symbols.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
}

/** Which running server should answer a workspace-wide query. */
export function clientForWorkspace(manager: LspManager, language: unknown): LspClient {
  const running = manager.runningLanguages();
  if (!running.length) throw new Error('No language server is running; call lsp_start first');
  if (language !== undefined) {
    const requested = String(language);
    const client = manager.running(requested);
    if (!client)
      throw new Error(
        `No running language server for "${requested}"; running: ${running.join(', ')}`,
      );
    return client;
  }
  if (running.length > 1)
    throw new Error(
      `Several language servers are running (${running.join(', ')}); pass language to choose one`,
    );
  return manager.running(running[0]!)!;
}

export async function prepareStart(
  manager: LspManager,
  root: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PreparedTool> {
  const language = String(args.language ?? '').trim();
  if (!language) throw new Error('language must not be empty');
  const definition = await manager.definitionFor(language);
  if (!definition)
    throw new Error(
      `No language server is configured for "${language}"; declare one in .yuantu/lsp.json`,
    );
  const resolved = await resolveServerCommand(root, definition);
  if (!resolved)
    throw new Error(
      `"${definition.command}" was not found in node_modules/.bin or on PATH for ${language}.` +
        (definition.install ? ` Install it with: ${definition.install}` : ''),
    );
  context.signal.throwIfAborted();
  return {
    approvalDescription: [
      `Start the ${language} language server`,
      `Runs: ${resolved.command} ${resolved.args.join(' ')}`.trim(),
      `Resolved from: ${resolved.via}`,
      `Working directory: ${root}`,
      ...(definition.notes ? [`Cost: ${definition.notes}`] : []),
      'The server uses this call’s host or Windows execution backend and workspace identity. Windows limits writes partially; reads and network remain unrestricted. Containers are unsupported.',
    ].join('\n'),
    async execute(ctx: ToolContext) {
      const client = await manager.start(language, ctx.signal);
      return {
        isError: false,
        content: JSON.stringify({
          language,
          running: client.running,
          command: definition.command,
        }),
      };
    },
  };
}

export async function prepareRename(
  manager: LspManager,
  workspace: Workspace,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PreparedTool> {
  const newName = String(args.new_name ?? '').trim();
  if (!newName) throw new Error('new_name must not be empty');
  if (newName.length > 200) throw new Error('new_name must be at most 200 characters');
  if (/[\s\0]/.test(newName)) throw new Error('new_name must be a single identifier');
  const file = await workspace.resolve(String(args.path));
  const client = await requireClient(manager, file);
  const position = toProtocolPosition(args.line, args.character);
  context.signal.throwIfAborted();
  await client.diagnostics(file, context.signal, DIAGNOSTIC_TIMEOUT_MS);
  const result = await client.send(
    'textDocument/rename',
    { textDocument: { uri: pathToUri(file) }, position, newName },
    context.signal,
  );
  return prepareWorkspaceEdit(workspace, client, result, {
    missing: 'The language server returned no effective edits for this rename',
    outside: 'Rename would modify files outside the workspace',
    approval: (files) => [
      `Rename to "${newName}" across ${files.length} file(s): ${files.join(', ')}`,
      'Applied atomically through the file journal, so it can be undone.',
    ],
  });
}

/** Append a bounded diagnostics summary after a mutation, but never fail the edit. */
