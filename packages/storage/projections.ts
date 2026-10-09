import type { SubAgentSummary, TodoItem, Usage } from '../protocol/index.ts';
import { isTodoItem } from '../protocol/index.ts';
import { isPresentedFile, presentFiles } from '../protocol/deliverables.ts';
import type { PresentedFile } from '../protocol/deliverables.ts';
import { isGoal } from '../protocol/goals.ts';
import type { Goal } from '../protocol/goals.ts';
import { todoDiff } from '../protocol/todos.ts';
import type { TodoChange } from '../protocol/todos.ts';
import { applyStepEvent } from '../protocol/steps.ts';
import type { StepRecord } from '../protocol/steps.ts';
import {
  addStatistics,
  addUsage,
  emptyStatistics,
  isSessionStatistics,
  normalizeStatistics,
} from '../protocol/statistics.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { Disposer } from '../tools/dispatch.ts';
import { foldMessages } from './events.ts';
import type { SessionEvent } from './events.ts';

/**
 * Session projections: folds over the durable log.
 *
 * Once the log is the record, "what does this session look like" stops being a question each reader
 * answers with its own query, and becomes a fold a reader asks the log for. That matters for more than
 * tidiness: a view computed from the log is reproducible from the log (the same session replayed on a
 * newer build produces the same state, or refuses loudly), and a view computed from a table is whatever
 * that table happens to contain right now.
 *
 * A projection is deliberately small and pure: `initial()` is the empty state and `apply()` folds one
 * event. No I/O, no clock, no ordering assumptions beyond "events arrive in seq order" — those are what
 * make a fold checkable against the write-through tables it is replacing, which is exactly what the
 * reconciliation tests do while both exist.
 */
export interface SessionProjection<State> {
  readonly name: string;
  /** One line for `describe()`, so a host can show what projections exist. */
  readonly description?: string;
  /**
   * Whether a host may keep this projection's folded state between processes.
   *
   * True by default, and false for the one projection whose state is as large as the log it folds: the
   * transcript. Persisting that would be copying the session to avoid folding it — a trade of disk and a
   * serialisation of every message for a few tens of milliseconds, which is not a trade this project makes.
   * Everything else here is a small derived view,
   * and it is exactly those that are re-folded on every read today.
   */
  readonly persist?: boolean;
  initial(): State;
  apply(state: State, event: SessionEvent): State;
}
/** Thrown when a caller asks for a projection nobody registered. */
export class UnknownSessionProjectionError extends Error {
  readonly projection: string;
  constructor(projection: string, known: readonly string[]) {
    super(
      `Unknown session projection "${projection}"; registered projections: ${known.join(', ') || '(none)'}`,
    );
    this.name = 'UnknownSessionProjectionError';
    this.projection = projection;
  }
}
export class SessionProjectionRegistry {
  private projections = new Map<string, SessionProjection<unknown>>();
  /** Every registration hands back its removal, like every other seam in the runtime. */
  register<State>(projection: SessionProjection<State>): Disposer {
    if (!projection.name.trim()) throw new Error('A session projection needs a name');
    if (this.projections.has(projection.name))
      throw new Error(`Duplicate session projection: ${projection.name}`);
    this.projections.set(projection.name, projection as SessionProjection<unknown>);
    return () => {
      if (this.projections.get(projection.name) === projection)
        this.projections.delete(projection.name);
    };
  }
  names(): string[] {
    return [...this.projections.keys()];
  }
  describe(): { name: string; description?: string }[] {
    return [...this.projections.values()].map((projection) => ({
      name: projection.name,
      ...(projection.description ? { description: projection.description } : {}),
    }));
  }
  get<State>(name: string): SessionProjection<State> {
    const projection = this.projections.get(name);
    if (!projection) throw new UnknownSessionProjectionError(name, this.names());
    return projection as SessionProjection<State>;
  }
  /**
   * The state one projection folds to. A missing projection is an error rather than an empty state: a
   * reader that asks for something this build does not have must find out, not silently see nothing.
   */
  stateOf<State>(name: string, events: readonly SessionEvent[]): State {
    const projection = this.get<State>(name);
    let state = projection.initial();
    for (const event of events) state = projection.apply(state, event);
    return state;
  }
  /**
   * Every projection in one pass over the log, which is what a host wants when it renders a session:
   * one read, one fold per projection, no projection able to observe another's intermediate state.
   */
  snapshot(events: readonly SessionEvent[]): Record<string, unknown> {
    const states = new Map<string, unknown>(
      [...this.projections].map(([name, projection]) => [name, projection.initial()]),
    );
    for (const event of events)
      for (const [name, projection] of this.projections) {
        const projection_ = projection as SessionProjection<unknown>;
        states.set(name, projection_.apply(states.get(name), event));
      }
    return Object.fromEntries(states);
  }
}
/**
 * The transcript, as a projection. It is the fold the "model-visible ⇒ recorded" property rests on, so it
 * is registered under its own name rather than left as a function only the store calls.
 */
export const messagesProjection: SessionProjection<ReturnType<typeof foldMessages>> = {
  name: 'messages',
  description: 'The model-visible transcript, folded from message events.',
  // The one projection whose folded state is the size of the log (see the note on `persist`).
  persist: false,
  initial: () => [],
  apply: (state, event) => {
    const folded = foldMessages([event]);
    return folded.length ? [...state, ...folded] : state;
  },
};
/**
 * Session statistics, as a projection.
 *
 * A finished run contributes its reported statistics; a run recorded before statistics existed
 * contributes what it had (usage only) and marks the total's timing as unknown, which is the same
 * fallback the table fold used. Keeping that distinction in the fold is what lets the projection be
 * compared against the table it replaces, run for run.
 *
 * Compaction usage is visible before its owning run ends. A matching finished run confirms both the
 * already-counted usage and its timing. Standalone, legacy and interrupted summaries remain unknown;
 * pending sources are checkpointed so a later known run cannot erase someone else's uncertainty.
 */
export interface StatisticsState {
  statistics: SessionStatistics;
  settledTimingKnown: boolean;
  pendingCompactions: Record<string, Usage>;
}
/** Persisted projections are derived caches; invalid state must be recomputed from the authoritative log. */
export function isStatisticsState(value: unknown): value is StatisticsState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!isSessionStatistics(state.statistics) || typeof state.settledTimingKnown !== 'boolean')
    return false;
  const pending = state.pendingCompactions;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return false;
  return Object.values(pending).every((usage) => {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
    const record = usage as Record<string, unknown>;
    return ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens'].every(
      (key) =>
        (record[key] === undefined && key !== 'inputTokens' && key !== 'outputTokens') ||
        (Number.isSafeInteger(record[key]) && (record[key] as number) >= 0),
    );
  });
}
export const statisticsProjection: SessionProjection<StatisticsState> = {
  name: 'statistics',
  description: 'Aggregated usage and timing across every finished run of the session.',
  initial: () => ({
    statistics: emptyStatistics(),
    settledTimingKnown: true,
    pendingCompactions: {},
  }),
  apply: (state, event) => {
    let statistics = state.statistics;
    let settledTimingKnown = state.settledTimingKnown;
    const pendingCompactions = { ...state.pendingCompactions };
    const finish = (): StatisticsState => ({
      statistics: {
        ...statistics,
        timingKnown: settledTimingKnown && Object.keys(pendingCompactions).length === 0,
      },
      settledTimingKnown,
      pendingCompactions,
    });
    if (event.type === 'session.title.generated') {
      if (!event.data.usage) return state;
      const generated = emptyStatistics();
      addUsage(generated, event.data.usage as Usage);
      settledTimingKnown = false;
      statistics = addStatistics(statistics, generated);
      return finish();
    }
    if (event.type === 'context.compacted') {
      if (!event.data.usage) return state;
      const compacted = emptyStatistics();
      addUsage(compacted, event.data.usage as Usage);
      if (event.data.cacheKnown === false) compacted.cacheKnown = false;
      const runId = event.data.runId;
      if (typeof runId === 'string' && runId) {
        const usage = compacted;
        const previous = Object.hasOwn(pendingCompactions, runId)
          ? pendingCompactions[runId]
          : undefined;
        Object.defineProperty(pendingCompactions, runId, {
          enumerable: true,
          configurable: true,
          writable: true,
          value: {
            inputTokens: Math.min(
              Number.MAX_SAFE_INTEGER,
              (previous?.inputTokens ?? 0) + usage.inputTokens,
            ),
            outputTokens: Math.min(
              Number.MAX_SAFE_INTEGER,
              (previous?.outputTokens ?? 0) + usage.outputTokens,
            ),
            cachedInputTokens: Math.min(
              Number.MAX_SAFE_INTEGER,
              (previous?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
            ),
            cacheWriteInputTokens: Math.min(
              Number.MAX_SAFE_INTEGER,
              (previous?.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
            ),
          },
        });
      } else settledTimingKnown = false;
      statistics = addStatistics(statistics, compacted);
      return finish();
    }
    if (event.type === 'run.interrupted') {
      const runId = String(event.data.runId ?? '');
      if (!Object.hasOwn(pendingCompactions, runId)) return state;
      delete pendingCompactions[runId];
      settledTimingKnown = false;
      return finish();
    }
    if (event.type !== 'run.finished') return state;
    const runStatistics =
      event.data.statistics === undefined ? undefined : normalizeStatistics(event.data.statistics);
    const runId = String(event.data.runId ?? '');
    const pending = Object.hasOwn(pendingCompactions, runId)
      ? pendingCompactions[runId]
      : undefined;
    if (runStatistics) {
      const counted = event.data.compactionUsage === undefined ? undefined : emptyStatistics();
      if (counted) addUsage(counted, event.data.compactionUsage as Usage);
      settledTimingKnown &&= runStatistics.timingKnown;
      if (pending) {
        const matches =
          counted &&
          (
            ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens'] as const
          ).every((key) => (pending[key] ?? 0) === (counted[key] ?? 0));
        if (!matches) settledTimingKnown = false;
        delete pendingCompactions[runId];
      }
      statistics = addStatistics(
        // Pending summaries make the displayed total temporarily unknown. Keep that separate from
        // settled uncertainty so a matching run can confirm them, while numeric overflow stays unknown.
        { ...statistics, timingKnown: settledTimingKnown },
        counted
          ? {
              ...runStatistics,
              usageComplete: runStatistics.usageComplete && counted.usageComplete,
              inputTokens: runStatistics.inputTokens - counted.inputTokens,
              outputTokens: runStatistics.outputTokens - counted.outputTokens,
              cachedInputTokens: runStatistics.cachedInputTokens - (counted.cachedInputTokens ?? 0),
              cacheWriteInputTokens:
                runStatistics.cacheWriteInputTokens - (counted.cacheWriteInputTokens ?? 0),
            }
          : runStatistics,
      );
      settledTimingKnown &&= statistics.timingKnown;
      return finish();
    }
    const legacy = emptyStatistics();
    if (event.data.usage) addUsage(legacy, event.data.usage as Usage);
    settledTimingKnown = false;
    delete pendingCompactions[runId];
    statistics = addStatistics(statistics, legacy);
    return finish();
  },
};
/**
 * Sub-agent cards, as a projection.
 *
 * A card used to be derived at read time from two places: the parent's latest stored run result (which
 * carried the summaries) and a `subagent_assignments` table that existed only so a child whose parent
 * crashed could still be shown. Both are durable facts about the *parent's* session, so they belong in the
 * parent's log — and once they are, the cards are a fold.
 *
 * The fold keeps identity and outcome separate on purpose: `assigned` says a child exists (and which run
 * started it), `finished` fills in how it ended, and `interrupted` is recorded by crash recovery, which is
 * the only place that knows a child's run died. Which cards a reader should *see* is a separate question,
 * answered by `subAgentCards` — a fold must not decide presentation.
 */
export interface SubAgentCard extends SubAgentSummary {
  /** The run that started this child; the interrupted cards carry the run that died. */
  runId?: string;
}
export interface SubAgentCardsState {
  /** The most recent run that finished, which is the run whose children a reader shows. */
  latestRunId?: string;
  children: Record<string, SubAgentCard>;
}
export const subAgentsProjection: SessionProjection<SubAgentCardsState> = {
  name: 'subagents',
  description: 'Durable sub-agent cards: identity, outcome and interruption, per run.',
  initial: () => ({ children: {} }),
  apply: (state, event) => {
    const children = { ...state.children };
    if (event.type === 'run.finished') {
      const runId = String(event.data.runId ?? '');
      if (runId) return { ...state, latestRunId: runId, children };
      return state;
    }
    if (event.type === 'subagent.assigned') {
      const id = String(event.data.id ?? '');
      const childSessionId = String(event.data.childSessionId ?? '');
      if (!id || !childSessionId) return state;
      const previous = children[id];
      // Merge rather than replace: an assignment that arrives after its own outcome (a replayed or
      // backfilled log) must not reset a known result back to "running".
      children[id] = {
        ...(previous ?? {
          id,
          sessionId: childSessionId,
          role: 'explore' as const,
          objective: '',
          status: 'running' as const,
          rounds: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
        id,
        sessionId: childSessionId,
        role: (event.data.role as SubAgentSummary['role']) ?? previous?.role ?? 'explore',
        objective: String(event.data.objective ?? previous?.objective ?? ''),
        ...(event.data.runId
          ? { runId: String(event.data.runId) }
          : previous?.runId
            ? { runId: previous.runId }
            : {}),
      };
      return { ...state, children };
    }
    if (event.type === 'subagent.finished') {
      const id = String(event.data.id ?? '');
      if (!id) return state;
      const previous = children[id];
      children[id] = {
        ...(previous ?? {
          id,
          sessionId: String(event.data.sessionId ?? ''),
          role: event.data.role as SubAgentSummary['role'],
          objective: String(event.data.objective ?? ''),
          rounds: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
        ...(event.data.sessionId ? { sessionId: String(event.data.sessionId) } : {}),
        status: event.data.status as SubAgentSummary['status'],
        rounds: Number(event.data.rounds ?? 0),
        toolCalls: Number(event.data.toolCalls ?? 0),
        usage: (event.data.usage as SubAgentSummary['usage']) ?? {
          inputTokens: 0,
          outputTokens: 0,
        },
        ...(event.data.report ? { report: event.data.report as SubAgentSummary['report'] } : {}),
        ...(event.data.error ? { error: String(event.data.error) } : {}),
        ...(event.data.runId ? { runId: String(event.data.runId) } : {}),
      };
      return { ...state, children };
    }
    if (event.type === 'subagent.interrupted') {
      const childSessionId = String(event.data.childSessionId ?? '');
      const existing = Object.values(children).find((child) => child.sessionId === childSessionId);
      const id = existing?.id ?? childSessionId;
      children[id] = {
        ...(existing ?? {
          id,
          sessionId: childSessionId,
          role: 'explore',
          objective: '',
          rounds: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
        status: 'interrupted',
        error: String(
          event.data.reason ??
            'Interrupted; inspect the child transcript and current state before retrying.',
        ),
        ...(event.data.runId ? { runId: String(event.data.runId) } : {}),
      };
      return { ...state, children };
    }
    return state;
  },
};
/**
 * Which cards a reader of a parent session should see, given the folded state.
 *
 * Two rules, both inherited from what the desktop already showed and both worth stating because they are
 * presentation rather than fact: the cards of the **latest finished run**, plus any child that was
 * **interrupted and never reported**, so an unfinished delegation does not disappear from the UI just
 * because a later run happened. Ordering follows the log, which is the order the runs happened in.
 */
export function subAgentCards(state: SubAgentCardsState): SubAgentSummary[] {
  const cards = Object.values(state.children);
  const latest = state.latestRunId;
  const shown = latest ? cards.filter((card) => card.runId === latest) : [];
  const shownIds = new Set(shown.map((card) => card.id));
  for (const card of cards)
    if (card.status === 'interrupted' && !shownIds.has(card.id)) shown.push(card);
  return shown.map(({ runId: _runId, ...summary }) => summary as SubAgentSummary);
}
/**
 * The session-owned todo list, as a projection.
 *
 * The event carries the whole list rather than a delta, so the fold is a replacement and the latest
 * `todo.written` in the log *is* the current list. That is what lets a reload rebuild the checklist with no
 * table beside it, and what makes "did the model drop an item?" answerable from the record.
 *
 * The payload is filtered rather than trusted: this fold reads a log that a different build may have written,
 * and keeping the previous list beats substituting an empty one — an empty list reads as "the model cleared
 * its plan", which is a claim nothing in a malformed event supports.
 */
export const todosProjection: SessionProjection<TodoItem[]> = {
  name: 'todos',
  description: 'The session-owned checklist as the model last wrote it.',
  initial: () => [],
  apply: (state, event) => {
    if (event.type !== 'todo.written') return state;
    const todos = event.data.todos;
    if (!Array.isArray(todos)) return state;
    return todos.filter(isTodoItem);
  },
};
/**
 * What the latest `todo.written` changed, alongside the list it changed it into.
 *
 * The list projection answers "what is the plan"; this one answers "what just happened to it", which a reader
 * cannot get from the newest event alone — the previous version is what makes a change a change. Both are
 * folds of the same events rather than two sources: the fold carries the previous list forward, so a write has
 * something to be compared against, and an event written by a build that predates this view still produces the
 * right answer (there is nothing to fall back on, because nothing was ever recorded).
 */
export const todoChangeProjection: SessionProjection<{
  todos: TodoItem[];
  change: TodoChange | null;
}> = {
  name: 'todoChange',
  description: 'The session checklist and what the most recent write changed about it.',
  initial: () => ({ todos: [], change: null }),
  apply: (state, event) => {
    if (event.type !== 'todo.written') return state;
    const todos = event.data.todos;
    if (!Array.isArray(todos)) return state;
    const next = todos.filter(isTodoItem);
    return { todos: next, change: todoDiff(state.todos, next) };
  },
};
/**
 * The run's steps, as the log recorded their boundaries.
 *
 * A fold rather than a table, because the log already is the record: a step's start, its end and the reason for
 * the end are written once each, and the reader's question — which step is open, and how did the last ones end —
 * is what folding them in order answers. It is also the only view that can answer it *after a crash*: a step that
 * never ended has no record of its own, so "open" is a property of the fold, not of a row anybody could have
 * written before the process died.
 *
 * Bounded by `STEP_HISTORY_LIMIT`, so a session that has run for a month does not grow this view without bound;
 * the older boundaries stay in the log for a reader that wants the whole history.
 */
export const stepsProjection: SessionProjection<readonly StepRecord[]> = {
  name: 'steps',
  description: "The run's recent steps, and why each one ended.",
  initial: () => [],
  apply: (state, event) => applyStepEvent(state, event),
};
/**
 * How long this session's runs have been active, as a fold of its own run boundaries.
 *
 * A session's *work* time is not its age and not the sum of its model time: a child delegated an hour ago
 * may have run for two minutes, an interrupted run may have ended without a `run.finished`, and a session
 * that ran three turns spent the gaps between them idle. Only the run boundaries answer that, and they are
 * already in the log — `run.started` opens a span, `run.finished` or `run.interrupted` closes it.
 *
 * The state keeps the open run's id as well as its start: two runs of one session cannot overlap, and a
 * boundary that names a different run than the open one is a record about a run this fold is not holding —
 * closing the open span with it would charge this run for somebody else's end. Timestamps are read from the
 * event's own `at` rather than from a clock, so the fold is a pure function of the log and a reload computes
 * exactly what the process that watched it would have.
 */
export interface TurnTiming {
  /** Summed wall time of this session's ended runs, in milliseconds. */
  settledMs: number;
  /** Epoch ms the open run started, or null when none is open. */
  runningSince: number | null;
  /** The open run's id, so a stale end cannot close a span it does not belong to. */
  runningRunId: string | null;
}
export const turnTimingProjection: SessionProjection<TurnTiming> = {
  name: 'turnTiming',
  description: "Wall-clock time this session's runs have been active.",
  initial: () => ({ settledMs: 0, runningSince: null, runningRunId: null }),
  apply: (state, event) => {
    if (event.type === 'run.started') {
      const runId = event.data.runId;
      if (typeof runId !== 'string' || !runId) return state;
      // A start with no usable clock is not a span this fold can measure; the run is still not "open" for
      // timing purposes, which is the honest answer rather than a span measured from the epoch.
      const started = Date.parse(event.at);
      if (!Number.isFinite(started)) return state;
      // Repeating the same start keeps the original clock. A different run replaces an unclosed run at
      // this boundary, settling the elapsed span so recovery cannot discard time already observed.
      if (runId === state.runningRunId) return state;
      return {
        settledMs:
          state.settledMs +
          (state.runningSince === null ? 0 : Math.max(0, started - state.runningSince)),
        runningSince: started,
        runningRunId: runId,
      };
    }
    if (event.type !== 'run.finished' && event.type !== 'run.interrupted') return state;
    const runId = event.data.runId;
    if (typeof runId !== 'string' || !runId || runId !== state.runningRunId) return state;
    if (state.runningSince === null) return state;
    const ended = Date.parse(event.at);
    if (!Number.isFinite(ended)) return state;
    return {
      settledMs: state.settledMs + Math.max(0, ended - state.runningSince),
      runningSince: null,
      runningRunId: null,
    };
  },
};
/** One message a parent accepted for a child whose own transcript has not taken it up. */
export interface PendingSubagentMessage {
  /** The id the parent's log gave the message; the receipt `send_message` returned carries the same one. */
  id: string;
  /** The delegation this message was for; `subagent.assigned` names the same child this way. */
  childId: string;
  /** The child's own session, which is how `job_output` and `send_message` address it. */
  childSessionId: string;
  message: string;
  /**
   * True once a *correction*'s hand-off happened — its queue accepted it, and what is missing is the child's
   * receipt. Always false for a message handed over as its own turn, which does not stay pending at all.
   *
   * The two states have different prescriptions, which is the whole reason this field exists: a message that was
   * never handed over never reached the child and has to be sent again, while one that was handed over may well
   * be in the child's next step — so the parent has to look before it resends.
   */
  handed: boolean;
}
/**
 * The messages that were accepted for a child and never reached its transcript.
 *
 * The log has three records per message (`subagent.message.queued`, `subagent.message.handed`, and the child's
 * own `subagent.message.consumed` receipt), and this fold is what they add up to: queued, in one of two states,
 * until the child's transcript takes it up.
 *
 * It used to stop at `handed`, because that was the last thing anyone wrote down: the child's queue is in
 * memory, so "a turn accepted it" was the strongest fact available, and the record had to treat it as the end.
 * The cost was the window this projection could not see — a process that stopped between the hand-off and the
 * child's next step boundary left a message the child never read while the parent's log said it was delivered,
 * and the parent believed a correction had landed that never did. The receipt closes it: the child writes one
 * durable record at the moment the correction becomes a user message in its own transcript, and `handed` becomes
 * what it always was — a state, not an ending.
 */
export const subagentInboxProjection: SessionProjection<readonly PendingSubagentMessage[]> = {
  name: 'subagentInbox',
  description: 'Messages accepted for a sub-agent that its transcript never took up.',
  initial: () => [],
  apply: (state, event) => {
    if (event.type === 'subagent.message.queued') {
      const id = String(event.data.id ?? '');
      const childSessionId = String(event.data.childSessionId ?? '');
      // A record without an id or a child names nothing a reader could act on, so it contributes nothing rather
      // than a row the parent cannot send anywhere.
      if (!id || !childSessionId) return state;
      return [
        ...state.filter((entry) => entry.id !== id),
        {
          id,
          childId: String(event.data.childId ?? ''),
          childSessionId,
          message: String(event.data.message ?? ''),
          handed: false,
        },
      ];
    }
    if (event.type === 'subagent.message.handed') {
      const id = String(event.data.id ?? '');
      // Only a message this log queued can become "handed": a hand-off for something never accepted is not a
      // pending message, and inventing a row for it would report a message the parent cannot quote.
      if (!id) return state;
      /**
       * A *turn* ends the story; a *correction* does not.
       *
       * The two hand-offs put the message in different places. A correction rides the child's queue, which is in
       * memory, so "a turn's queue accepted it" is not yet "the child read it" — that is the window the receipt
       * closes, and it stays pending until the receipt arrives. A turn is the run the parent started, whose first
       * act is writing the message into the child's transcript, so a completed hand-off there has already reached
       * the child; keeping it pending would nag a parent about a message it may be holding the answer to.
       */
      if (String(event.data.how ?? '') === 'turn') return state.filter((entry) => entry.id !== id);
      return state.map((entry) => (entry.id === id ? { ...entry, handed: true } : entry));
    }
    if (event.type === 'subagent.message.consumed') {
      const id = String(event.data.id ?? '');
      return id ? state.filter((entry) => entry.id !== id) : state;
    }
    return state;
  },
};
/**
 * The files this session presented, as a projection.
 *
 * The event carries the whole declaration of the files in one call, and the fold replaces by path, so the
 * newest record for a path is what a reader sees and the order a panel shows is the order the files were
 * first named. `presentFiles` is the same function the writing side uses, so a live panel and a reloaded one
 * cannot disagree about what a second presentation of the same path means.
 *
 * Payloads are filtered rather than trusted, for the reason the checklist's fold is: this reads a log another
 * build may have written, and dropping an entry nothing can render beats rendering a file with no path.
 */
export const deliverablesProjection: SessionProjection<PresentedFile[]> = {
  name: 'deliverables',
  description: 'The workspace files the model presented as this session’s deliverables.',
  initial: () => [],
  apply: (state, event) => {
    if (event.type !== 'deliverable.presented') return state;
    const files = event.data.files;
    if (!Array.isArray(files)) return state;
    return presentFiles(state, files.filter(isPresentedFile));
  },
};
/**
 * The session's goal, as a projection.
 *
 * One state, replaced wholesale: the event carries the goal and the fold is that replacement, so the newest
 * `goal.changed` *is* the goal and a reload needs no replay of actions. A payload this build cannot read
 * keeps the previous state rather than clearing it — "no goal" is a real answer a person reads as "nothing is
 * running", and a malformed record does not support it.
 */
export const goalProjection: SessionProjection<Goal | null> = {
  name: 'goal',
  description: 'The objective this session is pursuing, as last recorded.',
  initial: () => null,
  apply: (state, event) => {
    if (event.type !== 'goal.changed') return state;
    const goal = event.data.goal;
    return isGoal(goal) ? goal : state;
  },
};
/** The projections every store starts with. A host may register more, and remove any of them. */
export const BUILT_IN_SESSION_PROJECTIONS: readonly SessionProjection<unknown>[] = [
  messagesProjection,
  statisticsProjection,
  turnTimingProjection,
  subAgentsProjection,
  subagentInboxProjection,
  todosProjection,
  todoChangeProjection,
  deliverablesProjection,
  goalProjection,
  stepsProjection,
];
