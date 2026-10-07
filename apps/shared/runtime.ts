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
import type { HookRegistry } from '../../packages/tools/hooks.ts';
import { createProvider, readConfig } from '../../packages/providers/index.ts';
import type { ProviderConfig } from '../../packages/providers/config.ts';
import { declaredRoutes, resolveRouteCapacity } from '../../packages/providers/capacity.ts';
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
  if (mode === 'sbx')
    return (
      'Command environment: Docker Sandboxes Linux /bin/sh. Commands receive a sanitized read-only workspace snapshot with network denied. Native Git and stdio MCP are unavailable. If sbx cannot start, report the blocker; never switch to host execution.' +
      web
    );
  if (mode === 'docker')
    return (
      'Command environment: Docker Engine Linux /bin/sh. Workspace is /workspace and read-only, network disabled, only /tmp writable. Native Git and stdio MCP are unavailable. If Docker or the local image is unavailable, report the blocker; never switch to host execution.' +
      web
    );
  if (mode === 'windows')
    return (
      'Command environment: Windows write-restricted token over the host shell (cmd.exe), with a workspace-specific restricting SID and private scratch directory. Ordinary outside writes are refused, but ambient Everyone ACL grants remain writable; this is a partial filesystem boundary, with reads and network unconfined. The workspace is the real one. Native Git tools and stdio MCP remain disabled. If stricter filesystem or network confinement is required or this backend cannot start, report the blocker; never switch to host execution.' +
      web
    );
  return `Command environment: host ${process.platform}, shell ${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}. Host commands are not OS-sandboxed; permissions still apply.${web}`;
}
/**
 * The sandbox a shipped app starts from when the operator has not chosen one.
 *
 * The default used to be `host` for everything — no isolation at all, chosen by nobody, visible only to someone
 * who went looking for `YUANTU_SANDBOX`. That is the one default a sandbox must not have: the safe state is not
 * the convenient one, and "we have no local backend on this platform" is a fact to report, not a licence to run
 * unconfined. So the two programs a person actually starts pick the local backend on the platform that has one
 * (Windows), and leave the library default alone for embedders and tests, where `host` is a deliberate choice
 * rather than an accident.
 *
 * Nowhere else does anything local exist: macOS and Linux would need their own backend (`seatbelt`, `bwrap`,
 * `landlock`), and defaulting those to `docker` would refuse every command on machines that do not have Docker
 * installed — a regression dressed as a security fix. Their default therefore stays as it was.
 *
 * The hook category is pinned to the host in the same breath. A hook is one command per event and every
 * isolating backend either cannot host one (the containers) or is not worth a token per event; leaving it to
 * inherit `YUANTU_SANDBOX` would make the bridge refuse to install and silently disable the operator's hooks,
 * which is a worse failure than running them on the host, where they already ran.
 */
export function applySandboxDefaults(env: NodeJS.ProcessEnv = process.env): void {
  if (env.YUANTU_SANDBOX !== undefined || env.YUANTU_SANDBOX_HOOK !== undefined) return;
  if (process.platform !== 'win32') return;
  env.YUANTU_SANDBOX = 'windows';
  env.YUANTU_SANDBOX_HOOK = 'host';
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
 * Nothing resolving is a refusal, not a default: a window this runtime invented is worse than no run at all,
 * because too small compacts conversations that fit and too large lets the endpoint refuse the first request
 * that outgrows the real limit — and both failures look like something else.
 */
export function declaredCapacity(options: Options, config: ProviderConfig): number {
  const capacity = resolveRouteCapacity({
    model: config.model,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    declared: declaredRoute(options, config),
    // The same map the per-round resolver reads, so "this model's window" has one answer whether it is asked
    // before the run or during it.
    routes: declaredRoutes(process.env.YUANTU_MODEL_CAPACITIES),
  });
  if (!capacity)
    throw new Error(
      `No context window is declared for "${config.model || '(no model configured)'}" on this connection. ` +
        'The window is the only ceiling a run has, and this runtime does not guess it. Declare it with ' +
        '--max-context-tokens <n> / YUANTU_MAX_CONTEXT_TOKENS, set it on the model in the desktop settings, ' +
        'or read it from the endpoint with `yuantu-agent models`.',
    );
  return capacity.contextWindow;
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
 * catalogue this project ships; a model none of them knows gets no answer at all — the round then keeps the
 * window this run declared rather than being measured against a second, invented one.
 */
export function capacityResolver(
  options: Options,
  config: ProviderConfig,
): (model: string) => { contextWindow: number; maxOutputTokens?: number } | undefined {
  const base = config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl };
  const declared = declaredRoute(options, config);
  const routes = declaredRoutes(process.env.YUANTU_MODEL_CAPACITIES);
  return (model) =>
    resolveRouteCapacity({
      model,
      ...base,
      ...(model === config.model ? { declared } : {}),
      routes,
    });
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
export function openStore(options: Options): SessionStore {
  return new SessionStore(sessionDatabasePath(options));
}
export function createAgent(
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
): Agent {
  const config = readConfig();
  const provider = createProvider(config);
  const policyForCall =
    executionPolicy ??
    (() => {
      const config = resolveSandboxConfig();
      return callExecutionPolicy(config.mode, { image: config.image });
    });
  return new Agent({
    store,
    executionEnvironment: withExecutionPolicy(policyForCall(), () => executionEnvironment()),
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
     */
    ...(residency
      ? {
          subagentResidency: residency,
          childTools: () => createTools(workspace, undefined, 'subagent', hooks),
        }
      : {}),
    maxContextChars: options.maxContextChars,
    maxContextTokens: declaredCapacity(options, config),
    // Per round, not per run: a policy that moves a round onto another model moves it onto that model's window
    // too, and the catalogue is what can answer for a model the operator declared nothing about.
    capacityFor: capacityResolver(options, config),
    autoCompactTokens: options.autoCompactTokens,
    maxOutputTokens: options.maxOutputTokens,
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
