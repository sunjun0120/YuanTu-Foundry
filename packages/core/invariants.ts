import { RUN_DEFAULTS } from '../protocol/settings.ts';
import type {
  Invariant,
  InvariantContext,
  InvariantScope,
  InvariantViolation,
} from '../protocol/invariants.ts';
import { describeViolations } from '../protocol/invariants.ts';
import type { Disposer } from '../tools/dispatch.ts';
/** Thrown by `assert` when one or more invariants did not hold. */
export class InvariantViolationError extends Error {
  readonly violations: readonly InvariantViolation[];
  constructor(violations: readonly InvariantViolation[]) {
    super(`Runtime invariant(s) violated: ${describeViolations(violations)}`);
    this.name = 'InvariantViolationError';
    this.violations = violations;
  }
}
/**
 * The runtime invariant registry.
 *
 * The project's cross-cutting promises used to live in exactly one place a package could not reach: its own
 * test file. That made every new seam a new edit to `tests/invariants.test.ts`, and made it impossible for a
 * package, an extension or an embedder to publish a promise of its own. This is the seam that fixes that, and
 * it is deliberately shaped like the other registries in this runtime: `register` hands back its removal,
 * names are owned, and asking for a violation collects *all* of them rather than stopping at the first —
 * one broken promise must not hide the rest.
 *
 * It is also deliberately not a filter on every event: an invariant runs at the scopes its publisher named,
 * so the cost is bounded by the number of invariants rather than by how busy the runtime is.
 */
export class InvariantRegistry {
  private entries = new Map<string, Invariant>();
  private timeoutMs: number;
  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? RUN_DEFAULTS.invariantTimeoutMs;
  }
  /** Every registration hands back its removal, like every other seam in this runtime. */
  register(invariant: Invariant): Disposer {
    if (!invariant.name.trim()) throw new Error('An invariant needs a name');
    if (!invariant.owner.trim())
      throw new Error(
        `Invariant "${invariant.name}" needs an owner; an unattributable promise is refused`,
      );
    if (this.entries.has(invariant.name))
      throw new Error(
        `Duplicate invariant: ${invariant.name} (already registered by ${this.entries.get(invariant.name)!.owner})`,
      );
    this.entries.set(invariant.name, invariant);
    return () => {
      // Removes only the registration it created, so a re-registration after disposal is a fresh entry
      // rather than deleting somebody else's.
      if (this.entries.get(invariant.name) === invariant) this.entries.delete(invariant.name);
    };
  }
  names(): string[] {
    return [...this.entries.keys()];
  }
  /** What a host prints so an operator can see what is registered, and when it is checked. */
  describe(): { name: string; owner: string; description: string; scope: InvariantScope }[] {
    return [...this.entries.values()].map((invariant) => ({
      name: invariant.name,
      owner: invariant.owner,
      description: invariant.description,
      scope: invariant.scope,
    }));
  }
  /**
   * Runs every invariant whose scope is `scope` and returns the violations.
   *
   * Nothing throws out of here except a programming error in this class: a check that throws, rejects or
   * hangs becomes a violation like any other. That is the whole contract — a broken promise is data the
   * caller decides what to do with, and one check blowing up must not stop the others from running.
   */
  async run(scope: InvariantScope, context: InvariantContext = {}): Promise<InvariantViolation[]> {
    const violations: InvariantViolation[] = [];
    for (const invariant of this.entries.values()) {
      if (invariant.scope !== scope) continue;
      try {
        await this.bounded(invariant, context);
      } catch (error) {
        violations.push({
          name: invariant.name,
          owner: invariant.owner,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return violations;
  }
  /** `run` plus a throw when anything was violated. */
  async assert(scope: InvariantScope, context: InvariantContext = {}): Promise<void> {
    const violations = await this.run(scope, context);
    if (violations.length) throw new InvariantViolationError(violations);
  }
  /**
   * Bounds one check by the shared timeout, and does not leave the loser of the race unhandled.
   *
   * A timed-out check is reported as a violation naming the invariant rather than as a generic timeout: the
   * caller has to be able to tell "this promise is broken" from "the thing that verifies it is stuck", and
   * both have to be loud.
   */
  private async bounded(invariant: Invariant, context: InvariantContext): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `check did not finish within ${this.timeoutMs}ms; treat the promise as unverified`,
            ),
          ),
        this.timeoutMs,
      );
      // A pending timer is not a reason for the process to stay alive after the run is over.
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.resolve(invariant.check(context)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
