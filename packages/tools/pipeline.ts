import type { Invariant } from '../protocol/invariants.ts';

/**
 * The ordered stages every tool call passes through.
 *
 * They used to be implicit: one long `execute()` read top to bottom, with the extension hooks called
 * from two inline points. That works until something needs to add a policy — a guard, a redaction, a
 * context injection — and has to decide *where* in that function it belongs, by editing the function.
 * Naming the stages turns the order into a contract: what each stage may see, what it may decide, and
 * which decisions are monotonic.
 *
 *   validate → pre-execute → guards → prepare → approval → execute → post-execute → finalize → result
 *
 * Monotonicity is the point of the split: `pre-execute` hooks and `guard`s can only ever *deny*. A hook
 * cannot grant a permission the approval stage would refuse, so "the extension allowed it" is not a
 * sentence this pipeline can express. That is what makes a guard safe to inherit into a delegated run.
 */
export { PIPELINE_STAGES, PIPELINE_ORDER } from '../protocol/tool-pipeline.ts';
export type {
  PipelineStage,
  ToolExecution,
  PreToolDecision,
  GuardDecision,
  PostToolDecision,
  ToolExecutionResult,
} from '../protocol/tool-pipeline.ts';
import {
  PIPELINE_STAGES,
  PIPELINE_ORDER,
  type PipelineStage,
  type ToolExecution,
} from '../protocol/tool-pipeline.ts';
const STAGE_RANK = new Map<PipelineStage, number>(
  PIPELINE_STAGES.map((stage, index) => [stage, index]),
);
/** Bounded trace history: diagnostics, not an audit log. */
const MAX_PIPELINE_HISTORY = 64;

export interface PipelineViolation {
  execution: string;
  stage: PipelineStage;
  detail: string;
  seen: PipelineStage[];
}
/**
 * The runtime pipeline invariant.
 *
 * This is the executable half of the paragraph at the top: a test suite can only assert the stages the
 * scenarios it writes happen to exercise, while this checks *every* execution in every run — including
 * the orders nobody thought to write a test for. It is checked in-process, on the way past, for a few
 * array operations per call.
 *
 * A violation throws, and `ToolRegistry.execute` turns a thrown error into a failed tool result. That
 * is deliberate: failing the call loudly is better than silently running a policy stage out of order,
 * and it keeps the whole failure inside the one place the model and the operator both already look.
 */
export class ToolPipelineInvariant {
  private stages = new WeakMap<ToolExecution, PipelineStage[]>();
  readonly violations: PipelineViolation[] = [];
  /**
   * Completed traces, newest last and bounded: enough for an operator or a test to see the order a
   * policy stage actually ran in, without holding on to every execution of a long session.
   */
  private completed: { execution: string; stages: PipelineStage[] }[] = [];
  get history(): { execution: string; stages: PipelineStage[] }[] {
    return this.completed.map((entry) => ({ ...entry, stages: [...entry.stages] }));
  }
  /** The stages recorded for an execution, for diagnostics and tests. */
  trace(execution: ToolExecution): PipelineStage[] {
    return [...(this.stages.get(execution) ?? [])];
  }
  /** Records a stage entry. `validate` opens the record; every other stage must follow it in order. */
  enter(execution: ToolExecution, stage: PipelineStage): void {
    const seen = this.stages.get(execution);
    if (seen === undefined) {
      if (stage !== 'validate') this.fail(execution, stage, 'the first stage must be validate', []);
      this.stages.set(execution, [stage]);
      return;
    }
    const last = seen.at(-1)!;
    if (seen.includes(stage))
      this.fail(execution, stage, `stage repeated (already ran after ${last})`, seen);
    if (STAGE_RANK.get(stage)! <= STAGE_RANK.get(last)!)
      this.fail(execution, stage, `stage ran out of order after ${last}`, seen);
    this.require(execution, stage, seen, 'execute', ['pre-execute', 'guards']);
    if (stage === 'execute' && execution.permission)
      this.require(execution, stage, seen, 'execute', ['approval']);
    this.require(execution, stage, seen, 'finalize', ['post-execute']);
    seen.push(stage);
  }
  /**
   * Closes a record. `completed` is false for the control-flow errors the registry rethrows
   * (`DeferredApprovalError`, `ToolCleanupError`): those leave the pipeline deliberately, and a
   * half-finished trace is not evidence that a stage ran out of order.
   *
   * The record itself is kept — it is a `WeakMap` entry keyed by the execution, so it disappears with
   * the call — which is what lets a caller ask "which stages did that call go through?" after the fact.
   */
  leave(execution: ToolExecution, completed: boolean): void {
    const seen = this.stages.get(execution);
    if (!completed || seen === undefined) return;
    if (seen.at(-1) !== 'result')
      this.fail(execution, 'result', `execution ended after ${seen.at(-1) ?? 'nothing'}`, seen);
    this.completed.push({ execution: `${execution.tool}#${execution.attempt}`, stages: [...seen] });
    if (this.completed.length > MAX_PIPELINE_HISTORY) this.completed.shift();
  }
  private require(
    execution: ToolExecution,
    stage: PipelineStage,
    seen: PipelineStage[],
    required: PipelineStage,
    prerequisites: PipelineStage[],
  ): void {
    if (stage !== required) return;
    const missing = prerequisites.filter((prerequisite) => !seen.includes(prerequisite));
    if (missing.length)
      this.fail(execution, stage, `${required} requires ${missing.join(', ')} first`, seen);
  }
  private fail(
    execution: ToolExecution,
    stage: PipelineStage,
    detail: string,
    seen: PipelineStage[],
  ): never {
    const executionLabel = `${execution.tool}#${execution.attempt}`;
    this.violations.push({ execution: executionLabel, stage, detail, seen: [...seen] });
    throw new Error(
      `Tool pipeline invariant violated for ${executionLabel} at ${stage}: ${detail} (order: ${PIPELINE_ORDER})`,
    );
  }
}
/**
 * The pipeline invariant, published to the runtime registry.
 *
 * `fail` already throws and `ToolRegistry.execute` turns that into a failed *tool result* — so an
 * out-of-order policy stage is visible to the model and to nobody else, and the run carries on. Publishing
 * the same fact at `tool-execution` scope is what turns it into a failed run, which is the outcome the
 * paragraph at the top of this file argues for.
 *
 * It takes no argument and reads the trace out of the check context, because registration is process-wide
 * while the trace is per tool registry: a run-scoped registration would collide with every concurrent run,
 * and a registration that captured one registry would check that registry forever.
 */
export function pipelineStagesInvariant(): Invariant {
  return {
    name: 'tools.pipeline-stages',
    owner: 'packages/tools',
    description: `Every dispatched tool call runs the ${PIPELINE_STAGES.length} pipeline stages in order.`,
    scope: 'tool-execution',
    check: ({ pipeline }) => {
      // A check that cannot see its subject must not report success.
      if (!pipeline) throw new Error('the stage check needs the trace of the run it is checking');
      if (!pipeline.violations.length) return;
      throw new Error(
        pipeline.violations
          .map(
            (violation) =>
              `${violation.execution} ended at ${violation.stage}: ${violation.detail}`,
          )
          .join('; '),
      );
    },
  };
}
