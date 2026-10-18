import type { AcceptanceEvidence, TaskStepStatus } from './index.ts';

/**
 * The completion contract: what "this task is done" means, and what evidence says so.
 *
 * `RunStatus` answers "how did the run end" — a run that stops because the model wrote a paragraph ends
 * `completed` whether or not the work exists. This module adds the *other* answer a person actually asks for,
 * "is the request satisfied", as a separate field, so a run can end without anything claiming the goal was met.
 * Keeping the two apart is what makes an unverified answer honest instead of a false pass: an old client that
 * only knows `status` keeps reading it exactly as before, and no code has to guess which meaning a `completed`
 * carried.
 */

/**
 * Why a check did not pass.
 *
 * It exists so repair is decided structurally. A retry loop that matched on the check's `detail` text would
 * eventually retry an "expected exit code 0, received 1" that happened to be phrased as a permission problem —
 * and would stop retrying a genuine assertion failure whose message happened to contain the word "timeout". The
 * classification is emitted where the checker already knew the semantics, and history without it (every result
 * recorded before this field existed) is treated as *not* automatically repairable.
 */
export type CheckFailureReason =
  /** The command finished normally with the wrong exit code, or the content is not what was asserted. */
  | 'assertion-failed'
  /** A permission rule refused the check, or the person reading the approval declined it. */
  | 'permission-denied'
  /** The check ran out of time, or the process was terminated by a signal. */
  | 'timeout'
  /** The command could not start, or an I/O or cleanup failure happened around it. */
  | 'environment-error'
  /** The acceptance definition itself is unusable, or a path that must not change did change. */
  | 'invalid-definition'
  /** The criterion is a human judgement and nobody has confirmed it yet. */
  | 'manual-review';

/**
 * What a completion contract currently knows about its own evidence.
 *
 * Four states rather than a boolean, because they are four different things to do next: `verified` is done,
 * `needs_review` is "a person has to look", `limited` is "the repair budget ran out on work that might still be
 * fixable", and `unverified` is "no evidence was ever claimed" — the honest answer for every run that carried no
 * contract at all.
 */
export type CompletionState = 'verified' | 'unverified' | 'needs_review' | 'limited';

export interface CompletionStep {
  id: string;
  description: string;
  status: TaskStepStatus;
}

/**
 * The definition of done a run is judged against.
 *
 * `Acceptance` is deliberately *not* redeclared here: the runtime already has exactly one schema for an
 * executable check, and a second one would drift. This type names the envelope the completion contract adds
 * around it.
 */
export interface CompletionSpec {
  version: 1;
  objective: string;
  constraints: string[];
  steps: CompletionStep[];
  acceptance: import('./index.ts').Acceptance[];
  inputs: string[];
}

export interface CompletionSummary {
  version: 1;
  state: CompletionState;
  reason: string;
  contractId?: string;
  definitionHash?: string;
  verificationRound: number;
  repairRounds: number;
  repeatedFailures: number;
  failedCheckIds: string[];
  unfinishedStepIds: string[];
  inputDigest?: string;
}

/**
 * How much repair a run may spend before it stops trying.
 *
 * Deliberately not part of `CompletionSpec`: a contract states what done means, and the budget is the caller's
 * decision about how much model work that is worth. The model has no tool that writes either field.
 */
export interface CompletionRepairPolicy {
  maxRepairRounds: number;
  maxRepeatedFailures: number;
  repairTimeoutMs: number;
}

export const COMPLETION_REPAIR_DEFAULTS: CompletionRepairPolicy = {
  maxRepairRounds: 3,
  maxRepeatedFailures: 2,
  repairTimeoutMs: 900_000,
};

/**
 * Ceilings a caller may raise a budget to, and no further.
 *
 * They are constants here rather than in the core policy module so that a CLI parsing `--completion-spec` and a
 * host validating an RPC parameter reject the same numbers: two copies of "10" is one copy too many.
 */
export const COMPLETION_REPAIR_CEILINGS = {
  maxRepairRounds: 10,
  maxRepeatedFailures: 5,
  repairTimeoutMs: 3_600_000,
} as const;

/**
 * Bounds on a contract body.
 *
 * These are the numbers the normalizer enforces. They are stated once, next to the type, because the spec is
 * also persisted verbatim in the session log: an unbounded objective would be an unbounded log record.
 */
export const COMPLETION_LIMITS = {
  objectiveChars: 4000,
  constraints: 32,
  constraintChars: 500,
  steps: 64,
  stepDescriptionChars: 500,
  stepIdChars: 64,
  inputs: 128,
  /** Paths one `completion_scope` call may add, and the total a contract may accumulate. */
  affectedPathsPerCall: 64,
  affectedPaths: 256,
  /** The verifier's own ceiling for executable checks; the single source for `MAX_CHECKS` in the core verifier and the task validator. */
  acceptanceChecks: 64,
} as const;

/**
 * The durable completion contract a session is currently working against.
 *
 * One record per contract, folded from `completion.updated` events. `originRunId` and `latestRunId` are separate
 * because a contract outlives the run that created it: a repair, a resume and a goal continuation are all the
 * same contract in new runs, and a reader that could not tell them apart could not say whether a `verified`
 * verdict belongs to the code it is looking at.
 */
export interface CompletionRecord {
  version: 1;
  contractId: string;
  sessionId: string;
  originRunId: string;
  latestRunId: string;
  source: 'task' | 'request' | 'approved-plan';
  definition: CompletionSpec;
  definitionHash: string;
  summary: CompletionSummary;
  steps: CompletionStep[];
  affectedPaths: string[];
  policy: CompletionRepairPolicy;
  repairStartedAt?: number;
  failureFingerprint?: string;
  taskId?: string;
  planId?: string;
  planHash?: string;
  goalObjective?: string;
}

export const COMPLETION_STATES: readonly CompletionState[] = [
  'verified',
  'unverified',
  'needs_review',
  'limited',
] as const;

export const CHECK_FAILURE_REASONS: readonly CheckFailureReason[] = [
  'assertion-failed',
  'permission-denied',
  'timeout',
  'environment-error',
  'invalid-definition',
  'manual-review',
] as const;

/** Whether a failure the checker classified may be handed back to the model as repairable work. */
export function isRepairableFailure(reason: CheckFailureReason | undefined): boolean {
  // A missing reason is an old result, from a build that did not classify; it is not a licence to retry.
  return reason === 'assertion-failed';
}

/** The smallest amount of a check failure a repair decision needs. */
export interface FailedCheckRef {
  id: string;
  reason?: CheckFailureReason;
  exitCode?: number | null;
}

export function collectFailedChecks(evidence: AcceptanceEvidence): FailedCheckRef[] {
  return evidence.checks
    .filter((check) => !check.passed)
    .map((check) => ({
      id: check.id,
      ...(check.failureReason === undefined ? {} : { reason: check.failureReason }),
      ...(check.command ? { exitCode: check.command.exitCode } : {}),
    }));
}
