/** Bounding and spilling a tool's output, the run-scoped tool names, and the plain failure result. */
import type { SpilledOutput, ToolResult } from '../protocol/index.ts';
import type { Disposer } from './dispatch.ts';

/** Shown when an observer misbehaved: the effect happened, so "retry" would repeat it. */
export const OBSERVER_FAILURE_NOTICE =
  '\n[Extension observer failed; tool result above remains valid. Do not repeat completed effects.]';

export const noop: Disposer = () => undefined;
export const MAX_TOOL_OUTPUT = 24_000;
/**
 * Spill without letting the spill itself fail the tool: the tool already ran, and its effect is recorded.
 * A result that could not be shortened is a smaller problem than an effect reported as a failure.
 */
export function safeSpill(
  spill: (input: { tool: string; content: string }) => SpilledOutput | null,
  tool: string,
  content: string,
): SpilledOutput | null {
  try {
    return spill({ tool, content });
  } catch {
    return null;
  }
}
/**
 * Tools a run installs for itself with `replace`. A delegated run works on a copy of its parent's
 * registry, so it must not inherit these: a child that saw the parent's `delegate_task` could call it
 * and delegate through the parent's coordinator, straight past the depth cap, and a child that saw
 * `task_step` could checkpoint a task it does not own.
 *
 * The rule behind every name is one thing: the tool's closure captured something that belongs to *that* run
 * — its coordinator, its residency, its attempt, its plan, the session's own goal. Inheriting the parent's
 * copy does not merely offer the child a capability, it hands the child the parent's *identity*, and the
 * tool's own checks (a lineage check, a role check) compare against the closure, so they pass. A name-based
 * list is the only place this can be decided, which makes forgetting to extend it a bug rather than an
 * oversight: `tests/run-scoped-tools.test.ts` fails when a run installs something that is not declared here.
 *
 * `workflow` is on the list for the same reason as `delegate_task`: it captures the coordinator it was built
 * for, so a child that inherited the copy would run its own sub-agents through *the parent's* caps and lineage.
 * A run that is allowed to delegate registers its own.
 *
 * The last three were missing when this comment was first written, and the gap was reachable from any embedder
 * that does not hand its children their own registry (the CLI and the Host always do, through `childTools`):
 * `subagent_fork` forks the *parent's* transcript through the parent's coordinator, `list_subagent_models`
 * answers from the parent's model list, and `send_message` is the sharpest of the three — its lineage check
 * compares the activation's parent against the closure's session id, so a child holding the parent's copy
 * passes its own check and can drive its siblings, which is precisely what that check exists to prevent.
 */
export const RUN_SCOPED_TOOLS = [
  'verify_work',
  'completion_step',
  'completion_scope',
  'task_step',
  'submit_plan',
  'exit_plan_mode',
  'submit_report',
  'delegate_task',
  'subagent_fork',
  'collect_subagents',
  'workflow',
  'list_subagent_models',
  'send_message',
  // The session's own goal: a child that could rewrite it could silently redirect the work it was delegated
  // from, and one that could read it would be reading past the run it was given.
  'create_goal',
  'get_goal',
  'update_goal',
  /**
   * The workspace tools, for the same reason as `delegate_task`: their closure captures *this* session — the
   * directory it may import into and the child results it was offered. A child that inherited `workspace_results`
   * would be reading its siblings' results, and one that inherited `workspace_result_apply` could import them into
   * its own workspace, which is precisely the authority the parent's approval exists to gate.
   */
  'workspace_results',
  'workspace_result_apply',
] as const;
/**
 * What a result says when it was cut, and the only evidence the result stage has that it was.
 *
 * `bounded` appends this *on top of* its limit, so a cut result is `limit + marker.length` characters. The
 * marker is therefore not decoration: it is the one thing that tells the result stage whether the text it is
 * holding is the whole output or the head of one. See the overflow decision in `materialize`.
 */
export const TRUNCATION_MARKER = '\n[output truncated]';
export function bounded(text: string, limit = MAX_TOOL_OUTPUT): string {
  return text.length > limit ? text.slice(0, limit) + TRUNCATION_MARKER : text;
}
export function failure(error: unknown): ToolResult {
  return {
    isError: true,
    content: bounded(error instanceof Error ? error.message : String(error)),
  };
}
