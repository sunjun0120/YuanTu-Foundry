import type { Usage } from '../../protocol/index.ts';
import type {
  SubAgentRole,
  SubAgentSummaryReport,
  SubAgentTaskStatus,
} from '../../protocol/index.ts';
import type { WorkspaceBinding } from '../../protocol/workspaces.ts';
import type { Disposer } from '../../tools/dispatch.ts';

/**
 * The sub-agent provider seam. A provider is a named object with a declared capability list, and
 * the registry refuses a request for an unadvertised capability (`UNSUPPORTED_CAPABILITY`) before
 * any child session exists, so nothing is accepted and silently ignored.
 */
export const SUBAGENT_CAPABILITIES = [
  /** `agentOptions`: the provider can run the child with options the parent chose, currently the model. */
  'agentOptions',
  /** The provider can hold the child to the structured report contract (`submit_report`). */
  'outputSchema',
  /** The provider can enforce the nesting cap it is given instead of nesting without bound. */
  'depthLimit',
  /** The provider can restrict which tools the child may call. */
  'toolFilter',
  /** The provider can give the child its own role prompt. */
  'persona',
  /**
   * The provider can start the child from the parent's transcript. Separate from `persona`:
   * inheriting a conversation and an identity are different promises.
   */
  'contextFork',
  /**
   * The provider can give the child its own execution directory. A capability because it promises
   * where the child's writes land.
   */
  'workspaceIsolation',
] as const;
export type SubAgentCapability = (typeof SUBAGENT_CAPABILITIES)[number];
const CAPABILITY_NAMES = new Set<string>(SUBAGENT_CAPABILITIES);
export interface SubAgentTask {
  id: string;
  index: number;
  role: SubAgentRole;
  objective: string;
  context?: string;
  /**
   * The object this task must return, when the caller defines one. Absent means the fixed report
   * contract (`REPORT_SCHEMA`); present means the answer arrives as `data` instead of `report`.
   */
  schema?: Record<string, unknown>;
}
/** How much of the parent's transcript a forked child inherited, and what the budget left out. */
export interface SubAgentSeed {
  messages: number;
  chars: number;
  dropped: number;
}
export interface SubAgentOutcome {
  /** The child session that holds this sub-agent's transcript. */
  sessionId: string;
  status: SubAgentTaskStatus;
  text: string;
  rounds: number;
  toolCalls: number;
  usage: Usage;
  /** The child's structured report, when it submitted one. */
  report?: SubAgentSummaryReport;
  /**
   * The child's structured answer for a task with its own `schema`, already validated by the submit
   * tool's argument schema. Not part of the summary, which keeps one shape.
   */
  data?: unknown;
  /** Present for a forked child: what it inherited, so the parent's result can state it. */
  seeded?: SubAgentSeed;
  error?: string;
}
/** Where the child sits in the lineage, as data. Nothing here is inherited through a scope tree. */
export interface SubAgentParent {
  sessionId: string;
  workspace: string;
  /**
   * The parent's project when it differs from where it works (a worktree), so the child's memory
   * points at the project.
   */
  project?: string;
  /** 0 for a child of the top-level run. */
  depth: number;
}
/**
 * What the caller asks for. Every field is optional; absent fields are never asserted against a
 * capability.
 */
export interface SubAgentRequestOptions {
  /** `{model}` asks the provider to run this child on a specific model. */
  agentOptions?: { model?: string };
  /** The structured report contract the caller expects the child to satisfy. */
  outputSchema?: Record<string, unknown>;
  maxDepth?: number;
  toolFilter?: readonly string[];
  /**
   * This child's own persona, which replaces the deployment's for it alone. Unlike the additive
   * role prompt, a provider declaring `persona` must put it in a shadowing slot
   * (`AgentOptions.persona` in-process).
   */
  persona?: string;
  /** `true` starts the child from the parent's transcript instead of from nothing. */
  contextFork?: boolean;
  /**
   * The execution-directory mode, after resolving `auto` against the role. Only `worktree` is
   * requested; `shared` leaves it absent, and a provider that cannot isolate must refuse a
   * `worktree` task.
   */
  workspace?: 'shared' | 'worktree';
}
export interface SubAgentStartRequest {
  task: SubAgentTask;
  parent: SubAgentParent;
  options: SubAgentRequestOptions;
  signal: AbortSignal;
  /**
   * The directory this child was given. Part of the request because the coordinator already decided
   * it; a provider that cannot use it must have refused at capability time.
   */
  binding?: WorkspaceBinding;
  /** Called as soon as the child session exists, which is what lets progress be published early. */
  started: (sessionId: string) => void;
}
export interface ResolvedSubAgentStartRequest extends SubAgentStartRequest {
  /** The provider that accepted the request. */
  provider: string;
}
export interface SubAgentProvider {
  /** Unique name; the registry rejects a second provider under the same name. */
  readonly name: string;
  /** Short human-readable note for `describe()`. */
  readonly description?: string;
  /** Exactly what this provider can honour. Anything absent is refused, never ignored. */
  readonly capabilities: readonly SubAgentCapability[];
  start(request: ResolvedSubAgentStartRequest): Promise<SubAgentOutcome>;
}
/** Thrown when a request asks for something the provider does not advertise. */
export class SubAgentCapabilityError extends Error {
  readonly provider: string;
  readonly capability: SubAgentCapability;
  constructor(provider: string, capability: SubAgentCapability) {
    super(
      `Sub-agent provider "${provider}" does not support ${capability} (UNSUPPORTED_CAPABILITY); ` +
        'the request was refused rather than run with that part ignored',
    );
    this.name = 'SubAgentCapabilityError';
    this.provider = provider;
    this.capability = capability;
  }
}
export class UnknownSubAgentProviderError extends Error {
  readonly provider: string;
  readonly known: readonly string[];
  constructor(provider: string, known: readonly string[]) {
    super(
      `Unknown sub-agent provider "${provider}"; registered providers: ${known.join(', ') || '(none)'}`,
    );
    this.name = 'UnknownSubAgentProviderError';
    this.provider = provider;
    this.known = known;
  }
}
/**
 * Which requested options map to which capability, kept next to the list so each new option decides
 * its capability.
 */
const OPTION_CAPABILITIES: readonly [keyof SubAgentRequestOptions, SubAgentCapability][] = [
  ['agentOptions', 'agentOptions'],
  ['outputSchema', 'outputSchema'],
  ['maxDepth', 'depthLimit'],
  ['toolFilter', 'toolFilter'],
  ['persona', 'persona'],
  ['contextFork', 'contextFork'],
  ['workspace', 'workspaceIsolation'],
];
export class SubAgentProviderRegistry {
  private providers = new Map<string, SubAgentProvider>();
  /** Every registration hands back its removal, like every other seam in the runtime. */
  register(provider: SubAgentProvider): Disposer {
    if (!provider.name.trim()) throw new Error('A sub-agent provider needs a name');
    if (this.providers.has(provider.name))
      throw new Error(`Duplicate sub-agent provider: ${provider.name}`);
    const unknown = provider.capabilities.filter((capability) => !CAPABILITY_NAMES.has(capability));
    if (unknown.length) throw new Error(`Unknown sub-agent capability: ${unknown.join(', ')}`);
    this.providers.set(provider.name, provider);
    return () => {
      if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name);
    };
  }
  get size(): number {
    return this.providers.size;
  }
  names(): string[] {
    return [...this.providers.keys()];
  }
  /** The capability surface, for a host that wants to show or check what delegation can do here. */
  describe(): { name: string; description?: string; capabilities: SubAgentCapability[] }[] {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      ...(provider.description ? { description: provider.description } : {}),
      capabilities: [...provider.capabilities],
    }));
  }
  /**
   * Validates a request against the provider's declared capabilities and returns it, before the
   * child session exists.
   */
  resolve(name: string, options: SubAgentRequestOptions): SubAgentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new UnknownSubAgentProviderError(name, this.names());
    const declared = new Set(provider.capabilities);
    for (const [option, capability] of OPTION_CAPABILITIES) {
      const requested = options[option];
      if (requested === undefined) continue;
      // `false` asks for nothing.
      if (requested === false) continue;
      if (Array.isArray(requested) && requested.length === 0) continue;
      if (typeof requested === 'string' && !requested.trim()) continue;
      if (!declared.has(capability)) throw new SubAgentCapabilityError(provider.name, capability);
    }
    return provider;
  }
}
/**
 * Adapts a plain "run this child" closure into a provider. The kernel's own delegation is such a
 * closure; this module must not import the agent loop.
 */
export function inProcessProvider(options: {
  name?: string;
  description?: string;
  capabilities: readonly SubAgentCapability[];
  run: (request: ResolvedSubAgentStartRequest) => Promise<SubAgentOutcome>;
}): SubAgentProvider {
  return {
    name: options.name ?? 'in-process',
    description:
      options.description ??
      'Runs the child as a real agent session in this process, with the workspace, tools and lineage of the parent run.',
    capabilities: options.capabilities,
    start: options.run,
  };
}
