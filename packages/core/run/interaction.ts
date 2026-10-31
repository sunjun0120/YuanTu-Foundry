import type {
  Approval,
  Approver,
  QuestionOutcome,
  QuestionRequest,
  Questioner,
} from '../../protocol/index.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import type { RunQueue } from './queue.ts';
import type { RunEmit } from './emit.ts';

/**
 * The two seams a run offers a person: approving an effect and asking a question. The host decides;
 * this module records each request and answer in the session log, so "asked but never answered"
 * only means the run was interrupted while waiting.
 *
 * - A read-only run refuses effects without asking, and records the refusal as an answer.
 * - A wait cut short (aborted signal) is recorded as cancelled, not denied.
 * - A host that cannot ask still runs; the model is told `unavailable`.
 */

export interface RunInteractionOptions {
  store: SessionStore;
  sessionId: string;
  queue: RunQueue;
  emit: RunEmit;
  /** Whether this run may change anything, as a getter read when each call arrives. */
  isReadOnly: () => boolean;
  approve?: Approver | undefined;
  question?: Questioner | undefined;
}

export interface RunInteraction {
  approve: Approver;
  ask: Questioner;
  /**
   * Wall time spent waiting on a person so far; overlapping waits count once, an open wait counts
   * up to now.
   */
  humanWaitMs: () => number;
}

export function createRunInteraction(options: RunInteractionOptions): RunInteraction {
  const { store, sessionId, queue, emit } = options;
  /**
   * Commands already approved in this run, keyed by command and cwd, so automatic verification
   * re-running the same `run_command` in the same cwd does not ask twice.
   */
  const approvedCommands = new Set<string>();
  /** Approvals this run refused without asking a person, so the registry can report policy rather than "user no". */
  const readOnlyRefusals = new WeakSet<Approval>();
  /** The person-held clock behind `humanWaitMs`: open waits, when the first of them opened, and closed time. */
  let openWaits = 0;
  let waitOpenedAt = 0;
  let closedWaitMs = 0;
  const waitingOnPerson = async <T>(wait: () => Promise<T>): Promise<T> => {
    if (openWaits++ === 0) waitOpenedAt = Date.now();
    try {
      return await wait();
    } finally {
      if (--openWaits === 0) closedWaitMs += Date.now() - waitOpenedAt;
    }
  };
  const humanWaitMs = (): number => closedWaitMs + (openWaits > 0 ? Date.now() - waitOpenedAt : 0);
  const commandKey = (approval: Approval): string | undefined => {
    if (approval.toolCall.name !== 'run_command') return undefined;
    const args = approval.toolCall.arguments as { command?: unknown; cwd?: unknown } | undefined;
    if (typeof args?.command !== 'string') return undefined;
    return `${args.command}\u0000${typeof args.cwd === 'string' ? args.cwd : '.'}`;
  };
  const approve: Approver = async (approval: Approval, approvalSignal) => {
    const command = commandKey(approval);
    const verification = approval.toolCall.id.startsWith('acceptance:');
    if (verification && command && approvedCommands.has(command)) {
      store.recordEvent(sessionId, 'approval.decided', {
        approval,
        allow: true,
        reason: 'reused',
      });
      return true;
    }
    /** Read-only (planning) runs refuse every permissioned effect here without prompting. */
    if (options.isReadOnly()) {
      // Record the refusal as an answer.
      readOnlyRefusals.add(approval);
      store.recordEvent(sessionId, 'approval.required', { approval });
      store.recordEvent(sessionId, 'approval.decided', {
        approval,
        allow: false,
        reason: 'read-only',
      });
      return false;
    }
    emit('approval.required', { approval });
    store.recordEvent(sessionId, 'approval.required', { approval });
    const steering = queue.steering.signal;
    if (steering.aborted) {
      store.recordEvent(sessionId, 'approval.decided', {
        approval,
        allow: false,
        reason: 'cancelled',
      });
      return false;
    }
    try {
      const allowed = await waitingOnPerson(async () =>
        options.approve?.(approval, AbortSignal.any([approvalSignal, steering])),
      );
      /** Why the wait ended: an aborted signal means it was cut short, not refused. */
      const cancelled = steering.aborted || approvalSignal.aborted;
      const reason = cancelled
        ? 'cancelled'
        : (options.approve?.decisionSource?.(approval) ?? 'user');
      const decision = {
        approval,
        allow: allowed === true && !steering.aborted,
        reason,
      } as const;
      if (decision.allow && command) approvedCommands.add(command);
      // Durable: the only record that a person allowed this effect.
      store.recordEvent(sessionId, 'approval.decided', decision);
      emit('approval.decided', decision);
      return decision.allow;
    } catch (error) {
      if (steering.aborted && !approvalSignal.aborted) {
        store.recordEvent(sessionId, 'approval.decided', {
          approval,
          allow: false,
          reason: 'cancelled',
        });
        return false;
      }
      throw error;
    }
  };
  const ask: Questioner = async (request: QuestionRequest, questionSignal) => {
    /**
     * Asking is not a mutation, so read-only and planning runs keep it. Without a questioner the
     * answer is `unavailable`.
     */
    if (!options.question) return { answered: false, answers: [], reason: 'unavailable' };
    const steering = queue.steering.signal;
    if (steering.aborted) return { answered: false, answers: [], reason: 'cancelled' };
    emit('question.required', { request });
    store.recordEvent(sessionId, 'question.required', { request });
    try {
      const question = options.question;
      const outcome = await waitingOnPerson(() =>
        question(request, AbortSignal.any([questionSignal, steering])),
      );
      // Recorded the same way an approval is: the pair is what makes "never answered" mean interrupted.
      store.recordEvent(sessionId, 'question.answered', { request, outcome });
      emit('question.answered', { request, outcome });
      return outcome;
    } catch (error) {
      if (steering.aborted && !questionSignal.aborted) {
        const outcome: QuestionOutcome = { answered: false, answers: [], reason: 'cancelled' };
        store.recordEvent(sessionId, 'question.answered', { request, outcome });
        return outcome;
      }
      throw error;
    }
  };
  approve.decisionReason = (approval) => (readOnlyRefusals.has(approval) ? 'read-only' : undefined);
  /**
   * Why a refusal happened, so a policy denial is not reported as a human refusal. The inner
   * approver's source (`policy`, `launch-options`, `task-approval`, `user`) is used when present;
   * this wrapper adds only its own read-only refusals.
   */
  approve.decisionSource = (approval) =>
    readOnlyRefusals.has(approval) ? 'policy' : options.approve?.decisionSource?.(approval);
  return { approve, ask, humanWaitMs };
}
