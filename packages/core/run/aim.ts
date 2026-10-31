import type { ReasoningEffort, ToolSpec } from '../../protocol/index.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { AgentOptions } from '../agent-options.ts';
import { cacheKeyFor } from '../context/cache-key.ts';
import type { RunEmit } from './emit.ts';

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
 * The model each round aims at after the pre-step waterfall. Per round: each starts from the run's
 * own values. Only the previous pair is carried, to record transitions.
 */
export class RunAim {
  private readonly options: RunAimOptions;
  /** The configured model, or `null` when the embedder declared no `modelInfo`. */
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
   * The model and effort this round uses. Only changes are recorded, with the model named in the
   * row.
   */
  aim(round: number, preStep: { model: string; reasoningEffort?: ReasoningEffort }): RoundAim {
    const { store, sessionId, runId, emit, modelInfo, capacityFor } = this.options;
    const configuredModel = this.configuredModel;
    const aimed = preStep.model.trim() || null;
    /**
     * The override to send: `null` unless a policy named a different model, since `modelInfo.model`
     * is a display label, not necessarily the adapter's configured name.
     */
    const requestedModel = aimed === configuredModel ? null : aimed;
    // `none` means no reasoning parameter at all.
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
     * The cache key of a request. The route is resolved per round (the model can change) and the
     * prompt is an argument (plan approval rebuilds it). Also used by `prepareContext` for summary
     * requests. The last answer is memoised, since a round asks twice for the same prompt and
     * catalogue.
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
     * The capacity of the model this round will use, resolved after the waterfall. Falls back to
     * the run's own window.
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
