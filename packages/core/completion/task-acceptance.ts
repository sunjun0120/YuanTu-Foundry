import type {
  Acceptance,
  AcceptanceEvidence,
  CompletionStep,
  Task,
  TaskStep,
  Approver,
} from '../../protocol/index.ts';
import {
  capturePathSnapshot,
  verifyAcceptance,
  type AcceptanceSpec,
  type PathSnapshot,
} from './acceptance.ts';
import { taskCompletionStepId } from './contract.ts';

export type TaskBaselines = Record<string, PathSnapshot>;

/**
 * Why a task's own definition says it is not done yet.
 *
 * The order of this union is the precedence the verifier applies: the first condition that holds decides, and the
 * order is not arbitrary. "The definition cannot be executed" outranks "the definition is empty" (an unusable
 * check is a definition problem whether or not there are others), both outrank progress (there is no point
 * discussing steps against a definition that cannot be judged), progress outranks a human's pending judgement
 * (asking the model to fix what a person has to sign off is not repair), and failing checks come last because
 * they are the only class another model round may address.
 */
export type TaskCompletionReason =
  | 'invalid-definition'
  | 'empty-acceptance'
  | 'unfinished-steps'
  | 'manual-review'
  | 'checks-failed';

export interface TaskVerification {
  evidence: AcceptanceEvidence;
  passed: boolean;
  acceptance: Acceptance[];
  steps: TaskStep[];
  /** Set only on failure, so a reader that sees it knows the verdict came from the definition. */
  completionReason?: TaskCompletionReason;
  error?: string;
}

export function captureTaskBaselines(
  root: string,
  task: Task,
  prior?: Readonly<TaskBaselines>,
): Promise<TaskBaselines> {
  return captureAcceptanceBaselines(root, task.acceptance, prior);
}

/**
 * The before-image of every `forbidden-path` + `unchanged` check in an acceptance list.
 *
 * Whichever source the list came from — a task, an explicit request, an approved plan, a resumed contract — the
 * check compares against what the path was when the run started; without the image it has nothing to compare to
 * and the verifier reports the definition as unexecutable.
 *
 * `prior` is the image the same definition already took. A baseline belongs to the definition, not to one attempt
 * at it: a retry or a resumed contract that re-sampled would take the previous attempt's edits as the new "before",
 * and a forbidden path the failed attempt changed would then pass. An image is reused only for the check id and
 * path it was taken for; a check the prior images do not cover is captured now.
 */
export async function captureAcceptanceBaselines(
  root: string,
  acceptanceList: readonly Acceptance[],
  prior?: Readonly<TaskBaselines>,
): Promise<TaskBaselines> {
  const baselines: TaskBaselines = {};
  for (const acceptance of acceptanceList) {
    const check = acceptance.check;
    if (check?.kind !== 'forbidden-path' || check.expectation !== 'unchanged' || !check.path)
      continue;
    const kept = prior?.[check.id];
    baselines[check.id] =
      kept && (kept.path === undefined || kept.path === check.path)
        ? { ...kept, path: check.path }
        : { ...(await capturePathSnapshot(root, check.path)), path: check.path };
  }
  return baselines;
}

function acceptanceSpecs(
  acceptance: readonly Acceptance[],
  baselines: TaskBaselines,
): AcceptanceSpec[] {
  const specs: AcceptanceSpec[] = [];
  for (const item of acceptance) {
    const check = item.check;
    if (!check) continue;
    if (check.kind === 'command' && check.command) {
      specs.push({
        id: check.id,
        kind: 'command',
        command: check.command,
        ...(check.args ? { args: check.args } : {}),
        ...(check.cwd ? { cwd: check.cwd } : {}),
        ...(check.expectedExitCode === undefined
          ? {}
          : { expectedExitCode: check.expectedExitCode }),
        ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
      });
    } else if (
      (check.kind === 'file-exact' || check.kind === 'file-contains') &&
      check.path &&
      check.expected !== undefined
    ) {
      specs.push({
        id: check.id,
        kind: check.kind,
        path: check.path,
        expected: check.expected,
        ...(check.maxBytes === undefined ? {} : { maxBytes: check.maxBytes }),
      });
    } else if (check.kind === 'file-delivery' && check.path) {
      specs.push({
        id: check.id,
        kind: 'file-delivery',
        path: check.path,
        ...(check.format ? { format: check.format } : {}),
        ...(check.minBytes === undefined ? {} : { minBytes: check.minBytes }),
        ...(check.sha256 ? { sha256: check.sha256 } : {}),
      });
    } else if (check.kind === 'forbidden-path' && check.path && check.expectation === 'absent') {
      specs.push({ id: check.id, kind: 'forbidden-path', path: check.path, expectation: 'absent' });
    } else if (
      check.kind === 'forbidden-path' &&
      check.path &&
      check.expectation === 'unchanged' &&
      baselines[check.id]
    ) {
      specs.push({
        id: check.id,
        kind: 'forbidden-path',
        path: check.path,
        expectation: 'unchanged',
        baseline: baselines[check.id]!,
      });
    }
  }
  return specs;
}

const REASON_DETAIL: Record<TaskCompletionReason, string> = {
  'invalid-definition':
    'Task acceptance contains a criterion that cannot be executed as written; review the definition.',
  'empty-acceptance':
    'Task has no acceptance criteria, so nothing about this run can be verified; the definition needs a criterion that states what done means.',
  'unfinished-steps':
    'Task steps are not all completed, so the work is not finished; record progress before asking for completion.',
  'manual-review':
    'Acceptance requires explicit user confirmation of a manual criterion; review the evidence.',
  'checks-failed': 'Acceptance checks did not pass; review the evidence.',
};

/**
 * Verify one task definition against the work that was actually done.
 *
 * Three rules here are the whole point of the function, and each replaced a way an empty or unfinished task used
 * to be reported as successful:
 *
 * 1. **An empty definition proves nothing.** A task with no criteria used to pass vacuously — "every criterion of
 *    none holds" — which turned "nobody said what done means" into a success. It is now `empty-acceptance`.
 * 2. **Steps are the model's own record of progress, not the verifier's verdict.** The result copies the statuses
 *    it was given. It used to overwrite every step with `completed` or `blocked` from the run's overall outcome,
 *    which meant a failing check erased real progress and a passing one declared unstarted work finished.
 * 3. **`skipped` is not `completed`.** A step the model skipped is not work the definition was satisfied
 *    against; only a person may change the definition that says otherwise.
 */
export async function verifyTaskAcceptance(
  root: string,
  task: Task,
  baselines: TaskBaselines,
  signal?: AbortSignal,
  approve?: Approver,
): Promise<TaskVerification> {
  return verifyCompletionAcceptance(
    root,
    task.acceptance,
    task.steps.map((step, index) => ({
      id: taskCompletionStepId(task.id, index),
      description: step.description,
      status: step.status,
    })),
    baselines,
    signal,
    approve,
  );
}

/**
 * The same verdict, for a contract that is not a task.
 *
 * An ordinary request or an approved plan carries a `CompletionSpec` rather than a task row, and the rules it is
 * judged by have to be *the same rules* — the plan's requirement is one decision maker, not two that agree today.
 * So this is not a parallel implementation: it is the body of `verifyTaskAcceptance` with the task row removed,
 * which is why the task version above is three lines of adaptation.
 */
export async function verifyCompletionAcceptance(
  root: string,
  acceptance: readonly Acceptance[],
  steps: readonly CompletionStep[],
  baselines: TaskBaselines,
  signal?: AbortSignal,
  approve?: Approver,
): Promise<TaskVerification> {
  const specs = acceptanceSpecs(acceptance, baselines);
  const evidence = await verifyAcceptance(root, specs, { signal, approve });
  const declaredChecks = acceptance.filter((item) => item.check);
  // A declared check that produced no spec is a definition this verifier cannot execute — not a failing
  // assertion. It is named separately because the fix is to the definition, never to the code under test.
  const invalidDefinition = specs.length !== declaredChecks.length;
  const manual = acceptance.filter((item) => !item.check);
  const unfinished = steps.filter((step) => step.status !== 'completed');
  const manualPending = manual.some((item) => !item.met);
  const completionReason: TaskCompletionReason | undefined = invalidDefinition
    ? 'invalid-definition'
    : acceptance.length === 0
      ? 'empty-acceptance'
      : unfinished.length
        ? 'unfinished-steps'
        : manualPending
          ? 'manual-review'
          : !evidence.passed
            ? 'checks-failed'
            : undefined;
  const passed = completionReason === undefined;
  const combinedEvidence: AcceptanceEvidence = {
    ...evidence,
    passed,
    checks: [
      ...evidence.checks,
      ...acceptance.flatMap((item, index) =>
        item.check
          ? []
          : [
              {
                id: 'manual:' + index,
                kind: 'manual' as const,
                passed: item.met,
                detail: item.met
                  ? 'Explicitly confirmed by the user'
                  : 'Awaiting explicit user confirmation',
                durationMs: 0,
                // A criterion only a person can settle is never repairable by another model round; saying so
                // here is what keeps the repair loop from asking the model to confirm its own work.
                ...(item.met ? {} : { failureReason: 'manual-review' as const }),
              },
            ],
      ),
    ],
  };
  return {
    evidence: combinedEvidence,
    passed,
    acceptance: acceptance.map((item) => ({
      ...item,
      met: item.check
        ? (evidence.checks.find((check) => check.id === item.check?.id)?.passed ?? false)
        : item.met,
    })),
    // Copied, not reconstructed. The execution journal is what decides progress; this result only reports it.
    steps: steps.map((step) => ({
      description: step.description,
      status: step.status,
    })),
    ...(completionReason
      ? {
          completionReason,
          error:
            completionReason === 'checks-failed' &&
            evidence.checks.some((check) => check.failureReason === 'environment-error')
              ? 'Verification was blocked by the execution environment; inspect the failed or unexecuted checks. ' +
                evidence.checks
                  .find((check) => check.failureReason === 'environment-error')!
                  .detail.slice(0, 1000)
              : REASON_DETAIL[completionReason],
        }
      : {}),
  };
}
