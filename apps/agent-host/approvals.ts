import { randomUUID } from 'node:crypto';
import { DeferredApprovalError } from '../../packages/core/approval-deferred.ts';
import type { PermissionPolicy } from '../../packages/core/permissions.ts';
import type {
  Approval,
  ApprovalDecisionSource,
  Approver,
  QuestionOutcome,
  QuestionRequest,
  Questioner,
} from '../../packages/protocol/index.ts';
import { resolveRunLimits } from '../../packages/protocol/settings.ts';
import type { SessionStore } from '../../packages/storage/sqlite.ts';
import type { Options } from '../shared/args.ts';
import type { HostContext, PendingApproval, PendingQuestion } from './state.ts';

/**
 * The Host's side of every interactive decision: who may run a command, and who answers a question.
 *
 * Two callers with genuinely different authority share this module. A *run* asks a person — and a run started by
 * the clock or by a background wake has nobody to ask, so it is told "unavailable" and proceeds on a stated
 * assumption instead of holding a promise open. *Verification* runs outside any run and cannot use the streaming
 * approval flow at all, so it honors the permission policy and `--allow-command` and otherwise fails closed rather
 * than executing an unauthorized host command. Both report *why* they decided what they decided, because the
 * verification path reads that afterwards.
 */

/**
 * How a decision was reached, recorded against the tool call that asked. Keyed on the call object rather than on
 * the approval, because the source is read *after* the decision and must not keep an approval alive to do it.
 */
const record = (
  sources: WeakMap<object, ApprovalDecisionSource>,
  approval: Approval,
  source: ApprovalDecisionSource,
): void => {
  sources.set(approval.toolCall, source);
};

export interface VerifierOptions {
  /** Read lazily: `permission.update` replaces the policy while a run is in flight. */
  policy: () => PermissionPolicy | undefined;
  options: Options;
  approvalSources: WeakMap<object, ApprovalDecisionSource>;
}

/**
 * The approver for commands that run outside an active run.
 *
 * Verification commands cannot rely on the streaming approval flow, so they still honor the permission policy and
 * `--allow-command`, and otherwise fail closed rather than executing an unauthorized host command.
 */
export function createVerifier(options: VerifierOptions): Approver {
  const verifyApprover: Approver = async (approval, signal) => {
    signal.throwIfAborted();
    const decision = options.policy()?.decide(approval);
    if (decision === 'deny' || decision === 'allow') {
      record(options.approvalSources, approval, 'policy');
      return decision === 'allow';
    }
    if (
      decision !== 'ask' &&
      ((approval.kind === 'write' && options.options.allowWrite) ||
        (approval.kind === 'command' && options.options.allowCommand))
    ) {
      record(options.approvalSources, approval, 'launch-options');
      return true;
    }
    record(options.approvalSources, approval, 'unavailable');
    return false;
  };
  verifyApprover.decisionSource = (approval) => options.approvalSources.get(approval.toolCall);
  return verifyApprover;
}

export interface RunApproverOptions {
  /** The parsed command line, for `--allow-write` and `--allow-command`. */
  options: Options;
  store: SessionStore;
  sessionId: string;
  /** The policy in force for this run: the wake's captured one, or the process's live one. */
  policy: () => PermissionPolicy | undefined;
  /** True when a background wake started this run, which has nobody to ask. */
  wake: boolean;
  /** The unattended task this run belongs to, when a clock or an event started it. */
  unattendedTaskId: string | undefined;
  /** The run's id, which its first event settles; a run that has not started reports an empty id. */
  runId: () => string;
  approvals: Map<string, PendingApproval>;
  approvalSources: WeakMap<object, ApprovalDecisionSource>;
  send: (data: unknown) => void;
}

/**
 * The approver a live run asks through.
 *
 * The order of the checks is the policy: an explicit deny ends it, a task's own recorded approval answers next, an
 * explicit allow answers after that, then the launch options, and only then a person. A run that has nobody to ask
 * — unattended, or woken by the clock — is refused rather than left holding a promise the client will never see.
 */
export function createRunApprover(options: RunApproverOptions): Approver {
  const { sessionId, approvals, approvalSources } = options;
  const approve: Approver = (approval: Approval, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const decision = options.policy()?.decide(approval);
    if (decision === 'deny') {
      record(approvalSources, approval, 'policy');
      return Promise.resolve(false);
    }
    if (
      options.unattendedTaskId &&
      options.store.consumeTaskApproval(sessionId, options.unattendedTaskId, approval)
    ) {
      record(approvalSources, approval, 'task-approval');
      return Promise.resolve(true);
    }
    if (decision === 'allow') {
      record(approvalSources, approval, 'policy');
      return Promise.resolve(true);
    }
    if (
      decision !== 'ask' &&
      ((approval.kind === 'write' && options.options.allowWrite) ||
        (approval.kind === 'command' && options.options.allowCommand))
    ) {
      record(approvalSources, approval, 'launch-options');
      return Promise.resolve(true);
    }
    signal.throwIfAborted();
    if (options.unattendedTaskId) {
      options.store.deferTaskApproval(sessionId, options.unattendedTaskId, approval);
      return Promise.reject(new DeferredApprovalError());
    }
    if (options.wake) {
      record(approvalSources, approval, 'unavailable');
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const approvalId = randomUUID();
      const abort = () => finish(false);
      // The Host's own bound on the wait, so a run cannot be held open by a client that stopped listening.
      const timer = setTimeout(() => finish(false, 'unavailable'), 120_000);
      const finish = (allow: boolean, source: ApprovalDecisionSource = 'user') => {
        record(approvalSources, approval, source);
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        approvals.delete(approvalId);
        resolve(allow);
      };
      approvals.set(approvalId, {
        approval: structuredClone(approval),
        resolve: finish,
      });
      signal.addEventListener('abort', abort, { once: true });
      options.send({
        event: {
          type: 'approval.required',
          sessionId,
          runId: options.runId(),
          data: { approvalId, approval },
        },
      });
    });
  };
  approve.decisionSource = (approval) => approvalSources.get(approval.toolCall);
  return approve;
}

export interface RunQuestionerOptions {
  options: Options;
  sessionId: string;
  /** True when this run has nobody to ask, so the answer is "unavailable" rather than a wait. */
  wake: boolean;
  unattendedTaskId: string | undefined;
  runId: () => string;
  questions: Map<string, PendingQuestion>;
  send: (data: unknown) => void;
}

/**
 * Asking the human, the one interactive seam a run keeps even when it may not write.
 *
 * A scheduled run has nobody to ask, so it answers "unavailable" immediately rather than holding the
 * run open for the whole timeout: the model is told to proceed on a stated assumption, and the
 * scheduler does not sit behind a question no one will ever see.
 */
export function createRunQuestioner(options: RunQuestionerOptions): Questioner {
  const { sessionId, questions } = options;
  return (request: QuestionRequest, signal: AbortSignal): Promise<QuestionOutcome> => {
    signal.throwIfAborted();
    if (options.unattendedTaskId || options.wake)
      return Promise.resolve({ answered: false, answers: [], reason: 'unavailable' });
    // The Host's own bound on the wait, from the same settings owner the kernel reads.
    const questionTimeoutMs = resolveRunLimits(options.options).questionTimeoutMs;
    return new Promise((resolve) => {
      const questionId = randomUUID();
      const finish = (outcome: QuestionOutcome) => {
        const pending = questions.get(questionId);
        if (!pending) return;
        clearTimeout(pending.timer);
        questions.delete(questionId);
        signal.removeEventListener('abort', abort);
        resolve(outcome);
      };
      const abort = () => finish({ answered: false, answers: [], reason: 'cancelled' });
      const timer = setTimeout(
        () => finish({ answered: false, answers: [], timedOut: true, reason: 'timeout' }),
        questionTimeoutMs,
      );
      questions.set(questionId, { resolve: finish, timer });
      signal.addEventListener('abort', abort, { once: true });
      options.send({
        event: {
          type: 'question.required',
          sessionId,
          runId: options.runId(),
          data: { questionId, request },
        },
      });
    });
  };
}

/**
 * Settle everything the Host is still waiting on, on the way down.
 *
 * A pending approval resolves false and a pending question settles as cancelled, because the run that asked is
 * being aborted: leaving either unresolved would leave a promise nobody will ever settle. Called from `shutdown`
 * between aborting the runs and disposing the residents, so a run that unwinds because of it is already stopped.
 */
export function settleInteraction(ctx: HostContext): void {
  for (const pending of ctx.approvals.values()) pending.resolve(false);
  ctx.approvals.clear();
  // A question outlives nothing: the run that asked it is being aborted, so the wait settles as
  // unavailable rather than leaving a promise nobody will ever resolve.
  for (const pending of ctx.questions.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ answered: false, answers: [], reason: 'cancelled' });
  }
  ctx.questions.clear();
}
