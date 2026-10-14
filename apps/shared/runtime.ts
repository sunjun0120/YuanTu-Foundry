import { resolveSandboxConfig } from '../../packages/tools/sandbox.ts';
import {
  executionPolicy as callExecutionPolicy,
  withExecutionPolicy,
} from '../../packages/tools/execution-policy.ts';
import type { ExecutionPolicy } from '../../packages/protocol/execution.ts';
import type { BackgroundCommands } from '../../packages/tools/background.ts';
import type { TerminalSessions } from '../../packages/tools/terminal.ts';
import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { SessionStore } from '../../packages/storage/sqlite.ts';
import { Agent } from '../../packages/core/agent.ts';
import { createTools } from '../../packages/tools/index.ts';
import { WorkspaceManager } from '../../packages/workspaces/manager.ts';
import { WorkspaceResultsService } from '../../packages/workspaces/results.ts';
import type { WorkspaceMode } from '../../packages/protocol/workspaces.ts';
import type { HookRegistry } from '../../packages/tools/hooks.ts';
import { createProvider, readConfig } from '../../packages/providers/index.ts';
import type { ProviderConfig } from '../../packages/providers/config.ts';
import {
  declaredRoutes,
  resolveRouteCapacity,
  type RouteCapacity,
} from '../../packages/providers/capacity.ts';
import {
  AUTOMATIC_CONTEXT_TOKENS,
  AUTOMATIC_OUTPUT_TOKENS,
  automaticOutputBudget,
  discoverAutomaticCapacities,
} from '../../packages/providers/automatic-capacity.ts';
import type { SubAgentResidency } from '../../packages/core/residency.ts';
import type { InvariantRegistry } from '../../packages/core/invariants.ts';
import type { PermissionPolicyView } from '../../packages/protocol/permissions.ts';
import type { AgentEvent, Approver, Questioner } from '../../packages/protocol/index.ts';
import type { Options } from './args.ts';
import { redactSecrets } from '../../packages/core/errors.ts';
import { parseSetting } from '../../packages/protocol/settings.ts';
/**
 * The route a run's measurements belong to, from the configuration this process reads.
 *
 * Exported because more than one caller has to answer "which endpoint is this about" and the answers have to be
 * the same string: a calibration recorded under a route no run reads is a measurement nothing will ever use, and
 * one recorded under a second name for the same endpoint is a correction that never accumulates. The Host's manual
 * compaction is the other caller — it prices a summary request for the same route the rounds around it use.
 */
export function modelInfoFor(config: ProviderConfig): {
  model: string;
  protocol: string;
  connectionId?: string;
} {
  return {
    model: redactSecrets(config.model),
    protocol: config.protocol ?? 'anthropic',
    connectionId: process.env.YUANTU_CONNECTION_ID || undefined,
  };
}

export function executionEnvironment(): string {
  const mode = resolveSandboxConfig().mode;
  const web =
    ' Web search, page fetch and browser tools run in the Host process behind their own approval, independently of this command sandbox.';
  if (mode !== 'host') {
    const backend =
      mode === 'native'
        ? process.platform === 'win32'
          ? 'windows'
          : process.platform === 'darwin'
            ? 'seatbelt'
            : 'unavailable'
        : mode;
    return (
      (backend === 'windows'
        ? 'Command environment: Windows native restricted-token sandbox, real workspace and private scratch. Filesystem enforcement is partial; reads and network are unconfined. Required unsupported policies fail closed.'
        : backend === 'seatbelt'
          ? 'Command environment: macOS native Seatbelt sandbox, /bin/sh, real workspace and private scratch. File and network access follow the selected policy. Unsupported policies fail closed.'
          : 'Command environment: native sandbox unavailable on this platform; command execution must fail closed.') +
      web
    );
  }
  return `Command environment: host ${process.platform}, shell ${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}. Host commands are not OS-sandboxed; permissions still apply.${web}`;
}

/** Shipped apps select native isolation; an unavailable backend never selects host implicitly. */
export function applySandboxDefaults(env: NodeJS.ProcessEnv = process.env): void {
  env.YUANTU_SANDBOX ??= 'native';
}
export function resolveWorkspace(input: string): string {
  const root = realpathSync(path.resolve(input));
  if (!statSync(root).isDirectory()) throw new Error('Workspace must be an existing directory');
  return root;
}
/**
 * The context window this run measures every request against.
 *
 * Resolved, never assumed: the operator's declaration for the connection (`--max-context-tokens`,
 * `YUANTU_MAX_CONTEXT_TOKENS`, the model entry in the desktop settings) wins, then the small catalogue this
 * project stands behind for an endpoint it ships knowledge about (`packages/providers/capacity.ts`), and
 * `discoverModels()` is what produces a number worth declaring for everything else.
 *
 * With no declaration or metadata, the entry points use a local application budget. It is not an assertion
 * about the endpoint's real limit; provider-confirmed overflow still uses the kernel's bounded recovery.
 */
export function declaredCapacity(options: Options, config: ProviderConfig): number {
  return capacityResolver(options, config)(config.model)!.contextWindow;
}
/** What the operator declared for this connection's configured route. */
function declaredRoute(
  options: Options,
  config: ProviderConfig,
): { contextWindow?: number; maxOutputTokens?: number } {
  const window = options.maxContextTokens ?? config.maxContextTokens;
  return {
    ...(window === undefined ? {} : { contextWindow: window }),
    ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
  };
}
/**
 * The window of whichever model a round ends up using.
 *
 * A declaration is a statement about *this connection's model*, so it answers for that model and no other; the
 * models beside it on the same endpoint are answered by what the operator saved for them
 * (`YUANTU_MODEL_CAPACITIES`, written by the desktop from the endpoint group's model rows) and then by the
 * catalogue this project ships, discovered metadata, then a local budget. An unknown sibling does not borrow
 * the active model's manually declared window.
 */
export function capacityResolver(
  options: Options,
  config: ProviderConfig,
  automatic: ReadonlyMap<string, RouteCapacity> = new Map(),
): (model: string) => RouteCapacity {
  const base = config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl };
  const declared = declaredRoute(options, config);
  const routes = declaredRoutes(process.env.YUANTU_MODEL_CAPACITIES);
  const configuredLabel = modelInfoFor(config).model;
  return (model) => {
    // The kernel holds a redacted display label; capacity lookup needs the configured route ID.
    if (model === configuredLabel) model = config.model;
    const resolved = resolveRouteCapacity({
      model,
      ...base,
      ...(model === config.model ? { declared } : {}),
      routes,
    }) ??
      automatic.get(model.trim()) ?? {
        contextWindow: AUTOMATIC_CONTEXT_TOKENS,
        maxOutputTokens: AUTOMATIC_OUTPUT_TOKENS,
        source: 'default' as const,
      };
    const declaredOutput =
      (model === config.model ? (options.maxOutputTokens ?? config.maxOutputTokens) : undefined) ??
      routes.get(model.trim())?.maxOutputTokens;
    const defaultOutput = automaticOutputBudget(resolved.contextWindow);
    return {
      ...resolved,
      maxOutputTokens:
        declaredOutput ?? Math.min(defaultOutput, resolved.maxOutputTokens ?? defaultOutput),
    };
  };
}
/** Share the connection budget between normal runs and manual context compaction. */
export async function resolveConnectionCapacities(
  options: Options,
  config: ProviderConfig,
  signal?: AbortSignal,
): Promise<(model: string) => RouteCapacity> {
  signal?.throwIfAborted();
  const known = resolveRouteCapacity({
    model: config.model,
    baseUrl: config.baseUrl,
    declared: declaredRoute(options, config),
    routes: declaredRoutes(process.env.YUANTU_MODEL_CAPACITIES),
  });
  const automatic = known
    ? new Map<string, RouteCapacity>()
    : await discoverAutomaticCapacities(config, { signal });
  signal?.throwIfAborted();
  return capacityResolver(options, config, automatic);
}
/**
 * The models a sub-agent may be asked to run on, as this process can honestly promise them.
 *
 * The configured model comes first because it is the one thing here that is certainly served, and the
 * declared extras follow in the order the operator wrote them. Duplicates are dropped so a list that names
 * the configured model again does not read as two choices, and the whole list is bounded because it is
 * rendered into a tool result the model reads.
 */
export function subagentModels(active: string): { model: string; note?: string }[] {
  const declared = String(parseSetting(process.env, 'YUANTU_SUBAGENT_MODELS') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const models = [active, ...declared].filter((model, index, all) => all.indexOf(model) === index);
  return models.map((model) =>
    model === active
      ? { model, note: 'the model this session is configured with' }
      : { model, note: 'declared by YUANTU_SUBAGENT_MODELS' },
  );
}
export function sessionDatabasePath(options: Options): string {
  return path.resolve(
    options.db ?? path.join(options.workspace ?? process.cwd(), '.yuantu', 'sessions.sqlite'),
  );
}
/**
 * Whether the effective policy permits the Git metadata operations a managed worktree needs.
 *
 * The plan's rule is that worktree management is *controlled infrastructure work*: it needs a policy that can say
 * it is safe to write repository metadata. Only the host policy currently can, and the answer is deliberately
 * about the policy rather than about the platform — a native sandbox that cannot state whether it may manage Git's
 * own files must fail with `WORKSPACE_POLICY_UNSUPPORTED` instead of running outside the policy it was given.
 */
export function metadataWritesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = resolveSandboxConfig(env);
  return config.mode === 'host' && config.files !== 'read-only';
}
/**
 * The execution-directory mode this process delegates under.
 *
 * Read from the setting rather than defaulted here, so a mistyped value fails at startup with the list of ones
 * that exist instead of silently becoming the default — a workspace mode is a statement about isolation, and
 * "isolation was quietly off" is the one answer that must never be produced by a typo.
 */
export function workspaceModeFor(
  options: { subagentWorkspace?: string },
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceMode {
  const raw = options.subagentWorkspace ?? parseSetting(env, 'YUANTU_SUBAGENT_WORKSPACE');
  // The shipped default: a write-capable child gets its own directory, and a read-only one shares the delegator's.
  if (raw === undefined || raw === '') return 'auto';
  if (raw === 'auto' || raw === 'shared' || raw === 'worktree') return raw;
  throw new Error(
    `YUANTU_SUBAGENT_WORKSPACE must be auto, shared or worktree (got ${JSON.stringify(raw)})`,
  );
}
export function openStore(options: Options): SessionStore {
  return new SessionStore(sessionDatabasePath(options));
}
export async function createAgent(
  store: SessionStore,
  workspace: string,
  options: Options,
  approve: Approver,
  permissionPolicy: () => PermissionPolicyView | undefined,
  onEvent: (event: AgentEvent) => void,
  background?: BackgroundCommands,
  scope?: string,
  hooks?: HookRegistry,
  residency?: SubAgentResidency,
  question?: Questioner,
  invariants?: InvariantRegistry,
  /**
   * The process's terminal manager, when the host offers terminals at all.
   *
   * It is passed rather than built here for the same reason the background manager is: a terminal belongs to the
   * *session* and has to outlive the run that opened it, so exactly one manager per host owns them and every run
   * of a session reaches the same one through its scope. A host that passes nothing has no `terminal_*` tools,
   * which is the honest state for a process with nowhere to put a terminal — or one that would rather not have
   * a shell on the host behind an approval prompt.
   */
  terminals?: TerminalSessions,
  executionPolicy?: () => ExecutionPolicy,
  signal?: AbortSignal,
): Promise<Agent> {
  const config = readConfig();
  const provider = createProvider(config);
  const capacityFor = await resolveConnectionCapacities(options, config, signal);
  const capacity = capacityFor(config.model);
  const policyForCall =
    executionPolicy ??
    (() => {
      const config = resolveSandboxConfig();
      return callExecutionPolicy(config.mode, config);
    });
  const workspaces = new WorkspaceManager({
    store,
    // Session overrides can change after construction; use the same live policy as the child's tools.
    metadataWritesAllowed: () =>
      withExecutionPolicy(policyForCall(), () => metadataWritesAllowed()),
    onDiagnostic: (message) => console.error(`[workspace] ${message}`),
  });
  const workspaceResults = new WorkspaceResultsService({
    store,
    onDiagnostic: (message) => console.error(`[workspace] ${message}`),
  });
  return new Agent({
    store,
    executionEnvironment: () => withExecutionPolicy(policyForCall(), () => executionEnvironment()),
    executionPolicy: policyForCall,
    modelInfo: modelInfoFor(config),
    supportsVision: config.supportsVision ?? true,
    tools: createTools(workspace, background, scope, hooks, undefined, terminals),
    provider,
    /**
     * Per-child model selection, wired to the same configuration the run itself uses.
     *
     * This runtime talks to one configured endpoint, so a child may name any model that endpoint
     * serves; a model it does not serve fails at request time with the provider's own error, and the
     * child reports that error like any other failure. Naming the model the run already uses reuses the
     * existing client. Without this resolver the built-in provider does not advertise `agentOptions`,
     * and a task that names a model is refused instead of silently running on the default one.
     */
    subagentProviderFor: (requested) =>
      requested === config.model ? provider : createProvider({ ...config, model: requested }),
    /**
     * What `list_subagent_models` answers with.
     *
     * Deliberately short: this runtime can *construct* a client for any model id, so the honest list is the
     * set an operator has declared — the configured model plus `YUANTU_SUBAGENT_MODELS`. Listing anything
     * else would promise that the endpoint serves it, which is exactly what this runtime cannot know.
     */
    subagentModels: () => subagentModels(config.model),
    forkTranscriptChars: options.forkTranscriptChars,
    forkTranscriptMessages: options.forkTranscriptMessages,
    approve,
    // Absent for an embedder that cannot reach a human: the tool then reports the missing answer rather than
    // failing the call, which is why a run without a questioner still starts.
    ...(question ? { question } : {}),
    // Host-owned and optional: an embedder with no registry simply runs without any runtime invariant
    // checking, which is the same behaviour every package had before this seam existed.
    ...(invariants ? { invariants } : {}),
    permissionPolicy,
    onEvent,
    // The kernel keeps delegation off; every user-facing entry point turns it on. The per-run caps
    // stay in the kernel, because they bound what one agent may spend without asking.
    subagents: {
      enabled: options.subagents !== false,
      ...(options.subagentConcurrency === undefined
        ? {}
        : { maxConcurrency: options.subagentConcurrency }),
      // Absent means the kernel's own default, which is the ten-minute stall watchdog. An operator who wants a
      // different window sets one; zero is accepted and means the watchdog is off entirely, which is a real
      // choice with a real cost — see `SubAgentOptions.timeoutMs` for why the bound exists by default.
      ...(options.subagentTimeoutMs === undefined ? {} : { timeoutMs: options.subagentTimeoutMs }),
    },
    /**
     * Resident children, when the process owner supplied a residency.
     *
     * A resident child cannot borrow this run's registry — the run ends and closes it — so it gets its own,
     * built by `childTools`. That is a real cost: each resident child owns its language servers, background
     * commands and MCP connections. It is the price of a child that outlives the run that started it, and it
     * is why residency is opt-in per process rather than a default.
     *
     * The factory is always supplied, not only when there is a residency, because an *isolated* child needs one
     * too: it works in a directory this run's tools were never bound to, so borrowing them would mean reading and
     * writing the delegator's tree. `childTools` is called with the child's binding; the fallback keeps every
     * existing caller working unchanged.
     */
    subagentResidency: residency,
    childTools: (binding) =>
      createTools(binding?.executionRoot ?? workspace, undefined, 'subagent', hooks),
    workspaceMode: workspaceModeFor(options),
    workspaceManager: workspaces,
    workspaceResults,
    workspaceApply: workspaceResults,
    /**
     * Where a session actually executes, resolved per call rather than captured.
     *
     * The fallback matters as much as the resolution: a session whose binding cannot be read is a session whose
     * directory this process must not guess at, so it keeps its project — which is exactly what it did before
     * isolation existed.
     */
    workspaceRoots: (sessionId) => {
      try {
        const binding = workspaces.resolve(sessionId);
        return { projectRoot: binding.projectRoot, executionRoot: binding.executionRoot };
      } catch {
        const projectRoot = store.get(sessionId).workspace;
        return { projectRoot, executionRoot: projectRoot };
      }
    },
    maxContextChars: options.maxContextChars,
    maxContextTokens: capacity.contextWindow,
    // Per round, not per run: a policy that moves a round onto another model moves it onto that model's window
    // too, and the catalogue is what can answer for a model the operator declared nothing about.
    capacityFor,
    autoCompactTokens: options.autoCompactTokens,
    maxOutputTokens: capacity.maxOutputTokens ?? options.maxOutputTokens,
    requestTimeoutMs: options.requestTimeoutMs,
    maxModelRetries: options.maxModelRetries,
    maxParallelToolCalls: options.maxParallelToolCalls,
    toolResultKeepRecent: options.toolResultKeepRecent,
    toolResultShrinkTokens: options.toolResultShrinkTokens,
    toolResultPruneThresholdChars: options.toolResultPruneThresholdChars,
    toolResultPruneHeadChars: options.toolResultPruneHeadChars,
    toolResultPruneTailChars: options.toolResultPruneTailChars,
    contextShrinkPercent: options.contextShrinkPercent,
  });
}
export function safeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : 'Operation failed');
}
export function display(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
