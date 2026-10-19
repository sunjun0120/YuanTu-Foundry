/**
 * Named locks the Host takes instead of one Host-wide barrier.
 *
 * A key names one resource — a session, an execution directory, a workspace binding, or the Host itself — and a
 * claim takes it either `shared` or `exclusive`. Two claims on the same key conflict unless both are shared; claims
 * on different keys never do. That is the whole rule, and it is the same one Codex applies to tool calls within a
 * turn (readers together, a writer alone), lifted to the Host's own operations.
 *
 * Acquiring is all-or-nothing and never waits. The Host's protocol has always refused a busy request rather than
 * queueing it, and a caller that gets every key at once or none cannot deadlock, so no ordering between keys is
 * needed. `alsoHeld` lets a caller add claims this table does not own — the Host passes the ones its active runs
 * imply, so a run never has to remember to release a lease.
 */
export type LockMode = 'shared' | 'exclusive';

export interface LockClaim {
  readonly key: string;
  readonly mode: LockMode;
}

export interface Lease {
  readonly claims: readonly LockClaim[];
  /** Idempotent: a `finally` that runs twice must not release someone else's claim. */
  release(): void;
}

export class ResourceLocks {
  private readonly leases = new Set<Lease>();

  /** Every claim currently held through a lease of this table. */
  claims(): LockClaim[] {
    return [...this.leases].flatMap((lease) => lease.claims);
  }

  /** The first held claim `requested` would collide with, or `undefined` when all of it is free. */
  conflict(
    requested: readonly LockClaim[],
    alsoHeld: Iterable<LockClaim> = [],
  ): LockClaim | undefined {
    const held = [...this.claims(), ...alsoHeld];
    for (const want of requested)
      for (const have of held)
        if (have.key === want.key && (have.mode === 'exclusive' || want.mode === 'exclusive'))
          return have;
    return undefined;
  }

  /** Take every claim in `requested`, or none of them when any one conflicts. */
  tryAcquire(requested: readonly LockClaim[], alsoHeld?: Iterable<LockClaim>): Lease | undefined {
    if (this.conflict(requested, alsoHeld)) return undefined;
    let released = false;
    const lease: Lease = {
      claims: [...requested],
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(lease);
      },
    };
    this.leases.add(lease);
    return lease;
  }
}
