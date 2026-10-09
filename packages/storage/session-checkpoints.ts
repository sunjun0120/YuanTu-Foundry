import type { DatabaseSync } from 'node:sqlite';
import { isGoal } from '../protocol/goals.ts';
import type { SessionEvent } from './events.ts';
import {
  SessionProjectionRegistry,
  isStatisticsState,
  type SessionProjection,
} from './projections.ts';
import { projectionFoldIdentity, shapedLike, trustedCheckpoint } from './session-schema.ts';

export interface SessionCheckpointPort {
  readonly db: DatabaseSync;
  readonly projections: SessionProjectionRegistry;
  transaction<T>(fn: () => T): T;
  checkedLog(id: string): readonly SessionEvent[];
  events(id: string, afterSeq?: number, limit?: number): SessionEvent[];
  flush(id?: string): void;
}

/** Derived states are trusted only after the same log and checkpoint validation as a full fold. */
export class SessionCheckpoints {
  private readonly port: SessionCheckpointPort;
  private foldCounters = { checkpointHits: 0, events: 0 };
  constructor(port: SessionCheckpointPort) {
    this.port = port;
  }

  /**
   * Folds the requested projections, reading the log once and using each projection's own checkpoint.
   *
   * The read starts at the earliest checkpoint **only when every projection being folded has one**. A
   * projection without a checkpoint must be folded from the beginning, so one such projection (the transcript,
   * always) makes the read start at 0 — and the projections that do have checkpoints still skip the events
   * theirs already covered, so the fold work saved is theirs either way.
   *
   * A checkpoint is a *shortcut* to what the log says, never a second answer, so doubt about one is settled the
   * same way in every case: fold from the beginning. Two kinds of doubt are handled here.
   *
   * The **structure** is checked against the projection's own empty state, because a state that parses as JSON
   * but has the wrong shape is the corruption a fold will not necessarily notice: an `apply` that walks an array
   * which arrived as an object can produce a quietly wrong answer instead of an error.
   *
   * And the state must survive **one real fold step** before it is trusted — `trustedCheckpoint` below. That is
   * the case the structural check cannot cover and the one that matters most: when a checkpoint has already
   * reached the end of the log, nothing is folded on top of it, so a rotten state is not "corrected by the next
   * event" — it is handed to the caller verbatim. Proving the state against one actual event is what makes the
   * answer the same as the log's rather than merely shaped like it.
   */
  foldProjections(
    names: readonly string[],
    sessionId: string,
  ): { states: Map<string, unknown>; seq: number } {
    // Before anything is folded: a projection answers from a log it must be able to interpret (see `checkedLog`).
    this.port.checkedLog(sessionId);
    const projections = names.map((name) => this.port.projections.get<unknown>(name));
    const checkpoints = new Map<string, { seq: number; state: unknown }>();
    for (const projection of projections) {
      // The identity is computed per projection, so a checkpoint written by a different fold of the *same*
      // projection is the only thing this discards: changing one fold no longer invalidates the others.
      const checkpoint = this.readProjectionCheckpoint(
        sessionId,
        projection.name,
        projectionFoldIdentity(projection as SessionProjection<never>),
        projection.initial(),
      );
      if (checkpoint) checkpoints.set(projection.name, checkpoint);
    }
    const complete = checkpoints.size === projections.length;
    const earliest =
      checkpoints.size && complete
        ? Math.min(...[...checkpoints.values()].map((checkpoint) => checkpoint.seq))
        : 0;
    /**
     * The read starts one event *before* the earliest checkpoint, because `events(id, afterSeq)` is exclusive:
     * without that adjustment the event each checkpoint claims to have folded is not in the array, and the
     * validation below would have nothing to replay against. The loop skips everything up to each checkpoint's
     * own seq, so the extra event is read and not folded.
     */
    const events = this.port.events(sessionId, Math.max(0, earliest - (earliest ? 1 : 0)));
    const states = new Map<string, unknown>();
    for (const projection of projections) {
      const checkpoint = checkpoints.get(projection.name);
      /**
       * A refused checkpoint means this projection starts at the beginning of the log, **and so does the read**.
       *
       * Reading from the earliest *surviving* checkpoint is only sound while every projection being folded has
       * one: `events` below starts there, so a projection whose checkpoint was refused would otherwise be handed
       * a partial log and fold it into the empty state — a quietly wrong answer, which is precisely what the
       * refusal was meant to prevent. So a refusal anywhere moves the read back to seq 0, and the projections
       * that still have checkpoints skip their own events as they always did.
       */
      if (checkpoint && !trustedCheckpoint(projection, checkpoint, events))
        return this.foldFromScratch(names, sessionId);
    }
    for (const projection of projections) {
      const checkpoint = checkpoints.get(projection.name);
      let state = checkpoint ? checkpoint.state : projection.initial();
      for (const event of events) {
        if (checkpoint && event.seq <= checkpoint.seq) continue;
        state = projection.apply(state, event);
        this.foldCounters.events++;
      }
      if (checkpoint) this.foldCounters.checkpointHits++;
      states.set(projection.name, state);
    }
    // The cursor belongs to the exact events folded above, so a checkpoint written from this fold claims only
    // what these states actually saw.
    return { states, seq: events.at(-1)?.seq ?? 0 };
  }

  /** The read every refusal falls back to: no checkpoints at all, from the first event in the log. */
  private foldFromScratch(
    names: readonly string[],
    sessionId: string,
  ): { states: Map<string, unknown>; seq: number } {
    const events = this.port.events(sessionId, 0);
    const states = new Map<string, unknown>();
    for (const name of names) {
      const projection = this.port.projections.get<unknown>(name);
      let state = projection.initial();
      for (const event of events) {
        state = projection.apply(state, event);
        this.foldCounters.events++;
      }
      states.set(name, state);
    }
    // The cursor is the newest event actually folded here, which is what a checkpoint written from this fold
    // must claim: a separate `MAX(seq)` could include a second connection's commit that none of these states saw.
    return { states, seq: events.at(-1)?.seq ?? 0 };
  }

  /**
   * How much folding reads have done in this process, for tests and benchmarks.
   *
   * `checkpointHits` says how many projection reads started from persisted state; `events` says how many
   * events those reads actually folded. They exist because "the checkpoint saved work" is otherwise a claim
   * nobody can check — the correctness tests compare against a full fold, and these numbers are what show the
   * fold did not happen.
   */
  foldStats(): { checkpointHits: number; events: number } {
    return { ...this.foldCounters };
  }

  resetFoldCounters(): void {
    this.foldCounters = { checkpointHits: 0, events: 0 };
  }

  /**
   * Writes the folded state of this session's projections, so the next process reads instead of folds.
   *
   * Deliberately not called on every read: that would turn a read into a write. It is called where a run or a
   * process is already at a stopping point (`finishRun`, `close`) and can be called explicitly by a host.
   * Failures are swallowed — this is derived data, and a session that cannot be checkpointed must still be
   * readable.
   */
  saveProjectionCheckpoints(sessionId?: string): number {
    try {
      const sessions = sessionId === undefined ? this.sessionIds() : [sessionId];
      let written = 0;
      const write = this.port.db.prepare(
        `INSERT INTO projection_checkpoints(session_id,name,seq,version,state,updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(session_id,name) DO UPDATE SET
           seq=excluded.seq, version=excluded.version, state=excluded.state, updated_at=excluded.updated_at`,
      );
      for (const id of sessions) {
        const persistent = this.port.projections
          .names()
          .filter((name) => this.port.projections.get(name).persist !== false);
        if (!persistent.length) continue;
        const { states: folded, seq } = this.foldProjections(persistent, id);
        const at = new Date().toISOString();
        this.port.transaction(() => {
          for (const name of persistent) {
            let state: string;
            try {
              state = JSON.stringify(folded.get(name));
            } catch {
              // A projection whose state cannot be serialised is simply not persisted; the reader falls back
              // to folding it, which is the same answer by a slower route.
              continue;
            }
            if (state === undefined) continue;
            write.run(
              id,
              name,
              seq,
              projectionFoldIdentity(this.port.projections.get<never>(name)),
              state,
              at,
            );
            written++;
          }
        });
      }
      return written;
    } catch {
      return 0;
    }
  }

  /**
   * The folded state a checkpoint holds, when one is usable. Anything doubtful reads as "no checkpoint".
   *
   * `identity` is the digest of the fold that would continue this state — see `projectionFoldIdentity`. A row
   * whose `version` is anything else (a different fold, an older build, a hand-edited file, a row written before
   * identities existed) is not a starting point, because folding from the log is always correct and continuing
   * somebody else's state is not.
   *
   * `fresh` is what the projection's own `initial()` returns, and the state has to have the same top-level
   * structure as it. That is the one structural claim this layer can make without knowing what a projection
   * means: an empty array and an empty object are both valid states, but only one of them is *this* projection's
   * kind of state, and a fold handed the other can produce a wrong answer instead of an error.
   */
  private readProjectionCheckpoint(
    sessionId: string,
    name: string,
    identity: string,
    fresh: unknown,
  ): { seq: number; state: unknown } | undefined {
    const row = this.port.db
      .prepare('SELECT seq,version,state FROM projection_checkpoints WHERE session_id=? AND name=?')
      .get(sessionId, name) as { seq?: number; version?: string; state?: string } | undefined;
    if (!row) return undefined;
    if (String(row.version) !== identity) return undefined;
    const seq = Number(row.seq);
    if (!Number.isFinite(seq) || seq < 0 || seq > this.lastEventSeq(sessionId)) return undefined;
    try {
      const state: unknown = JSON.parse(String(row.state));
      // A cached fold is only worth continuing if it is still the shape this build's guard accepts. Two
      // projections carry a semantic guard of their own — a statistics state whose numbers saturated, and a goal
      // whose budget is nonsense — and a checkpoint written before that guard existed must not slip past it.
      if (name === 'statistics' && !isStatisticsState(state)) return undefined;
      if (name === 'goal' && state !== null && !isGoal(state)) return undefined;
      return shapedLike(state, fresh) ? { seq, state } : undefined;
    } catch {
      return undefined;
    }
  }

  private lastEventSeq(sessionId: string): number {
    this.port.flush(sessionId);
    return Number(
      (
        this.port.db
          .prepare('SELECT MAX(seq) AS seq FROM session_events WHERE session_id=?')
          .get(sessionId) as { seq?: number | null } | undefined
      )?.seq ?? 0,
    );
  }

  /** Session ids in this database, oldest first — what a whole-database checkpoint pass walks. */
  private sessionIds(): string[] {
    return (
      this.port.db
        .prepare('SELECT id FROM sessions ORDER BY created_at,rowid')
        .all() as unknown as {
        id: string;
      }[]
    ).map((row) => row.id);
  }
}
