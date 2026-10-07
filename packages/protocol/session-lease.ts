/**
 * Who is writing a session right now, and when they last proved it.
 *
 * This is **presence**, not history: it is the one fact about a session that is true only while a process is
 * alive, which is why it is a row and not an event. The lease has two jobs and no more:
 *
 * - **Mutual exclusion.** `beginRun` takes it, so a second writer is refused instead of racing the first.
 *   Liveness is still decided by the owner's pid (`deadOwner`): a lease is **never** expired by age. The main
 *   request has no total duration and its only watchdog resets on every byte, so "no renewal for a while"
 *   cannot tell a healthy five-minute model call from a dead process — and acting on it would let recovery
 *   write a healthy run down as interrupted and hand the session to a second writer.
 * - **The compaction lock.** A compaction rewrites what the model sees, so it may only be recorded by the run
 *   that holds the session. `claimCompaction` is taken **before** the summary request (so a run does not pay
 *   for a summary it cannot write) and `applyCompaction` re-checks the same rule at the write.
 *
 * `renewedAt`/`renewals` are evidence, never a verdict: a refusal can tell an operator how long ago the owner
 * last did anything, which is the difference between "the run is thinking" and "something is stuck".
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
 * How often a run renews its lease while it is waiting on a model call.
 *
 * Not a TTL and not a bound on anything: it exists so that "last active" stays true during a long request. A
 * run waiting five minutes for an answer is working, and a refusal that called it idle for five minutes would
 * be describing the wrong process.
 */
export const LEASE_RENEW_INTERVAL_MS = 10_000;
