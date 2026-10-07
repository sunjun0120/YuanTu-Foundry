import type { FailureCode } from './failure.ts';
import type { ToolOutputContract, ToolResultOutput } from './tool-result.ts';
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ImageAttachment {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
  name?: string;
}
/**
 * One image as the session database stores it: a content address instead of the bytes.
 *
 * `hash` is the sha256 of the *decoded* bytes, so the same picture attached twice — or attached by a client
 * that padded or wrapped its base64 differently — is one row in `attachment_blobs` rather than two copies of
 * the same megabytes. A message read back from the store never looks like this: the storage layer hydrates
 * every reference before a `Message` leaves it, and a reference it cannot resolve is an error rather than a
 * message with fewer images in it.
 */
export interface ImageReference {
  hash: string;
  mimeType: ImageAttachment['mimeType'];
  name?: string;
}
export interface UserInput {
  prompt: string;
  images?: ImageAttachment[];
}
export interface ProviderState {
  protocol: 'openai-responses';
  model: string;
  endpoint: string;
  output: Record<string, unknown>[];
}
export type Message =
  | {
      role: 'user';
      createdAt?: string;
      content: string;
      displayContent?: string;
      images?: ImageAttachment[];
      modelInfo?: { model: string; protocol: string; connectionId?: string };
    }
  | {
      role: 'assistant';
      content: string;
      toolCalls: ToolCall[];
      providerState?: ProviderState;
      interrupted?: boolean;
      /**
       * What the model thought before it answered, kept so a reopened session can still show it.
       *
       * Display-only, and deliberately not part of the conversation: no encoder sends it back (endpoints
       * that produce `reasoning_content` reject it on the way in), it is excluded from the context estimate
       * because it is not in the next prompt, and it is never the answer — `content` is.
       */
      reasoning?: string;
    }
  | {
      role: 'tool';
      toolCallId: string;
      content: string;
      isError: boolean;
      change?: FileChange;
      images?: ImageAttachment[];
      /** The structured value and its renderer name, when the tool declared an output contract. */
      output?: ToolResultOutput;
    };
export type FileChangeKind = 'create' | 'edit' | 'delete' | 'move' | 'batch';
/**
 * Which sub-agent produced an effect. It rides on the record itself so every consumer — the change
 * list, the approval card, a deferred task approval — can name the child instead of parsing a string.
 */
export interface SubAgentTag {
  id: string;
  role: SubAgentRole;
  objective: string;
}
export interface FileChange {
  id?: string;
  path: string;
  kind: FileChangeKind;
  patch: string;
  added: number;
  removed: number;
  truncated: boolean;
  changes?: FileChange[];
  /** Set when a sub-agent made this change; it is still journaled against the parent session. */
  subagent?: SubAgentTag;
}
export interface FileSnapshot {
  path: string;
  before: Uint8Array | null;
  after: Uint8Array | null;
}
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The shape of this tool's results, when they are more than text — a JSON Schema for the value and the name
   * of the view that draws it.
   *
   * Declared here, on the declaration, rather than repeated inside every result: the shape belongs to the tool,
   * and a per-call copy would put the same schema on the live channel and in the session log once per call made.
   * The model is deliberately not shown it — `ToolRegistry.specs` builds each request's `ToolSpec` from `name`,
   * `description` and `inputSchema` alone — because the output shape is for the client that has to lay the result
   * out, and the model already reads the value through the result's `content`. A tool that declares nothing here
   * has no structured payload and no renderer name, which is the one meaning absence has (see `ToolResult.output`).
   */
  output?: ToolOutputContract;
}
export interface Usage {
  cachedInputTokens?: number;
  /**
   * Input tokens the provider wrote into its prompt cache, when it reports that separately.
   *
   * `inputTokens` is the total the provider billed, so read and write are *parts* of it, not additions. They
   * are separated because they cost differently and cache the same prompt differently on the next call: a
   * total that mixes them cannot answer "is the prompt cache paying for itself?".
   */
  cacheWriteInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
}
export interface ModelProgress {
  phase: 'reasoning' | 'tool_call' | 'text';
  reasoningChars: number;
  toolArgumentChars: number;
  visibleChars: number;
}
export interface OutputDiagnostics {
  reasoningTokens?: number;
  reasoningChars: number;
  toolArgumentChars: number;
  visibleChars: number;
}
export interface ModelResponse {
  outputDiagnostics?: OutputDiagnostics;
  providerState?: ProviderState;
  text: string;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  /**
   * Set when the provider named the *context window* as the reason the turn ended, rather than the output
   * limit. Both arrive as `finishReason: 'length'`, and the difference decides whether the run can recover: a
   * window overflow is answered by compressing the conversation and sending the round again, an output limit
   * is not.
   */
  truncation?: 'context-window';
  usage: Usage;
}
/**
 * How much reasoning a request is asking to buy.
 *
 * A level rather than a token budget because that is the vocabulary two of the three protocols speak
 * (`reasoning_effort`, `reasoning.effort`); Anthropic only understands a token budget, so a level is
 * translated there by a documented rule (see `packages/providers/effort.ts`). `none` is not "a low budget":
 * it means the request carries no reasoning parameter at all, which is what a policy needs in order to undo
 * an earlier policy's choice.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'none';
/**
 * The protocols this build ships an adapter for.
 *
 * The single declaration: the settings table's `YUANTU_PROTOCOL` enum and the provider registry are both built
 * from it, so "what protocol names exist" cannot drift between the parser, the help text and the factory. A
 * host that registers a further adapter extends the *registry* — the environment path stays these three,
 * because `YUANTU_PROTOCOL` is validated against the table before a factory is ever consulted.
 */
export const BUILTIN_PROTOCOLS = ['anthropic', 'openai', 'openai-responses'] as const;
export type BuiltinProtocol = (typeof BUILTIN_PROTOCOLS)[number];
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal: AbortSignal;
  onText: (text: string) => void;
  /**
   * The model's own reasoning, as it streams.
   *
   * A channel of its own rather than a flag on `onText`, because the two must never become
   * interchangeable: `onText` is the answer — it is stored as the answer, replayed as the answer and
   * counted as the answer — while reasoning is shown folded, is never sent back to a provider, and is not
   * part of the next prompt. A provider with nothing to report simply never calls this.
   */
  onReasoning?: (text: string) => void;
  onProgress?: (progress: ModelProgress) => void;
  /**
   * The model to serve *this* request, when it is not the provider's configured one.
   *
   * A provider is one configured endpoint; this is the per-request half of "run this step on a different
   * model", and it is deliberately per request rather than per provider: a run that switches models
   * mid-conversation must not have to be re-plumbed, and the prompt cache key follows the model that
   * actually served the request.
   */
  model?: string;
  /** How much reasoning to buy for this request; omitted means the protocol's own default. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Stable identifier for the request's cacheable prefix. Supplying it asks the
   * provider to cache the system prompt, tool definitions and conversation prefix;
   * omitting it leaves the request uncached. It carries no workspace content of its
   * own beyond a digest, and must never contain credentials.
   */
  cacheKey?: string;
}
export interface Provider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
export interface Approval {
  kind: 'write' | 'command' | 'external';
  description: string;
  toolCall: ToolCall;
  change?: FileChange;
  /** Set when a sub-agent is asking, so the prompt names the child instead of looking like the parent. */
  subagent?: SubAgentTag;
}
export type ApprovalDecisionSource =
  'user' | 'policy' | 'launch-options' | 'task-approval' | 'unavailable';
export type Approver = ((approval: Approval, signal: AbortSignal) => Promise<boolean>) & {
  /** The decision just made for this call. Omitted by legacy human approvers. */
  decisionSource?: (approval: Approval) => ApprovalDecisionSource | undefined;
};
/**
 * One choice a question offers.
 *
 * `label` is what an answer refers to, so it is the identity of an option: two options with the same
 * label would make an answer ambiguous, which is why the tool refuses duplicates instead of picking one.
 */
export interface QuestionOption {
  label: string;
  description?: string;
  /**
   * The option the asker would pick, which the interface marks rather than reorders.
   *
   * A recommendation is information for a person, not a default that acts: the panel shows it as a badge and the
   * answer is still whatever the user clicks. It is a field rather than a convention in the label text, because a
   * suffix like "(recommended)" would be part of the answer the model reads back — and a label is data the model
   * wrote, so the interface must not be editing it to draw a badge.
   */
  recommended?: boolean;
}
export interface Question {
  id: string;
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
}
export interface QuestionRequest {
  questions: Question[];
  /** Set when a sub-agent is asking, so the prompt names the child instead of looking like the parent. */
  subagent?: SubAgentTag;
  /**
   * The tool call that asked.
   *
   * It rides along for the same reason `Approval.toolCall` does: when the wait ends without an answer, the
   * client has to withdraw the panel it opened, and the only fact tying that panel to the call is the id the
   * tool result will carry.
   */
  callId?: string;
}
export interface QuestionAnswer {
  id: string;
  selected: string[];
  freeText?: string;
}
/**
 * Why a question came back without an answer.
 *
 * `timedOut` is redundant with `reason === 'timeout'` on purpose: a reader that only wants the
 * distinction the UI draws (answered vs not) does not have to switch on the reason to find it.
 */
export interface QuestionOutcome {
  answered: boolean;
  answers: QuestionAnswer[];
  timedOut?: boolean;
  reason?: 'timeout' | 'cancelled' | 'unavailable';
}
/**
 * Asking a human is not an effect, so unlike an approval it is allowed in a read-only or planning run:
 * a run that may not write may still need a decision before it can plan anything at all.
 */
export type Questioner = (
  request: QuestionRequest,
  signal: AbortSignal,
) => Promise<QuestionOutcome>;
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
/**
 * One line of the session's own progress list.
 *
 * It is not a task: a task is a durable multi-run object with acceptance checks and triggers, while this is
 * "what am I doing right now" within a run. It never touches the workspace, which is why it is not an
 * effect and carries no permission.
 */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}
/**
 * A guard rather than a cast, because the reader is a fold over a log this build may not have written: a
 * malformed payload has to be rejected as data, not trusted as a type.
 */
export function isTodoItem(value: unknown): value is TodoItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<TodoItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.content === 'string' &&
    TODO_STATUSES.includes(item.status as TodoStatus)
  );
}
/**
 * The session's todo list, as the tool sees it.
 *
 * Reading and writing go through the seam rather than through the store so that the tool stays ignorant of
 * sessions and durability — the same reason `spill` is a callback. Writing is what records the event and
 * announces it to a connected client.
 */
export interface TodoList {
  read(): TodoItem[];
  write(items: TodoItem[]): TodoItem[];
}
/**
 * The files this session has presented as deliverables.
 *
 * Same seam as `TodoList`, for the same reason: the fact belongs in the session's log, and the tool that
 * declares it must not have to know what a session is. Reading is the fold; writing appends the event and
 * announces it, so the log line and the panel update are one accepted call rather than two.
 */
export interface DeliverableLog {
  read(): import('./deliverables.ts').PresentedFile[];
  write(files: readonly import('./deliverables.ts').PresentedFile[]): void;
}
/**
 * The session's goal, and the one way to change it.
 *
 * `write` takes the goal as it now stands, not an intention: the transitions that decide it (the round count,
 * reopening a terminal goal, the blocked floor) live in `packages/protocol/goals.ts`, are applied by whoever
 * owns the state, and the seam's job is only to record the result. Carrying the whole goal rather than a diff
 * is what makes the fold a replacement — the newest event *is* the goal, and a reload needs no replay.
 */
export interface GoalLog {
  read(): import('./goals.ts').Goal | null;
  /**
   * Record a change. `action` labels it for the log and the client; the two the runtime performs itself are
   * `create` (a goal that did not exist until now, and whose first round is this run) and `round` (one more run
   * admitted to an existing goal, which is what its budget counts).
   */
  write(action: import('./goals.ts').GoalChangeAction, goal: import('./goals.ts').Goal): void;
  /**
   * Whether this turn carries the user's own input.
   *
   * The seam exposes it because the question belongs to the goal: the goal tools let a model report on the
   * objective and end it, but `edit`, `pause` and `resume` decide *who is in charge* of it, and a round the
   * runtime started to continue the goal is not the user's turn (see `HUMAN_ONLY_GOAL_ACTIONS`). It is a
   * property of the turn rather than of the goal, which is why it is read here rather than stored in the
   * record: the same goal is `active` in both turns, and only the caller knows which one this is.
   */
  human: boolean;
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
  signal: AbortSignal;
  /** Fixed for this invocation, including nested RPC calls and approval waits. */
  executionPolicy?: import('./execution.ts').ExecutionPolicy;
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
export type RunStatus = 'completed' | 'needs_review' | 'cancelled' | 'limited' | 'failed';
/**
 * Where a plan sits in the plan -> approve -> execute machine.
 *
 * `planning` is durable on purpose: the row is created before the read-only planning run starts, so a
 * crash mid-plan leaves a visible record with its dead run instead of silently nothing. What that record must
 * *not* do is keep calling itself `planning` forever — the run that would have filled it is gone, and a reader
 * that shows "planning in progress" for a plan nobody is working on is worse than showing nothing. So the
 * convergence that settles an interrupted run moves its unfinished plan to `abandoned`: still a record, no longer
 * a promise. `submitPlan` refuses it for the same reason it refuses any other status.
 */
export type PlanStatus = 'planning' | 'proposed' | 'approved' | 'rejected' | 'abandoned';
export interface PlanStep {
  description: string;
}
export interface Plan {
  id: string;
  sessionId: string;
  /** The read-only planning run that produced this plan, when there was one. */
  runId?: string;
  status: PlanStatus;
  title: string;
  summary: string;
  steps: PlanStep[];
  /** Digest of the plan body. Editing after approval invalidates it. */
  hash: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
export interface AcceptanceEvidence {
  passed: boolean;
  durationMs: number;
  checks: Array<{
    id: string;
    kind:
      'command' | 'file-exact' | 'file-contains' | 'file-delivery' | 'forbidden-path' | 'manual';
    passed: boolean;
    detail: string;
    durationMs: number;
    command?: {
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
      outputTruncated: boolean;
    };
  }>;
}
export interface RunResult {
  /** Summary usage already present in context.compacted events, for exactly-once session aggregation. */
  compactionUsage?: Usage;
  statistics?: import('./statistics.ts').SessionStatistics;
  runId: string;
  sessionId: string;
  status: RunStatus;
  text: string;
  usage: Usage;
  acceptance?: AcceptanceEvidence;
  /** One entry per sub-agent this run delegated to, in the order the tasks were requested. */
  subagents?: SubAgentSummary[];
  /**
   * A delegated run's structured report. It is only ever set by a child run (`reportRequired`), which
   * is how the report reaches the tool result the parent sees.
   */
  report?: SubAgentSummaryReport;
  /**
   * A delegated run's structured answer, when its task declared its own `schema` instead of the report shape.
   *
   * Validated by the same Ajv pass as any other tool argument, because the child submits it through a tool whose
   * argument schema *is* the caller's schema. Only one of `report` and `data` is ever set: they are two
   * different promises, and a caller that asked for its own shape should not have to parse the standard one.
   */
  data?: unknown;
  error?: string;
  /**
   * Why the run ended, when the reason has a name.
   *
   * `error` is for the person reading it; this is for the code that has to do something different about a
   * failed run — a timeout may be worth retrying, an exhausted budget is not, and a client that has to match
   * on the message to tell them apart will eventually match the wrong one. Absent means the failure was prose
   * only, which is honest rather than a default code that overstates what is known.
   */
  code?: FailureCode;
  /**
   * The HTTP status a failed model request ended on, when it failed as a response at all.
   *
   * `code` is what code branches on and is deliberately coarse; this is the number behind it, which is what a
   * person quotes when they ask whoever runs the endpoint what happened. Named `httpStatus` because `status`
   * is already this result's own outcome, and one field cannot be two facts.
   */
  httpStatus?: number;
  /**
   * The endpoint's own id for the request that failed, when it sent one.
   *
   * The one handle a provider's support can look a call up by. Absent when the endpoint named no request: an id
   * this runtime invented would look exactly like one that identifies the call.
   */
  requestId?: string;
}
/**
 * A sub-agent is a delegated child run with its own session and context.
 *
 * `explore` is read-only by construction (permission-declaring tools are hidden and approvals are
 * refused); `general` inherits the parent run's permissions and therefore still asks for each write.
 */
export type SubAgentRole = 'explore' | 'general';
export type SubAgentTaskStatus = RunStatus | 'running' | 'skipped' | 'interrupted';
export interface SubAgentFinding {
  statement: string;
  /** How the child knows: a command and its result, or a file and what is in it. */
  evidence: string;
  paths?: string[];
}
/**
 * A child's structured report.
 *
 * It exists because the parent has to be able to cite, distrust or act on a finding. Prose gives it
 * nothing to point at, and the parent cannot tell a verified fact from a guess the child made.
 */
export interface SubAgentSummaryReport {
  summary: string;
  findings: SubAgentFinding[];
  /** What the child could not check, stated rather than left as an implied claim. */
  unverified?: string[];
  blockers?: string[];
}
export interface SubAgentSummary {
  id: string;
  role: SubAgentRole;
  objective: string;
  /** The child session holding the sub-agent transcript; hidden from the session list. */
  sessionId: string;
  status: SubAgentTaskStatus;
  rounds: number;
  toolCalls: number;
  usage: Usage;
  /**
   * Wall time this child's **ended** turns took, in milliseconds.
   *
   * It is the child's active time rather than the wall clock since it was delegated: a child that was
   * delegated an hour ago and ran for two minutes reports two minutes, which is the number a reader
   * comparing children is actually looking at. The turn that is still running is not in here — it is
   * `runningSince`, and whoever renders this adds the elapsed part itself so the number can tick.
   *
   * Derived from the child's own session log (`turnTiming`), so it survives a reload and never counts the
   * time a child spent idle between turns.
   */
  durationMs?: number;
  /** Epoch ms the child's open turn started, or `null` when nothing is running. */
  runningSince?: number | null;
  /** Set when the child finished by submitting a structured report. */
  report?: SubAgentSummaryReport;
  error?: string;
}
/**
 * Every event the agent can emit. This is a runtime array, not just a type, because clients
 * allow-list incoming events against it — an omitted type is silently dropped for every consumer
 * instead of raising an error. Deriving the union from the array keeps the type and the runtime
 * list in step, so adding an event here is the only step needed.
 */
export const AGENT_EVENT_TYPES = [
  'statistics.updated',
  'run.started',
  'message.started',
  'message.delta',
  /** The model's reasoning, on its own channel so no consumer can mistake it for the answer. */
  'message.reasoning',
  'message.finished',
  'tool.started',
  'tool.finished',
  'tool.execution.started',
  'tool.execution.finished',
  'approval.required',
  /**
   * What the human answered. The live event lets a client settle its panel; the durable record (same name, in
   * the session log) is what lets a reopened session say who allowed what.
   */
  'approval.decided',
  'question.required',
  'question.answered',
  /** The session's checklist changed, carrying the whole list so a client needs no second read. */
  'todo.written',
  /** Inner program effects survive a guest disconnect as known or unknown outcomes. */
  'program.call.settled',
  /**
   * The model declared workspace files as the deliverables of this session.
   *
   * Live so a panel fills in while the run is still going, and durable because "what was handed to me" is
   * the one thing a person comes back for: a reopened session that lost it would show the work and not the
   * output. The whole declaration is carried — a path, its size and its digest at the moment it was named —
   * so a reader needs no second read of the file to say what was presented.
   */
  'deliverable.presented',
  /**
   * The session's goal changed, carrying the whole goal for the same reason `todo.written` does.
   *
   * One record per accepted change, including the round a run starts with an active goal: the round count is
   * part of the state, so a reader that skipped the rounds would read "3 rounds" off a goal that has had
   * seven, and the blocked floor is expressed in exactly that number.
   */
  'goal.changed',
  'context.compacting',
  'context.compacted',
  /**
   * The budget prediction the round was decided on: what the next request is expected to cost, what the run
   * has left, and what was done to the conversation first (shortened results, a compression). Live only — it
   * is one line per request, and the log already records the compressions themselves.
   */
  'context.forecast',
  /**
   * Model-visible context the runtime adds to the conversation rather than to the prompt — post-execute policy
   * output, pre-step injections, and the notice that announces the session's goal. It is appended as a user
   * message, so the event exists to make the addition observable live, and to say which of those sources it came
   * from, not to carry the content to the model.
   */
  'context.injected',
  /**
   * A request the provider refused because it exceeded the model's context window. Emitted whether or not the
   * run recovered from it, because "this conversation was too large for this model" is the fact an operator
   * needs when they later ask why a round was compressed or why a run failed.
   */
  'context.overflow',
  /**
   * A round's request is about to be re-sent after a transient failure, carrying which failure, which attempt
   * this is, and how long the run will wait first.
   *
   * Live as well as durable because the wait is the part the user experiences: a run that is silent for thirty
   * seconds looks stuck, and "the endpoint said 429, retrying in 4s (attempt 2 of 2)" is the difference between
   * waiting and giving up.
   */
  'llm.retry',
  'provider.request.finished',
  'context.summary.retry',
  /**
   * How a round's request was shaped: which model and effort served it, recorded when either differs from the
   * previous round's. Deliberately a *change* log rather than one row per round — a run on its configured
   * model writes nothing at all, and a run that switches writes one row at the switch.
   */
  'llm.request',
  'input.queued',
  'input.consumed',
  'queue.changed',
  'resources.loaded',
  'task.step',
  'plan.proposed',
  /**
   * A planning run's plan was approved by the user mid-run (`exit_plan_mode`), so the run continues as an
   * executing one. Separate from `plan.proposed` because it is a different fact about the same plan object: the
   * client shows the plan either way, but only this one means "work is starting in *this* run", which is what
   * decides whether offering to execute the plan again would duplicate it. The durable record of an approval is
   * the plan row itself (`approved_at` and the status), exactly as it is for an approval from the panel.
   */
  'plan.approved',
  'subagent.started',
  'subagent.delta',
  'subagent.tool',
  /**
   * A working child's own numbers moved: how long its turns have run, and what it has spent so far.
   *
   * The card and the catalog both show a running child's tokens and time, and neither can be assembled from
   * the parent's events: the child's usage arrives with `subagent.finished`, and its turn clock is its own
   * session's. So the child's own frames are folded into one live shape here, and nothing durable is written
   * — the log already holds the child's runs, and a reload reads the same numbers out of them.
   */
  'subagent.progress',
  'subagent.finished',
  /**
   * A runtime invariant did not hold. Emitted for diagnostics even though the run is already failing at that
   * point: the log is where an operator sees a broken promise, and a host outlives many runs.
   */
  'invariant.violated',
  'run.finished',
] as const;
/**
 * One durable log record as a client reads it.
 *
 * The log's sequence number is the cursor: it is assigned by the store when the record is appended, it never
 * repeats, and a reader that asks for everything after the last one it saw gets exactly the records it is
 * missing. `data` stays open because the payload belongs to the record's type — a reader switches on `type`
 * and reads the fields it knows.
 */
export interface SessionEventView {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
export interface AgentEvent {
  type: AgentEventType;
  sessionId: string;
  runId: string;
  /**
   * The session's durable cursor at the moment this frame was emitted: every record up to this seq has been
   * announced on the live channel.
   *
   * The log's own cursor, not a second numbering: a reader that has a frame has a position in the log, and the
   * two can be compared directly. That is what makes a gap recoverable — a client keeps the highest seq it has
   * seen and asks `session.events` for everything after it, instead of re-reading the session (or, on a carrier
   * that owns its Host, restarting it) because it cannot tell how much it missed.
   *
   * Frames that announce no durable fact — model deltas, statistics — carry the mark unchanged: they are
   * superseded by the durable frame that follows them, so a client that loses one has lost nothing it cannot
   * rebuild, and the mark says exactly how much of the log it is *not* behind on.
   */
  seq: number;
  data: Record<string, unknown>;
}

export type TaskStatus =
  'pending' | 'in_progress' | 'completed' | 'needs_review' | 'blocked' | 'cancelled';
export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped';

export interface AcceptanceCheck {
  id: string;
  kind: 'command' | 'file-exact' | 'file-contains' | 'file-delivery' | 'forbidden-path';
  command?: string;
  args?: string[];
  cwd?: string;
  expectedExitCode?: number;
  timeoutMs?: number;
  path?: string;
  expected?: string;
  maxBytes?: number;
  minBytes?: number;
  sha256?: string;
  format?:
    'auto' | 'binary' | 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'xls' | 'png' | 'jpeg' | 'zip';
  expectation?: 'absent' | 'unchanged';
}

export interface Acceptance {
  description: string;
  met: boolean;
  check?: AcceptanceCheck;
}

export interface TaskStep {
  description: string;
  status: TaskStepStatus;
}

/**
 * One append-only step transition. The journal is the durable record of how far a task actually
 * got, so a run interrupted mid-flight can be resumed from the last completed step instead of
 * redoing work or guessing.
 */
export interface TaskStepCheckpoint {
  id: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  index: number;
  status: TaskStepStatus;
  note?: string;
  createdAt: string;
}

/** Events a durable task can react to. `task.completed` may be narrowed to one source task. */
export type TaskEventName = 'run.finished' | 'task.completed' | 'session.created';
export type TaskMisfirePolicy = 'skip' | 'latest';
export type TaskTrigger =
  | { kind: 'interval'; enabled: boolean; everyMinutes: number; misfire?: TaskMisfirePolicy }
  | {
      kind: 'daily';
      enabled: boolean;
      atMinutes: number;
      timeZone?: string;
      misfire?: TaskMisfirePolicy;
    }
  | {
      kind: 'weekly';
      enabled: boolean;
      atMinutes: number;
      weekdays: number[];
      timeZone: string;
      misfire?: TaskMisfirePolicy;
    }
  | {
      kind: 'cron';
      enabled: boolean;
      expression: string;
      timeZone: string;
      misfire?: TaskMisfirePolicy;
    }
  | { kind: 'at'; enabled: boolean; at: string }
  | { kind: 'after'; enabled: boolean; afterMinutes: number; anchorAt?: string }
  | { kind: 'event'; enabled: boolean; on: TaskEventName; taskId?: string };
/** Why an attempt started. Recovery marks a resume after the Host restarted mid-attempt. */
export type TaskTriggerSource = 'manual' | TaskTrigger['kind'] | 'recovery';

export interface TaskApproval {
  id: string;
  state: 'pending' | 'approved' | 'rejected';
  phase: 'tool' | 'acceptance';
  kind: Approval['kind'];
  tool: string;
  description: string;
  createdAt: string;
  reviewedAt?: string;
}

export type TaskAttemptKind = 'run' | 'verify' | 'review';
export interface TaskAttempt {
  id: string;
  taskId: string;
  sessionId: string;
  ordinal: number;
  kind: TaskAttemptKind;
  runId?: string;
  status: TaskStatus;
  prompt?: string;
  trigger: TaskTriggerSource;
  resume: boolean;
  verification?: AcceptanceEvidence;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Task {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: TaskStatus;
  acceptance: Acceptance[];
  verification?: AcceptanceEvidence;
  steps: TaskStep[];
  trigger?: TaskTrigger;
  triggerRevision?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastTriggerError?: string;
  approvalOutcomeUnknown?: boolean;
  pendingApproval?: TaskApproval;
  attemptCount: number;
  latestAttemptId?: string;
  latestRunId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Set while a scheduled moment this Host was not free to start is still owed.
   *
   * Computed at read time rather than stored, and only by the surfaces that can see the session's log
   * (`task.list` / `task.get`): the record is a `task.due` event, the answer changes the moment the run happens,
   * and a copy of it on the row would be a second truth about the same fact. `since` is the moment the schedule
   * named — the oldest one this task is owed for — and `reason` is why it could not start then.
   */
  waiting?: { since: string; reason: string };
}

export interface SessionInfo {
  title?: string;
  id: string;
  workspace: string;
  createdAt: string;
  activeRun: string | null;
  /** Set when this session belongs to a sub-agent run rather than to the user. */
  parentSessionId?: string | null;
}
