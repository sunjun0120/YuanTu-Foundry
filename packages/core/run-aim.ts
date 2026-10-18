import type { ReasoningEffort, ToolSpec } from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { AgentOptions } from './agent-options.ts';
import { cacheKeyFor } from './cache-key.ts';
import type { RunEmit } from './run-emit.ts';

export interface RunAimOptions {
  store: SessionStore;
  sessionId: string;
  runId: string;
  emit: RunEmit;
  modelInfo: AgentOptions['modelInfo'];
  capacityFor: AgentOptions['capacityFor'];
  /** The run's own window and output ceiling, which a route the host has no opinion about keeps. */
  maxContextTokens: number | undefined;
  maxOutputTokens: number;
}

/** The model, effort, capacity and cache key one round's request is built around. */
export interface RoundAim {
  /** The model to put on the wire, or `null` when nothing re-aimed the round and the adapter's own applies. */
  requestedModel: string | null;
  requestedEffort: ReasoningEffort | undefined;
  /** The model this round aims at, when one is named at all: `null` means the embedder declared none. */
  model: string | null;
  contextTokens: number | undefined;
  outputTokens: number;
  cacheKeyOf(systemText: string, toolSpecs: readonly ToolSpec[]): string;
}

/**
 * The model each round of a run aims at, as the pre-step waterfall leaves it.
 *
 * The aim is *per round*: it starts from the run's own values every time, never from what the round before it
 * chose. A policy that wants a model for several rounds says so each round — which is the only version of this
 * that stays readable, because the alternative is a state nobody declared. What *is* carried between rounds is the
 * previous pair, because the transition is what the log records.
 */
export class RunAim {
  private readonly options: RunAimOptions;
  /**
   * The model this run was configured to use.
   *
   * `null` for an embedder that declared no `modelInfo`: the kernel then does not know the provider's model name,
   * so it can only report — and re-aim at — a name a policy actually supplies.
   */
  readonly configuredModel: string | null;
  /** The pair the previous request aimed at. It starts as the configured one, so the transition *into* an override is a change. */
  private previousModel: string | null;
  private previousEffort: ReasoningEffort | undefined;

  constructor(options: RunAimOptions) {
    this.options = options;
    this.configuredModel = options.modelInfo?.model ?? null;
    this.previousModel = this.configuredModel;
  }

  /**
   * The model and effort this round's request will actually use.
   *
   * A re-aimed round changes how the run spends money, so the change is recorded — and *only* the change,
   * because the transition is the interesting fact: a run on its configured model writes nothing, a run
   * that switches writes one row where it switches, and a policy that switches back writes one more. The
   * row carries the model itself, so a reader does not have to know the run's configuration to read it.
   */
  aim(round: number, preStep: { model: string; reasoningEffort?: ReasoningEffort }): RoundAim {
    const { store, sessionId, runId, emit, modelInfo, capacityFor } = this.options;
    const configuredModel = this.configuredModel;
    const aimed = preStep.model.trim() || null;
    /**
     * The override to send, which is *not* the same thing as the model the round uses.
     *
     * When nothing re-aims the round the request carries no model at all, and the adapter uses the model
     * its own configuration names. That is not a detail: what the kernel holds is `modelInfo.model`, a
     * label prepared for display, so sending it as the model would be a guess at somebody else's
     * configuration. Only a policy that names a model puts one on the wire.
     */
    const requestedModel = aimed === configuredModel ? null : aimed;
    // `none` is how a hook takes a level back, so by the time the request is built it means exactly what
    // "no effort was named" means: no reasoning parameter at all.
    const requestedEffort =
      preStep.reasoningEffort === 'none' ? undefined : preStep.reasoningEffort;
    const effectiveModel = requestedModel ?? configuredModel;
    if (
      effectiveModel !== null &&
      (effectiveModel !== this.previousModel || requestedEffort !== this.previousEffort)
    ) {
      const shape = {
        runId,
        round,
        model: effectiveModel,
        ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
      };
      store.recordEvent(sessionId, 'llm.request', shape);
      emit('llm.request', shape);
    }
    this.previousModel = effectiveModel;
    this.previousEffort = requestedEffort;
    /**
     * The cache key of a request, as a function of that request.
     *
     * The route is resolved per round, because the model it names can change from round to round: an entry
     * belongs to the model that served it, and two models sharing a key would read each other's cache. The
     * prompt is an argument rather than a captured value because the prompt is not a constant of the run —
     * approving a plan mid-run adds the tools that write and rebuilds it — and a key taken from the prompt the
     * round began with names a prefix nobody was sent.
     *
     * Handed to `prepareContext` as well, so the summary request it makes carries the key of the prefix that
     * request actually replays, rather than of the compressed round it is compressing for.
     *
     * The round asks twice for the same request — once to record its envelope and once to send it — so the last
     * answer is kept: the digest serializes the whole tool catalogue, and the second ask is for the same prompt
     * and the same catalogue array. A different prompt or a different array is a different request and is hashed.
     */
    const route =
      modelInfo === undefined
        ? undefined
        : { ...modelInfo, model: effectiveModel ?? modelInfo.model };
    let last:
      { system: string; tools: readonly ToolSpec[]; count: number; key: string } | undefined;
    const cacheKeyOf = (systemText: string, toolSpecs: readonly ToolSpec[]): string => {
      if (
        last &&
        last.tools === toolSpecs &&
        last.count === toolSpecs.length &&
        last.system === systemText
      )
        return last.key;
      const key = cacheKeyFor(route, systemText, toolSpecs);
      last = { system: systemText, tools: toolSpecs, count: toolSpecs.length, key };
      return key;
    };
    /**
     * The capacity of the route this round will actually use.
     *
     * Resolved per round, after the pre-step waterfall has had its say about the model, because a re-aimed
     * round is measured against the window of the model that will serve it. The run's own window remains
     * the answer when the host has no opinion about this model — a resolver that shrugs is not a licence to
     * invent a window.
     */
    const resolved = effectiveModel === null ? undefined : capacityFor?.(effectiveModel);
    return {
      requestedModel,
      requestedEffort,
      model: effectiveModel,
      contextTokens: resolved?.contextWindow ?? this.options.maxContextTokens,
      outputTokens: resolved?.maxOutputTokens ?? this.options.maxOutputTokens,
      cacheKeyOf,
    };
  }
}
