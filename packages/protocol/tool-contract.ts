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
   * Sandbox preparation this call is waiting on, forwarded to the run's live channel.
   *
   * The first Windows workspace authorization can walk an existing tree for minutes, and the command has not
   * started while it does; this is how the run learns the wait began and ended. The registry makes it ambient
   * around the body together with the run's signal, so stopping the run cancels a helper that has no deadline
   * of its own, while one call's deadline does not throw away progress the next call would have to redo. A
   * report cannot control execution.
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
  /**
   * The session the call belongs to.
   *
   * A policy that reports about a call needs to say *whose* call it was, and a policy that gates an effect
   * needs to know whether the run may produce one at all — which is what `readOnly` says. Both are supplied
   * by the run, because the registry genuinely does not know them.
   */
  sessionId?: string;
  /**
   * The run is a planning phase or a read-only sub-agent: nothing outside this process may be affected.
   *
   * Stated on the context rather than inferred from the tool allowlist because an extension hook still runs
   * for a call it might have to refuse, and "there is no way to tell" is not an acceptable answer for one.
   */
  readOnly?: boolean;
  /**
   * The control plane for this session's long-running work.
   *
   * Supplied per run because the answer is scoped to a session: the registry that runs a child's tools must
   * answer for that child's own jobs, not its parent's.
   */
  jobs?: import('./jobs.ts').JobControl;
  /** The session-owned checklist, supplied by the run that knows which session it belongs to. */
  todos?: TodoList;
  /**
   * The files this session has presented as deliverables.
   *
   * Optional for the same reason `todos` is: an embedder that never wired a session has nowhere to record a
   * declaration, and the tool then says so instead of pretending the file was handed over.
   */
  deliverables?: DeliverableLog;
  /**
   * The session's goal, supplied by the run that owns the session.
   *
   * Absent for a run that may not hold one — a sub-agent, a planning run — which is how "only a root run
   * states the objective" is enforced by the absence of a seam rather than by a check inside the tool.
   */
  goals?: GoalLog;
  /**
   * Writes output too large to return as a tool result, and says where it went.
   *
   * The result stage truncates at `MAX_TOOL_OUTPUT` characters; without somewhere to put the rest, a long
   * command output was simply gone and the model could only see that it had been cut. The host supplies
   * this: only it knows the session and its workspace. A host that does not supply it keeps truncating.
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
   * The tools this run may call, for a tool that runs a program the model wrote (`run_code`).
   *
   * Supplied by the run rather than reached by the tool, for the same reason `jobs` is: the answer belongs to
   * *this* run's registry, and a tool that went looking for it would find the parent's — which is how a
   * read-only child would acquire an ability it was never granted. `specs` is the trimmed catalog the model was
   * told about (a read-only run has no mutations in it), and `invoke` runs one call through the same registry,
   * context and policy as a call the model made directly, so every inner call is validated, permission-checked,
   * approved and journalled exactly like an outer one.
   *
   * Absent for an embedder that never built a run: the tool that needs it then says so instead of guessing.
   */
  catalog?: ToolCatalog;
  /**
   * The session's durable record of the background commands it started.
   *
   * Supplied by the run for the same reason `todos` and `goals` are: the record belongs to a session, and the
   * tool that starts a command knows its id but not whose log it belongs in. A command outlives the call that
   * started it, so this is also the only seam through which its *settlement* can be recorded — the exit happens
   * long after the tool result was returned, possibly after the run that started it has ended.
   *
   * Absent for an embedder with no session: commands then behave exactly as they did before the seam existed —
   * they run, and nothing outside the process that started them learns how they ended.
   */
  commandJournal?: import('./jobs.ts').CommandJournal;
}
/**
 * The context one tool body runs under, with its cancellation narrowed to **this call**.
 *
 * `signal` is required here where it is optional-by-construction on {@link ToolContext}: this is the shape a
 * tool's `execute` reads, and a body that cannot name the signal it must stop on cannot be cooperative. The run's
 * own cancellation still reaches it — the registry links the two — so `aborted`, `reason` and `throwIfAborted()`
 * behave exactly as they always did.
 */
export type ToolScope = ToolContext & { signal: AbortSignal };
/**
 * The tools a run may call programmatically, and the one way to call them.
 *
 * Deliberately narrow: a program gets no second tool path, no privileged shortcut and no way to reach a tool
 * the model itself could not see. That is what keeps "the program can only do what the run already allowed"
 * a property of the design rather than a promise in a comment.
 */
export interface ToolCatalog {
  /** The tools this run may call, after read-only and permission trimming (never folded). */
  specs: readonly ToolSpec[];
  /** Runs one call as if the model had made it, and resolves to that call's result. */
  invoke(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  /**
   * Whether this call may overlap another inner call, by the same fail-closed rule the model's own batch uses.
   *
   * A program can start several calls at once with `Promise.all`, and a program is *not* a second dispatcher: the
   * classification that decides whether one call may run beside another — a permission-bearing tool may not, and
   * neither may one that declares no classifier — belongs to the registry, not to whoever is calling it. Without
   * this the inner path was the one way to have two approvals pending at once and two effect-journal entries
   * interleaved, which is exactly what the model's own batching refuses to do.
   */
  mode(call: ToolCall): 'parallel' | 'exclusive';
  /**
   * How many calls the run itself would overlap, so a program cannot fan out wider than the run it runs inside.
   *
   * `1` for a strict run: the same number `YUANTU_MAX_PARALLEL_TOOLS` sets for the model's batches, which is what
   * makes "a program cannot buy more concurrency than the run allows" true rather than intended.
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
   * The value this result carries, and the view that draws it, when the tool declares a contract.
   *
   * Absence means one thing only: this result has no structured payload. Either the tool declares no contract,
   * or the call produced no value — it was refused before dispatch, its body threw, or a steer retired it — and
   * a failure is prose, not a shape. A client's only correct answer to absence is the text rendering it already
   * had; it must never try to parse `content` into a shape, because "this tool has no card" and "this card could
   * not be built" would then be the same state and neither would be visible. A tool that declares a contract
   * and answers successfully *without* a payload is a defect, and the test suite fails on it rather than leaving
   * a client to degrade quietly.
   *
   * `content` is unchanged by any of this: the model still reads the text form, the structured value is for the
   * carrier that has to draw it, and the two are allowed to differ in form (one is prose, the other is data).
   */
  output?: ToolResultOutput;
  /**
   * Pictures the tool produced, for the model to look at.
   *
   * A path in `content` says where an image is; it does not let the model see it, so every task whose answer
   * is *in* the picture — a screenshot to check a layout, a chart, a diagram, a rendered page — was
   * impossible: the model could only reason about a filename. These are attached to the tool result itself
   * rather than returned as paths for the same reason a file's contents are: a second round trip to fetch
   * them is a step the model can skip, and a step it can forget.
   *
   * Bounded exactly like a user's attachments (`validateImages`: at most 4, 5MB each, 10MB total, real
   * image signatures), because the run's context and the session log both have to carry them.
   */
  images?: ImageAttachment[];
  /**
   * Whether the tool itself cut the text it is handing over, before the registry's own budget applied.
   *
   * Some tools bound their output where it is *produced*, and deliberately above the registry's inline budget:
   * `run_command` keeps two megabytes because the result stage may write what it captured somewhere the model can
   * read back. That captured text is therefore already short of the command's real output, and the difference is
   * invisible in the prose — the registry used to spill it under a notice promising "the full N bytes", which is a
   * claim about a tail that no longer exists. The flag is how a tool says "this is everything I captured, and it is
   * not everything there was", so the notice can say the same thing.
   *
   * It is *not* the registry's own truncation: that one is visible in the text (`TRUNCATION_MARKER`) and needs no
   * field, because the text a model reads has to carry it either way.
   */
  truncated?: boolean;
}
export interface PreparedTool {
  change?: FileChange;
  approvalDescription?: string;
  execute(context: ToolContext): Promise<ToolResult>;
}
export interface Tool extends ToolSpec {
  /** On deadline, join cooperative cleanup within this bound before returning a timeout. */
  cancellationGraceMs?: number;
  approvalDescription?: string;
  permission?: 'write' | 'command' | 'external';
  /** Internal capability used to restrict investigation handoff to workspace file edits. */
  effect?: 'workspace-file' | 'workspace-read';
  /**
   * Whether *this* call may run while its siblings from the same assistant message are still running.
   *
   * Sibling calls are independent as far as the model is concerned — it asked for all of them at once — but
   * they are not independent as far as the workspace is concerned, so overlapping them is the tool's promise
   * to make, not the loop's guess. The classifier is synchronous and pure: it sees this call's parsed
   * arguments and nothing else, performs no I/O, and returns `true` only when it is sure. A missing
   * classifier, a throw, invalid arguments or any other return value all mean exclusive, so a tool that
   * forgets to decide is serial rather than accidentally concurrent.
   *
   * `true` promises that the whole call may overlap another call that also returned `true`: it must not
   * mutate the session, the workspace, or any other state this run owns outside this call. It cannot express
   * "safe only when the sibling differs" — a call whose safety depends on a sibling stays exclusive.
   */
  isConcurrencySafe?(args: Record<string, unknown>): boolean;
  prepare?(args: Record<string, unknown>, context: ToolContext): Promise<PreparedTool>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
