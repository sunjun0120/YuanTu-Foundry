import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  Acceptance,
  CompletionRecord,
  CompletionRepairPolicy,
  CompletionSpec,
  CompletionStep,
  Plan,
  Task,
} from '../protocol/index.ts';
import {
  COMPLETION_LIMITS,
  COMPLETION_REPAIR_CEILINGS,
  COMPLETION_REPAIR_DEFAULTS,
} from '../protocol/index.ts';
import { normalizeAcceptanceCheck } from '../protocol/task-spec.ts';

/**
 * Building, validating and fingerprinting a completion contract.
 *
 * This is the one place that turns "what the caller asked for" into the `CompletionSpec` the rest of the runtime
 * judges work against, and the one place that says what a contract's *identity* is. Both jobs belong together:
 * the hash is defined over the normalized form, so a contract that skipped normalization would have a hash that
 * changes when nothing meaningful did.
 */

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid completion ${label}`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`Invalid completion ${label}`);
  if (value.includes('\0')) throw new Error(`Invalid completion ${label}`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new Error(`Invalid completion ${label}`);
  if (value.length > max) throw new Error(`Completion ${label} exceeds ${String(max)} characters`);
  return allowEmpty ? value : trimmed;
}

/**
 * A path as the contract records it: relative to the execution root, normalized, and going nowhere else.
 *
 * Absolute paths, `..` segments, NUL bytes, Windows drive/UNC forms and duplicates-after-normalization are all
 * refused rather than silently rewritten. A contract that named `../../etc` and was quietly stored as something
 * else would be a contract whose hash no longer describes what the caller asked to be checked.
 */
export function normalizeCompletionPath(value: unknown, label = 'path'): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error(`Invalid completion ${label}`);
  const input = value.trim();
  if (path.isAbsolute(input) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^[\\/]/.test(input))
    throw new Error(`Completion ${label} must be relative to the execution root: ${input}`);
  const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../'))
    throw new Error(`Completion ${label} escapes the execution root: ${input}`);
  if (normalized === '' || normalized === '.') return '.';
  return normalized.replace(/\/+$/, '');
}

export function normalizeCompletionSpec(value: unknown): CompletionSpec {
  const input = object(value, 'spec');
  if (input.version !== undefined && input.version !== 1)
    throw new Error('Unsupported completion spec version');
  const objective = boundedText(input.objective, 'objective', COMPLETION_LIMITS.objectiveChars);
  // Each list is optional and defaults to empty, but a list that *is* present has to be the right shape: the
  // difference between "the caller stated nothing" and "the caller stated something malformed" is the difference
  // between a valid contract and one that would be silently reinterpreted.
  if (input.constraints !== undefined && !Array.isArray(input.constraints))
    throw new Error('Invalid completion constraints');
  const rawConstraints = (input.constraints ?? []) as unknown[];
  if (rawConstraints.length > COMPLETION_LIMITS.constraints)
    throw new Error(
      `Provide at most ${String(COMPLETION_LIMITS.constraints)} completion constraints`,
    );
  const constraints = rawConstraints.map((item) =>
    boundedText(item, 'constraint', COMPLETION_LIMITS.constraintChars),
  );
  if (input.steps !== undefined && !Array.isArray(input.steps))
    throw new Error('Invalid completion steps');
  const rawSteps = (input.steps ?? []) as unknown[];
  if (rawSteps.length > COMPLETION_LIMITS.steps)
    throw new Error(`Provide at most ${String(COMPLETION_LIMITS.steps)} completion steps`);
  const stepIds = new Set<string>();
  const steps: CompletionStep[] = rawSteps.map((raw) => {
    const step = object(raw, 'step');
    const id = boundedText(step.id, 'step id', COMPLETION_LIMITS.stepIdChars);
    if (stepIds.has(id)) throw new Error(`Duplicate completion step id: ${id}`);
    stepIds.add(id);
    const status = step.status ?? 'pending';
    if (
      status !== 'pending' &&
      status !== 'in_progress' &&
      status !== 'completed' &&
      status !== 'blocked' &&
      status !== 'skipped'
    )
      throw new Error('Invalid completion step status');
    return {
      id,
      description: boundedText(
        step.description,
        'step description',
        COMPLETION_LIMITS.stepDescriptionChars,
      ),
      status,
    };
  });
  if (
    input.acceptance !== undefined &&
    (!Array.isArray(input.acceptance) ||
      input.acceptance.length > COMPLETION_LIMITS.acceptanceChecks)
  )
    throw new Error(
      `Provide at most ${String(COMPLETION_LIMITS.acceptanceChecks)} acceptance criteria`,
    );
  const acceptance = normalizeCompletionAcceptance(input.acceptance);
  if (input.inputs !== undefined && !Array.isArray(input.inputs))
    throw new Error('Invalid completion inputs');
  const rawInputs = (input.inputs ?? []) as unknown[];
  if (rawInputs.length > COMPLETION_LIMITS.inputs)
    throw new Error(`Provide at most ${String(COMPLETION_LIMITS.inputs)} completion inputs`);
  const inputs: string[] = [];
  const seenInputs = new Set<string>();
  for (const raw of rawInputs) {
    const normalized = normalizeCompletionPath(raw, 'input');
    if (normalized === '.') throw new Error('A completion input must name a path, not the root');
    if (seenInputs.has(normalized)) throw new Error(`Duplicate completion input: ${normalized}`);
    seenInputs.add(normalized);
    inputs.push(normalized);
  }
  return { version: 1, objective, constraints, steps, acceptance, inputs };
}

/**
 * The acceptance half of a contract, validated by the *existing* check validator.
 *
 * Not a second schema: `normalizeAcceptanceCheck` is what `task.create` and `task.update` already run, and a
 * contract that accepted a check a task would refuse would make "the same decision for every source" untrue in
 * the one place it matters. Only the envelope is built here.
 */
function normalizeCompletionAcceptance(value: unknown): Acceptance[] {
  if (value === undefined) return [];
  const ids = new Set<string>();
  return (value as unknown[]).map((raw) => {
    const item = object(raw, 'acceptance');
    if (typeof item.met !== 'boolean') throw new Error('Invalid completion acceptance');
    return {
      description: boundedText(item.description, 'acceptance description', 2000),
      met: item.met,
      ...(item.check === undefined ? {} : { check: normalizeAcceptanceCheck(item.check, ids) }),
    };
  });
}

export function normalizeCompletionRepairPolicy(value: unknown): CompletionRepairPolicy {
  if (value === undefined) return { ...COMPLETION_REPAIR_DEFAULTS };
  const input = object(value, 'repair policy');
  const integer = (raw: unknown, label: string, ceiling: number): number => {
    if (raw === undefined) return 0;
    if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > ceiling)
      throw new Error(`Invalid completion repair ${label}`);
    return raw as number;
  };
  return {
    maxRepairRounds: integer(
      input.maxRepairRounds,
      'maxRepairRounds',
      COMPLETION_REPAIR_CEILINGS.maxRepairRounds,
    ),
    maxRepeatedFailures: integer(
      input.maxRepeatedFailures,
      'maxRepeatedFailures',
      COMPLETION_REPAIR_CEILINGS.maxRepeatedFailures,
    ),
    repairTimeoutMs: integer(
      input.repairTimeoutMs,
      'repairTimeoutMs',
      COMPLETION_REPAIR_CEILINGS.repairTimeoutMs,
    ),
  };
}

/** The step id a contract step gets, stable across runs and independent of progress. */
export function taskCompletionStepId(taskId: string, index: number): string {
  return `task:${taskId}:${String(index)}`;
}

/**
 * A task's contract, built from the definition the user already approved.
 *
 * The caller cannot replace this: a task's acceptance is the operator's definition of done, and a run that could
 * hand in its own would be grading its own work. `inputs` is the one thing a caller may add — it says which files
 * the checks are about, which is a fact about verification rather than about what done means.
 */
export function taskCompletionSpec(task: Task, inputs: readonly string[] = []): CompletionSpec {
  return {
    version: 1,
    objective: task.title.trim() || task.description.trim() || 'Task',
    constraints: task.description.trim() ? [task.description.trim()] : [],
    steps: task.steps.map((step, index) => ({
      id: taskCompletionStepId(task.id, index),
      description: step.description,
      status: step.status,
    })),
    acceptance: task.acceptance.map((item) => ({ ...item })),
    inputs: [...inputs],
  };
}

/**
 * An approved plan plus the caller's additions, as a contract.
 *
 * The plan's own steps are authoritative and must appear in order and unchanged — a caller that reordered or
 * reworded them would be executing a plan nobody approved. Its `title` is the objective and its `summary` becomes
 * the first constraint verbatim; the caller's constraints are appended after it and re-validated, because the
 * combined list is what the model will be held to.
 */
export function planCompletionSpec(
  plan: Plan,
  additions: {
    constraints?: readonly string[];
    steps?: readonly { id: string; description: string }[];
    acceptance?: Acceptance[];
    inputs?: readonly string[];
  },
): CompletionSpec {
  const expected = plan.steps.map((step) => step.description);
  if (additions.steps) {
    const actual = additions.steps.map((step) => step.description);
    if (
      actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])
    )
      throw new Error('Completion steps must match the approved plan exactly and in order');
  }
  return normalizeCompletionSpec({
    version: 1,
    objective: plan.title,
    constraints: [...(plan.summary.trim() ? [plan.summary] : []), ...(additions.constraints ?? [])],
    steps:
      additions.steps ??
      expected.map((description, index) => ({
        id: `plan:${plan.id}:${String(index)}`,
        description,
      })),
    acceptance: additions.acceptance ?? [],
    inputs: [...(additions.inputs ?? [])],
  });
}

/**
 * What a contract's identity is.
 *
 * The normalized objective, constraints, step ids and descriptions, acceptance definition and monitored inputs —
 * and deliberately nothing else. Step *status* changes as the run makes progress, `updatedAt` changes on every
 * write, and the check results change every round; a hash that included any of them would report "the definition
 * changed" every time the run did work, which is the exact signal this hash exists to distinguish from real
 * edits.
 */
export function completionDefinitionHash(spec: CompletionSpec): string {
  return createHash('sha256')
    .update(canonicalJson(definitionView(spec)))
    .digest('hex');
}

function definitionView(spec: CompletionSpec): unknown {
  return {
    objective: spec.objective,
    constraints: spec.constraints,
    steps: spec.steps.map((step) => ({ id: step.id, description: step.description })),
    acceptance: spec.acceptance.map((item) => ({
      description: item.description,
      check: item.check ? canonicalCheck(item.check) : null,
    })),
    inputs: spec.inputs,
  };
}

/** The check without its `met` flag: whether a criterion is met is progress, not definition. */
function canonicalCheck(check: NonNullable<Acceptance['check']>): unknown {
  const entries = Object.entries(check as unknown as Record<string, unknown>)
    .filter(([key, value]) => key !== 'met' && value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries);
}

/** Deterministic JSON: object keys sorted, so two equal contracts hash equally regardless of construction order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/**
 * Why a contract stopped being current, or `undefined` when it still is.
 *
 * Defined as a comparison rather than as a flag so that every surface — the run's own finalization, a resumed
 * run, a goal asking whether it may complete — asks the same question about the same two snapshots. A reader that
 * could not tell "the definition moved under me" from "the work changed" would either keep repairing against a
 * definition nobody approved or stop a run that was making progress.
 */
export function definitionDrift(
  before: { definitionHash: string },
  after: { definitionHash: string },
): 'definition-changed' | undefined {
  return before.definitionHash === after.definitionHash ? undefined : 'definition-changed';
}

/** The completion half of a run's result, rebuilt from a record when a resumed run needs it. */
export function recordDefinition(record: CompletionRecord): CompletionSpec {
  return record.definition;
}
