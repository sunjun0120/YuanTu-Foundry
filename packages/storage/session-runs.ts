import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { redactSecrets } from '../core/errors.ts';
import { changeGoal, type Goal } from '../protocol/goals.ts';
import type { Message, RunResult } from '../protocol/index.ts';
import type { SessionLease } from '../protocol/session-lease.ts';
import type { StepRecord } from '../protocol/steps.ts';
import { foldSteps, inFlightStep as openStepOf } from '../protocol/steps.ts';
import type { WorkspaceBinding } from '../protocol/workspaces.ts';
import { WorkspaceFailure } from '../protocol/workspaces.ts';
import { type PendingSessionInput, type SessionEventType } from './events.ts';
import type { Session } from './session-schema.ts';
import { ownStartedAt } from '../platform/process-identity.ts';
import { ageSuffix, deadOwner, leaseEvidence, RUN_INTERRUPTED_REASON } from './session-schema.ts';

/** Run lifecycle, interruption recovery and leases. All writes borrow the store transaction and event writer. */
export interface SessionRunsPort {
  db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  get(id: string): Session;
  messages(id: string): Message[];
  append(id: string, message: Message): void;
  pendingInputs(id: string): PendingSessionInput[];
  recordEvent(id: string, type: SessionEventType, data: Record<string, unknown>): void;
  workspaceBinding(id: string): WorkspaceBinding;
  workspaces: { operationIsLive(bindingId: string): boolean };
  goal(id: string): Goal | null;
  saveProjectionCheckpoints(id?: string): number;
}

/** Runs this process ended without managing to persist their end; see `forsakeRun`. */
const FORSAKEN_RUNS = new Set<string>();

export class SessionRuns {
  private readonly port: SessionRunsPort;

  constructor(port: SessionRunsPort) {
    this.port = port;
  }

  // An unresolved call may already have had effects: record uncertainty, never replay it.
  resolvePending(id: string, reason: string): number {
    const messages = this.port.messages(id);
    const pending = new Map<string, Message & { role: 'assistant' }>();
    for (const message of messages) {
      if (message.role === 'assistant')
        for (const call of message.toolCalls) pending.set(call.id, message);
      if (message.role === 'tool') pending.delete(message.toolCallId);
    }
    for (const callId of pending.keys())
      this.port.append(id, { role: 'tool', toolCallId: callId, isError: true, content: reason });
    return pending.size;
  }

  /**
   * Converge one run whose owning process is gone, and record the fact in the session's log.
   *
   * Every path that finds an abandoned run goes through here, because the three effects have to happen
   * together or not at all: the unresolved calls must be answered with uncertainty (they may have had
   * effects, so they are never replayed), the run row must stop saying `running`, and the session must stop
   * pointing at it. The last of those is why this is not just housekeeping — a stale `active_run` blocks
   * deleting the session and editing its history, so a crash used to leave a session that could not be
   * cleaned up until something else happened to converge it.
   *
   * The `run.interrupted` record is the part that replaces what the stale pointer was carrying: "this run
   * ended because its process died" belongs in the log, where a reader finds it next to the run's start,
   * rather than in a column that only says a run is *somewhere* in flight.
   */
  /**
   * Converge one run whose owning process is gone; the task journal settles a dead attempt through this.
   *
   * `private` would be the default, but the journal is a collaborator rather than a caller: it borrows exactly
   * this and the five other members named in the port it is constructed with.
   */
  settleAbandonedRun(sessionId: string, runId: string, reason: string): void {
    /**
     * Every fallible read happens before the first write.
     *
     * `resolvePending` appends an answer per unresolved call, and the caller's transaction joins rather than
     * nests, so a refusal from a later read (`inFlightStep` parses each step payload, `pendingInputs` parses
     * queued input) would be committed anyway: the transcript would carry "outcome unknown" answers while the
     * run row and `sessions.active_run` still claimed the dead run was in flight, and a session in that state
     * cannot be continued, renamed or deleted. Reading first means a refusal leaves nothing written.
     */
    const step = this.inFlightStep(sessionId, runId);
    /**
     * Inputs the dead process was holding when it stopped.
     *
     * Counted here, where the interruption is already being described, because it is the same kind of fact as
     * `pendingCalls`: something was accepted and never happened. The inbox fold answers it too, but a reader
     * looking for the aftermath of a crash reads this record, and "a follow-up was waiting and was never sent"
     * is part of that aftermath. Left off the record when there was none, so absence means "nothing was
     * waiting" rather than "nobody counted".
     */
    const undelivered = this.port.pendingInputs(sessionId).length;
    /**
     * The plan this run was filling in, if it never finished filling it.
     *
     * The row was created before the planning run started, on purpose, so that a crash leaves a record rather than
     * nothing. What it must not keep saying is that somebody is still working on it: `planning` is a promise, and
     * the run that made it is gone. Moving it to `abandoned` keeps the record and drops the promise, and the count
     * rides the interruption record so a reader learns it where they learn about the crash.
     */
    // The first write of this method, with every fallible read above it: see the note at the top.
    const pendingCalls = this.resolvePending(sessionId, reason);
    const abandonedPlans = this.port.db
      .prepare(
        "UPDATE plans SET status='abandoned', updated_at=? WHERE run_id=? AND status='planning'",
      )
      .run(new Date().toISOString(), runId).changes;
    this.port.db
      .prepare("UPDATE runs SET status='interrupted' WHERE id=? AND status='running'")
      .run(runId);
    this.port.db.prepare('UPDATE sessions SET active_run=NULL WHERE active_run=?').run(runId);
    // The abandoned run's lease goes with it: it is presence, and the process that held it is gone. Only the
    // owner's own lease is cleared, so converging one run cannot release another run's hold on the session.
    this.port.db
      .prepare('DELETE FROM session_leases WHERE session_id=? AND run_id=?')
      .run(sessionId, runId);
    this.port.recordEvent(sessionId, 'run.interrupted', {
      runId,
      pendingCalls,
      reason,
      /**
       * The step it died in, when the run opened one.
       *
       * The first question a crash raises is "where was it?", and the answer is in the log already — a
       * `step.started` with no end — but only for a reader who knows to pair the boundaries up. Carrying the
       * number here means the record of the interruption answers it where somebody looks for the interruption,
       * and `null`-less absence means the process died before the run's first step, which is a different (and
       * equally useful) answer.
       */
      ...(step ? { step: step.step } : {}),
      ...(undelivered ? { undeliveredInputs: undelivered } : {}),
      ...(abandonedPlans ? { abandonedPlans } : {}),
    });
  }

  /**
   * The step a run left open in the log, or `null` when every step it opened was closed.
   *
   * Read from the log rather than kept in a column, for the same reason `retryCount` is counted from the log: a
   * second copy of "which step was in flight" is a second answer, and the one that survives a crash is the one
   * written before it. Only the two boundary types are read and the fold is bounded, so this stays cheap on a
   * session with a long history.
   */
  inFlightStep(sessionId: string, runId: string): StepRecord | null {
    const events = this.port.db
      .prepare(
        "SELECT type,data,at FROM session_events WHERE session_id=? AND type IN ('step.started','step.finished') ORDER BY seq",
      )
      .all(sessionId)
      .map((row) => ({
        type: String(row.type),
        data: JSON.parse(String(row.data)) as Record<string, unknown>,
        at: String(row.at),
      }));
    return openStepOf(foldSteps(events, { runId }));
  }

  /**
   * Converge every ordinary session a dead Host left with a run in flight.
   *
   * Run at startup, so reopening a workspace after a crash shows sessions that can be used, deleted or
   * edited, and shows the interruption in each session's own record. Only runs whose owner process is gone
   * are touched: another Host on the same workspace is a live owner, and its runs are left alone.
   *
   * Delegated child sessions are excluded because `reconcileChildRuns` converges them and additionally records
   * the interruption on the parent's log, where a reader of the parent can see it. A fork is not a child in that
   * sense — it is an ordinary conversation that happens to point at its source — so it is converged here.
   *
   * Every carrier that opens a workspace has to call this at startup, next to `reconcileChildRuns`: a
   * conversation is only usable again once something has looked at it, and a carrier that forgets leaves
   * sessions its own UI cannot delete, rename or continue. `tests/cli.test.ts` pins that for the CLI.
   */
  reconcileInterruptedRuns(workspace?: string): number {
    return this.port.transaction(() => {
      const rows = this.port.db
        .prepare(
          `SELECT s.id AS sessionId, s.active_run AS runId, r.owner_pid AS ownerPid,
                  r.owner_started_at AS ownerStartedAt
           FROM sessions s JOIN runs r ON r.id=s.active_run
           WHERE (s.parent_session_id IS NULL OR s.fork_message_count IS NOT NULL)
             AND r.status='running' AND (? IS NULL OR s.workspace=?)`,
        )
        .all(workspace ?? null, workspace ?? null)
        .filter((row) => deadOwner(row.ownerPid, row.ownerStartedAt));
      /** How many were actually converged: a session that threw above is not one of them. */
      let converged = 0;
      for (const row of rows) {
        /**
         * One session at a time, and one failure at a time.
         *
         * `settleAbandonedRun` is not read-only housekeeping: it answers the run's unresolved tool calls and
         * parses the session's event log, so a session this build cannot fold — a blob that is gone, an event
         * type it refuses by design — throws from inside here. Letting that escape did two things at once: it
         * rolled back the convergence already performed for the *other* sessions, and it propagated to the
         * caller, which is Host startup. One unreadable conversation therefore left every session in the
         * workspace unusable and stopped the Host from opening at all. The session that cannot be converged is
         * named and skipped, and the rest still become deletable, renameable and continuable.
         */
        try {
          this.settleAbandonedRun(String(row.sessionId), String(row.runId), RUN_INTERRUPTED_REASON);
          converged += 1;
        } catch (error) {
          console.error(
            `[session log] could not converge interrupted run ${String(row.runId)} in session ` +
              `${String(row.sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return converged;
    });
  }

  /**
   * Record that this process has finished with a run whose end it could not persist.
   *
   * The lease is decided by the owner's pid and never by age, which is right for a run that is working and wrong
   * for one that is over: when `finishRun` itself keeps failing, the row still names this live process and every
   * later run of the session was refused until the Host restarted. The note is process memory on purpose — it is
   * this process vouching for its own run, which no other process could do — and `beginRun` then converges the
   * row exactly as it does a crashed owner's.
   */
  forsakeRun(runId: string): void {
    FORSAKEN_RUNS.add(runId);
  }

  beginRun(id: string): string {
    return this.port.transaction(() => {
      const session = this.port.get(id);
      const binding = this.port.workspaceBinding(id);
      if (binding.kind === 'worktree' && this.port.workspaces.operationIsLive(binding.id))
        throw new WorkspaceFailure(
          'WORKSPACE_BUSY',
          'Workspace management is in progress; wait before starting a run',
        );
      if (binding.kind === 'worktree' && binding.state !== 'ready')
        throw new WorkspaceFailure(
          'WORKSPACE_BUSY',
          'Restore the isolated workspace before starting a run',
        );
      if (session.activeRun) {
        const row = this.port.db
          .prepare('SELECT owner_pid,owner_started_at FROM runs WHERE id=?')
          .get(session.activeRun);
        let alive = false;
        if (row) {
          alive = !deadOwner(row.owner_pid, row.owner_started_at);
          // This process ended that run and could not write so: its owner is alive, but the run is not.
          if (Number(row.owner_pid) === process.pid && FORSAKEN_RUNS.has(session.activeRun))
            alive = false;
        }
        if (alive)
          throw new Error(
            'This session is already running. Cancel or stop its owning process first.' +
              leaseEvidence(this.leaseOf(id)),
          );
        // The same convergence startup performs, in case this session was never read since the crash.
        this.settleAbandonedRun(id, session.activeRun, RUN_INTERRUPTED_REASON);
      }
      const runId = randomUUID();
      this.port.db
        .prepare(
          "INSERT INTO runs(id,session_id,owner_pid,status,started_at,owner_started_at) VALUES(?,?,?,'running',?,?)",
        )
        .run(runId, id, process.pid, new Date().toISOString(), ownStartedAt());
      this.port.db.prepare('UPDATE sessions SET active_run=? WHERE id=?').run(runId, id);
      /**
       * The lease is taken in the same transaction as the run row, so "this session has a writer" and "here is
       * which run" cannot disagree — the pair is what makes a refusal precise and a takeover safe.
       */
      this.port.db
        .prepare(
          `INSERT INTO session_leases(session_id,run_id,owner_pid,renewed_at,renewals,compacting_run_id)
           VALUES(?,?,?,?,0,NULL)
           ON CONFLICT(session_id) DO UPDATE SET
             run_id=excluded.run_id, owner_pid=excluded.owner_pid,
             renewed_at=excluded.renewed_at, renewals=0, compacting_run_id=NULL`,
        )
        .run(id, runId, process.pid, new Date().toISOString());
      this.port.recordEvent(id, 'run.started', { runId, ownerPid: process.pid });
      return runId;
    });
  }

  /**
   * The lease on a session, or `null` when nothing holds it.
   *
   * A reader, not a decision: the only code that *acts* on a lease is `beginRun` (mutual exclusion) and the
   * compaction lock. `renewedAt` is there so a refusal can say how long ago the owner last did anything.
   */
  leaseOf(sessionId: string): SessionLease | null {
    const row = this.port.db
      .prepare('SELECT * FROM session_leases WHERE session_id=?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      ownerPid: Number(row.owner_pid),
      renewedAt: String(row.renewed_at),
      renewals: Number(row.renewals),
      ...(row.compacting_run_id ? { compactingRunId: String(row.compacting_run_id) } : {}),
    };
  }

  /**
   * Records that the owning run is still working. Returns false when the session is no longer this run's.
   *
   * Called at every step boundary and on a timer while a request is in flight (`LEASE_RENEW_INTERVAL_MS`).
   * Nothing expires because of it — see `SessionLease`: it is how "last active" stays true during a long model
   * call rather than reporting a working run as idle.
   */
  renewLease(sessionId: string, runId: string): boolean {
    const result = this.port.db
      .prepare(
        'UPDATE session_leases SET renewed_at=?, renewals=renewals+1 WHERE session_id=? AND run_id=?',
      )
      .run(new Date().toISOString(), sessionId, runId);
    return Number(result.changes) > 0;
  }

  /** Gives up a lease this run holds. False means it is not ours any more, which is worth knowing. */
  releaseLease(sessionId: string, runId: string): boolean {
    const result = this.port.db
      .prepare('DELETE FROM session_leases WHERE session_id=? AND run_id=?')
      .run(sessionId, runId);
    return Number(result.changes) > 0;
  }

  /**
   * Takes the compaction lock for a session, before the summary request is sent.
   *
   * The rule is one sentence: **a compaction may only be recorded by the run that holds the session**. The lock
   * is taken here so a run does not pay for a summary it will be refused at the write, and `applyCompaction`
   * re-checks the same rule — the two checkpoints are the acquire and the commit of one lock, not two locks.
   *
   * A session with no lease has no competing writer on record (a store-level caller, a migration), so there is
   * nothing to exclude; a lease held by a *different* run is exactly the case this refuses.
   */
  claimCompaction(sessionId: string, runId?: string): void {
    const lease = this.leaseOf(sessionId);
    if (!lease) return;
    if (lease.runId !== runId)
      throw new Error(
        `Another run is writing this session (run ${lease.runId}, pid ${lease.ownerPid}${ageSuffix(lease.renewedAt)}); ` +
          'a compaction was not attempted.',
      );
    if (lease.compactingRunId !== undefined)
      throw new Error(
        `A summary is already in flight for this session (run ${lease.compactingRunId}); a second compaction was not attempted.`,
      );
    this.port.db
      .prepare('UPDATE session_leases SET compacting_run_id=? WHERE session_id=?')
      .run(runId ?? null, sessionId);
  }

  /** Releases the compaction lock. Only the run that took it releases it, so a stale release is a no-op. */
  releaseCompaction(sessionId: string, runId?: string): void {
    this.port.db
      .prepare(
        'UPDATE session_leases SET compacting_run_id=NULL WHERE session_id=? AND compacting_run_id IS ?',
      )
      .run(sessionId, runId ?? null);
  }

  /**
   * How many times a round's model request has already been re-sent, counted in the log.
   *
   * The counter is the log rather than a field on the run or a variable in the loop, because a retry that was
   * recorded is a retry that happened: a host that dies during the backoff comes back to a session whose
   * attempts are already counted, and a reader can see the number the run acted on without asking the run.
   */
  /**
   * How many times a round has been retried, optionally scoped to one session.
   *
   * The session scope is an *index* on the query, not a second rule: `session_events` is keyed and indexed by
   * session, so a count that names the session is served by that index, while a count across the whole database
   * has to look at every session's retry records. Callers that know the session pass it; the two-argument form
   * keeps working, which is what the public API promises.
   */
  retryCount(runId: string, round: number, sessionId?: string): number {
    const row = this.port.db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_events WHERE ${
          sessionId === undefined ? '' : 'session_id=? AND '
        } type='llm.retry' AND json_extract(data,'$.runId')=? AND json_extract(data,'$.round')=?`,
      )
      .get(...(sessionId === undefined ? [runId, round] : [sessionId, runId, round]));
    return Number(row?.n ?? 0);
  }

  finishRun(result: RunResult, options: { completeGoalObjective?: string } = {}): void {
    this.port.transaction(() => {
      if (result.completion?.contractId)
        this.port.recordEvent(result.sessionId, 'completion.updated', {
          runId: result.runId,
          contractId: result.completion.contractId,
          summary: result.completion,
        });
      if (
        result.status === 'completed' &&
        result.completion?.state === 'verified' &&
        options.completeGoalObjective !== undefined
      ) {
        const goal = this.port.goal(result.sessionId);
        if (goal?.status === 'active' && goal.objective === options.completeGoalObjective)
          this.port.recordEvent(result.sessionId, 'goal.changed', {
            action: 'complete',
            goal: changeGoal(goal, 'complete', {}, new Date().toISOString()),
          });
      }
      this.port.db
        .prepare('UPDATE runs SET status=?,result=? WHERE id=?')
        .run(result.status, JSON.stringify(result), result.runId);
      this.port.db
        .prepare('UPDATE sessions SET active_run=NULL WHERE id=? AND active_run=?')
        .run(result.sessionId, result.runId);
      // The run stops being this session's writer the moment it stops writing. A lease left behind would be a
      // row claiming presence for a process that is done, and the next run would have to reason around it.
      this.port.db
        .prepare('DELETE FROM session_leases WHERE session_id=? AND run_id=?')
        .run(result.sessionId, result.runId);
      this.port.recordEvent(result.sessionId, 'run.finished', {
        runId: result.runId,
        status: result.status,
        // Usage is what the statistics projection folds; the full result row stays the record of record
        // for everything else, so a multi-megabyte payload is not duplicated into the log.
        usage: result.usage,
        ...(result.statistics ? { statistics: result.statistics } : {}),
        ...(result.compactionUsage ? { compactionUsage: result.compactionUsage } : {}),
        ...(result.error ? { error: redactSecrets(result.error).slice(0, 600) } : {}),
        // Why it ended, when the reason has a name. It rides the durable event rather than only the run row so
        // that "why did this fail?" is answerable from the log alone, and so a client that only follows events
        // learns as much as one that reads the row.
        ...(result.code ? { code: result.code } : {}),
        // The endpoint's own two facts about the call, when the failure came from one. They ride the event for
        // the same reason the code does: "it failed" is answerable from the log, and so is *what* the endpoint
        // said — which is what somebody has to quote when they ask the provider about it.
        ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      });
    });
    // After the run is closed, not inside it: the checkpoint is derived data, and a failure to write it must not
    // be able to fail the run's own transaction. `saveProjectionCheckpoints` swallows its errors for the same
    // reason.
    this.port.saveProjectionCheckpoints(result.sessionId);
  }
}
