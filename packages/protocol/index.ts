import type { FailureCode } from './failure.ts';
import type { ToolOutputContract, ToolResultOutput } from './tool-result.ts';
import type { CheckFailureReason, CompletionSummary } from './completion.ts';
import type { PreparedRequestFingerprint } from './request-cache.ts';
import type { ExecutionPolicy } from './execution.ts';
export * from './tool-contract.ts';
export * from './events.ts';
export * from './tasks.ts';
export * from './tool-families.ts';

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
 * One image as the session database stores it: a content address instead of the bytes. `hash` is
 * the sha256 of the decoded bytes, so re-attaching the same picture is one `attachment_blobs` row.
 * The storage layer hydrates every reference before a `Message` leaves it; an unresolvable one is
 * an error.
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
  /** Saved connections with different credentials must not share native continuation state. */
  connectionId?: string;
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
       * An answer the runtime is about to replace in the same turn (e.g. after a verification
       * nudge). It stays in the transcript sent to the model; renderers hide it once a later answer
       * exists.
       */
      provisional?: boolean;
      /**
       * The model's reasoning, kept for display in reopened sessions. Never replayed directly;
       * adapters replay native reasoning from `providerState` only to its original route.
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
/** Which sub-agent produced an effect, carried on the record so consumers can name the child. */
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
   * The shape of this tool's results, when they are more than text. Declared once on the tool, not
   * per result. Never shown to the model (`ToolRegistry.specs` sends only name, description and
   * input schema). Absent means no structured payload (see `ToolResult.output`).
   */
  output?: ToolOutputContract;
}
export interface Usage {
  cachedInputTokens?: number;
  /**
   * Input tokens written into the prompt cache, when reported. Part of `inputTokens`, not an
   * addition; kept separate because reads and writes cost differently.
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
   * How the turn ended. `content-filter` is the endpoint's policy stopping the turn (OpenAI
   * `content_filter`, Anthropic `refusal`, Responses `incomplete_details.reason`); it is neither a
   * clean `stop` nor a `length` limit.
   */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content-filter';
  /**
   * Set when the provider named the context window, not the output limit, as the cause of a
   * `length` finish. Only a window overflow is recovered by compressing and re-sending.
   */
  truncation?: 'context-window';
  usage: Usage;
}
/**
 * How much reasoning a request asks for. A level because two protocols speak levels; Anthropic's
 * token budget is mapped in `packages/providers/effort.ts`. `none` sends no reasoning parameter at
 * all, so a policy can undo an earlier choice.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'none';
/**
 * The protocols this build ships an adapter for. The `YUANTU_PROTOCOL` enum and the provider
 * registry are built from it. Hosts may register more adapters, but the environment path stays
 * these three.
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
   * The model's reasoning as it streams. A separate channel so it can never be stored or counted as
   * the answer; it alone never authorizes replay.
   */
  onReasoning?: (text: string) => void;
  onProgress?: (progress: ModelProgress) => void;
  /**
   * The model for this request, when not the provider's configured one. Per request so a run can
   * switch models mid-conversation; the cache key follows the serving model.
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
   * `none` forbids tool calls while still sending the catalogue, which is part of the cacheable
   * prefix. Set only when retrying a summary that answered with a tool call. Omitted means `auto`.
   */
  toolChoice?: 'none';
  /** Disable parallel calls only for a route that dropped required arguments. */
  parallelToolCalls?: false;
  /** Strict validation belongs only to the one recovery response. Never serialized. */
  toolArgumentsRecovery?: boolean;
  /** Measurement identity of the discarded request. Never serialized. */
  degradedFrom?: number;
}
export interface Provider {
  /** Non-secret routing identity for embedders that do not supply modelInfo. */
  readonly route?: { protocol: string; model: string };
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
   * For a command: what its backend will and will not stop, as data so the interface can phrase it
   * in the reader's language.
   */
  boundary?: Pick<ExecutionPolicy, 'processFiles' | 'network'>;
  /**
   * What this call asks for beyond its session's policy, so blanket approvals like
   * `--allow-command` do not grant it.
   */
  escalation?: { network: 'unrestricted' };
}
/**
 * `timeout`: someone could have answered and did not. `unavailable`: nobody to ask. The model is
 * told different things, so an approver's own deadline must report `timeout`.
 */
export type ApprovalDecisionSource =
  'user' | 'policy' | 'launch-options' | 'task-approval' | 'unavailable' | 'timeout';
export type Approver = ((approval: Approval, signal: AbortSignal) => Promise<boolean>) & {
  /** The decision just made for this call. Omitted by legacy human approvers. */
  decisionSource?: (approval: Approval) => ApprovalDecisionSource | undefined;
  /**
   * Why a refusal was made, when it is policy rather than a person. Without it `false` reads as
   * "the user said no", and a read-only run should make the model propose a plan instead.
   */
  decisionReason?: (approval: Approval) => string | undefined;
};
/** One choice a question offers. `label` identifies the option, so duplicates are refused. */
export interface QuestionOption {
  label: string;
  description?: string;
  /**
   * The option the asker would pick, shown as a badge without reordering. A field rather than label
   * text so the interface never edits model-written labels.
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
   * The tool call that asked, so the client can withdraw its panel when the wait ends unanswered.
   */
  callId?: string;
}
export interface QuestionAnswer {
  id: string;
  selected: string[];
  freeText?: string;
}
/**
 * Why a question came back without an answer. `timedOut` duplicates `reason === 'timeout'` for
 * convenience.
 */
export interface QuestionOutcome {
  answered: boolean;
  answers: QuestionAnswer[];
  timedOut?: boolean;
  reason?: 'timeout' | 'cancelled' | 'unavailable';
}
/** Asking a human is not an effect, so it is allowed in read-only and planning runs. */
export type Questioner = (
  request: QuestionRequest,
  signal: AbortSignal,
) => Promise<QuestionOutcome>;
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
/**
 * One line of the session's progress list: "what am I doing now" within a run. Not a durable task
 * and not a workspace effect, so it needs no permission.
 */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}
/** A guard rather than a cast: the log may come from another build. */
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
 * The session's todo list as the tool sees it, so the tool stays ignorant of sessions and storage.
 * Writing records the event and announces it.
 */
export interface TodoList {
  read(): TodoItem[];
  write(items: TodoItem[]): TodoItem[];
}
/**
 * The files this session has presented as deliverables. Same seam as `TodoList`: reading is the
 * fold, writing appends and announces in one call.
 */
export interface DeliverableLog {
  read(): import('./deliverables.ts').PresentedFile[];
  write(files: readonly import('./deliverables.ts').PresentedFile[]): void;
}
/**
 * The session's goal and the one way to change it. `write` takes the whole resulting goal;
 * transitions live in `packages/protocol/goals.ts`. The newest event is the goal, so reloads need
 * no replay.
 */
export interface GoalLog {
  read(): import('./goals.ts').Goal | null;
  /**
   * Record a change. The runtime itself performs `create` (new goal, first round is this run) and
   * `round` (one more run admitted to an existing goal).
   */
  write(action: import('./goals.ts').GoalChangeAction, goal: import('./goals.ts').Goal): void;
  /**
   * Whether this turn carries the user's own input. `edit`, `pause` and `resume` are reserved for
   * the user (`HUMAN_ONLY_GOAL_ACTIONS`), and only the caller knows whose turn this is.
   */
  human: boolean;
  /**
   * Whether a completion contract permits closing this goal as complete. Optional: without a
   * contract the goal keeps its plain behaviour. It reads current evidence only and never runs
   * checks itself, which would bypass permissions.
   */
  canComplete?: () => Promise<{ allowed: boolean; reason?: string }>;
}
export type RunStatus = 'completed' | 'needs_review' | 'cancelled' | 'limited' | 'failed';
/**
 * Where a plan sits in plan -> approve -> execute. `planning` is durable so a crash mid-plan leaves
 * a record; settling an interrupted run moves its unfinished plan to `abandoned`. `submitPlan`
 * refuses it.
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
     * Why the check failed, when known. Absent on success and on older results, which the repair
     * policy treats as not automatically repairable.
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
  cancelReason?: import('./run-cancellation.ts').CancelReason;
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
   * The completion contract's evidence state for this run, when it carried one. Separate from
   * `status`: `completed` only means the run ended by itself, not that the request was satisfied.
   */
  completion?: CompletionSummary;
  /** One entry per sub-agent this run delegated to, in the order the tasks were requested. */
  subagents?: SubAgentSummary[];
  /** A delegated run's structured report. Only set by a child run (`reportRequired`). */
  report?: SubAgentSummaryReport;
  /**
   * A delegated run's answer when its task declared its own `schema`; validated by Ajv like any
   * tool argument. Only one of `report` and `data` is ever set.
   */
  data?: unknown;
  error?: string;
  /**
   * Why the run ended, when the reason has a name, so code need not match on `error`. Absent when
   * the failure was prose only.
   */
  code?: FailureCode;
  /**
   * The HTTP status a failed model request ended on. `status` is already this result's outcome,
   * hence the name.
   */
  httpStatus?: number;
  /** The endpoint's request id for the failed request, when it sent one. */
  requestId?: string;
}
/**
 * A delegated child run with its own session and context. `explore` is read-only by construction;
 * `general` inherits the parent's permissions and still asks for each write.
 */
export type SubAgentRole = 'explore' | 'general';
export type SubAgentTaskStatus = RunStatus | 'running' | 'skipped' | 'interrupted';
export interface SubAgentFinding {
  statement: string;
  /** How the child knows: a command and its result, or a file and what is in it. */
  evidence: string;
  paths?: string[];
}
/** A child's structured report, so the parent can cite, distrust or act on specific findings. */
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
   * Wall time of this child's ended turns in ms, excluding idle time between turns. The running
   * turn is in `runningSince`. Derived from the child's log (`turnTiming`), so it survives reloads.
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
