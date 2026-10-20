import { randomUUID } from 'node:crypto';
import { COMPLETION_LIMITS } from '../protocol/index.ts';
import type {
  Approver,
  CompletionRepairPolicy,
  CompletionSpec,
  CompletionStep,
  CompletionSummary,
  Plan,
  RunResult,
  RunStatus,
  Task,
  TaskStepStatus,
} from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import {
  completionDefinitionHash,
  normalizeCompletionPath,
  normalizeCompletionRepairPolicy,
  normalizeCompletionSpec,
  planCompletionSpec,
  taskCompletionSpec,
  taskCompletionStepId,
} from './completion-contract.ts';
import { decideCompletion, failureFingerprint, type CompletionDecision } from './completion.ts';
import {
  assertCompletionInputReadable,
  snapshotCompletionInputs,
  type CompletionInputSnapshot,
} from './completion-inputs.ts';
import type { RunEmit } from './run-emit.ts';
import {
  captureAcceptanceBaselines,
  verifyCompletionAcceptance,
  type TaskBaselines,
  type verifyTaskAcceptance,
} from './task-acceptance.ts';

/**
 * The completion contract a run is judged against: how it is resolved, the state the bounded repair loop keeps,
 * and the two tools that speak about it.
 *
 * Resolution happens once, before a single model request, because everything that can be wrong about a contract
 * is worth refusing before the model has been paid to do work: a conflicting source, an invalid body, a task
 * whose definition the caller tried to replace. There is at most one contract per run, and the conflicts are
 * errors rather than a silent precedence order.
 *
 * The counters are per run and in memory, and the state object is shared with the run loop on purpose, exactly
 * as `run-emit.ts`'s is: the verification round and the run's finalization are *the run's* own steps, so this
 * file owns the rules — what a contract is, what the next failure means, how a scope grows — while the loop
 * keeps owning the numbers it reads and writes between rounds. What makes that safe is that the durable half of
 * the state is the `completion.updated` record: a restart reads its budget back from the log rather than
 * resetting it by dying.
 */

/**
 * The completion contract and the bounded repair loop's own state.
 *
 * All of it is per run and in memory, which is what the plan asks for: the *counters* are persisted on every
 * round (the `completion.updated` record carries `repairRounds`), so a restart reads them back from the log
 * rather than resetting a budget by dying. `repairStartedAt` is set when the first failure is decided and
 * never moved afterwards — a resume must not restart the clock it is being measured against.
 */
export interface RunCompletionState {
  automatic: boolean;
  policy: CompletionRepairPolicy;
  contractId: string | undefined;
  contractDefinitionHash: string | undefined;
  contractSpec: CompletionSpec | undefined;
  steps: CompletionStep[];
  /**
   * The paths this run has declared as the scope of its changes.
   *
   * Recorded through the `completion_scope` tool rather than inferred: a refactor that missed a caller is
   * exactly the failure this list exists to make visible, and a list derived from what the model happened to
   * edit could never contain the file it never opened.
   */
  affectedPaths: string[];
  summary: CompletionSummary | undefined;
  /** A round that decided "complete" but has not yet survived cleanup, re-fingerprinting and persistence. */
  candidate: CompletionSummary | undefined;
  verificationRound: number;
  repairRounds: number;
  repeatedFailures: number;
  repairStartedAt: number | undefined;
  previousFailureFingerprint: string | undefined;
  lastFailureFingerprint: string | undefined;
  previousStepSignature: string | undefined;
  /**
   * The fingerprint taken after the last verification round, and the one before it.
   *
   * `lastInputSnapshot` is what the final cleanup is compared against (`S1` against `S2`): a resource that is
   * still writing when the run declares itself done has changed the monitored source, and evidence collected
   * before that write does not describe what is on disk. `previousInputDigest` is what makes "did the code
   * change since the last failure" answerable, which is the question the repeat detector asks.
   */
  lastInputSnapshot: CompletionInputSnapshot | undefined;
  /**
   * The exact input list the last snapshot covered.
   *
   * Kept rather than recomputed, because the digest is a function of the *list* as well as the tree: a final
   * check that rebuilt the list slightly differently — the task fallback plus the check paths, say — would
   * compare two different questions and call the difference a workspace change.
   */
  lastMonitoredInputs: string[];
  previousInputDigest: string | undefined;
  /** The message from the last failed fingerprint attempt, reported with the stop rather than swallowed. */
  snapshotFailure: string | undefined;
  /**
   * The verdict's own two products, kept beside the contract rather than in the run's local declaration.
   *
   * Both are written by the one verification round and read by the run's finalization: `acceptance` is the
   * evidence that round produced (what `RunResult.acceptance` reports) and `taskVerification` is the whole
   * result, which finalization reads back for the attempt record.
   */
  acceptance: RunResult['acceptance'];
  taskVerification: Awaited<ReturnType<typeof verifyTaskAcceptance>> | undefined;
}

export interface RunCompletionOptions {
  store: SessionStore;
  sessionId: string;
  runId: string;
  emit: RunEmit;
  /** The run's registry: the contract tools are replaced into it. */
  tools: ToolRegistry;
  /**
   * Whether this run may change anything, as the value in force when the contract is resolved.
   *
   * A value rather than the loop's own `let` because the tools guard on it exactly once, at registration: the
   * transition the loop performs later (`exit_plan_mode`) happens in a run that registered no contract tools.
   */
  readOnly: boolean;
  planPhase: boolean;
  task: Task | undefined;
  /** The attempt this run records into, read once: it never changes after the run starts. */
  taskAttempt: { id: string } | undefined;
  /** The execution root the round's checks run in, and the tree its input fingerprints cover. */
  workspace: string;
  /** The run's cancellation signal, which the fingerprints and the checks observe. */
  signal: AbortSignal;
  /**
   * The before-images the checks compare against, captured before the run wrote anything.
   *
   * A task's are taken before the run row exists; any other source's are added by `captureBaselines` once the
   * contract is resolved, into this same object.
   */
  baselines: TaskBaselines;
  /**
   * The approval seam an acceptance command goes through.
   *
   * The round is one more caller of the run's own decision rather than a policy of its own: a check that needs
   * permission asks where every other tool asks, and a refusal is reported as the failed check it is.
   */
  approve: Approver;
  /** The caller's request, as the fields this module reads from it. */
  request: {
    completion: CompletionSpec | undefined;
    resumeCompletionId: string | undefined;
    completionInputs: string[] | undefined;
    approvedPlan: Plan | undefined;
    repairPolicy: CompletionRepairPolicy | undefined;
  };
}

export interface RunCompletion {
  state: RunCompletionState;
  /** Install agent-selected checks once; explicit user/task contracts are never replaced. */
  configureAutomatic(spec: CompletionSpec, plan?: Plan): void;
  /**
   * Record that this run changed the workspace.
   *
   * A run that carries no contract has nothing of its own to record, so the session's previous `verified`
   * verdict would otherwise outlive the edit: the completion record is session-scoped, and a cancelled turn
   * writes no replacement. The old evidence describes a tree that no longer exists, so it is downgraded at the
   * first observed change rather than at finalization, where a cancelled run might never get the chance.
   */
  noteWorkspaceChange(): void;
  /** Predeclare tools for automatic verification before its contract exists. */
  registerTools(automatic?: boolean): void;
  /**
   * The before-images a non-task contract's `unchanged` checks compare against.
   *
   * Called once the contract is resolved and before the first model request. A task's images were taken before the
   * run started; every other source — an explicit request, an approved plan, a resumed contract — is known only
   * here, and without an image its `unchanged` check is a definition the verifier cannot execute.
   */
  captureBaselines(): Promise<void>;
  /** The one verification round this run carries; `undefined` when it carries no contract to judge. */
  verifyRound(): Promise<CompletionDecision | undefined>;
  /**
   * The verdict's last rule before the run is allowed to call itself done: the final source is re-fingerprinted.
   *
   * Returns the stop the run must report instead of `completed`, or `undefined` when nothing moved — including
   * when this run carries no candidate or no earlier snapshot to compare against.
   */
  settleFinalInputs(): Promise<string | undefined>;
  /** Writes the verdict this run ends on, from the status and failure the cleanup phase settled on. */
  finalizeVerdict(status: RunStatus, failure: string | undefined): void;
}

const MAX_AFFECTED_PATHS = COMPLETION_LIMITS.affectedPaths;
/** The size from which a fingerprint is announced before it is taken (see `snapshotOptions`). */
const FINGERPRINT_NOTICE_FILES = 2_000;
const FINGERPRINT_NOTICE_BYTES = 64 * 1024 * 1024;

/**
 * The run's completion contract, resolved from the caller's request.
 *
 * A throw here is the run refusing to start, not a failed round: nothing has been sent to the provider yet, so
 * there is no evidence to report and no budget to spend. What the factory returns is the state the loop keeps
 * mutating plus the registration of the tools that let the model report progress and scope against it.
 */
export function createRunCompletion(options: RunCompletionOptions): RunCompletion {
  const {
    store,
    sessionId,
    runId,
    emit,
    tools,
    readOnly,
    planPhase,
    task,
    taskAttempt,
    workspace,
    signal,
    baselines,
    approve,
  } = options;
  const { completion, resumeCompletionId, completionInputs, approvedPlan, repairPolicy } =
    options.request;
  const state: RunCompletionState = {
    automatic: false,
    policy: normalizeCompletionRepairPolicy(repairPolicy),
    contractId: undefined,
    contractDefinitionHash: undefined,
    contractSpec: undefined,
    steps: [],
    affectedPaths: [],
    summary: undefined,
    candidate: undefined,
    verificationRound: 0,
    repairRounds: 0,
    repeatedFailures: 0,
    repairStartedAt: undefined,
    previousFailureFingerprint: undefined,
    lastFailureFingerprint: undefined,
    previousStepSignature: undefined,
    lastInputSnapshot: undefined,
    lastMonitoredInputs: [],
    previousInputDigest: undefined,
    snapshotFailure: undefined,
    acceptance: undefined,
    taskVerification: undefined,
  };
  /**
   * The contract this run is judged against, resolved before a single model request.
   *
   * Everything that can be wrong about a contract is refused here rather than discovered after the model has
   * been paid to do work: a conflicting source, an invalid body, a task whose definition the caller tried to
   * replace. There is at most one contract per run, and the conflicts are errors rather than a silent
   * precedence order — a caller that supplied two different definitions did not mean either one of them.
   */
  /** The images a resumed contract recorded when it was created; `undefined` unless this run resumes one. */
  let resumedBaselines: TaskBaselines | undefined;
  /** Images an earlier attempt at the same plan contract recorded, reused where they still cover a check. */
  let inheritedBaselines: TaskBaselines | undefined;
  /** Whether this run observed a workspace change of its own, for the invalidation below. */
  let workspaceChanged = false;
  /** Whether the session's previous verdict has already been marked stale by this run. */
  let priorEvidenceInvalidated = false;
  const taskInputs = completionInputs ?? [];
  if (task && completion)
    throw new Error('A task already carries the acceptance definition for this run');
  if (task && resumeCompletionId)
    throw new Error('A task run continues its own completion contract');
  if (completion && resumeCompletionId)
    throw new Error('Provide a completion spec or a contract to resume, not both');
  if (completion && completionInputs)
    throw new Error('Completion inputs describe a task contract, not an explicit spec');
  if (resumeCompletionId && completionInputs)
    throw new Error('A resumed contract already records the inputs it was created with');
  const requestedSpec = completion
    ? approvedPlan
      ? // An approved plan's steps are the ones a person approved, so the caller may add checks and inputs but
        // not rewrite the steps; `planCompletionSpec` refuses anything that is not byte-identical and in order.
        planCompletionSpec(approvedPlan, {
          ...(completion.constraints ? { constraints: completion.constraints } : {}),
          ...(completion.steps ? { steps: completion.steps } : {}),
          acceptance: completion.acceptance,
          inputs: completion.inputs,
        })
      : normalizeCompletionSpec(completion)
    : undefined;
  if (requestedSpec) {
    state.contractId = approvedPlan ? `plan:${approvedPlan.id}` : randomUUID();
    state.contractDefinitionHash = completionDefinitionHash(requestedSpec);
    state.contractSpec = requestedSpec;
    state.steps = requestedSpec.steps.map((step) => ({ ...step }));
    // Executing the same approved plan again under the same definition is another attempt at one contract, so it
    // keeps the images the first attempt took. Older records without images fall back to a fresh capture.
    const previous = approvedPlan ? store.completionCurrent(sessionId) : null;
    if (
      previous?.contractId === state.contractId &&
      previous.definitionHash === state.contractDefinitionHash &&
      previous.baselines
    )
      inheritedBaselines = previous.baselines;
    const record = {
      runId,
      contractId: state.contractId,
      source: approvedPlan ? ('approved-plan' as const) : ('request' as const),
      ...(approvedPlan ? { planId: approvedPlan.id, planHash: approvedPlan.hash } : {}),
      definition: requestedSpec,
      policy: state.policy,
      steps: state.steps,
      affectedPaths: state.affectedPaths,
      summary: {
        version: 1 as const,
        state: 'unverified' as const,
        reason: 'contract-created',
        contractId: state.contractId,
        definitionHash: state.contractDefinitionHash,
        verificationRound: 0,
        repairRounds: 0,
        repeatedFailures: 0,
        failedCheckIds: [],
        unfinishedStepIds: [],
      },
    };
    store.recordEvent(sessionId, 'completion.updated', record);
    emit('completion.updated', record);
  } else if (resumeCompletionId) {
    /**
     * Continue a contract this session already recorded.
     *
     * What is restored is the *contract* — its definition, its budget, the repair clock and how much of that
     * budget is spent — and deliberately not the verdict: a `verified` conclusion belongs to the code that was
     * on disk when it was reached, and a resume happens precisely because something changed or nothing was
     * finished. Re-running the checks is the only way to earn it again.
     */
    const record = store.completionCurrent(sessionId);
    if (!record) throw new Error('No completion contract is recorded for this session');
    if (record.contractId !== resumeCompletionId)
      throw new Error('The requested completion contract is not the current one for this session');
    if (record.sessionId !== sessionId)
      throw new Error('The requested completion contract belongs to another session');
    state.contractId = record.contractId;
    state.automatic = record.source === 'automatic';
    state.contractDefinitionHash = record.definitionHash;
    state.contractSpec = record.definition;
    state.affectedPaths = [...record.affectedPaths];
    state.steps = record.steps.map((step) => ({
      ...step,
      status: step.status === 'completed' ? 'completed' : 'pending',
    }));
    resumedBaselines = record.baselines ?? {};
    state.repairRounds = record.summary.repairRounds;
    state.repeatedFailures = record.summary.repeatedFailures;
    if (record.repairStartedAt !== undefined) state.repairStartedAt = record.repairStartedAt;
    store.recordEvent(sessionId, 'completion.updated', {
      runId,
      contractId: state.contractId,
      ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
      ...(record.planId === undefined ? {} : { planId: record.planId }),
      steps: state.steps,
      summary: { ...record.summary, state: 'unverified', reason: 'resumed' },
      ...(record.policy === undefined ? {} : { policy: record.policy }),
    });
  } else if (task) {
    // A task's contract is derived from the definition the operator approved, and its identity is the task:
    // a resume of the same task continues the same contract rather than minting a second one.
    const spec = taskCompletionSpec(task, taskInputs);
    state.contractId = `task:${task.id}`;
    state.contractDefinitionHash = completionDefinitionHash(spec);
    state.contractSpec = spec;
    state.steps = spec.steps.map((step) => ({ ...step }));
    const record = {
      runId,
      contractId: state.contractId,
      source: 'task' as const,
      taskId: task.id,
      definition: spec,
      policy: state.policy,
      steps: state.steps,
      affectedPaths: [],
      summary: {
        version: 1 as const,
        state: 'unverified' as const,
        reason: 'contract-created',
        contractId: state.contractId,
        definitionHash: state.contractDefinitionHash,
        verificationRound: 0,
        repairRounds: 0,
        repeatedFailures: 0,
        failedCheckIds: [],
        unfinishedStepIds: [],
      },
    };
    store.recordEvent(sessionId, 'completion.updated', record);
    emit('completion.updated', record);
  }
  /**
   * Contract tools are predeclared for writable automatic verification runs, keeping the catalogue stable.
   *
   * Planning and read-only runs get neither. Before registration, calls explicitly refuse to record progress
   * or widen a scope nobody is verifying. `task_step` stays registered for a task as well — it is the compatibility
   * entry point — and the two cannot disagree, because `completion_step` writes through the *same* checkpoint
   * call rather than keeping a second list.
   */
  /**
   * The options every fingerprint of this run is taken with, and the notice a large one sends first.
   *
   * A fingerprint of a large range is the slow part of a task's end, so it is announced once its size is known and
   * before its files are read — live only, because the snapshot's own result is what the record keeps. A small range
   * says nothing: a notice on every round would be noise about work that takes no time.
   */
  const snapshotOptions = (phase: 'before' | 'after' | 'final') => ({
    runtimeStatePaths: store.databaseFiles(),
    onCollected: (scale: { files: number; bytes: number }) => {
      if (scale.files >= FINGERPRINT_NOTICE_FILES || scale.bytes >= FINGERPRINT_NOTICE_BYTES)
        emit('completion.fingerprinting', { contractId: state.contractId, phase, ...scale });
    },
  });
  const configureAutomatic = (spec: CompletionSpec, plan?: Plan): void => {
    if (state.contractId || task || completion || resumeCompletionId)
      throw new Error('Verification checks are already registered and cannot be replaced');
    const normalized = normalizeCompletionSpec(spec);
    const contractId = randomUUID();
    const definitionHash = completionDefinitionHash(normalized);
    const record = {
      runId,
      contractId,
      definitionHash,
      source: 'automatic' as const,
      ...(plan ? { planId: plan.id, planHash: plan.hash } : {}),
      definition: normalized,
      policy: state.policy,
      steps: normalized.steps,
      affectedPaths: state.affectedPaths,
      summary: {
        version: 1 as const,
        state: 'unverified' as const,
        reason: 'contract-created',
        contractId,
        definitionHash,
        verificationRound: 0,
        repairRounds: 0,
        repeatedFailures: 0,
        failedCheckIds: [],
        unfinishedStepIds: [],
      },
    };
    // Persist before making a new definition usable by tools or the verifier.
    store.recordEvent(sessionId, 'completion.updated', record);
    state.contractId = contractId;
    state.contractDefinitionHash = definitionHash;
    state.contractSpec = normalized;
    state.automatic = true;
    state.steps = normalized.steps.map((step) => ({ ...step }));
    registerTools(true);
    emit('completion.updated', record);
  };
  /**
   * Mark the session's previous `verified` verdict stale once this run changes the workspace.
   *
   * A completion record is session-scoped: it outlives the run that produced it, and a plain or cancelled turn
   * writes no replacement of its own. Without this, the badge from an earlier run survives an edit the current
   * run has already made, and the desktop reads exactly that record. Only `verified` is downgraded —
   * `needs_review`/`limited`/`unverified` already make no pass claim, and replacing them would discard why a
   * person was asked to look.
   *
   * The record carries this run's id and an empty evidence list, so neither the old digest nor its passed checks
   * can be read as evidence for the new tree. The write is best-effort: invalidation is bookkeeping, and a failed
   * write must not fail a run that is still working. Finalization retries it.
   */
  const invalidatePriorEvidence = (): void => {
    if (state.contractId || !workspaceChanged || priorEvidenceInvalidated) return;
    const current = store.completionCurrent(sessionId);
    if (current?.summary.state !== 'verified') return;
    const invalidated: CompletionSummary = {
      ...current.summary,
      state: 'unverified',
      reason: 'superseded',
    };
    // The digest described the previous tree. Keeping it would let a reader treat it as evidence for this one.
    delete invalidated.inputDigest;
    const record = {
      runId,
      contractId: current.contractId,
      summary: invalidated,
      // The old checks judged the old bytes. Keeping them would let the notice expand to a pass under an
      // `unverified` heading; an empty list is the honest evidence for a verdict that no longer exists.
      evidence: { passed: false, durationMs: 0, checks: [] },
    };
    try {
      store.recordEvent(sessionId, 'completion.updated', record);
      priorEvidenceInvalidated = true;
      emit('completion.updated', record);
    } catch {
      /* The evidence is still stale; finalization tries again before the run is persisted. */
    }
  };
  const noteWorkspaceChange = (): void => {
    workspaceChanged = true;
    invalidatePriorEvidence();
  };
  const registerTools = (automatic = false): void => {
    if ((state.contractId || automatic) && (automatic || (!readOnly && !planPhase))) {
      tools.replace({
        name: 'completion_step',
        description:
          'Record durable progress on this run’ completion steps: mark one step in_progress, completed, blocked or skipped by its id. Requires an active verification contract; register checks with verify_work first when using automatic verification. This is the same list acceptance is judged against, so call it as you finish each step. Use it for progress only — it cannot confirm an acceptance criterion.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', maxLength: 64 },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'blocked', 'skipped'],
            },
            note: { type: 'string', maxLength: 500 },
          },
          required: ['id', 'status'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          context.signal.throwIfAborted();
          if (context.readOnly || context.executionPolicy?.files === 'read-only')
            return {
              isError: true,
              content: 'Completion tools are unavailable in read-only or planning mode.',
            };
          if (!state.contractId)
            return {
              isError: true,
              content: 'No verification contract is registered. Call verify_work first.',
            };
          try {
            const id = String(args.id);
            const index = state.steps.findIndex((step) => step.id === id);
            if (index < 0) return { isError: true, content: `Unknown completion step: ${id}` };
            const status = String(args.status) as TaskStepStatus;
            const note = args.note === undefined ? undefined : String(args.note);
            if (task && taskAttempt) {
              const updated = store.checkpointTaskStep(sessionId, task.id, {
                attemptId: taskAttempt.id,
                index,
                status,
                ...(note === undefined ? {} : { note }),
              });
              state.steps = updated.steps.map((step, position) => ({
                id: taskCompletionStepId(task.id, position),
                description: step.description,
                status: step.status,
              }));
              emit('task.step', { taskId: task.id, steps: updated.steps });
            } else {
              state.steps = state.steps.map((step, position) =>
                position === index ? { ...step, status } : step,
              );
              const update = {
                runId,
                contractId: state.contractId,
                steps: state.steps,
                ...(note === undefined ? {} : { note }),
              };
              store.recordEvent(sessionId, 'completion.updated', update);
            }
            return {
              isError: false,
              content: state.steps
                .map((step) => `[${step.status}] ${step.id} — ${step.description}`)
                .join('\n'),
            };
          } catch (error) {
            return {
              isError: true,
              content: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
      tools.replace({
        name: 'completion_scope',
        description:
          'Declare the workspace paths this change touches, so a missed caller, export, config or test is visible instead of assumed. Requires an active verification contract; register checks with verify_work first when using automatic verification. Declaring a path grants no permission: writes still need their own approval. Use it when a cross-file refactor finds a new reference.',
        inputSchema: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              minItems: 1,
              maxItems: 64,
              items: { type: 'string', maxLength: 4096 },
            },
            note: { type: 'string', maxLength: 500 },
          },
          required: ['paths'],
          additionalProperties: false,
        },
        execute: async (args, context) => {
          context.signal.throwIfAborted();
          if (context.readOnly || context.executionPolicy?.files === 'read-only')
            return {
              isError: true,
              content: 'Completion tools are unavailable in read-only or planning mode.',
            };
          if (!state.contractId)
            return {
              isError: true,
              content: 'No verification contract is registered. Call verify_work first.',
            };
          try {
            const raw = Array.isArray(args.paths) ? args.paths : [];
            const note = args.note === undefined ? undefined : String(args.note);
            const added: string[] = [];
            for (const value of raw) {
              const normalized = normalizeCompletionPath(value, 'scope path');
              // A declared path joins the monitored range, so a credential path is refused here rather than
              // turning every later round into an `input-snapshot-failed` review.
              assertCompletionInputReadable(normalized);
              if (normalized === '.' || state.affectedPaths.includes(normalized)) continue;
              added.push(normalized);
            }
            if (state.affectedPaths.length + added.length > MAX_AFFECTED_PATHS)
              return {
                isError: true,
                content: `Completion scope is limited to ${String(MAX_AFFECTED_PATHS)} paths; record the remaining ones in your answer instead.`,
              };
            state.affectedPaths = [...state.affectedPaths, ...added];
            store.recordEvent(sessionId, 'completion.updated', {
              runId,
              contractId: state.contractId,
              affectedPaths: state.affectedPaths,
              ...(note === undefined ? {} : { note }),
            });
            emit('completion.updated', {
              runId,
              contractId: state.contractId,
              affectedPaths: state.affectedPaths,
            });
            return {
              isError: false,
              content: added.length
                ? `Recorded ${String(added.length)} path(s). Scope now covers ${String(state.affectedPaths.length)}.`
                : 'Those paths were already recorded.',
            };
          } catch (error) {
            return {
              isError: true,
              content: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
    }
  };
  /**
   * One verification round, for whichever contract this run carries.
   *
   * Written once, on purpose. A task's definition, an approved plan's and a request's are three sources and one
   * decision: if each grew its own round, the plan's guarantee — "Task, ordinary explicit contract and approved
   * plan all use the same decision maker, with no second driver" — would be a claim about three code paths that
   * happen to agree today. What differs by source is only where the definition and the progress are *read from*,
   * and where the round is *recorded*; everything between those two points is here.
   */
  const verifyRound = async (): Promise<CompletionDecision | undefined> => {
    if (!state.contractId || !state.contractSpec) return undefined;
    const taskSubject = task && taskAttempt ? { task, attemptId: taskAttempt.id } : undefined;
    const currentTask = taskSubject ? store.getTask(sessionId, taskSubject.task.id) : undefined;
    const roundSteps: CompletionStep[] = currentTask
      ? currentTask.steps.map((step, index) => ({
          id: taskCompletionStepId(taskSubject!.task.id, index),
          description: step.description,
          status: step.status,
        }))
      : state.steps.map((step) => ({ ...step }));
    const roundAcceptance = currentTask
      ? currentTask.acceptance.map((item) => ({ ...item, met: false }))
      : state.contractSpec.acceptance;
    // The definition hash is taken over the same normalized body the contract was created with, with the live
    // acceptance in place: step *statuses* are excluded by the hash itself, so progress does not read as an edit.
    const roundHash = completionDefinitionHash({
      ...state.contractSpec,
      acceptance: roundAcceptance,
    });
    /**
     * The files this contract's evidence is about.
     *
     * An explicit spec states them (and refuses to be empty). A task does not, so it falls back to the whole
     * execution root minus the derived directories — the honest default for "verify the work", stated here so
     * that the coverage of a task's evidence is a documented range rather than an assumption.
     */
    const inputPaths = state.contractSpec.inputs.length
      ? state.contractSpec.inputs
      : taskSubject || state.automatic
        ? ['.']
        : [];
    /**
     * A path a check names is always covered, whatever the declared input range says.
     *
     * A `file-exact` check is a statement about one file; a fingerprint that skipped it because the caller's
     * range did not mention it would let the check's own subject change without the evidence noticing. The
     * declared range decides what *else* is monitored, never less than what was asserted. A protected path is
     * still refused rather than included, because refusing is the honest answer to "verify this credential file".
     */
    const checkPaths: string[] = [];
    for (const item of roundAcceptance) {
      const checkPath = item.check?.path;
      if (!checkPath) continue;
      try {
        const normalized = normalizeCompletionPath(checkPath, 'check path');
        if (normalized !== '.') checkPaths.push(normalized);
      } catch {
        // An unusable check path is already an `invalid-definition` failure from the verifier; the fingerprint
        // must not turn it into a different error from a different layer.
      }
    }
    /**
     * A path the run declared through `completion_scope` is part of what this contract claims to have changed,
     * so the evidence must notice it moving after the checks exactly as it notices a declared input moving.
     * Recorded scope is already normalized and refused for protected segments when it was declared.
     */
    const monitored: string[] = [
      ...new Set([...inputPaths, ...checkPaths, ...state.affectedPaths]),
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const reviewEarly = (reason: string): CompletionDecision => ({
      action: 'review',
      summary: {
        version: 1,
        state: 'needs_review',
        reason,
        contractId: state.contractId!,
        definitionHash: roundHash,
        verificationRound: state.verificationRound,
        repairRounds: state.repairRounds,
        repeatedFailures: state.repeatedFailures,
        failedCheckIds: [],
        unfinishedStepIds: [],
      },
    });
    const before = monitored.length
      ? await snapshotCompletionInputs(
          workspace,
          monitored,
          signal,
          snapshotOptions('before'),
        ).then(
          (snapshot) => snapshot,
          (error: unknown) => {
            // A range that cannot be fingerprinted is not a range that can be declared verified: a digest over
            // part of the tree would be a digest of a different tree.
            state.snapshotFailure = error instanceof Error ? error.message : String(error);
            return undefined;
          },
        )
      : undefined;
    if (monitored.length && !before)
      return reviewEarly(`input-snapshot-failed: ${state.snapshotFailure ?? 'unknown'}`);
    const roundEffects = new Map<string, string>();
    const verification: Awaited<ReturnType<typeof verifyCompletionAcceptance>> =
      await verifyCompletionAcceptance(
        workspace,
        roundAcceptance,
        roundSteps,
        baselines,
        signal,
        async (approval, approvalSignal) => {
          const allowed = await approve(approval, approvalSignal);
          // Only a task has an effect ledger to write into; for any other source the acceptance command is
          // approved exactly like any other command of the run, with no journal to reconcile afterwards.
          if (allowed && taskSubject) {
            roundEffects.set(
              approval.toolCall.id.slice('acceptance:'.length),
              store.beginTaskEffect(
                sessionId,
                taskSubject.task.id,
                taskSubject.attemptId,
                approval.toolCall.name,
              ),
            );
          }
          return allowed;
        },
      );
    state.taskVerification = verification;
    state.acceptance = state.taskVerification.evidence;
    state.verificationRound += 1;
    const after = before
      ? await snapshotCompletionInputs(workspace, monitored, signal, snapshotOptions('after')).then(
          (snapshot) => snapshot,
          (error: unknown) => {
            state.snapshotFailure = error instanceof Error ? error.message : String(error);
            return undefined;
          },
        )
      : undefined;
    if (before && !after)
      return reviewEarly(`input-snapshot-failed: ${state.snapshotFailure ?? 'unknown'}`);
    /**
     * A check that changed the code it was judging has verified nothing.
     *
     * The two snapshots bracket the checks, so a difference means the verification command (or a build it
     * started, or anything else that ran in between) wrote to the monitored range. Whatever the checks said
     * about the tree they read, that tree is gone; the report is `needs_review`, never a pass.
     */
    if (before && after && before.digest !== after.digest)
      return reviewEarly('verification-changed-monitored-inputs');
    if (after) {
      state.lastInputSnapshot = after;
      state.lastMonitoredInputs = [...monitored];
    }
    const stepSignature = roundSteps.map((step) => step.status).join(',');
    const fingerprint = failureFingerprint(state.taskVerification.evidence, roundSteps);
    state.lastFailureFingerprint = fingerprint;
    const decision = decideCompletion({
      summary: {
        version: 1,
        state: 'unverified',
        reason: '',
        contractId: state.contractId,
        definitionHash: roundHash,
        verificationRound: state.verificationRound,
        repairRounds: state.repairRounds,
        repeatedFailures: state.repeatedFailures,
        failedCheckIds: [],
        unfinishedStepIds: [],
        ...(after === undefined ? {} : { inputDigest: after.digest }),
      },
      steps: roundSteps,
      evidence: state.taskVerification.evidence,
      definitionValid: state.taskVerification.completionReason !== 'invalid-definition',
      definitionNonEmpty: roundAcceptance.length > 0,
      manualPending: state.taskVerification.completionReason === 'manual-review',
      pendingEffects: false,
      definitionChanged: roundHash !== state.contractDefinitionHash,
      cancelled: false,
      now: Date.now(),
      ...(state.repairStartedAt === undefined ? {} : { repairStartedAt: state.repairStartedAt }),
      policy: state.policy,
      failureFingerprint: fingerprint,
      ...(state.previousFailureFingerprint === undefined
        ? {}
        : { previousFailureFingerprint: state.previousFailureFingerprint }),
      // A round that moved the monitored input is progress even when the same check fails again: the code under
      // test is not the code the previous round judged, and reporting otherwise would stop a run that is working.
      inputChanged:
        after !== undefined &&
        state.previousInputDigest !== undefined &&
        after.digest !== state.previousInputDigest,
      stepsChanged:
        state.previousStepSignature !== undefined && state.previousStepSignature !== stepSignature,
    });
    if (after) state.previousInputDigest = after.digest;
    state.summary = decision.summary;
    state.previousStepSignature = stepSignature;
    if (taskSubject && currentTask) {
      /**
       * One write for the round: the evidence and the effects it settled, or nothing at all.
       *
       * A round that cannot be recorded must not be followed by another model request — the repair counter
       * would advance against evidence the journal never accepted, and the attempt would report rounds that do
       * not exist.
       */
      try {
        store.recordTaskVerificationRound(sessionId, currentTask.id, taskSubject.attemptId, {
          verificationRound: state.verificationRound,
          evidence: state.taskVerification.evidence,
          resolvedEffectIds: [...roundEffects.values()],
          summary: decision.summary,
        });
      } catch (recordError) {
        return {
          action: 'review',
          summary: {
            ...decision.summary,
            state: 'needs_review',
            reason:
              'round-not-recorded: ' +
              (recordError instanceof Error ? recordError.message : String(recordError)),
          },
        };
      }
    } else {
      // No attempt row to write into, so the round's own record *is* the evidence: one durable write, with the
      // same payload shape the task path produces, so a reader of either sees the same thing.
      store.recordEvent(sessionId, 'completion.updated', {
        runId,
        contractId: state.contractId,
        verificationRound: state.verificationRound,
        definitionHash: roundHash,
        summary: decision.summary,
        steps: roundSteps,
        affectedPaths: state.affectedPaths,
        policy: state.policy,
        evidence: state.taskVerification.evidence,
        ...(state.repairStartedAt === undefined ? {} : { repairStartedAt: state.repairStartedAt }),
        failureFingerprint: fingerprint,
      });
    }
    emit('completion.updated', {
      runId,
      contractId: state.contractId,
      ...(taskSubject && currentTask
        ? { taskId: currentTask.id, attemptId: taskSubject.attemptId }
        : {}),
      verificationRound: state.verificationRound,
      summary: decision.summary,
      evidence: state.taskVerification.evidence,
      steps: roundSteps,
      failureFingerprint: fingerprint,
    });
    return decision;
  };
  /**
   * Check the final source before marking either the task or the run done.
   *
   * Tool resources, children and stop hooks have settled. A final fingerprint mismatch must keep the task
   * open as well as downgrade the run; recording the task first would preserve a false completed status.
   *
   * Returns the stop the run must report instead of `completed`, or `undefined` when nothing moved — including
   * when this run carries no candidate or no earlier snapshot to compare against.
   */
  const settleFinalInputs = async (): Promise<string | undefined> => {
    if (!state.candidate || !state.lastInputSnapshot) return undefined;
    // `S1` was taken after the checks and before the cleanup; `S2` after it. A difference means the closing
    // phase itself wrote to the monitored source — a background build finishing, a formatter, a language
    // server — so the evidence describes a tree that no longer exists.
    const settled = await snapshotCompletionInputs(
      workspace,
      state.lastMonitoredInputs,
      signal,
      snapshotOptions('final'),
    ).catch((error: unknown) => {
      state.snapshotFailure = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (
      !settled ||
      settled.digest !== state.lastInputSnapshot.digest ||
      settled.rootId !== state.lastInputSnapshot.rootId
    )
      return (
        'Monitored inputs changed during finalization' +
        (state.snapshotFailure ? `: ${state.snapshotFailure}` : '') +
        '; the verification evidence no longer describes this workspace.'
      );
    return undefined;
  };
  /**
   * The verdict this run ends on, written once the status can no longer move.
   *
   * A candidate that survived cleanup is the round's own conclusion restated as the run's; one that did not is
   * reported as the stop that happened — a finalization failure and an incomplete cleanup are different answers.
   * A contract that produced no candidate at all still reports its state rather than nothing.
   */
  const finalizeVerdict = (status: RunStatus, failure: string | undefined): void => {
    if (state.candidate && status === 'completed') {
      state.summary = {
        ...state.candidate,
        state: 'verified',
        reason: 'verified',
      };
    } else if (state.candidate) {
      state.summary = {
        ...state.candidate,
        state: 'needs_review',
        reason: status === 'failed' ? 'finalization-failed' : 'cleanup-incomplete',
      };
    }
    if (!state.summary && state.contractId) {
      // A contract that never reached a verification round still reports its state rather than nothing: the
      // absence of a verdict and an unverified verdict are different answers, and only one of them is true.
      state.summary = {
        version: 1,
        state: 'unverified',
        reason: failure ?? 'not-verified',
        contractId: state.contractId,
        ...(state.contractDefinitionHash === undefined
          ? {}
          : { definitionHash: state.contractDefinitionHash }),
        verificationRound: state.verificationRound,
        repairRounds: state.repairRounds,
        repeatedFailures: state.repeatedFailures,
        failedCheckIds: [],
        unfinishedStepIds: [],
      };
    }
    // A change observed after the live invalidation write failed is retried here, before the run is persisted.
    invalidatePriorEvidence();
  };
  const captureBaselines = async (): Promise<void> => {
    if (task || !state.contractSpec) return;
    const acceptance = state.contractSpec.acceptance;
    if (resumedBaselines) {
      // A resume compares against what the contract's first run saw. Re-sampling would take the failed run's edits
      // as the new "before", so a contract whose images were never recorded is refused rather than re-imaged.
      const missing = acceptance.filter(
        (item) =>
          item.check?.kind === 'forbidden-path' &&
          item.check.expectation === 'unchanged' &&
          item.check.path &&
          !resumedBaselines![item.check.id],
      );
      if (missing.length)
        throw new Error(
          'This completion contract has no recorded baseline for its unchanged-path checks; start a new contract instead of resuming',
        );
      Object.assign(
        baselines,
        await captureAcceptanceBaselines(workspace, acceptance, resumedBaselines),
      );
      return;
    }
    const captured = await captureAcceptanceBaselines(workspace, acceptance, inheritedBaselines);
    Object.assign(baselines, captured);
    if (Object.keys(captured).length && state.contractId)
      store.recordEvent(sessionId, 'completion.updated', {
        runId,
        contractId: state.contractId,
        baselines: captured,
      });
  };

  return {
    state,
    configureAutomatic,
    noteWorkspaceChange,
    registerTools,
    captureBaselines,
    verifyRound,
    settleFinalInputs,
    finalizeVerdict,
  };
}
