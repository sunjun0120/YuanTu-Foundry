/** The contract between the tool registry and one tool: its context, its result and its definition. */
import type {
  Approver,
  DeliverableLog,
  FileChange,
  FileSnapshot,
  GoalLog,
  ImageAttachment,
  Questioner,
  TodoList,
  ToolCall,
  ToolSpec,
} from './index.ts';
import type { ToolResultOutput } from './tool-result.ts';

/** A sandbox preparation a call is waiting on, before the command it asked for can start. */
export interface ToolPreparationProgress {
  stage: 'workspace-authorization';
  root: string;
  /** `true` opens one call's wait, `false` closes it — after success, a refusal or cancellation alike. */
  active: boolean;
}

export interface ToolContext {
  /** Diagnostic observer around each actual tool body attempt, after approval. Cannot control execution. */
  onExecution?: (event: {
    phase: 'started' | 'finished';
    attempt: number;
    startedAt: number;
    finishedAt?: number;
    durationMs?: number;
  }) => void;
  /**
   * Sandbox preparation this call is waiting on, forwarded to the run's live channel. The registry
   * runs it under the run's signal, so stopping the run cancels the helper, while one call's
   * deadline does not discard progress the next call would redo. Cannot control execution.
   */
  onPreparation?: (event: ToolPreparationProgress) => void;
  signal: AbortSignal;
  /** Fixed invocation snapshot; only the trusted resolver below may refresh a pending dispatch. */
  executionPolicy?: import('./execution.ts').ExecutionPolicy;
  /** Trusted session selection, refreshed before dispatch; an executing body keeps its snapshot. */
  executionPolicyForCall?: () => import('./execution.ts').ExecutionPolicy;
  /** Trusted approval selection; a change before body execution must be checked again. */
  permissionPolicyForCall?: () => import('./permissions.ts').PermissionPolicyView | undefined;
  /** Canonical local workspace owned by this registry/run. Required for confined programs. */
  workspaceRoot?: string;
  /** Durable known/unknown outcomes of inner program calls, independent of the guest result. */
  programJournal?: {
    record(call: ToolCall, state: 'known' | 'unknown', result?: ToolResult): void;
  };
  approve: Approver;
  ask?: Questioner;
  /** The call this context belongs to, so an interactive seam can be correlated with its result. */
  callId?: string;
  /** The session the call belongs to. Supplied by the run, which the registry cannot know. */
  sessionId?: string;
  /**
   * The run is a planning phase or a read-only sub-agent: nothing outside this process may be
   * affected. Stated explicitly so extension hooks can refuse calls.
   */
  readOnly?: boolean;
  /**
   * This session's long-running work. Per run, so a child's registry answers for the child's jobs,
   * not the parent's.
   */
  jobs?: import('./jobs.ts').JobControl;
  /** The session-owned checklist, supplied by the run that knows which session it belongs to. */
  todos?: TodoList;
  /**
   * The files this session has presented as deliverables. Optional like `todos`; without it the
   * tool says the declaration cannot be recorded.
   */
  deliverables?: DeliverableLog;
  /**
   * The session's goal. Absent for sub-agents and planning runs, which is how "only a root run
   * states the objective" is enforced.
   */
  goals?: GoalLog;
  /**
   * Writes output too large for the result (over `MAX_TOOL_OUTPUT`) and says where it went.
   * Supplied by the host; without it output is truncated.
   */
  spill?: (input: { tool: string; content: string }) => SpilledOutput | null;
  /** Task effects are marked durable after approval, immediately before tool execution. */
  effectJournal?: { begin(call: ToolCall): void };
  fileJournal?: {
    prepare(change: FileChange, before: Uint8Array | null, after: Uint8Array): string;
    prepareGroup?(change: FileChange, files: FileSnapshot[]): string;
    applied(id: string): void;
  };
  /**
   * The tools this run may call, for `run_code`. Supplied by the run so a read-only child cannot
   * reach the parent's tools. `specs` is the trimmed catalog the model saw; `invoke` runs a call
   * through the same registry, policy and approvals as a direct call. Absent when no run was built.
   */
  catalog?: ToolCatalog;
  /**
   * The session's durable record of background commands. The only seam for recording a command's
   * settlement, which may happen after its run ends. Without it commands run but their outcome
   * stays in-process.
   */
  commandJournal?: import('./jobs.ts').CommandJournal;
}
/**
 * The context one tool body runs under, with cancellation narrowed to this call. `signal` is
 * required here; the registry links it to the run's cancellation.
 */
export type ToolScope = ToolContext & { signal: AbortSignal };
/**
 * The tools a run may call programmatically, and the one way to call them: no second path, nothing
 * the model itself could not call.
 */
export interface ToolCatalog {
  /** The tools this run may call, after read-only and permission trimming (never folded). */
  specs: readonly ToolSpec[];
  /** Runs one call as if the model had made it, and resolves to that call's result. */
  invoke(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  /**
   * Whether this call may overlap another inner call, by the same fail-closed rule the model's own
   * batches use, so a program cannot have two approvals pending or interleave effect-journal
   * entries.
   */
  mode(call: ToolCall): 'parallel' | 'exclusive';
  /**
   * How many calls the run itself would overlap (`1` when strict, as `YUANTU_MAX_PARALLEL_TOOLS`
   * sets), so a program cannot fan out wider than its run.
   */
  parallelLimit: number;
}
/** Where oversized tool output was written, and how much of it there is. */
export interface SpilledOutput {
  /** Workspace-relative path, spelled the way the file tools accept it. */
  path: string;
  bytes: number;
  lines: number;
}
export interface ToolResult {
  content: string;
  isError: boolean;
  change?: FileChange;
  /** A command ran, even if it failed. The registry preserves this across extension result processing. */
  commandExecuted?: true;
  /**
   * The structured value and its view, when the tool declares a contract. Absent means no
   * structured payload (no contract, or the call failed); clients fall back to text and must never
   * parse `content`. A contract tool succeeding without a payload is a defect the tests catch.
   * `content` remains the model's text form.
   */
  output?: ToolResultOutput;
  /**
   * Images the tool produced for the model to see, attached to the result so no second fetch is
   * needed. Bounded like user attachments (`validateImages`).
   */
  images?: ImageAttachment[];
  /**
   * The tool itself cut the text before the registry's budget applied (e.g. `run_command` caps its
   * capture), so the spill notice must not claim the full output. The registry's own truncation is
   * marked in the text (`TRUNCATION_MARKER`) instead.
   */
  truncated?: boolean;
}
export interface PreparedTool {
  change?: FileChange;
  approvalDescription?: string;
  /** Trusted tool-owned boundary explanation for fixed Host operations that do not launch guest programs. */
  approvalIsolation?: string;
  execute(context: ToolContext): Promise<ToolResult>;
}
/**
 * The subsystem a tool belongs to; never sent to the model. `other` is the default for embedder and
 * MCP tools.
 */
export type ToolCategory =
  | 'files'
  | 'search'
  | 'command'
  | 'job'
  | 'terminal'
  | 'validation'
  | 'git'
  | 'lsp'
  | 'browser'
  | 'delivery'
  | 'web'
  | 'memory'
  | 'knowledge'
  | 'session'
  | 'goal'
  | 'interaction'
  | 'skill'
  | 'catalog'
  | 'workspace'
  | 'subagent'
  | 'run'
  | 'other';
export interface Tool extends ToolSpec {
  /** On deadline, join cooperative cleanup within this bound before returning a timeout. */
  cancellationGraceMs?: number;
  approvalDescription?: string;
  permission?: 'write' | 'command' | 'external';
  /** Internal capability used to restrict investigation handoff to workspace file edits. */
  effect?: 'workspace-file' | 'workspace-read';
  /**
   * The tool's subsystem. Product tools are classified in `tools/tool-categories.ts`; others
   * declare it here.
   */
  category?: ToolCategory;
  /**
   * Whether the tool is a query: it changes nothing and answers the same until something else
   * changes. The repeated-query guard counts these. Job polling is not a query.
   */
  query?: boolean;
  /**
   * Whether this call may run alongside its siblings from the same assistant message. Synchronous
   * and pure: sees only the parsed arguments and returns `true` only when sure. Missing, throwing
   * or any non-`true` result means exclusive.
   *
   * `true` promises the call mutates no session, workspace or run-owned state outside itself.
   */
  isConcurrencySafe?(args: Record<string, unknown>): boolean;
  /**
   * Whether this `command` call asks for network its session denies. Pure. `true` runs it with
   * network and marks the approval as an `escalation`, which launch options cannot grant.
   */
  requestsNetwork?(args: Record<string, unknown>): boolean;
  prepare?(args: Record<string, unknown>, context: ToolContext): Promise<PreparedTool>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
