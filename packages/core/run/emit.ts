import type { AgentEvent } from '../../protocol/index.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import type { SessionStore } from '../../storage/sqlite.ts';

/**
 * How a run's frames reach the host. Every frame passes through one function that also records the
 * event type for the run-end invariant, feeds delegated children's stall watchdogs, and accumulates
 * the timing and activity fields the desktop draws. The state object is shared with the run loop,
 * which owns the numbers.
 */

/** A child whose work is still arriving, as the emission path sees it. */
export interface RunProgressSink {
  progress(
    id: string,
    usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
  ): void;
}

/** The run's own counters and collections that emission reads or writes. */
export interface RunEmission {
  statistics: SessionStatistics;
  /** Every event type this run emitted, which is what the protocol invariant checks at the end. */
  emittedTypes: Set<string>;
  /**
   * Tool calls still in flight, by call id. A map, not a count, so overlapping calls keep the clock
   * open until the last finishes.
   */
  toolCalls: Map<string, number>;
  /** When the current uninterrupted stretch of "waiting on at least one tool" began, or `undefined` while none is. */
  toolSpanStarted: number | undefined;
  /** Epoch ms the current stretch began, for the activity frame a client draws, which is not a duration. */
  toolActivityStartedAt: number | undefined;
  /**
   * Each child's output tokens as of its last `subagent.progress`, so only growth re-arms the
   * watchdog (a running clock alone does not). Per parent run.
   */
  childOutputTokens: Map<string, number>;
  /** The coordinator of this run's children, once the run has one. */
  coordinator?: RunProgressSink | undefined;
}

export interface RunEmitOptions {
  store: SessionStore;
  sessionId: string;
  runId: string;
  state: RunEmission;
  /** The host's sink. Absent for an embedded runtime that does not stream. */
  onEvent?: ((event: AgentEvent) => void) | undefined;
}

/** The run's emitter, as its owner stores and passes it. */
export type RunEmit = (type: AgentEvent['type'], data: Record<string, unknown>) => void;

/**
 * The call id from either frame shape (`tool.started` carries `call`, `tool.finished` carries
 * `callId`), so a finish pairs with its start by identity.
 */
function toolCallId(data: Record<string, unknown>, field: 'call' | 'callId'): string | undefined {
  if (field === 'callId') return typeof data.callId === 'string' ? data.callId : undefined;
  const call = data.call;
  if (!call || typeof call !== 'object') return undefined;
  const id = (call as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}
/** Close the open stretch, charging the wall clock it covered. Idempotent: a closed span adds nothing. */
function closeToolSpan(state: RunEmission, now = performance.now()): void {
  if (state.toolSpanStarted === undefined) return;
  state.statistics.toolMs += Math.max(0, now - state.toolSpanStarted);
  state.toolSpanStarted = undefined;
  state.toolActivityStartedAt = undefined;
}
/** Settle calls still in flight when the run ended, so their wait time is counted. Idempotent. */
export function settleOpenToolSpans(state: RunEmission, now = performance.now()): void {
  state.toolCalls.clear();
  closeToolSpan(state, now);
}

/**
 * The run's emitter: stamps identity, folds in timing and activity, and never throws (listener
 * errors are swallowed).
 */
export function createRunEmit(options: RunEmitOptions): RunEmit {
  const { state } = options;
  return (type, data) => {
    state.emittedTypes.add(type);
    /**
     * A child's own frames keep its stall watchdog from firing (see `SubAgentOptions.timeoutMs`):
     * message deltas, tool calls starting or finishing, and `subagent.progress` only when its token
     * count grew. Hooked here because high-volume frames never reach the coordinator's emit.
     */
    if (state.coordinator) {
      if (type === 'subagent.delta' || type === 'subagent.tool')
        state.coordinator.progress(String(data.id ?? ''));
      else if (type === 'subagent.progress') {
        const id = String(data.id ?? '');
        const reported = data.usage as
          { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined;
        const produced = Number(reported?.outputTokens);
        const previous = state.childOutputTokens.get(id);
        if (Number.isFinite(produced) && (previous === undefined || produced > previous)) {
          state.childOutputTokens.set(id, produced);
          // The usage rides along so the coordinator can hold the child to its token budget.
          state.coordinator.progress(id, {
            inputTokens: Number(reported?.inputTokens) || 0,
            outputTokens: produced,
            cachedInputTokens: Number(reported?.cachedInputTokens) || 0,
          });
        }
      }
    }
    /**
     * The tool wall clock as a union of spans: open with the first call in flight, close with the
     * last. Unmatched finishes are ignored.
     */
    if (type === 'tool.started') {
      const id = toolCallId(data, 'call') ?? '';
      if (!state.toolCalls.has(id)) {
        const now = performance.now();
        state.toolCalls.set(id, now);
        if (state.toolSpanStarted === undefined) {
          state.toolSpanStarted = now;
          state.toolActivityStartedAt = Date.now();
        }
      }
    } else if (type === 'tool.finished') {
      const id = toolCallId(data, 'callId') ?? '';
      if (state.toolCalls.delete(id) && state.toolCalls.size === 0) closeToolSpan(state);
    }
    if (type === 'tool.started' || type === 'tool.finished') {
      /** Activity follows the same clock; the epoch start stays fixed for the whole stretch. */
      const startedAt = state.toolActivityStartedAt;
      data = {
        ...data,
        statistics: { ...state.statistics },
        activity:
          state.toolCalls.size > 0 && startedAt !== undefined ? { kind: 'tool', startedAt } : null,
      };
    }
    // Observers retain event snapshots; nested counters must not change after emission.
    const reported = data.statistics as SessionStatistics | undefined;
    if (reported?.requestTiming)
      data = {
        ...data,
        statistics: { ...reported, requestTiming: { ...reported.requestTiming } },
      };
    try {
      void Promise.resolve(
        options.onEvent?.({
          type,
          sessionId: options.sessionId,
          runId: options.runId,
          /**
           * The log position at emission, so a frame announcing a durable fact carries its seq
           * (`AgentEvent.seq`). Cheap: the store keeps a high-water mark.
           */
          seq: options.store.lastSeq(options.sessionId),
          data,
        }),
      ).catch(() => {});
    } catch {
      // Event listeners observe runs; they must not control run execution or cleanup.
    }
  };
}
