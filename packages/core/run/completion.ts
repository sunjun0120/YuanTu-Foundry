import { randomUUID } from 'node:crypto';
import { COMPLETION_LIMITS } from '../../protocol/index.ts';
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
} from '../../protocol/index.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import {
  completionDefinitionHash,
  normalizeCompletionPath,
  normalizeCompletionRepairPolicy,
  normalizeCompletionSpec,
  planCompletionSpec,
  taskCompletionSpec,
  taskCompletionStepId,
} from '../completion/contract.ts';
import {
  decideCompletion,
  failureFingerprint,
  type CompletionDecision,
} from '../completion/completion.ts';
import {
  assertCompletionInputReadable,
  snapshotCompletionInputs,
  type CompletionInputSnapshot,
} from '../completion/inputs.ts';
import type { RunEmit } from './emit.ts';
import {
  captureAcceptanceBaselines,
  verifyCompletionAcceptance,
  type TaskBaselines,
  type verifyTaskAcceptance,
} from '../completion/task-acceptance.ts';

/**
 * The completion contract a run is judged against: its resolution, the bounded repair loop's state,
 * and the two tools that report against it.
 *
 * Resolved once before any model request, so a bad contract is refused before work is paid for. The
 * state is shared with the run loop like `run/emit.ts`'s: this file owns the rules, the loop owns
 * the numbers. The durable half is the `completion.updated` record, so a restart reads its budget
 * back from the log.
 */

/**
 * The completion contract and the repair loop's in-memory state. Counters are persisted every round
 * (`repairRounds`). `repairStartedAt` is set at the first failure and never moved, even on resume.
 */
export interface RunCompletionState {
  automatic: boolean;
  policy: CompletionRepairPolicy;
  contractId: string | undefined;
  contractDefinitionHash: string | undefined;
  contractSpec: CompletionSpec | undefined;
  steps: CompletionStep[];
  /**
   * Paths the run declared as its change scope via `completion_scope`. Declared rather than
   * inferred, so a missed caller shows up.
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
   * The fingerprint after the last verification round, and the digest before it. The final cleanup
   * is compared against `lastInputSnapshot`; `previousInputDigest` answers "did the code change
   * since the last failure".
   */
  lastInputSnapshot: CompletionInputSnapshot | undefined;
  /**
   * The exact input list the last snapshot covered, kept because the digest depends on the list
   * too.
   */
  lastMonitoredInputs: string[];
  previousInputDigest: string | undefined;
  /** The message from the last failed fingerprint attempt, reported with the stop rather than swallowed. */
  snapshotFailure: string | undefined;
  /**
   * The verification round's products: `acceptance` (reported as `RunResult.acceptance`) and
   * `taskVerification` (read back by finalization for the attempt record).
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
   * Whether this run may change anything, as when the contract was resolved. The tools guard on it
   * once, at registration.
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
   * Before-images the checks compare against, captured before the run wrote anything. A task's are
   * taken before the run row exists; others are added by `captureBaselines`.
   */
  baselines: TaskBaselines;
  /**
   * The run's own approver: a check needing permission asks like any tool, and a refusal is a
   * failed check.
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
   * Record that this run changed the workspace, downgrading the session's previous `verified`
   * verdict at the first change (a cancelled run may never reach finalization).
   */
  noteWorkspaceChange(): void;
  /** Predeclare tools for automatic verification before its contract exists. */
  registerTools(automatic?: boolean): void;
  /**
   * Before-images for a non-task contract's `unchanged` checks, captured after resolution and
   * before the first model request.
   */
  captureBaselines(): Promise<void>;
  /** The one verification round this run carries; `undefined` when it carries no contract to judge. */
  verifyRound(): Promise<CompletionDecision | undefined>;
  /**
   * Re-fingerprint the final source before the run may call itself done. Returns the stop to report
   * instead of `completed`, or `undefined` when nothing moved or there is nothing to compare.
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
 * The run's completion contract, resolved from the caller's request. A throw refuses to start the
 * run. Returns the state the loop mutates plus registration of the progress and scope tools.
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
  // Resolve the contract before any model request. Conflicting sources, invalid bodies and attempts
  // to replace a task's definition are errors, not a precedence order.
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
    // Re-executing the same approved plan under the same definition keeps the first attempt's
    // images; older records without images fall back to a fresh capture.
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
     * Continue a recorded contract: its definition, budget, repair clock and spent budget, but not
     * its verdict, which must be re-earned.
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
    /**
     * Restore the repeat fingerprint and input digest together with the count, so resuming cannot
     * bypass `maxRepeatedFailures` and an edited workspace still counts as progress.
     */
    if (record.summary.repeatedFailures > 0 && record.failureFingerprint !== undefined)
      state.previousFailureFingerprint = record.failureFingerprint;
    if (record.summary.inputDigest !== undefined)
      state.previousInputDigest = record.summary.inputDigest;
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
    // A task's contract is identified by the task, so a resume continues it.
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
  // Contract tools are predeclared for writable automatic verification runs; planning and read-only
  // runs get neither. `task_step` writes through the same checkpoint as `completion_step`.
  /**
   * Fingerprint options for this run. A large range is announced live before its files are read;
   * small ones say nothing.
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
   * Downgrade the session's previous `verified` verdict once this run changes the workspace. Only
   * `verified` is downgraded. The record carries this run's id and empty evidence. Best-effort;
   * finalization retries.
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
      // The old checks judged the old bytes, so the evidence is emptied.
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
              // Declared paths join the monitored range, so credential paths are refused here.
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
   * One verification round for whichever contract this run carries (task, approved plan or
   * request). Sources differ only in where the definition and progress are read and where the round
   * is recorded.
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
    // Hash the normalized body with live acceptance; step statuses are excluded so progress is not
    // an edit.
    const roundHash = completionDefinitionHash({
      ...state.contractSpec,
      acceptance: roundAcceptance,
    });
    /**
     * The files the evidence covers. An explicit spec states them; a task falls back to the whole
     * execution root minus derived directories.
     */
    const inputPaths = state.contractSpec.inputs.length
      ? state.contractSpec.inputs
      : taskSubject || state.automatic
        ? ['.']
        : [];
    /** Paths named by a check are always covered; protected paths are still refused. */
    const checkPaths: string[] = [];
    for (const item of roundAcceptance) {
      const checkPath = item.check?.path;
      if (!checkPath) continue;
      try {
        const normalized = normalizeCompletionPath(checkPath, 'check path');
        if (normalized !== '.') checkPaths.push(normalized);
      } catch {
        // The verifier already reports an unusable check path as `invalid-definition`.
      }
    }
    /**
     * Paths declared through `completion_scope` are monitored too (already normalized and checked).
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
            // A range that cannot be fingerprinted cannot be declared verified.
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
          // Only a task has an effect ledger; other sources approve the command like any other.
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
     * If the snapshots around the checks differ, a check changed what it judged: `needs_review`,
     * never a pass.
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
      // Read from the definition, since the verdict's reason names only the first failing
      // condition.
      manualPending: roundAcceptance.some((item) => !item.check && !item.met),
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
      // A round that changed the monitored input is progress even if the same check fails again.
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
       * One write for the round's evidence and settled effects, or nothing; an unrecorded round
       * must not be followed by another model request.
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
      // Without an attempt row, the round's own record is the evidence, in the same shape as the
      // task path.
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
   * Check the final source before marking the task or the run done. A mismatch keeps the task open
   * and downgrades the run. Returns the stop to report, or `undefined` when nothing moved.
   */
  const settleFinalInputs = async (): Promise<string | undefined> => {
    if (!state.candidate || !state.lastInputSnapshot) return undefined;
    // `S1` was taken after the checks, `S2` after cleanup; a difference means cleanup wrote to the
    // monitored source.
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
   * The verdict this run ends on, once the status is final. A surviving candidate becomes the run's
   * verdict; otherwise the actual stop is reported. A contract with no candidate still reports its
   * state.
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
      // No verification round still reports a state; "no verdict" and "unverified" differ.
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
      // A resume compares against the first run's images; a contract without recorded images is
      // refused rather than re-imaged.
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
