import type { AgentEvent } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { SessionStore } from '../storage/sqlite.ts';

/**
 * How a run's frames reach the outside world, and the two bookkeeping side effects that ride along.
 *
 * Every event a run emits passes through one function, and that function does three things beyond handing the
 * frame to the host: it records the event type for the run-end invariant, it feeds the stall watchdog of a
 * delegated child, and it accumulates the wall-clock and activity fields the desktop draws. Those three are the
 * reason this is a module rather than a call to `options.onEvent` at each site — a frame that skipped one of
 * them would be a frame the client shows, the watchdog ignores, or the invariant never sees.
 *
 * The state object is shared with the run loop on purpose: `toolStarted`, `statistics` and the child token map
 * are *the run's* counters, read and written by the loop as well, so this file owns the emission rule and the
 * loop keeps owning the numbers.
 */

/** A child whose work is still arriving, as the emission path sees it. */
export interface RunProgressSink {
  progress(id: string): void;
}

/** The run's own counters and collections that emission reads or writes. */
export interface RunEmission {
  statistics: SessionStatistics;
  /** Every event type this run emitted, which is what the protocol invariant checks at the end. */
  emittedTypes: Set<string>;
  /** When the tool now running started, or `undefined` while none is. */
  toolStarted: number | undefined;
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
     * Two of the three signals used to be missing, and the comments in `agent.ts` and in `subagents.ts` both
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
        const produced = Number(
          (data.usage as { outputTokens?: number } | undefined)?.outputTokens,
        );
        const previous = state.childOutputTokens.get(id);
        if (Number.isFinite(produced) && (previous === undefined || produced > previous)) {
          state.childOutputTokens.set(id, produced);
          state.coordinator.progress(id);
        }
      }
    }
    if (type === 'tool.started') state.toolStarted = performance.now();
    if (type === 'tool.finished' && state.toolStarted !== undefined) {
      state.statistics.toolMs += performance.now() - state.toolStarted;
      state.toolStarted = undefined;
    }
    if (type === 'tool.started' || type === 'tool.finished') {
      data = {
        ...data,
        statistics: { ...state.statistics },
        activity: type === 'tool.started' ? { kind: 'tool', startedAt: Date.now() } : null,
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
