import type { Tool, ToolCategory } from '../protocol/index.ts';

/**
 * Every product tool's subsystem, and which tools are queries, in one table.
 *
 * Before this table each feature that needed to know "is this a read" or "is this git" kept its own list: the
 * repeated-query guard had seventeen names written out, the deferred catalogue grouped its own, and a tool added in
 * one place was missing from the others — `web_search` once was, and a round of repeated web searches hid the
 * repetition entirely. A tool is now classified here once, and a test fails when a registered product tool is not.
 *
 * A table rather than a field on each definition because the definitions live in some thirty files and several are
 * built by factories; `Tool.category` and `Tool.query` are still how a tool from elsewhere classifies itself, and
 * win over this table when given (`classifyTool`).
 */
interface ToolClass {
  category: ToolCategory;
  /** Changes nothing, and the same call answers the same until something else changes (`Tool.query`). */
  query?: true;
}

const q = (category: ToolCategory): ToolClass => ({ category, query: true });
const c = (category: ToolCategory): ToolClass => ({ category });

export const TOOL_CLASSES: ReadonlyMap<string, ToolClass> = new Map<string, ToolClass>([
  // Files: reading is a query; every write declares a permission.
  ['read_file', q('files')],
  ['list_files', q('files')],
  // An image result is new evidence every time it is shown, so it is not counted as a repeat.
  ['read_image', c('files')],
  ['write_file', c('files')],
  ['edit_file', c('files')],
  ['apply_patch', c('files')],
  ['batch_edit', c('files')],
  ['delete_file', c('files')],
  ['move_file', c('files')],
  ['search_files', q('search')],
  ['repo_map', q('search')],
  // Commands and the jobs they start. `run_code` runs a program whose calls are classified on their own.
  ['run_command', c('command')],
  ['start_command', c('command')],
  ['write_command', c('command')],
  ['run_code', c('command')],
  // Polling a job is supposed to change as the job moves: not a query.
  ['job_list', c('job')],
  ['job_output', c('job')],
  ['job_kill', c('job')],
  ['terminal_open', c('terminal')],
  ['terminal_send', c('terminal')],
  ['terminal_read', c('terminal')],
  ['terminal_signal', c('terminal')],
  ['terminal_list', c('terminal')],
  ['terminal_close', c('terminal')],
  ['discover_validations', q('validation')],
  ['run_validation', c('validation')],
  ['git_status', q('git')],
  ['git_diff', q('git')],
  ['git_log', q('git')],
  ['git_branches', q('git')],
  ['git_worktrees', q('git')],
  ['git_worktree_create', c('git')],
  ['git_stage', c('git')],
  ['git_commit', c('git')],
  // The language server: navigation and diagnostics are queries; starting, stopping and editing are not.
  ['lsp_servers', q('lsp')],
  ['lsp_start', c('lsp')],
  ['lsp_stop', c('lsp')],
  ['lsp_diagnostics', q('lsp')],
  ['lsp_definition', q('lsp')],
  ['lsp_references', q('lsp')],
  ['lsp_hover', q('lsp')],
  ['lsp_symbols', q('lsp')],
  ['lsp_workspace_symbols', q('lsp')],
  ['lsp_rename', c('lsp')],
  ['lsp_code_action', c('lsp')],
  ['lsp_apply_code_action', c('lsp')],
  ['browser_open', c('browser')],
  ['browser_click', c('browser')],
  ['browser_fill', c('browser')],
  ['browser_screenshot', c('browser')],
  ['browser_close', c('browser')],
  ['office_inspect', q('office')],
  ['office_preview', c('office')],
  ['office_create', c('office')],
  ['office_edit', c('office')],
  ['verify_file_delivery', c('delivery')],
  ['present', c('delivery')],
  ['web_search', q('web')],
  ['web_fetch', q('web')],
  ['list_memories', q('memory')],
  ['read_memory', q('memory')],
  ['save_memory', c('memory')],
  ['forget_memory', c('memory')],
  ['restore_memory', c('memory')],
  ['recall_knowledge', q('knowledge')],
  ['index_document', c('knowledge')],
  ['remove_indexed_document', c('knowledge')],
  ['search_sessions', q('session')],
  ['search_session_events', q('session')],
  ['read_session_events', q('session')],
  ['trace_session', q('session')],
  ['create_goal', c('goal')],
  ['get_goal', q('goal')],
  ['update_goal', c('goal')],
  ['ask_user_question', c('interaction')],
  ['todo_write', c('interaction')],
  ['load_skill', c('skill')],
  ['load_tools', c('catalog')],
  ['workspace_results', c('workspace')],
  ['workspace_result_apply', c('workspace')],
  ['delegate_task', c('subagent')],
  ['subagent_fork', c('subagent')],
  ['collect_subagents', c('subagent')],
  ['workflow', c('subagent')],
  ['list_subagent_models', c('subagent')],
  ['send_message', c('subagent')],
  // The run's own control tools: how a run reports, plans and verifies, installed per run.
  ['verify_work', c('run')],
  ['completion_step', c('run')],
  ['completion_scope', c('run')],
  ['task_step', c('run')],
  ['submit_plan', c('run')],
  ['exit_plan_mode', c('run')],
  ['submit_report', c('run')],
]);

/** A tool's class: what it declares about itself, else the product table, else `other` and not a query. */
export function classifyTool(tool: Pick<Tool, 'name' | 'category' | 'query'>): {
  category: ToolCategory;
  query: boolean;
} {
  const known = TOOL_CLASSES.get(tool.name);
  return {
    category: tool.category ?? known?.category ?? 'other',
    query: tool.query ?? known?.query === true,
  };
}
