import type { ToolCall, ToolResult } from './index.ts';
export const PIPELINE_STAGES = [
  /** Argument validation against the tool's JSON schema. Nothing else may run for an invalid call. */
  'validate',
  /** Extension pre-execute policy: observation plus allow/deny, in registration order. */
  'pre-execute',
  /** Monotonic guards: deny-only, evaluated after extensible policy so they see the final identity. */
  'guards',
  /** The tool's own side-effect-free preparation: approval description, diff, resolved plan. */
  'prepare',
  /** Human approval for permission-carrying tools. A missing or unanswerable approver denies. */
  'approval',
  /** Dispatch into the tool body (prepared or raw). */
  'execute',
  /** Extension post-execute policy: accept, block, replace the result, or inject context. */
  'post-execute',
  /** Content-only finalization, after every policy decision and before truncation. */
  'finalize',
  /** Materialization: truncation, observer notice, additional context. */
  'result',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
/** Rendered order, for messages and docs. */
export const PIPELINE_ORDER = PIPELINE_STAGES.join(' -> ');
/**
 * The identity-protected view of one tool call as it enters a stage.
 *
 * Frozen, and holding a frozen clone of the call: a stage observes the call, it does not rewrite it.
 * A stage that wants a different call must deny and let the model ask again, which keeps every
 * recorded tool message a faithful record of what was requested.
 */
export interface ToolExecution {
  readonly call: ToolCall;
  readonly tool: string;
  readonly permission?: 'write' | 'command' | 'external';
  /** 1-based count of how often this registry has dispatched this tool, so retries are visible. */
  readonly attempt: number;
  /** Whose call this is, when the run supplied it. A policy that reports needs to name the session. */
  readonly sessionId?: string;
  /** A planning or read-only run, where nothing outside this process may be affected. */
  readonly readOnly?: boolean;
}
/** What a pre-execute stage may decide. There is no "allow" variant: allowing is the default. */
export type PreToolDecision = { action: 'deny'; reason: string };
/** What a guard may return. Deny-only by construction, exactly like `PreToolDecision`. */
export type GuardDecision = void | { deny: string };
/**
 * What a post-execute stage may decide.
 *
 * `block` is decided first and wins: once any policy blocks a result, later replacements cannot
 * un-block it. `replace`/`replace-content` chain (the last one in registration order wins) so that a
 * later, more specific policy can refine an earlier one, and `add-context` accumulates.
 */
export type PostToolDecision =
  | { action: 'accept' }
  | { action: 'block'; reason?: string }
  | { action: 'replace'; result: ToolResult }
  | { action: 'replace-content'; content: string }
  | { action: 'add-context'; context: string };
/**
 * A tool result plus the model-visible context the pipeline asked to inject.
 *
 * `additionalContext` is deliberately *outside* `ToolResult`: the caller must decide where to put it.
 * In the agent loop it becomes a persisted user message after the batch's tool results, so injected
 * context is logged exactly like every other model-visible input instead of riding along inside a
 * tool block where neither the transcript nor the summary would show it.
 */
export interface ToolExecutionResult extends ToolResult {
  additionalContext?: string[];
}
