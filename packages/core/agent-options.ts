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
import type { SubAgentResidency } from './residency.ts';
import type { SubAgentProvider } from './subagent-providers.ts';
import type { SubAgentOptions } from './subagents.ts';

export interface AgentOptions {
  /**
   * The execution environment this run reports, as a value or as a getter.
   *
   * A getter because the environment is *live*: the desktop can switch the sandbox between commands, and both the
   * prompt and the tool schema have to describe the environment in force when the round is built rather than the
   * one that was in force when the agent was constructed.
   */
  executionEnvironment?: string | (() => string);
  executionPolicy?: () => import('../protocol/execution.ts').ExecutionPolicy;
  modelInfo?: { model: string; protocol: string; connectionId?: string };
  supportsVision?: boolean;
  store: SessionStore;
  provider: Provider;
  /**
   * The model that writes compaction summaries, when it is not the run's own.
   *
   * A summary is a bounded rewrite of history that blocks the round waiting for it, so a faster, cheaper model is
   * usually the better trade (`YUANTU_SUMMARY_MODEL`). Its window must hold what a summary request carries: the
   * batch is cut to fit the *run's* window, so a summary model with a smaller one fails that request. Absent, the
   * run's provider writes its summaries, as it always did.
   */
  summaryProvider?: Provider;
  tools: ToolRegistry;
  approve: Approver;
  /**
   * How a run asks the human a structured question, when the host can ask one at all.
   *
   * Optional unlike `approve`, because asking is not an effect: a host that cannot reach a human (a
   * scheduled run, an embedded runtime) still runs, and the tool reports the missing answer to the model
   * instead of failing the call.
   */
  question?: Questioner;
  /**
   * The permission policy in force, read when a run builds the tool schema it sends.
   *
   * A getter rather than the policy itself because the policy can change between runs (the desktop's
   * permission mode is a setting) while one agent instance is reused. What the run does with it is trim:
   * a tool the policy denies every call of is not sent, so the schema the model sees is the schema it can
   * actually use. Hiding it is not the guarantee — the approver still consults the policy — but a run that
   * can only read should not be offered tools to write with.
   */
  permissionPolicy?: () => PermissionPolicyView | undefined;
  onEvent?: (event: AgentEvent) => void;
  /** Delegation limits. Sub-agents are enabled by default and capped by `SUBAGENT_DEFAULTS`. */
  subagents?: SubAgentOptions;
  /**
   * Resolves the provider a sub-agent should use when it asked for a specific model, or `undefined`
   * when this host cannot serve that model. Its presence is what lets the built-in provider advertise
   * the `agentOptions` capability: without a resolver, a task that names a model is refused loudly
   * instead of silently running on the default one.
   */
  subagentProviderFor?: (model: string) => Provider | undefined;
  /** Additional sub-agent providers, registered after the built-in `in-process` one. */
  subagentProviders?: readonly SubAgentProvider[];
  /** Which sub-agent provider this run delegates to. Defaults to the built-in `in-process`. */
  subagentProvider?: string;
  /**
   * The models this host can actually run a sub-agent on, for the `list_subagent_models` tool.
   *
   * Left out by a host with nothing to say, and then the tool is absent rather than empty: the list is a
   * promise that a named model will resolve, and a host that cannot make that promise must not appear to.
   */
  subagentModels?: () => readonly { model: string; note?: string }[];
  /** Characters of this session's transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptChars?: number;
  /** Messages of this session's transcript a forked child starts with. Defaults to `RUN_DEFAULTS`. */
  forkTranscriptMessages?: number;
  /**
   * Keeps delegated children resident after their first turn, so a later run in the same session can ask
   * them for more instead of delegating the same ground again.
   *
   * Without one, delegation stays one-shot: the child runs, reports, and its activation is gone. The
   * residency is host-owned because it must outlive runs; see `packages/core/residency.ts` for the
   * trade-offs it brings (children own their tools, and their usage is attributed to their own sessions).
   */
  subagentResidency?: SubAgentResidency;
  /**
   * Where this run publishes and checks runtime invariants.
   *
   * Host-owned, because the registry outlives any one run and a package other than this one registers into
   * it. A run contributes the one invariant that is genuinely per-run state — the tool pipeline trace — and
   * withdraws it when it ends.
   */
  invariants?: InvariantRegistry;
  /**
   * Builds the tool registry a *resident* child owns for its whole residency.
   *
   * A resident child cannot borrow the parent run's registry, because that run ends and closes it. Without
   * a factory, residency is refused rather than silently degraded to borrowing: a child whose tools vanish
   * between turns would fail in a way nobody could attribute.
   */
  childTools?: (binding?: WorkspaceBinding) => ToolRegistry;
  /**
   * Which directory this session actually executes in.
   *
   * Absent for an embedder that manages no workspaces, and then a session's directory is its project — the
   * pre-isolation behaviour, unchanged. Present, it answers for *this session's* binding, which is what lets a
   * delegated child whose directory is a worktree load the instructions, skills and outline of the tree it is
   * actually editing rather than the delegator's.
   *
   * It is a resolver rather than a string because the binding is durable state: a call that read it once at
   * construction would keep using a directory that a restart or a restore has since replaced.
   */
  workspaceRoots?: (sessionId: string) => { projectRoot: string; executionRoot: string };
  /**
   * How this run's delegations decide where a child executes.
   *
   * Absent means `shared`, which is exactly what delegation did before isolation existed: every child runs in the
   * delegator's own directory, and the parent's change list shows its work directly. `auto` is what a shipped
   * product selects, and `worktree` isolates read-only children as well as writing ones.
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
   * This agent's own persona, which **replaces** the deployment's rather than adding to it.
   *
   * `rolePrompt` above is additive and sits near the end of the prompt: a child that carries one is told both
   * what the parent was told about itself and what the child is. That is right for a role and wrong for a
   * persona — a persona is the paragraph that says who is speaking, and two of them in one prompt is the model
   * being handed a contradiction to average. This is the same text in a slot that shadows, so a host that
   * composes per-session personas (a support agent, a reviewer, a specialist child) has one place to put it.
   */
  persona?: string;
  /**
   * The deployment's persona, as opposed to this agent's.
   *
   * Both live in the same prompt slot and {@link persona} shadows this one, so a host can state a default
   * persona once (on every agent it composes) and let one agent replace it. Registering the deployment's even
   * when it is not overridden is what lets the prompt trace say which persona was in effect.
   */
  deploymentPersona?: string;
  /** How many delegation levels above this agent. A child is one deeper than its parent. */
  subagentDepth?: number;
  /**
   * Identifies this run as a delegated child, so the effects it causes can name it: the file-change
   * journal and every approval it raises carry this tag. Without it a sub-agent's write is
   * indistinguishable from the parent's own work in the session change list.
   */
  subagentTag?: SubAgentTag;
  /**
   * False for a sub-agent, which borrows its parent's tool registry and provider. Those resources
   * outlive the child: closing them there would take down the parent's language servers, background
   * commands and MCP connections mid-run.
   */
  ownsToolResources?: boolean;
  /** Parent task attempt whose effects a delegated child must journal. */
  taskEffectScope?: { sessionId: string; taskId: string; attemptId: string };
  maxContextChars?: number;
  maxContextTokens?: number;
  /**
   * The capacity of a model this run may be re-aimed at, when the host can resolve one.
   *
   * A window is a property of a *route*, not of a run: a pre-step policy that moves a round onto another model
   * moves it onto that model's window as well, and measuring the round against the model it is no longer using
   * is how a run compacts too early on a wide model or overruns a narrow one. The resolver answers for the
   * model a round will actually use — the connection's declaration, the catalogue this project ships, or
   * nothing — and `undefined` means "no opinion", which leaves this run's own window in place rather than
   * inventing a second one.
   */
  capacityFor?: (model: string) => { contextWindow: number; maxOutputTokens?: number } | undefined;
  autoCompactTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  /** How many times a round's model request may be re-sent after a transient failure. */
  maxModelRetries?: number;
  /** How many times an attempt that produced no bytes at all may be re-sent, on top of that allowance. */
  zeroByteRetries?: number;
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
   * A delegated child ends by calling `submit_report`, so the parent gets findings it can cite
   * instead of prose. Only set for a child run: only a child has a parent waiting for the answer.
   */
  reportRequired?: boolean;
  /**
   * The object this child must come back with, when its caller wants a shape of its own.
   *
   * The tool it submits through takes *this* schema as its argument schema, so the answer is validated by
   * the same Ajv pass every other tool call gets — a call that arrives is a call that conforms. The result
   * carries it as `data` instead of `report`.
   */
  reportSchema?: Record<string, unknown>;
  /** The `planning` row this run will fill in when `submit_plan` is called. */
  planId?: string;
  /** An approved plan to execute. Its approval and hash were checked before the run started. */
  approvedPlan?: Plan;
  /**
   * The completion contract this run is judged against, when it carries one of its own.
   *
   * A task's contract is built from the task definition and cannot be supplied here: the operator's
   * definition of done is not something the caller of a run gets to replace. This field is for an ordinary
   * request or an approved plan, which have no task row to read a definition from.
   */
  completion?: CompletionSpec;
  /** Let the agent select checks for ordinary desktop requests and approved plans. */
  autoVerify?: boolean;
  /** A previously recorded contract to continue, by id. Conflicts with `completion` and with `taskId`. */
  resumeCompletionId?: string;
  /** How much repair this run may spend before it stops. Callers may lower it or raise it to the ceilings. */
  completionRepairPolicy?: CompletionRepairPolicy;
  /**
   * The file range a task's checks are about.
   *
   * Only meaningful for a task (its own definition supplies the rest) and only for verification: it says
   * which files the evidence covers, never what "done" means. Supplying it alongside an explicit
   * `completion` is a conflict rather than an override.
   */
  completionInputs?: string[];
  /**
   * Session that owns the file-change journal. A sub-agent sets it to the parent session, so its
   * writes appear in the session the user is actually looking at and remain undoable there.
   */
  journalSessionId?: string;
  /**
   * Who asked for this turn, when it is not the user.
   *
   * Absent means the user's own request, which is what every entry point's ordinary path is: the CLI's
   * `run` and `resume`, and the Host serving whatever a person did in a carrier. A round the runtime
   * started by itself says so, and there are exactly two such paths today — the goal continuations
   * (`runGoalRounds`) and a task run the clock triggered. The distinction is what the goal tools read to
   * decide whether they may change *who is in charge* of the goal; see `HUMAN_ONLY_GOAL_ACTIONS`.
   *
   * The default is `human` rather than `automatic` on purpose. Defaulting the other way would silently take
   * the ability to pause or re-aim a goal away from every embedder that has not been told about this field,
   * including ones whose runs are all requests from a person; defaulting this way leaves the two automatic
   * paths above to opt in, which is a list short enough to keep true.
   */
  authority?: 'human' | 'automatic';
};
