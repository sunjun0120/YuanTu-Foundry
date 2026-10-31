import path from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../protocol/index.ts';
import { Workspace } from '../tools/files.ts';
import { bounded } from '../tools/registry.ts';
import { DIAGNOSTIC_TIMEOUT_MS, type LspDiagnostic } from './client.ts';
import type { LspManager } from './manager.ts';
import { pathToUri } from './protocol.ts';
import {
  AFTER_EDIT_TIMEOUT_MS,
  MAX_FILES_PER_CALL,
  MAX_RESULTS,
  POSITION_NOTE,
  clientForWorkspace,
  flattenSymbols,
  formatDiagnostic,
  hoverText,
  limitOf,
  normalizeLocations,
  parseWorkspaceSymbols,
  pathSchema,
  positionProperties,
  positionRequired,
  prepareApplyCodeAction,
  preparePosition,
  prepareRename,
  prepareStart,
  requestCodeActions,
  requireClient,
  severityFilter,
  timeoutOf,
} from './tool-support.ts';
export { parseWorkspaceSymbols } from './tool-support.ts';
export type { WorkspaceSymbolEntry } from './tool-support.ts';

async function annotate(
  manager: LspManager,
  root: string,
  result: ToolResult,
  context: ToolContext,
): Promise<ToolResult> {
  if (result.isError || context.signal.aborted) return result;
  const change = result.change;
  const paths = change?.changes?.length
    ? change.changes.map((item) => item.path)
    : change && change.kind !== 'delete' && change.path
      ? [change.path]
      : [];
  if (!paths.length) return result;
  const lines: string[] = [];
  try {
    for (const relative of paths.slice(0, 3)) {
      const absolute = path.join(root, relative);
      const client = await manager.runningForFile(absolute);
      if (!client) continue;
      const diagnostics = await client.diagnostics(absolute, context.signal, AFTER_EDIT_TIMEOUT_MS);
      const relevant = diagnostics.diagnostics
        .filter((item) => item.severity === 'error' || item.severity === 'warning')
        .slice(0, 10);
      if (!relevant.length) {
        /**
         * "No errors or warnings" is a conclusion, and it needs the analysis to have finished.
         *
         * A server publishes diagnostics after it has parsed the file, so an empty list while `settled` is
         * false means "nothing yet", not "nothing wrong". Saying the former in the latter's place gave an edit
         * a clean bill of health the server had not issued.
         */
        lines.push(
          diagnostics.settled
            ? `${relative}: no errors or warnings`
            : `${relative}: no diagnostics yet (the language server has not finished analysing)`,
        );
        continue;
      }
      lines.push(`${relative}:`);
      for (const item of relevant) lines.push(`  ${formatDiagnostic(item)}`);
      if (!diagnostics.settled) lines.push('  (the language server has not finished analysing)');
    }
  } catch {
    return result;
  }
  if (!lines.length) return result;
  return {
    ...result,
    content: bounded(`${result.content}\nLanguage server diagnostics:\n${lines.join('\n')}`),
  };
}

/**
 * Wrap a mutating file tool so its result carries fresh diagnostics. Editing
 * never starts a server: when none is running this is a no-op.
 */
export function attachDiagnostics(tool: Tool, manager: LspManager, root: string): Tool {
  const originalPrepare = tool.prepare;
  return {
    ...tool,
    ...(originalPrepare
      ? {
          prepare: async (args: Record<string, unknown>, context: ToolContext) => {
            const prepared = await originalPrepare(args, context);
            return {
              ...prepared,
              execute: async (ctx: ToolContext) =>
                annotate(manager, root, await prepared.execute(ctx), ctx),
            };
          },
        }
      : {}),
    execute: async (args: Record<string, unknown>, context: ToolContext) =>
      annotate(manager, root, await tool.execute(args, context), context),
  };
}

export function lspTools(
  root: string,
  manager: LspManager,
): { tools: Tool[]; close: () => Promise<void> } {
  const workspace = new Workspace(root);
  const tools: Tool[] = [
    {
      name: 'lsp_servers',
      description:
        'List configured servers: command, extensions, whether the executable was found and whether it runs. available means only that the command was found, not that the server starts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const status = await manager.status();
        return { isError: false, content: bounded(JSON.stringify(status, null, 2)) };
      },
    },
    {
      name: 'lsp_start',
      permission: 'command',
      description:
        'Start the language server for one language through this call’s host or Windows backend. The resolved executable and arguments are shown before approval. Containers are unsupported; a running server keeps its creation policy.',
      inputSchema: {
        type: 'object',
        properties: { language: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['language'],
        additionalProperties: false,
      },
      prepare: (args, context) => prepareStart(manager, root, args, context),
      async execute(args, context) {
        return (await prepareStart(manager, root, args, context)).execute(context);
      },
    },
    {
      name: 'lsp_stop',
      description: 'Stop a running language server and release its process.',
      inputSchema: {
        type: 'object',
        properties: { language: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['language'],
        additionalProperties: false,
      },
      async execute(args) {
        const stopped = await manager.stop(String(args.language ?? '').trim());
        return { isError: false, content: JSON.stringify({ stopped }) };
      },
    },
    {
      name: 'lsp_diagnostics',
      description:
        'Current compiler or linter diagnostics. Pass paths to synchronise and wait for those files; omit them for everything published so far.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: pathSchema,
            maxItems: MAX_FILES_PER_CALL,
          },
          severity: { type: 'string', enum: ['error', 'warning', 'information', 'hint'] },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          timeout_ms: { type: 'integer', minimum: 100, maximum: 10000 },
        },
        additionalProperties: false,
      },
      async execute(args, context) {
        const severity = severityFilter(args.severity);
        const limit = limitOf(args.limit, 100, 200);
        const timeoutMs = timeoutOf(args.timeout_ms);
        const inputs = Array.isArray(args.paths) ? args.paths.map(String) : [];
        const collected: LspDiagnostic[] = [];
        const notes: string[] = [];
        if (inputs.length) {
          for (const input of inputs.slice(0, MAX_FILES_PER_CALL)) {
            const file = await workspace.resolve(input);
            const client = await manager.runningForFile(file);
            if (!client) {
              notes.push(`${input}: no running language server handles this file`);
              continue;
            }
            const result = await client.diagnostics(file, context.signal, timeoutMs);
            if (!result.settled) notes.push(`${input}: the server has not published yet`);
            collected.push(...result.diagnostics);
          }
        } else {
          for (const language of manager.runningLanguages()) {
            const client = manager.running(language);
            if (client) collected.push(...client.allDiagnostics());
          }
          if (!manager.runningLanguages().length)
            notes.push('No language server is running; call lsp_start first');
        }
        const filtered = collected
          .filter((item) => !severity || item.severity === severity)
          .slice(0, limit);
        const byPath = new Map<string, LspDiagnostic[]>();
        for (const item of filtered) {
          const relative = path.relative(root, item.path);
          const key = relative.startsWith('..') ? item.path : relative.split(path.sep).join('/');
          byPath.set(key, [...(byPath.get(key) ?? []), item]);
        }
        const body = [...byPath.entries()]
          .map(
            ([file, items]) =>
              `${file}:\n${items.map((i) => `  ${formatDiagnostic(i)}`).join('\n')}`,
          )
          .join('\n');
        return {
          isError: notes.length > 0,
          content: bounded(
            [
              body ||
                (notes.length
                  ? 'Diagnostics were not fully checked'
                  : inputs.length
                    ? 'No diagnostics'
                    : 'No cached diagnostics'),
              notes.length ? `Notes:\n${notes.map((note) => `  ${note}`).join('\n')}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        };
      },
    },
    {
      name: 'lsp_definition',
      description: `Jump to the definition of the symbol at a position in a file. ${POSITION_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: positionProperties,
        required: positionRequired,
        additionalProperties: false,
      },
      async execute(args, context) {
        const { file, client, position } = await preparePosition(manager, workspace, args, context);
        const result = await client.send(
          'textDocument/definition',
          { textDocument: { uri: pathToUri(file) }, position },
          context.signal,
        );
        const locations = normalizeLocations(result, root);
        return {
          isError: false,
          content: bounded(
            locations.length ? JSON.stringify(locations, null, 2) : 'No definition found',
          ),
        };
      },
    },
    {
      name: 'lsp_references',
      description: `Find references to the symbol at a position in a file, including its declaration. ${POSITION_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { ...positionProperties, limit: { type: 'integer', minimum: 1, maximum: 50 } },
        required: positionRequired,
        additionalProperties: false,
      },
      async execute(args, context) {
        const limit = limitOf(args.limit, MAX_RESULTS, MAX_RESULTS);
        const { file, client, position } = await preparePosition(manager, workspace, args, context);
        const result = await client.send(
          'textDocument/references',
          {
            textDocument: { uri: pathToUri(file) },
            position,
            context: { includeDeclaration: true },
          },
          context.signal,
        );
        const locations = normalizeLocations(result, root).slice(0, limit);
        return {
          isError: false,
          content: bounded(
            locations.length ? JSON.stringify(locations, null, 2) : 'No references found',
          ),
        };
      },
    },
    {
      name: 'lsp_hover',
      description: `The type signature or documentation at a position. ${POSITION_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: positionProperties,
        required: positionRequired,
        additionalProperties: false,
      },
      async execute(args, context) {
        const { file, client, position } = await preparePosition(manager, workspace, args, context);
        const result = await client.send(
          'textDocument/hover',
          { textDocument: { uri: pathToUri(file) }, position },
          context.signal,
        );
        const text = hoverText(result);
        return { isError: false, content: bounded(text || 'No hover information') };
      },
    },
    {
      name: 'lsp_symbols',
      description: 'List the symbols declared in one file, with 1-based positions and their kind.',
      inputSchema: {
        type: 'object',
        properties: { path: pathSchema },
        required: ['path'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const file = await workspace.resolve(String(args.path));
        const client = await requireClient(manager, file);
        await client.sync(file, context.signal);
        const result = await client.send(
          'textDocument/documentSymbol',
          { textDocument: { uri: pathToUri(file) } },
          context.signal,
        );
        const symbols = flattenSymbols(result);
        return {
          isError: false,
          content: bounded(
            symbols.length
              ? symbols
                  .map(
                    (symbol) =>
                      `${symbol.line}:${symbol.character} ${symbol.kind} ${symbol.container ? `${symbol.container}.` : ''}${symbol.name}`,
                  )
                  .join('\n')
              : 'No symbols found',
          ),
        };
      },
    },
    {
      name: 'lsp_rename',
      permission: 'write',
      description: `Rename a symbol across the workspace using the language server. Every affected file is shown in the approval, written atomically and recorded in the file journal so it can be undone. ${POSITION_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          ...positionProperties,
          new_name: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: [...positionRequired, 'new_name'],
        additionalProperties: false,
      },
      prepare: (args, context) => prepareRename(manager, workspace, args, context),
      async execute(args, context) {
        return (await prepareRename(manager, workspace, args, context)).execute(context);
      },
    },
    {
      name: 'lsp_code_action',
      description: `Quick fixes, refactors and source actions at a position, numbered; apply one with lsp_edit (action "apply_code_action"). Command-only actions cannot be applied. ${POSITION_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          ...positionProperties,
          end_line: { type: 'integer', minimum: 1 },
          end_character: { type: 'integer', minimum: 1 },
          kind: {
            type: 'string',
            maxLength: 64,
            description: 'Restrict to one kind, for example quickfix or source.organizeImports.',
          },
        },
        required: positionRequired,
        additionalProperties: false,
      },
      async execute(args, context) {
        const file = await workspace.resolve(String(args.path));
        const client = await requireClient(manager, file);
        context.signal.throwIfAborted();
        // Quick fixes are computed from diagnostics, so settle them first.
        await client.diagnostics(file, context.signal, DIAGNOSTIC_TIMEOUT_MS);
        const actions = await requestCodeActions(client, file, args, context.signal);
        if (!actions.length) return { isError: false, content: 'No code actions available here' };
        return {
          isError: false,
          content: bounded(
            actions
              .map((action) => {
                const flags = [
                  action.kind || 'unspecified',
                  action.preferred ? 'preferred' : '',
                  action.disabled ? 'disabled' : '',
                  action.hasEdit ? 'applies' : action.hasCommand ? 'command-only' : 'no edit',
                ]
                  .filter(Boolean)
                  .join(', ');
                return `${action.index}. ${action.title} [${flags}]`;
              })
              .join('\n'),
          ),
        };
      },
    },
    {
      name: 'lsp_apply_code_action',
      permission: 'write',
      description: `Apply one code action listed by lsp (action "code_actions"), identified by its number. Every affected file is shown in the approval, written atomically and recorded in the file journal so it can be undone. Actions that only carry a server command are refused. ${POSITION_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          ...positionProperties,
          end_line: { type: 'integer', minimum: 1 },
          end_character: { type: 'integer', minimum: 1 },
          kind: { type: 'string', maxLength: 64 },
          index: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: [...positionRequired, 'index'],
        additionalProperties: false,
      },
      prepare: (args, context) => prepareApplyCodeAction(manager, workspace, args, context),
      async execute(args, context) {
        return (await prepareApplyCodeAction(manager, workspace, args, context)).execute(context);
      },
    },
    {
      name: 'lsp_workspace_symbols',
      description:
        'Find symbols by name across the workspace; more precise than text search for functions, classes and types. Pass language when more than one server is running.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          language: { type: 'string', minLength: 1, maxLength: 64 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('query must not be empty');
        const limit = limitOf(args.limit, 50, 200);
        const client = clientForWorkspace(manager, args.language);
        context.signal.throwIfAborted();
        const result = await client.send('workspace/symbol', { query }, context.signal);
        const symbols = parseWorkspaceSymbols(result, root, limit);
        return {
          isError: false,
          content: bounded(
            symbols.length
              ? symbols
                  .map(
                    (symbol) =>
                      `${symbol.path}${symbol.line === undefined ? '' : `:${symbol.line}:${symbol.character}`} ${symbol.kind} ${symbol.container ? `${symbol.container}.` : ''}${symbol.name}`,
                  )
                  .join('\n')
              : `No symbols match "${query}"`,
          ),
        };
      },
    },
  ];
  return { tools, close: () => manager.close() };
}
