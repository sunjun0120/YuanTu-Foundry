import type { Usage } from '../protocol/index.ts';
import type { SubAgentRole, SubAgentSummaryReport, SubAgentTaskStatus } from '../protocol/index.ts';
import type { Disposer } from '../tools/dispatch.ts';

/**
 * The sub-agent provider seam.
 *
 * Delegation used to be one closure the agent loop handed to the coordinator: "run this child, here is
 * how". That is a single implementation with no name, no stated abilities and no way to add a second
 * one — and, more importantly, no way for a caller to learn what the implementation *cannot* do. A
 * request for something unsupported was simply ignored, which is the worst possible answer: the caller
 * believes it asked for a different model (or a tool filter, or a depth cap) and never finds out.
 *
 * A provider is therefore a named object with a declared capability list, and the registry refuses a
 * request that asks for something the provider does not advertise, before any child session exists. The
 * refusal is loud and specific — `UNSUPPORTED_CAPABILITY` — because "accepted and ignored" is how a
 * safety property silently stops holding.
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
   * The provider can start the child from the parent's transcript instead of from nothing.
   *
   * Advertised separately from `persona` on purpose: inheriting a conversation and inheriting an identity are
   * different promises, and a provider that runs children out-of-process may well be able to do the second
   * without any way to do the first.
   */
  'contextFork',
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
   * The object this task must come back with, when the caller wants its own shape.
   *
   * Absent means the fixed report contract (`REPORT_SCHEMA`): summary, findings with evidence, unverified,
   * blockers. Present means the child is held to *this* schema instead, and its answer arrives as `data`
   * rather than `report` — the two are different promises, and a caller that asked for a shape it defined
   * should not have to parse the shape it did not.
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
   * The child's structured answer, when this task declared its own `schema`.
   *
   * Validated rather than trusted: the child submits it through a tool whose argument schema *is* the caller's
   * schema, so a call that arrives at all has already been checked against it. It is deliberately not part of
   * the child's summary — the card and the settlement notice keep one shape each, and neither is polymorphic.
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
  /** 0 for a child of the top-level run. */
  depth: number;
}
/**
 * What the caller asks for. Every field is optional: a provider only has to be asked for what the
 * caller genuinely needs, and an absent field is never asserted against a capability.
 */
export interface SubAgentRequestOptions {
  /** `{model}` asks the provider to run this child on a specific model. */
  agentOptions?: { model?: string };
  /** The structured report contract the caller expects the child to satisfy. */
  outputSchema?: Record<string, unknown>;
  maxDepth?: number;
  toolFilter?: readonly string[];
  /**
   * This child's own persona, which **replaces** the deployment's for it alone.
   *
   * Not to be confused with the sub-agent role prompt, which is a different statement: the role says what this
   * child may do ("you are read-only"), and it is additive — a child is told both what its parent was told and
   * what it is. A persona is who is speaking, and two of those in one prompt is a contradiction the model has to
   * average. So a provider that declares the `persona` capability must put this text in a slot that shadows the
   * deployment's rather than appending it (`AgentOptions.persona` is that slot in-process).
   *
   * `requestOptions()` no longer sends the role prompt here — it did, which made this option a promise the
   * built-in provider could not honour without erasing the harness's own identity paragraph.
   */
  persona?: string;
  /** `true` starts the child from the parent's transcript instead of from nothing. */
  contextFork?: boolean;
}
export interface SubAgentStartRequest {
  task: SubAgentTask;
  parent: SubAgentParent;
  options: SubAgentRequestOptions;
  signal: AbortSignal;
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
 * Which requested options map to which capability.
 *
 * Kept next to the capability list so a new option cannot be added without deciding what makes a
 * provider able to honour it — the same single-source-of-truth rule the event types follow.
 */
const OPTION_CAPABILITIES: readonly [keyof SubAgentRequestOptions, SubAgentCapability][] = [
  ['agentOptions', 'agentOptions'],
  ['outputSchema', 'outputSchema'],
  ['maxDepth', 'depthLimit'],
  ['toolFilter', 'toolFilter'],
  ['persona', 'persona'],
  ['contextFork', 'contextFork'],
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
   * Validates a request against the named provider's declared capabilities, and returns the provider.
   * This runs *before* the child session exists, so a refused request leaves nothing behind.
   */
  resolve(name: string, options: SubAgentRequestOptions): SubAgentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new UnknownSubAgentProviderError(name, this.names());
    const declared = new Set(provider.capabilities);
    for (const [option, capability] of OPTION_CAPABILITIES) {
      const requested = options[option];
      if (requested === undefined) continue;
      // `false` asks for nothing: an option that is switched off must not be read as a request for the
      // capability that would switch it on.
      if (requested === false) continue;
      if (Array.isArray(requested) && requested.length === 0) continue;
      if (typeof requested === 'string' && !requested.trim()) continue;
      if (!declared.has(capability)) throw new SubAgentCapabilityError(provider.name, capability);
    }
    return provider;
  }
}
/**
 * Adapts a plain "run this child" closure into a provider.
 *
 * The kernel's own delegation is exactly such a closure — the agent loop owns the store, the provider
 * and the tool registry the child needs, and this module must not import the loop (the dependency is
 * one-way). Wrapping it keeps the built-in path identical while making it one provider among however
 * many an embedder registers.
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
