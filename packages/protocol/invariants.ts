import { AGENT_EVENT_TYPES } from './index.ts';
/**
 * The runtime invariant seam: the types, plus the one invariant the protocol can check about itself.
 *
 * The types live here rather than beside the registry (`packages/core/invariants.ts`) because the whole point
 * of the seam is that several packages publish through it, and they sit at different layers: `protocol` and
 * `storage` cannot depend on `core`, which is the layer that owns the registry. A publisher needs the shape,
 * not the machinery.
 *
 * The difference between this and `tests/invariants.test.ts` is not rigour, it is reach: a test can only
 * check what its author wrote, on the fixtures they chose, at test time. A runtime invariant is checked in
 * the process that is actually doing the work — including in a deployment this repository never ran.
 */
export type InvariantScope = 'tool-execution' | 'run-end' | 'session-close';
/**
 * What a check may look at.
 *
 * Passed per run rather than captured at registration: a registry is process-wide and outlives any one
 * session, so an invariant that closed over a session id would check the wrong one forever after.
 */
export interface InvariantContext {
  /** The session this scope is about. Absent only for a check that is genuinely about the process. */
  sessionId?: string;
  runId?: string;
  /** Every event type the run emitted, for the check that the kernel only speaks a declared vocabulary. */
  emittedTypes?: readonly string[];
  /**
   * The stage trace of the run's tool calls, for `tool-execution`.
   *
   * Passed in rather than captured at registration: registration is process-wide, while a trace belongs to
   * the tool registry of one run. Stated structurally because `protocol` cannot import `tools`.
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
   * Throws when the promise is broken and returns normally when it holds.
   *
   * A check that cannot see its subject must throw rather than pass: reporting success for something it
   * never looked at is the one failure mode an invariant cannot have.
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
 * Every live event type a run emits is one the protocol declares.
 *
 * The client's delivery allow-list is derived from `AGENT_EVENT_TYPES`, and the kernel does not filter on the
 * way out — so an undeclared type is not an error anywhere, it simply never arrives. That is the failure this
 * exists for: nothing else in the system reports a dropped event, and the symptom (a panel that never
 * updates) is far from the cause.
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
