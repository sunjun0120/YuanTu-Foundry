import type { DatabaseSync } from 'node:sqlite';
import type {
  CompletionRecord,
  CompletionRepairPolicy,
  CompletionSpec,
  CompletionStep,
  CompletionSummary,
} from '../protocol/index.ts';

/** Completion read models derived from the durable event log. Writes use the shared event writer. */
export interface SessionCompletionPort {
  db: DatabaseSync;
}

export class SessionCompletion {
  private readonly port: SessionCompletionPort;

  constructor(port: SessionCompletionPort) {
    this.port = port;
  }

  /**
   * The session's current completion contract, folded from its `completion.updated` records.
   *
   * Three properties of the fold are what make it usable rather than merely correct:
   *
   * - **The definition is folded back to, not taken from the newest record.** Only the record written when a
   *   contract is created carries the whole definition; every later record carries the round's evidence. A reader
   *   that treated the newest payload as complete would report a contract with no objective and no criteria.
   * - **The newest summary wins whole.** Each round writes its entire summary, so the state is a replacement
   *   rather than a replay of deltas, and nothing has to be re-derived from the sequence.
   * - **The cost is the contract's own round count.** A task that repaired twice has a handful of these records;
   *   a session with a thousand runs has the same handful if it never carried a contract. This is deliberately not
   *   a scan of the session's history.
   *
   * `null` for a session that never carried one — which is every session from before this existed, and every
   * session whose request never asked to be verified.
   */
  completionCurrent(sessionId: string): CompletionRecord | null {
    const rows = this.port.db
      .prepare(
        "SELECT seq,data FROM session_events WHERE session_id=? AND type='completion.updated' ORDER BY seq",
      )
      .all(sessionId);
    if (!rows.length) return null;
    let definition: CompletionSpec | undefined;
    let policy: CompletionRepairPolicy | undefined;
    let originRunId: string | undefined;
    let latestRunId: string | undefined;
    let source: CompletionRecord['source'] | undefined;
    let contractId: string | undefined;
    let definitionHash: string | undefined;
    let summary: CompletionSummary | undefined;
    let steps: CompletionStep[] | undefined;
    let affectedPaths: string[] | undefined;
    let repairStartedAt: number | undefined;
    let failureFingerprint: string | undefined;
    let taskId: string | undefined;
    let planId: string | undefined;
    let planHash: string | undefined;
    let goalObjective: string | undefined;
    let baselines: CompletionRecord['baselines'];
    let baselinesContract: string | undefined;
    for (const row of rows) {
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(row.data));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        data = parsed as Record<string, unknown>;
      } catch {
        // A damaged record is skipped rather than fatal: the alternative is a session whose completion state
        // cannot be read at all because one line was truncated by a crash, and the remaining records still
        // describe the contract honestly.
        continue;
      }
      if (typeof data.contractId === 'string') contractId = data.contractId;
      if (typeof data.runId === 'string') {
        originRunId ??= data.runId;
        latestRunId = data.runId;
      }
      if (data.source === 'task' || data.source === 'request' || data.source === 'approved-plan')
        source = data.source;
      if (data.definition && typeof data.definition === 'object')
        definition = data.definition as CompletionSpec;
      if (data.policy && typeof data.policy === 'object')
        policy = data.policy as CompletionRepairPolicy;
      if (data.summary && typeof data.summary === 'object')
        summary = data.summary as CompletionSummary;
      if (Array.isArray(data.steps)) steps = data.steps as CompletionStep[];
      if (Array.isArray(data.affectedPaths)) affectedPaths = data.affectedPaths as string[];
      if (typeof data.repairStartedAt === 'number') repairStartedAt = data.repairStartedAt;
      if (typeof data.failureFingerprint === 'string') failureFingerprint = data.failureFingerprint;
      if (typeof data.taskId === 'string') taskId = data.taskId;
      if (typeof data.planId === 'string') planId = data.planId;
      if (typeof data.planHash === 'string') planHash = data.planHash;
      if (typeof data.goalObjective === 'string') goalObjective = data.goalObjective;
      // Images belong to the contract that recorded them; a later contract in the same session must not inherit them.
      if (data.baselines && typeof data.baselines === 'object' && !Array.isArray(data.baselines)) {
        baselines = data.baselines as CompletionRecord['baselines'];
        baselinesContract = contractId;
      }
    }
    if (baselinesContract !== contractId) baselines = undefined;
    if (!contractId || !summary) return null;
    if (!definition) {
      // A contract whose creating record is missing is reported as a contract with an empty definition rather
      // than as an error: the evidence that a run verified something is still worth reading.
      definition = {
        version: 1,
        objective: summary.reason,
        constraints: [],
        steps: steps ?? [],
        acceptance: [],
        inputs: [],
      };
    }
    if (!definitionHash) definitionHash = summary.definitionHash;
    if (!definitionHash) return null;
    return {
      version: 1,
      contractId,
      sessionId,
      originRunId: originRunId ?? '',
      latestRunId: latestRunId ?? '',
      source: source ?? 'request',
      definition,
      definitionHash,
      summary,
      steps: steps ?? definition.steps,
      affectedPaths: affectedPaths ?? [],
      policy: policy ?? { maxRepairRounds: 0, maxRepeatedFailures: 0, repairTimeoutMs: 0 },
      ...(repairStartedAt === undefined ? {} : { repairStartedAt }),
      ...(failureFingerprint === undefined ? {} : { failureFingerprint }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(planId === undefined ? {} : { planId }),
      ...(planHash === undefined ? {} : { planHash }),
      ...(goalObjective === undefined ? {} : { goalObjective }),
      ...(baselines === undefined ? {} : { baselines }),
    };
  }

  /**
   * The verification rounds one attempt has already recorded.
   *
   * Read straight from the log rather than from a column, because the log *is* the record of the rounds. The
   * scan is bounded by the number of rounds of a single attempt — a handful, even for a task that repaired to its
   * ceiling — and it is filtered by attempt before any payload is parsed, so a long session pays for its own
   * round count and not for the session's history.
   */
  completionVerificationRounds(sessionId: string, attemptId: string): number[] {
    const rows = this.port.db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND type='completion.updated' ORDER BY seq",
      )
      .all(sessionId);
    const rounds: number[] = [];
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(String(row.data));
      } catch {
        // A record this build cannot parse is not a round it may claim was already recorded; the round-number
        // guard still refuses a replay through its other branch, and refusing to read the log at all would
        // break every task on a session that contains one damaged line.
        continue;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const record = data as Record<string, unknown>;
      if (record.attemptId !== attemptId) continue;
      if (typeof record.verificationRound === 'number') rounds.push(record.verificationRound);
    }
    return rounds;
  }
}
