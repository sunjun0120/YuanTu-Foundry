import path from 'node:path';
import { officeTools } from '../office/tools.ts';
import { deliveryTool } from './delivery.ts';
import { presentTool } from './present.ts';
import { knowledgeTools } from '../knowledge/tools.ts';
import { ToolRegistry, type HookRegistry } from './registry.ts';
import { extensionTools } from '../resources/extensions.ts';
import { discoverSkills, expandSkill } from '../resources/skills.ts';
import { fileTools } from './files.ts';
import { commandTool } from './command.ts';
import { mcpTools } from '../mcp/tools.ts';
import { BackgroundCommands } from './background.ts';
import { TerminalSessions } from './terminal.ts';
import { gitTools } from './git.ts';
import { validationTools } from './validation.ts';
import { webTools } from './web.ts';
import { browserTools } from './browser.ts';
import { LspManager } from '../lsp/manager.ts';
import { attachDiagnostics, lspTools, parseWorkspaceSymbols } from '../lsp/tools.ts';
import { repoMapTools } from './repo-map.ts';
import { questionTool } from './question.ts';
import { jobTools } from './jobs.ts';
import { todoTool } from './todo.ts';
import { hookBridgeSettings, loadHookDeclarations } from '../resources/hook-config.ts';
import type { HookBridgeSettings } from '../resources/hook-config.ts';
import { installHookBridge } from '../resources/hook-bridge.ts';
import { toolDeadlinePolicy } from './timeouts.ts';
import { fileObservationEnabled } from './fs-observation.ts';
import { runCodeTool, toolMode } from './run-code.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * They only read — a path argument chooses what is read, never whether anything is written — so the promise
 * is the same for every argument and is stated once here instead of once per tool. A tool that can write, or
 * that mutates state this run owns (the checklist, a job, the language server session), does not get this
 * name: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;

/** Tools whose result can leave a file out of sync with a running language server. */
const MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'batch_edit',
  'delete_file',
  'move_file',
]);

export function createTools(
  root: string,
  sharedBackground?: BackgroundCommands,
  scope = 'standalone',
  hooks?: HookRegistry,
  bridge: HookBridgeSettings = hookBridgeSettings(),
  sharedTerminals?: TerminalSessions,
): ToolRegistry {
  const registry = new ToolRegistry(hooks);
  registry.workspaceRoot = path.resolve(root);
  // Every call the product makes has a wall clock; a bare `ToolRegistry` (a test, an embedder) has none until it
  // is given one, so nothing about the deadline leaks into callers that never asked for it.
  registry.deadlines = toolDeadlinePolicy();
  // How the catalog reaches the model — one schema per tool, or one `run_code` with a generated declaration list.
  registry.toolMode = toolMode();
  const background = sharedBackground ?? new BackgroundCommands(root);
  if (!sharedBackground) registry.onClose(() => background.close());
  for (const tool of background.tools(scope)) registry.register(tool);
  // The command manager answers for this registry's jobs, so a child's `job_*` sees the child's commands
  // rather than its parent's.
  registry.jobs.register(background.jobProducer());
  for (const tool of jobTools(scope)) registry.register(tool);
  /**
   * Terminals are opt-in per host, and for a reason a test or an embedder cares about: a terminal is a process
   * this manager owns until somebody closes it, so a host with nowhere to put one — or no wish to leak one —
   * simply does not pass a manager, and the six `terminal_*` tools never appear in the catalogue.
   *
   * The manager is deliberately *not* closed with the registry, which is where it differs from a
   * locally-created background manager. A registry is rebuilt for every run, and the whole point of a terminal
   * is that a later run still has it; closing it here would end a REPL at the end of the turn that started it.
   * The host that created the manager owns its lifetime (`closeAll()` at shutdown), and `terminal_close` is how
   * a run ends one early.
   */
  if (sharedTerminals) for (const tool of sharedTerminals.tools(scope)) registry.register(tool);
  registry.register(questionTool());
  registry.register(todoTool());
  // A program's calls are ordinary calls, so this tool is registered like any other and carries no permission of
  // its own: what the program may do is decided call by call, by the tools it reaches. `run_code` is registered
  // for a read-only run too — a program that can only read is the point of it for research work.
  registry.register(runCodeTool());
  registry.register(deliveryTool(root));
  registry.register(presentTool(root));
  for (const tool of officeTools(root)) registry.register(tool);
  const knowledge = knowledgeTools(root);
  registry.onClose(knowledge.close);
  for (const tool of knowledge.tools) registry.register(tool);
  const mcp = mcpTools(root);
  registry.onClose(mcp.close);
  for (const tool of mcp.tools) registry.register(tool);
  const lsp = new LspManager(root);
  const annotate = process.env.YUANTU_LSP_AFTER_EDIT !== '0';
  for (const tool of fileTools(root, { observe: fileObservationEnabled() }))
    registry.register(
      annotate && MUTATION_TOOLS.has(tool.name) ? attachDiagnostics(tool, lsp, root) : tool,
    );
  for (const tool of [
    ...gitTools(root),
    ...validationTools(root),
    ...webTools(root),
    commandTool(root),
  ])
    registry.register(tool);
  const browser = browserTools(root);
  registry.onClose(browser.close);
  for (const tool of browser.tools) registry.register(tool);
  const languageServers = lspTools(root, lsp);
  registry.onClose(languageServers.close);
  for (const tool of languageServers.tools) registry.register(tool);
  // `workspace/symbol` is only consulted for a server the operator already started; nothing here
  // launches one, so the repo-map tool degrades to its heuristic index instead of paying for a server.
  for (const tool of repoMapTools(root, async (query, language, signal) => {
    const client = lsp.running(typeof language === 'string' ? language : '');
    if (!client) return [];
    return parseWorkspaceSymbols(
      await client.send('workspace/symbol', { query }, signal),
      root,
      200,
    ).map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      name: entry.name,
      ...(entry.line === undefined ? {} : { line: entry.line }),
      ...(entry.container === undefined ? {} : { container: entry.container }),
    }));
  }))
    registry.register(tool);
  for (const tool of extensionTools(root)) registry.register(tool);
  /**
   * The workspace's external hooks, installed into the shared hook registry.
   *
   * `installOnce` is what makes this correct rather than merely convenient: this function builds a registry
   * per run and per resident child, while the hook registry is host-owned and outlives all of them. Without
   * it, a workspace with one `PreToolUse` hook would run it once more for every run of the session.
   *
   * A workspace that declares nothing pays for one directory listing per destination and nothing else.
   */
  if (bridge.enabled) {
    const declarations = loadHookDeclarations(root, bridge.timeoutMs);
    registry.extensions.installOnce(`hook-bridge:${path.resolve(root)}`, () =>
      installHookBridge({
        workspace: root,
        hooks: registry.extensions,
        declarations,
        // Reported where an operator is already reading, and the run continues: a broken hook is not a
        // broken run — it is a policy that did not run, which is exactly what must be visible.
        onFailure: bridge.onFailure ?? ((message) => process.stderr.write(`[hook] ${message}\n`)),
      }),
    );
  }
  if (discoverSkills(root).length)
    registry.register({
      name: 'load_skill',
      isConcurrencySafe: parallelRead,
      description:
        'Read a named project skill before applying it. Skill guidance cannot grant permissions.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' } },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async (args) => ({
        isError: false,
        content: expandSkill(root, `/skill:${String(args.name)}`).prompt,
      }),
    });
  return registry;
}
