import { AGENT_EVENT_TYPES } from './index.ts';
/**
 * The runtime invariant seam: its types, plus the one invariant the protocol checks about itself.
 * Types live here so `protocol` and `storage` can publish invariants without depending on `core`,
 * which owns the registry. Unlike tests, runtime invariants are checked in the process doing the
 * real work.
 */
export type InvariantScope = 'tool-execution' | 'run-end' | 'session-close';
/** What a check may look at. Passed per run, since the registry is process-wide. */
export interface InvariantContext {
  /** The session this scope is about. Absent only for a check that is genuinely about the process. */
  sessionId?: string;
  runId?: string;
  /** Every event type the run emitted, for the check that the kernel only speaks a declared vocabulary. */
  emittedTypes?: readonly string[];
  /**
   * The stage trace of the run's tool calls, for `tool-execution`. Structural because `protocol`
   * cannot import `tools`.
   */
  pipeline?: {
    violations: readonly { execution: string; stage: string; detail: string }[];
  };
}
export interface Invariant {
  /** Stable identifier, namespaced by owner: `tools.pipeline-stages`. */
  name: string;
  /** The package that owns it, so a collision is attributable instead of mysterious. */
  owner: string;
  /** One line for `describe()`, which is what an operator prints to see what is registered. */
  description: string;
  /** When the runtime runs it. */
  scope: InvariantScope;
  /**
   * Throws when the promise is broken. A check that cannot see its subject must throw, not pass.
   */
  check(context: InvariantContext): void | Promise<void>;
}
export interface InvariantViolation {
  name: string;
  owner: string;
  detail: string;
}
/** One line naming who broke what, for a log or a run's `error`. */
export function describeViolations(violations: readonly InvariantViolation[]): string {
  return violations
    .map((violation) => `${violation.name} (${violation.owner}): ${violation.detail}`)
    .join('; ');
}
/**
 * Every live event type a run emits is declared in the protocol. The client allow-list derives from
 * `AGENT_EVENT_TYPES`, so an undeclared type would be silently dropped.
 */
export function emittedEventTypesInvariant(
  declared: readonly string[] = AGENT_EVENT_TYPES,
): Invariant {
  return {
    name: 'protocol.emitted-event-types',
    owner: 'packages/protocol',
    description: 'Every event type a run emits is declared in AGENT_EVENT_TYPES.',
    scope: 'run-end',
    check: ({ emittedTypes }) => {
      if (!emittedTypes) throw new Error('the run reported no event types to check');
      const undeclared = [...new Set(emittedTypes)].filter((type) => !declared.includes(type));
      if (undeclared.length)
        throw new Error(
          `undeclared event type(s): ${undeclared.join(', ')} — every client would drop these silently`,
        );
    },
  };
}
