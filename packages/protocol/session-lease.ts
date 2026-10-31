/**
 * Who is writing a session right now, and when they last proved it. Presence, not history, so it is
 * a row, not an event.
 *
 * - Mutual exclusion: `beginRun` takes it and refuses a second writer. Liveness is decided by the
 *   owner's pid (`deadOwner`); a lease never expires by age, since a long model call is
 *   indistinguishable from a dead one.
 * - Compaction lock: `claimCompaction` is taken before the summary request, and `applyCompaction`
 *   re-checks at the write.
 *
 * `renewedAt`/`renewals` are evidence for operators, never a verdict.
 */
export interface SessionLease {
  sessionId: string;
  runId: string;
  ownerPid: number;
  /** When the owning run last proved it was still working. */
  renewedAt: string;
  /** How many times it has done so. A run that renews at step boundaries has a number here. */
  renewals: number;
  /** The run whose summary request is in flight for this session, when one is. */
  compactingRunId?: string;
}
/**
 * How often a run renews its lease while waiting on a model call, so "last active" stays accurate.
 * Not a TTL.
 */
export const LEASE_RENEW_INTERVAL_MS = 10_000;
