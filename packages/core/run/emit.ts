import type { AgentEvent } from '../../protocol/index.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import type { SessionStore } from '../../storage/sqlite.ts';

/**
 * How a run's frames reach the outside world, and the two bookkeeping side effects that ride along.
 *
 * Every event a run emits passes through one function, and that function does three things beyond handing the
 * frame to the host: it records the event type for the run-end invariant, it feeds the stall watchdog of a
 * delegated child, and it accumulates the wall-clock and activity fields the desktop draws. Those three are the
 * reason this is a module rather than a call to `options.onEvent` at each site — a frame that skipped one of
 * them would be a frame the client shows, the watchdog ignores, or the invariant never sees.
 *
 * The state object is shared with the run loop on purpose: `toolCalls`, `statistics` and the child token map
 * are *the run's* counters, read and written by the loop as well, so this file owns the emission rule and the
 * loop keeps owning the numbers.
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
   * The tool calls the run is still waiting on, by call id.
   *
   * A set rather than a count because the finish of one call says nothing about its siblings: two reads that
   * overlap are both in flight after the first of them answers, and the wall clock the run spends waiting is not
   * over until the last one does.
   */
  toolCalls: Map<string, number>;
  /** When the current uninterrupted stretch of "waiting on at least one tool" began, or `undefined` while none is. */
  toolSpanStarted: number | undefined;
  /** Epoch ms the current stretch began, for the activity frame a client draws, which is not a duration. */
  toolActivityStartedAt: number | undefined;
  /**
   * The output tokens each child had reported as of its last `subagent.progress` frame.
   *
   * It exists so that frame can be told apart from the one the stall watchdog is aimed at: a child that keeps
   * publishing a *running clock* without producing anything is exactly the child worth stopping, while a child
   * whose output token count grew has produced something. Per parent run — a resident child's next turn starts
   * from the count its last turn left, which is what makes the first frame of that turn count as no growth
   * rather than as growth.
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
 * The call id a tool frame carries, from whichever field that frame's shape uses.
 *
 * `tool.started` announces a `call` (the protocol's own object, id included) and `tool.finished` answers with a
 * `callId`. Both are read here rather than at the two call sites so a finish is paired with the start it belongs
 * to by identity and not by order.
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
/**
 * Settle whatever the run was still waiting on when it ended.
 *
 * A cancelled or failed run never sees the finish of the call that was in flight, and the wall time a person
 * spent waiting on it must not vanish from the totals. Called once from the run's teardown: the second call finds
 * no open span and adds nothing, which is what keeps a settlement from being charged twice.
 */
export function settleOpenToolSpans(state: RunEmission, now = performance.now()): void {
  state.toolCalls.clear();
  closeToolSpan(state, now);
}

/**
 * The run's emitter. Each call stamps identity, folds in timing and activity, and never throws.
 *
 * A listener is an observer: it cannot control the run or change its cleanup, so a sink that throws (or returns
 * a rejected promise) is swallowed here rather than unwinding a step that has already happened.
 */
export function createRunEmit(options: RunEmitOptions): RunEmit {
  const { state } = options;
  return (type, data) => {
    state.emittedTypes.add(type);
    /**
     * A child's own frames are what keeps its stall watchdog from firing.
     *
     * The watchdog bounds silence, not duration (see `SubAgentOptions.timeoutMs`), and the silence is
     * observable here: a message delta, a tool call starting or finishing, or an output token count that grew
     * is a child saying it is still working, and all of them travel on the parent's feed carrying the child's
     * own id.
     *
     * The hook is in this function rather than in the coordinator's own emit because the high-volume frames
     * never reach that one.
     *
     * Two of the three signals used to be missing, and the comments in `agent.ts` and in `subagents/delegation.ts` both
     * promised them. Only `subagent.delta` re-armed the watchdog, so a child that worked without talking —
     * reading files, running commands, or answering through a provider that does not stream — was stopped
     * after the stall window and had its finished work discarded, which is the most expensive failure in this
     * chain. A tool call starting or finishing is now a signal, and so is `subagent.progress`, but *only* when
     * the token count it carries has grown: the clock alone is deliberately not one, because a child that
     * reports a running clock forever without producing anything is the child this watchdog exists for.
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
     * The run's tool wall clock, kept as a union of spans rather than as a start time.
     *
     * The statistic answers "how long did this run spend waiting on tools", so what it accumulates is the wall
     * clock during which *at least one* call was in flight. A single scalar could not say that: it was overwritten
     * by every `tool.started` and cleared by the first `tool.finished`, so a second call that was still running
     * when its sibling answered was never charged at all, and the total came out as the shortest call instead of
     * the union. Tracking the open calls makes the answer independent of the order the finishes arrive in: the
     * clock opens with the first call and closes with the last, and a finish that matches nothing (a duplicate, or
     * a call this emitter never saw start) is ignored rather than subtracted.
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
      /**
       * Activity follows the same clock: a run is "running a tool" while any call is open, so the frame that ends
       * one of two overlapping reads is not the end of the run's tool work. The epoch timestamp is carried
       * unchanged for the whole stretch, because a panel draws it as "since when", not as a duration.
       */
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
           * The log position this frame is ordered against, read at the moment of emission so a frame that
           * announces a durable fact carries that fact's own seq (see `AgentEvent.seq`). Cheap by design: the
           * store keeps it as a high-water mark, because this runs once per emitted frame including deltas.
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
