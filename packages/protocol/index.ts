import type { FailureCode } from './failure.ts';
import type { ToolOutputContract, ToolResultOutput } from './tool-result.ts';
import type { CheckFailureReason, CompletionSummary } from './completion.ts';
import type { PreparedRequestFingerprint } from './request-cache.ts';
import type { ExecutionPolicy } from './execution.ts';
export * from './tool-contract.ts';
export * from './events.ts';
export * from './tasks.ts';

export type {
  CheckFailureReason,
  CompletionPathBaseline,
  CompletionRecord,
  CompletionRepairPolicy,
  CompletionSpec,
  CompletionState,
  CompletionStep,
  CompletionSummary,
} from './completion.ts';
export {
  CHECK_FAILURE_REASONS,
  COMPLETION_LIMITS,
  COMPLETION_REPAIR_CEILINGS,
  COMPLETION_REPAIR_DEFAULTS,
  COMPLETION_STATES,
  collectFailedChecks,
  isRepairableFailure,
  type FailedCheckRef,
} from './completion.ts';
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
  protocol: 'openai-responses' | 'openai' | 'anthropic';
  model: string;
  endpoint: string;
  output: Record<string, unknown>[];
  /** Native Chat/Messages replay is valid only while this assistant content and its calls are unchanged. */
  messageHash?: string;
  /** A complete system snapshot only at the start of a native series or when its effective text changes. */
  systemPrompt?: { kind: 'initial' | 'update'; text: string };
  /** Changed declarations start a new system series instead of applying stale historical instructions. */
  systemToolsHash?: string;
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
       * An answer the runtime is about to replace with another one from the same turn.
       *
       * Automatic verification nudges a run that tries to finish without checks, and the model answers again
       * after the nudge. The first answer is real model output and stays in the transcript the next request is
       * built from, but showing both leaves the person with two final answers. A transcript renderer hides a
       * provisional answer once a later answer exists; it still shows one when the run ends before that.
       */
      provisional?: boolean;
      /**
       * What the model thought before it answered, kept so a reopened session can still show it.
       *
       * Display text is not replayed directly. Capable adapters retain route-scoped native reasoning in
       * `providerState`, which participates in context sizing and is replayed only to its original route.
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
  /**
   * How the turn ended.
   *
   * `content-filter` is the endpoint's own policy stopping the turn — OpenAI's `content_filter`, Anthropic's
   * `refusal`, and the Responses API's `incomplete_details.reason: 'content_filter'`. It is neither of the other
   * two: it is not an answer (`stop`), and it is not a budget the run can do anything about (`length`). Without
   * the distinction two protocols described one event as a clean stop and the third described it as a length
   * truncation, which sent a run that had been refused by policy looking for a smaller task.
   */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content-filter';
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
  /** Actual serialized input identity, reported immediately before dispatch by supported adapters. */
  onRequestFingerprint?: (fingerprint: PreparedRequestFingerprint) => void;
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
   * counted as the answer. Capable adapters separately retain native reasoning for subsequent requests;
   * this display channel alone never authorizes replay. A provider with nothing to report never calls this.
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
   * Stable identifier used by adapters that accept explicit cache hints. Providers such as DeepSeek can
   * cache automatically without this field. It contains only a digest and must never contain credentials.
   */
  cacheKey?: string;
  /**
   * `none` forbids tool calls while still sending the catalogue.
   *
   * The catalogue stays because it is part of the cacheable prefix a summary request replays; the choice is
   * set only on a retry after a summary answered with a tool call, since changing it can invalidate the
   * provider's message cache. Omitted means the protocol's own default (`auto`).
   */
  toolChoice?: 'none';
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
  /**
   * For a command: what its backend will and will not stop, as data rather than the English sentence in
   * `description`, so an interface can say it in the reader's language at the moment they decide.
   */
  boundary?: Pick<ExecutionPolicy, 'processFiles' | 'network'>;
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
  /**
   * Whether a completion contract permits this goal to be closed as complete.
   *
   * A goal is the model's own statement of what it is trying to achieve, and `complete` was a lifecycle
   * transition with no evidence behind it: a run could declare an objective achieved and nothing in the runtime
   * disagreed. When a session also carries a completion contract, that contract is the stronger statement — it
   * names the criteria and holds the evidence — so the transition consults it first. The seam is optional
   * because a caller with no completion support simply has no opinion, and a goal that no contract is bound to
   * keeps its old behaviour rather than being retroactively held to criteria nobody wrote.
   *
   * The seam *reads* the current evidence; it never runs checks of its own. A goal tool that executed a set of
   * unapproved verification commands would be a permission bypass wearing a lifecycle hook's clothes.
   */
  canComplete?: () => Promise<{ allowed: boolean; reason?: string }>;
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
    /**
     * Why the check failed, when the checker could say. Absent on success, and absent on every result recorded
     * before the field existed — which the repair policy reads as "not automatically repairable" rather than
     * guessing a reason from `detail`.
     */
    failureReason?: CheckFailureReason;
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
  /**
   * The evidence state of the completion contract this run was judged against, when it carried one.
   *
   * Separate from `status` on purpose. `status: 'completed'` says the run ended by itself; it never said the
   * request was satisfied, and before this field existed nothing in the result could say so. A run with no
   * contract leaves it unset — or reports `unverified` — rather than borrowing the `completed` word for a claim
   * no check made.
   */
  completion?: CompletionSummary;
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
export interface SessionInfo {
  title?: string;
  id: string;
  workspace: string;
  createdAt: string;
  activeRun: string | null;
  /** Set when this session belongs to a sub-agent run rather than to the user. */
  parentSessionId?: string | null;
  /** When a person archived it; absent or null while it is listed. */
  archivedAt?: string | null;
}
