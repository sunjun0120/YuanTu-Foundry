import type { PresentedFile } from '../protocol/deliverables.ts';
import type { Goal } from '../protocol/goals.ts';
import type { SubAgentSummary, TodoItem } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { TodoChange } from '../protocol/todos.ts';
import type { StatisticsState, SubAgentCardsState, TurnTiming } from './projections.ts';
import { subAgentCards } from './projections.ts';
import type { Session } from './session-schema.ts';

export interface SessionProjectionReadsPort {
  get(id: string): Session;
  flush(id?: string): void;
  lastSeq(id: string): number;
  /** The registered projection names, in registration order, for a whole-session snapshot. */
  projectionNames(): readonly string[];
  /** See `SessionCheckpoints.foldProjections`. */
  foldProjections(
    names: readonly string[],
    sessionId: string,
  ): { states: Map<string, unknown>; seq: number };
  saveProjectionCheckpoints(sessionId?: string): number;
}

/**
 * The reader-facing views of a session's log: one projection, all of them, and the named reads built on them
 * (sub-agent cards, the checklist, deliverables, the goal, statistics). Every answer here is what the log folds
 * to; see `./session-checkpoints.ts` for how a persisted checkpoint only shortens that fold.
 */
export class SessionProjectionReads {
  private readonly port: SessionProjectionReadsPort;
  /** The log position each session was last checkpointed at by {@link checkpointIfDue}, in this process. */
  private checkpointMarks = new Map<string, number>();

  constructor(port: SessionProjectionReadsPort) {
    this.port = port;
  }

  /**
   * One projection's state for a session, folded from the log.
   *
   * This is the reader-facing form: a view is whatever the log folds to, so the same session read twice
   * gives the same answer, and a session read by a build that does not know an event refuses rather than
   * showing a shorter history.
   *
   * A persisted checkpoint, when there is a usable one, is the *starting point* rather than the answer: the
   * events after it are folded on top, so the result is still "what the log folds to" — and when the
   * checkpoint has already reached the end of the log, nothing is folded at all. That is the difference
   * between this and a cache: a cache answers, this one only skips work whose answer is already written down.
   */
  stateOf<State>(name: string, sessionId: string): State {
    this.port.get(sessionId);
    const folded = this.port.foldProjections([name], sessionId).states.get(name);
    return (name === 'statistics' ? (folded as StatisticsState).statistics : folded) as State;
  }

  /** Every projection in one pass, for a host rendering a whole session. */
  snapshot(sessionId: string): Record<string, unknown> {
    this.port.get(sessionId);
    const folded = this.port.foldProjections(this.port.projectionNames(), sessionId).states;
    const statistics = folded.get('statistics') as StatisticsState;
    folded.set('statistics', statistics.statistics);
    return Object.fromEntries(folded);
  }

  /**
   * Sub-agent summaries from the most recent finished run.
   *
   * They are read back out of the parent's durable log: `subagent.assigned` records that a child exists,
   * `subagent.finished` how it ended, and `subagent.interrupted` what crash recovery found. The child
   * session holds the transcript and the file-change journal holds the effects, so a summary stays derived
   * data — but it is now derived from the record rather than stored beside it.
   *
   * Each card is completed with the child's own turn timing, folded from that child session's log. It is the
   * one figure the parent's log cannot answer — the parent records one assignment and one end per turn, so a
   * resident child's later turns have no start of their own there — and a catalog that showed a delegated
   * child's age instead of its work time would be measuring the wrong thing.
   */
  subagents(sessionId: string, includePreviousRuns = false): SubAgentSummary[] {
    return subAgentCards(
      this.stateOf<SubAgentCardsState>('subagents', sessionId),
      includePreviousRuns,
    ).map((card) => (card.sessionId ? this.withTurnTiming(card) : card));
  }

  /** One child card plus the timing of the session that holds its work. */
  private withTurnTiming(card: SubAgentSummary): SubAgentSummary {
    /**
     * The card comes from the *parent's* log, so it outlives the child's own rows: a deleted child session
     * (the delete RPC accepts any id) left its card behind, and this lookup then threw "Session not found" —
     * making the whole catalog unreadable for a parent that was otherwise healthy. A missing child means
     * "there is no timing left to report", not "the catalog cannot be shown".
     */
    let timing: TurnTiming;
    try {
      timing = this.turnTiming(card.sessionId);
    } catch {
      return { ...card, durationMs: undefined, runningSince: undefined };
    }
    return { ...card, durationMs: timing.settledMs, runningSince: timing.runningSince };
  }

  /**
   * How long this session's runs have been active, folded from its own run boundaries.
   *
   * Asked for a child session as often as for the session being read: a sub-agent's duration is its own
   * session's work time, so the same fold answers both and there is no second tally to drift from it.
   */
  turnTiming(sessionId: string): TurnTiming {
    return this.stateOf<TurnTiming>('turnTiming', sessionId);
  }

  /**
   * The session's checklist as the model last wrote it.
   *
   * Read from the log like the sub-agent cards: the latest `todo.written` *is* the list, so a reload rebuilds
   * the checklist from the record rather than from a table that could disagree with it.
   */
  todos(sessionId: string): TodoItem[] {
    return this.stateOf<TodoItem[]>('todos', sessionId);
  }

  /**
   * What the most recent `todo_write` changed about the checklist — `null` when nothing has been written yet
   * or when the last write left the plan exactly as it was.
   *
   * Derived from the log like every other projection, so a session restored after a restart answers this the
   * same way the process that wrote it did, without a column beside the events that could disagree with them.
   */
  todoChange(sessionId: string): TodoChange | null {
    return this.stateOf<{ todos: TodoItem[]; change: TodoChange | null }>('todoChange', sessionId)
      .change;
  }

  /**
   * The files this session presented as deliverables, folded from the log.
   *
   * Read rather than stored beside the events for the same reason the checklist is: the presentation is a
   * record of what the model said, and a table would be a second copy of it that a crash could leave behind.
   */
  deliverables(sessionId: string): PresentedFile[] {
    return this.stateOf<PresentedFile[]>('deliverables', sessionId);
  }

  /** The objective this session is pursuing, or `null` when no run has recorded one. */
  goal(sessionId: string): Goal | null {
    return this.stateOf<Goal | null>('goal', sessionId);
  }

  statistics(sessionId: string): SessionStatistics {
    return this.stateOf<SessionStatistics>('statistics', sessionId);
  }

  /**
   * Checkpoint a session once its log has grown `everyEvents` past the last checkpoint this process wrote.
   *
   * `finishRun` and `close` checkpoint at their own stopping points; this is for the run that does not stop for
   * hours — a crash mid-run used to reopen by folding every event since the previous run ended. The first call
   * for a session only records where the log stands, so a short run never writes here and pays one map lookup
   * per step. Failures are swallowed like every checkpoint's: this is derived data.
   */
  checkpointIfDue(sessionId: string, everyEvents = 2_000): boolean {
    // `lastSeq` does not count buffered appends, so the log is written out first: the count has to be the log's.
    this.port.flush(sessionId);
    const seq = this.port.lastSeq(sessionId);
    const mark = this.checkpointMarks.get(sessionId);
    if (mark === undefined || seq < mark) {
      this.checkpointMarks.set(sessionId, seq);
      return false;
    }
    if (seq - mark < everyEvents) return false;
    this.checkpointMarks.set(sessionId, seq);
    return this.port.saveProjectionCheckpoints(sessionId) > 0;
  }
}
