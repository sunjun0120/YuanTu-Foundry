import type {
  AgentEvent,
  Approver,
  CompletionRepairPolicy,
  CompletionSpec,
  Plan,
  Provider,
  Questioner,
  SubAgentTag,
  TaskTriggerSource,
  UserInput,
} from '../protocol/index.ts';
import type { PermissionPolicyView } from '../protocol/permissions.ts';
import type { WorkspaceBinding, WorkspaceMode } from '../protocol/workspaces.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { WorkspaceManager } from '../workspaces/manager.ts';
import type { WorkspaceApply, WorkspaceResults } from '../workspaces/results.ts';
import type { InvariantRegistry } from './invariants.ts';
import type { SubAgentResidency } from './subagents/residency.ts';
import type { SubAgentProvider } from './subagents/providers.ts';
import type { SubAgentOptions } from './subagents/delegation.ts';

export interface AgentOptions {
  /**
   * The execution environment this run reports, as a value or a getter, since the sandbox can
   * switch between commands.
   */
  executionEnvironment?: string | (() => string);
  executionPolicy?: () => import('../protocol/execution.ts').ExecutionPolicy;
  modelInfo?: { model: string; protocol: string; connectionId?: string };
  supportsVision?: boolean;
  store: SessionStore;
  provider: Provider;
  /**
   * The model that writes compaction summaries, when not the run's own (`YUANTU_SUMMARY_MODEL`).
   * Its window must hold a batch cut to the run's window. Absent, the run's provider writes them.
   */
  summaryProvider?: Provider;
  tools: ToolRegistry;
  approve: Approver;
  /**
   * How a run asks the human a structured question. Optional: hosts that cannot reach a human still
   * run, and the tool reports the missing answer.
   */
  question?: Questioner;
  /**
   * The permission policy in force, read when building the tool schema. Tools denied for every call
   * are not sent; the approver still enforces the policy.
   */
  permissionPolicy?: () => PermissionPolicyView | undefined;
  onEvent?: (event: AgentEvent) => void;
  /** Delegation limits. Sub-agents are enabled by default and capped by `SUBAGENT_DEFAULTS`. */
  subagents?: SubAgentOptions;
  /**
   * Resolves a provider for a sub-agent that asked for a specific model, or `undefined`. Without
   * it, tasks naming a model are refused rather than run on the default.
   */
  subagentProviderFor?: (model: string) => Provider | undefined;
  /** Additional sub-agent providers, registered after the built-in `in-process` one. */
  subagentProviders?: readonly SubAgentProvider[];
  /** Which sub-agent provider this run delegates to. Defaults to the built-in `in-process`. */
  subagentProvider?: string;
  /**
   * Models this host can run a sub-agent on, for `list_subagent_models`. Absent means the tool is
   * absent.
   */
  subagentModels?: () => readonly { model: string; note?: string }[];
  /** Characters of this session's transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptChars?: number;
  /** Messages of this session's transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptMessages?: number;
  /**
   * Keeps delegated children resident after their first turn, so later runs can ask them for more.
   * Without it, delegation is one-shot. Host-owned because it outlives runs; see
   * `packages/core/subagents/residency.ts`.
   */
  subagentResidency?: SubAgentResidency;
  /**
   * Where this run publishes and checks runtime invariants. Host-owned; the run adds and withdraws
   * only its tool pipeline trace.
   */
  invariants?: InvariantRegistry;
  /**
   * Builds the registry a resident child owns for its residency. Without it, residency is refused.
   */
  childTools?: (binding?: WorkspaceBinding) => ToolRegistry;
  /**
   * Which directory this session executes in. Absent means the project directory. A resolver
   * because the binding is durable state that restarts or restores can change.
   */
  workspaceRoots?: (sessionId: string) => { projectRoot: string; executionRoot: string };
  /**
   * How this run's delegations choose a child's directory. Absent means `shared`; `auto` is the
   * product default; `worktree` isolates every child.
   */
  workspaceMode?: WorkspaceMode;
  /** The workspace service, when this host manages isolated directories at all. */
  workspaceManager?: WorkspaceManager;
  /** Where a child's frozen results are exported from, by the child's own turn. */
  workspaceResults?: WorkspaceResults;
  /** Where those results are previewed and imported, by the parent's tools. */
  workspaceApply?: WorkspaceApply;
  /** Appended to the system prompt, to give a delegated child its role. */
  rolePrompt?: string;
  /**
   * This agent's own persona, which replaces the deployment's. Unlike the additive `rolePrompt`,
   * two personas in one prompt would contradict.
   */
  persona?: string;
  /**
   * The deployment's default persona, shadowed by `persona`. Registered even when overridden so the
   * prompt trace shows which one was in effect.
   */
  deploymentPersona?: string;
  /** How many delegation levels above this agent. A child is one deeper than its parent. */
  subagentDepth?: number;
  /** Identifies this run as a delegated child, so its file changes and approvals name it. */
  subagentTag?: SubAgentTag;
  /**
   * False for a sub-agent, which borrows its parent's registry and provider; closing them would
   * take down the parent's resources.
   */
  ownsToolResources?: boolean;
  /** Parent task attempt whose effects a delegated child must journal. */
  taskEffectScope?: { sessionId: string; taskId: string; attemptId: string };
  maxContextChars?: number;
  maxContextTokens?: number;
  /**
   * The capacity of a model this run may be re-aimed at. A window belongs to the route, so a round
   * moved to another model is measured against that model. `undefined` keeps the run's own window.
   */
  capacityFor?: (model: string) => { contextWindow: number; maxOutputTokens?: number } | undefined;
  autoCompactTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  /** How many times a round's model request may be re-sent after a transient failure. */
  maxModelRetries?: number;
  /** How many times an attempt that produced no bytes at all may be re-sent, on top of that allowance. */
  zeroByteRetries?: number;
  /** Model time a run may investigate before it is nudged to edit, and (at twice the nudge point) cut short. */
  investigationMs?: number;
  /** How many sibling tool calls from one assistant message may be in flight at once. */
  maxParallelToolCalls?: number;
  /** A run's total budget, `0` = that one off (see `RunDefaults.maxRunRounds`). */
  maxRunRounds?: number;
  maxRunMs?: number;
  maxRunTokens?: number;
  /** How many of the newest tool results are never shortened. */
  toolResultKeepRecent?: number;
  /** Characters a shortened tool result keeps. */
  toolResultShrinkTokens?: number;
  /** Code points a tool result may reach before its middle is dropped. */
  toolResultPruneThresholdChars?: number;
  /** Code points a pruned result keeps at its head. */
  toolResultPruneHeadChars?: number;
  /** Code points a pruned result keeps at its tail. */
  toolResultPruneTailChars?: number;
  /** Share of the window at which old tool results start being shortened. */
  contextShrinkPercent?: number;
}

export type AgentRunInput = UserInput & {
  /** Host admission epoch time, for measuring preparation before the first answer request. */
  admittedAt?: number;
  sessionId: string;
  prompt: string;
  signal?: AbortSignal;
  taskId?: string;
  taskTrigger?: TaskTriggerSource;
  resumeTask?: boolean;
  /** Read-only planning phase: the run must end by calling `submit_plan`. */
  planPhase?: boolean;
  /** A sub-agent that may investigate but not change anything. */
  readOnly?: boolean;
  /**
   * A delegated child ends by calling `submit_report`, giving the parent citable findings. Child
   * runs only.
   */
  reportRequired?: boolean;
  /**
   * The object this child must return, when its caller defines one. Used as the submit tool's
   * argument schema, so Ajv validates it; the result carries it as `data`.
   */
  reportSchema?: Record<string, unknown>;
  /** The `planning` row this run will fill in when `submit_plan` is called. */
  planId?: string;
  /** An approved plan to execute. Its approval and hash were checked before the run started. */
  approvedPlan?: Plan;
  /**
   * The completion contract for an ordinary request or approved plan. A task's contract comes from
   * its definition and cannot be supplied here.
   */
  completion?: CompletionSpec;
  /** Let the agent select checks for ordinary desktop requests and approved plans. */
  autoVerify?: boolean;
  /** A previously recorded contract to continue, by id. Conflicts with `completion` and with `taskId`. */
  resumeCompletionId?: string;
  /** How much repair this run may spend before it stops. Callers may lower it or raise it to the ceilings. */
  completionRepairPolicy?: CompletionRepairPolicy;
  /** The file range a task's evidence covers. Conflicts with an explicit `completion`. */
  completionInputs?: string[];
  /**
   * Session that owns the file-change journal; a sub-agent sets the parent's so its writes stay
   * visible and undoable there.
   */
  journalSessionId?: string;
  /**
   * Who asked for this turn. Absent means the user. Only goal continuations (`runGoalRounds`) and
   * clock-triggered tasks say `automatic`; the goal tools read it (`HUMAN_ONLY_GOAL_ACTIONS`).
   * Defaults to `human` so embedders keep the ability to pause or re-aim goals.
   */
  authority?: 'human' | 'automatic';
};
