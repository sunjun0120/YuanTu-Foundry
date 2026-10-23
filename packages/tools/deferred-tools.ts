import type { Message, Tool } from '../protocol/index.ts';

/**
 * Deferred tool loading: the catalog a request carries is the tools a turn usually needs, plus one `load_tools`
 * that names the rest.
 *
 * A request used to carry every schema in the registry — about sixty tools and 33 KB in an empty workspace —
 * on every round, although most turns never touch a language server, a browser, an Office file or the
 * knowledge index. The deferred tools stay registered and callable exactly as before (same validation,
 * permission and approval); what changes is only whether their schema is *sent* before the model asks for it.
 *
 * Which deferred tools a request carries is derived from the session's own transcript rather than kept in
 * memory: a tool is loaded once a `load_tools` call named it, or once it was called at all. That makes the
 * answer the same after a restart or a resumed run, and it only ever grows within a transcript, so the tool list
 * changes once per load instead of churning — which is what keeps the provider's prompt cache usable.
 */
export const LOAD_TOOLS = 'load_tools';

/**
 * The tools whose schema waits for a `load_tools` call.
 *
 * The rule is "a whole subsystem a typical coding turn does not use": language servers, the browser, Office
 * documents, indexing documents into the knowledge base, the web, interactive terminals, worktree management
 * and manifest-driven validation. Everything a turn reaches for constantly — files, search, commands and their
 * jobs, git status/diff/log/commit, the checklist, questions, delivery and memory — is always sent, because a
 * load costs the model one round. Memory is the measured case: a plain "remember this" reaches it, and the extra
 * round a load costs (a whole request) outweighed its four schemas (about 1.8 KB) in a real-model comparison.
 * Run-scoped tools (delegation, plans, reports) are never listed here and are therefore always sent.
 */
/**
 * The deferred tools, by subsystem. The group's `hint` is what the `load_tools` catalog says about it: one line
 * per group instead of one sentence per tool, because the catalog is itself sent on every request and a
 * per-tool sentence made it the largest schema in the list (3.7 KB). The names are listed in full so the model
 * can load or call them exactly.
 */
export const DEFERRED_GROUPS: readonly { hint: string; names: readonly string[] }[] = [
  {
    hint: 'language server (definitions, references, hover, symbols, diagnostics, rename, code actions)',
    names: [
      'lsp_servers',
      'lsp_start',
      'lsp_stop',
      'lsp_diagnostics',
      'lsp_definition',
      'lsp_references',
      'lsp_hover',
      'lsp_symbols',
      'lsp_workspace_symbols',
      'lsp_rename',
      'lsp_code_action',
      'lsp_apply_code_action',
    ],
  },
  {
    hint: 'browser automation',
    names: ['browser_open', 'browser_click', 'browser_fill', 'browser_screenshot', 'browser_close'],
  },
  {
    hint: 'Word/Excel/PowerPoint files and file delivery checks',
    names: [
      'office_inspect',
      'office_preview',
      'office_create',
      'office_edit',
      'verify_file_delivery',
    ],
  },
  { hint: 'knowledge base indexing', names: ['index_document', 'remove_indexed_document'] },
  { hint: 'web', names: ['web_search', 'web_fetch'] },
  {
    hint: 'interactive terminals',
    names: [
      'terminal_open',
      'terminal_send',
      'terminal_read',
      'terminal_signal',
      'terminal_list',
      'terminal_close',
    ],
  },
  {
    hint: 'git branches, worktrees, staging and commits',
    names: ['git_branches', 'git_worktrees', 'git_worktree_create', 'git_stage', 'git_commit'],
  },
  /**
   * The rarer file operations. `edit_file` and `write_file` cover almost every change, so a patch, a multi-edit,
   * a delete or a move pays one load round instead of four schemas on every request.
   */
  {
    hint: 'more file operations (unified-diff patch, multi-edit, delete, move)',
    names: ['apply_patch', 'batch_edit', 'delete_file', 'move_file'],
  },
  // Manifest-driven validation and stdin to a managed command: `run_command` covers the common case of both.
  { hint: 'project validation', names: ['discover_validations', 'run_validation'] },
  /**
   * Starting a background job. Sent on every request, it was the command tool some models reached for first —
   * Claude-Haiku-5.5 started `ls` as a job and then needed `job_output`, a whole extra round per command, even
   * with descriptions that send it to `run_command`. A server or watcher is the rare case, so it is the one that
   * loads; `job_output`, `job_list` and `job_kill` stay sent, since they also read sub-agent jobs.
   */
  {
    hint: 'background jobs (dev servers, watchers; plain commands use run_command)',
    names: ['start_command', 'write_command'],
  },
  /**
   * Reading other sessions' history and starting a goal. Both are asked for by name ("what did we decide last
   * week", "set a goal"), and together they were 6 KB of every request. `update_goal` is deferred too, but only
   * while the session has no goal it could update: the run adds it to the loaded set whenever an unfinished goal
   * exists ({@link GOAL_UPDATE}), so a goal's rounds and its notice always find it in the list.
   */
  {
    hint: 'past sessions (search, read, trace)',
    names: ['search_sessions', 'search_session_events', 'read_session_events', 'trace_session'],
  },
  { hint: 'session goal', names: ['create_goal', 'get_goal', 'update_goal'] },
];

/** The goal tool a run sends without a load whenever the session has an unfinished goal. */
export const GOAL_UPDATE = 'update_goal';

/** The tools whose schema waits for a `load_tools` call: every name in {@link DEFERRED_GROUPS}. */
export const DEFERRED_TOOLS: ReadonlySet<string> = new Set(
  DEFERRED_GROUPS.flatMap((group) => group.names),
);

/** The deferred tools a transcript has already loaded: named by a `load_tools` call, or called directly. */
export function loadedTools(
  messages: readonly Message[],
  deferrable: ReadonlySet<string>,
): Set<string> {
  const loaded = new Set<string>();
  addLoadedTools(messages, deferrable, loaded);
  return loaded;
}

/**
 * The same reading as `loadedTools`, from `from` on and into a set the caller keeps.
 *
 * The transcript only grows, so a caller that remembers how far it has read only has to look at what was
 * appended since: a long deferred-mode session no longer walks every tool call it has ever made at every round.
 */
export function addLoadedTools(
  messages: readonly Message[],
  deferrable: ReadonlySet<string>,
  loaded: Set<string>,
  from = 0,
): void {
  for (let index = from; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name !== LOAD_TOOLS) {
        if (deferrable.has(call.name)) loaded.add(call.name);
        continue;
      }
      const names = call.arguments?.names;
      if (!Array.isArray(names)) continue;
      for (const name of names)
        if (typeof name === 'string' && deferrable.has(name)) loaded.add(name);
    }
  }
}

/** One stable catalogue line per offered deferred group, regardless of which members are already loaded. */
export function deferredCatalog(tools: readonly { name: string }[]): string {
  const hidden = new Set(tools.map((tool) => tool.name));
  const grouped = new Set(DEFERRED_GROUPS.flatMap((group) => group.names));
  const lines = DEFERRED_GROUPS.flatMap(({ hint, names }) => {
    const shown = names.filter((name) => hidden.has(name));
    return shown.length ? [`- ${hint}: ${shown.join(', ')}`] : [];
  });
  // A deferrable name no group lists (an embedder's own set) is still named, just without a hint.
  const rest = [...hidden].filter((name) => !grouped.has(name)).sort();
  if (rest.length) lines.push(`- other: ${rest.join(', ')}`);
  return lines.join('\n');
}

export const LOAD_TOOLS_DESCRIPTION =
  'Load the full definitions of tools that are available but not yet in your tool list, so you can call them ' +
  'from your next step. Load only what your next step will call, all in one call; a tool with no or obvious ' +
  'arguments can also be called directly without loading. Loading grants nothing: each loaded ' +
  'tool keeps its own permissions and approvals. The tools you can load, by area:';

/**
 * The `load_tools` tool. `offers` is the registry's own answer to "may this run call that name", so a name the
 * run cannot use (a read-only child's allowlist, a denying policy) is refused here rather than loaded.
 */
export function loadToolsTool(offers: (name: string) => boolean): Tool {
  return {
    name: LOAD_TOOLS,
    description: LOAD_TOOLS_DESCRIPTION,
    isConcurrencySafe: () => true,
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
          minItems: 1,
          maxItems: 40,
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const names = [...new Set((args.names as string[]) ?? [])];
      const loaded = names.filter((name) => DEFERRED_TOOLS.has(name) && offers(name));
      // A tool that is always sent is already callable: saying so is an answer, not a failure — a model that
      // "loads" one (GPT-5.6-Terra did, for `verify_file_delivery`) should go straight on to call it.
      const present = names.filter((name) => !DEFERRED_TOOLS.has(name) && offers(name));
      const refused = names.filter((name) => !loaded.includes(name) && !present.includes(name));
      const already = present.length
        ? ` Already in your tool list, call directly: ${present.join(', ')}.`
        : '';
      const unknown = refused.length ? ` Not loadable: ${refused.join(', ')}.` : '';
      if (!loaded.length && !present.length)
        return {
          isError: true,
          content: `None of these can be loaded: ${refused.join(', ')}. Use a name from this tool's list.`,
        };
      return {
        isError: false,
        content:
          (loaded.length
            ? `Loaded ${loaded.join(', ')}; their definitions are in your tool list from your next step.`
            : 'Nothing to load.') +
          already +
          unknown,
      };
    },
  };
}

/** How one deferred tool was used across a set of transcripts. */
export interface DeferredToolUsage {
  name: string;
  /** Named by a `load_tools` call. */
  loads: number;
  /** Called (whether or not it was loaded first). */
  calls: number;
  /** Called without having been loaded earlier in the same transcript. */
  direct: number;
  /** Transcripts that loaded or called it at least once. */
  sessions: number;
}

/**
 * Per-tool usage of the deferred set, so the list can be tuned from evidence rather than guessed: a tool loaded
 * in most sessions belongs in the always-sent set, and an always-sent tool nobody calls belongs here. Read by
 * `scripts/deferred-tool-usage.mjs`; pure, so a test can pin the counting.
 */
export function deferredToolUsage(
  transcripts: Iterable<readonly Message[]>,
  deferrable: ReadonlySet<string> = DEFERRED_TOOLS,
): { sessions: number; loadCalls: number; tools: DeferredToolUsage[] } {
  const usage = new Map<string, DeferredToolUsage>();
  const entry = (name: string) => {
    let found = usage.get(name);
    if (!found) usage.set(name, (found = { name, loads: 0, calls: 0, direct: 0, sessions: 0 }));
    return found;
  };
  let sessions = 0;
  let loadCalls = 0;
  for (const messages of transcripts) {
    sessions++;
    const loaded = new Set<string>();
    const touched = new Set<string>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls) {
        if (call.name === LOAD_TOOLS) {
          loadCalls++;
          const names = call.arguments?.names;
          if (!Array.isArray(names)) continue;
          for (const name of names) {
            if (typeof name !== 'string' || !deferrable.has(name)) continue;
            entry(name).loads++;
            loaded.add(name);
            touched.add(name);
          }
          continue;
        }
        if (!deferrable.has(call.name)) continue;
        const found = entry(call.name);
        found.calls++;
        if (!loaded.has(call.name)) found.direct++;
        loaded.add(call.name);
        touched.add(call.name);
      }
    }
    for (const name of touched) entry(name).sessions++;
  }
  const tools = [...usage.values()].sort(
    (a, b) => b.sessions - a.sessions || b.calls - a.calls || a.name.localeCompare(b.name),
  );
  return { sessions, loadCalls, tools };
}
