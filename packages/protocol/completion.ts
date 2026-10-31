import type { AcceptanceEvidence, TaskStepStatus } from './index.ts';

/**
 * The completion contract: what "this task is done" means, and what evidence says so.
 *
 * Separate from `RunStatus`, which only says how the run ended (`completed` even if the work is
 * missing). This answers "is the request satisfied", so an unverified answer is never a false pass.
 */

/**
 * Why a check did not pass, emitted by the checker so repair decisions never match on `detail`
 * text. Results without a reason (older records) are not automatically repairable.
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
  /** The acceptance definition itself is unusable. */
  | 'invalid-definition'
  /** A path the contract forbade changing was changed. Not repairable: a person has to look at the diff. */
  | 'protected-path-changed'
  /** The criterion is a human judgement and nobody has confirmed it yet. */
  | 'manual-review';

/**
 * What a completion contract knows about its evidence: `verified` (done), `needs_review` (a person
 * must look), `limited` (repair budget spent) or `unverified` (no evidence claimed, e.g. no
 * contract).
 */
export type CompletionState = 'verified' | 'unverified' | 'needs_review' | 'limited';

export interface CompletionStep {
  id: string;
  description: string;
  status: TaskStepStatus;
}

/**
 * The definition of done a run is judged against. Reuses the existing `Acceptance` check schema
 * rather than redeclaring it.
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
 * How much repair a run may spend. Kept out of `CompletionSpec` because the budget is the caller's
 * choice; the model cannot write either.
 */
export interface CompletionRepairPolicy {
  maxRepairRounds: number;
  maxRepeatedFailures: number;
  repairTimeoutMs: number;
}

/**
 * How a desktop request asks to be verified: a new contract, or the session's recorded one to
 * continue. Omitted by plain chat turns. The Host normalizes the body with the shared validator.
 */
export type RunVerification =
  | { completion: CompletionSpec; repairPolicy?: CompletionRepairPolicy }
  | { resumeCompletionId: string; repairPolicy?: CompletionRepairPolicy };
/**
 * Checks an approved plan's execution is judged against: the approved steps plus what "done" means
 * and the files the evidence covers.
 */
export interface PlanVerification {
  acceptance: import('./index.ts').Acceptance[];
  inputs?: string[];
  constraints?: string[];
  repairPolicy?: CompletionRepairPolicy;
}

export const COMPLETION_REPAIR_DEFAULTS: CompletionRepairPolicy = {
  maxRepairRounds: 3,
  maxRepeatedFailures: 2,
  repairTimeoutMs: 900_000,
};

/**
 * Ceilings a caller may raise a budget to. Here so the CLI and the RPC host reject the same
 * numbers.
 */
export const COMPLETION_REPAIR_CEILINGS = {
  maxRepairRounds: 10,
  maxRepeatedFailures: 5,
  repairTimeoutMs: 3_600_000,
} as const;

/**
 * Bounds on a contract body, enforced by the normalizer. The spec is persisted verbatim in the log.
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
 * The durable completion contract a session works against, folded from `completion.updated`.
 * `originRunId` and `latestRunId` differ because repairs, resumes and goal continuations reuse the
 * contract in new runs.
 */
export interface CompletionRecord {
  version: 1;
  contractId: string;
  sessionId: string;
  originRunId: string;
  latestRunId: string;
  source: 'task' | 'request' | 'approved-plan' | 'automatic';
  definition: CompletionSpec;
  definitionHash: string;
  summary: CompletionSummary;
  steps: CompletionStep[];
  affectedPaths: string[];
  policy: CompletionRepairPolicy;
  /** Last executed checks; unlike an agent's summary these contain actual exit codes and output. */
  evidence?: AcceptanceEvidence;
  repairStartedAt?: number;
  failureFingerprint?: string;
  taskId?: string;
  planId?: string;
  planHash?: string;
  goalObjective?: string;
  /**
   * Before-images for the contract's `forbidden-path` + `unchanged` checks, taken by the creating
   * run. A resume compares against these rather than re-sampling, which would treat the failed
   * run's edits as the baseline.
   */
  baselines?: Record<string, CompletionPathBaseline>;
}

/** A bounded content image of one workspace path (the core verifier's `PathSnapshot`). */
export interface CompletionPathBaseline {
  /** Directory entry order of the image: `1` English collation (older records), `2` code unit. */
  version: 1 | 2;
  state: 'absent' | 'present';
  digest?: string;
  entries: number;
  bytes: number;
  path?: string;
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
  'protected-path-changed',
  'manual-review',
] as const;

/** Whether a failure the checker classified may be handed back to the model as repairable work. */
export function isRepairableFailure(reason: CheckFailureReason | undefined): boolean {
  // A missing reason is an old, unclassified result; it is not a licence to retry.
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
