import type {
  Acceptance,
  AcceptanceEvidence,
  Task,
  TaskStep,
  Approver,
} from '../protocol/index.ts';
import {
  capturePathSnapshot,
  verifyAcceptance,
  type AcceptanceSpec,
  type PathSnapshot,
} from './acceptance.ts';

export type TaskBaselines = Record<string, PathSnapshot>;

export interface TaskVerification {
  evidence: AcceptanceEvidence;
  passed: boolean;
  acceptance: Acceptance[];
  steps: TaskStep[];
  error?: string;
}

export async function captureTaskBaselines(root: string, task: Task): Promise<TaskBaselines> {
  const baselines: TaskBaselines = {};
  for (const acceptance of task.acceptance) {
    const check = acceptance.check;
    if (check?.kind === 'forbidden-path' && check.expectation === 'unchanged' && check.path)
      baselines[check.id] = await capturePathSnapshot(root, check.path);
  }
  return baselines;
}

function acceptanceSpecs(task: Task, baselines: TaskBaselines): AcceptanceSpec[] {
  const specs: AcceptanceSpec[] = [];
  for (const item of task.acceptance) {
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

export async function verifyTaskAcceptance(
  root: string,
  task: Task,
  baselines: TaskBaselines,
  signal?: AbortSignal,
  approve?: Approver,
): Promise<TaskVerification> {
  const specs = acceptanceSpecs(task, baselines);
  const evidence = await verifyAcceptance(root, specs, { signal, approve });
  // A task with no acceptance criteria is vacuously executable: every criterion (of none)
  // has a corresponding check, so verification cannot stall forever on an empty definition.
  const executable = specs.length === task.acceptance.filter((item) => item.check).length;
  const manual = task.acceptance.filter((item) => !item.check);
  const passed = evidence.passed && executable && manual.every((item) => item.met);
  const combinedEvidence: AcceptanceEvidence = {
    ...evidence,
    passed,
    checks: [
      ...evidence.checks,
      ...task.acceptance.flatMap((item, index) =>
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
              },
            ],
      ),
    ],
  };
  return {
    evidence: combinedEvidence,
    passed,
    acceptance: task.acceptance.map((item) => ({
      ...item,
      met: item.check
        ? (evidence.checks.find((check) => check.id === item.check?.id)?.passed ?? false)
        : item.met,
    })),
    steps: task.steps.map((step) => ({
      ...step,
      status: passed ? 'completed' : 'blocked',
    })),
    ...(!passed
      ? {
          error: executable
            ? 'Acceptance checks did not pass or require explicit user confirmation; review the evidence.'
            : 'Task has acceptance criteria without executable checks; review is required.',
        }
      : {}),
  };
}
