import type {
  Approval,
  Approver,
  QuestionOutcome,
  QuestionRequest,
  Questioner,
} from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { RunQueue } from './run-queue.ts';
import type { RunEmit } from './run-emit.ts';

/**
 * The two seams a run offers a person: approving an effect, and asking a question.
 *
 * Both are adapters rather than policy. The decision belongs to the host — the desktop dialog, the CLI prompt —
 * and what this module owns is the *record*: each request and each answer is written to the session log, in
 * order, so "asked but never answered" keeps exactly one meaning (the run was interrupted while waiting) and a
 * reopened session can still say who allowed what.
 *
 * Three rules live here because they are the same in both adapters:
 *
 * - **A read-only run refuses effects without asking.** Every workspace mutation in the registry declares a
 *   permission, so refusing the approval refuses the effect; a 120-second prompt for an operation that cannot be
 *   allowed would only waste the person's time. The refusal is still recorded as an answer, so it is not confused
 *   with an interruption.
 * - **A wait that was cut short is not a refusal.** A denied approval and a stopped run both arrive as `false`,
 *   and the difference is only visible in the signals: a person who refuses a write does not abort the call, so an
 *   aborted call signal means the wait was *cut short*. Recording both as "denied" would tell a later reader that
 *   someone looked at this file and refused it, which they never did.
 * - **A host that cannot ask still runs.** Asking is not an effect, so a missing questioner answers
 *   `unavailable` to the model instead of failing the call.
 */

export interface RunInteractionOptions {
  store: SessionStore;
  sessionId: string;
  queue: RunQueue;
  emit: RunEmit;
  /**
   * Whether this run may change anything, as a getter.
   *
   * A getter rather than a boolean because the run's own loop can tighten it mid-run — a child that turns out to
   * need writes is admitted through delegation rather than by flipping this — and because the approval path must
   * read the value in force *when the call arrives*, not the one that was in force when the adapter was built.
   */
  isReadOnly: () => boolean;
  approve?: Approver | undefined;
  question?: Questioner | undefined;
}

export interface RunInteraction {
  approve: Approver;
  ask: Questioner;
}

export function createRunInteraction(options: RunInteractionOptions): RunInteraction {
  const { store, sessionId, queue, emit } = options;
  const approve: Approver = async (approval: Approval, approvalSignal) => {
    /**
     * The planning phase is read-only, and that is enforced here rather than only by hiding tools:
     * every workspace mutation in the registry declares a permission, so refusing the approval
     * refuses the effect. The model is not asked, because a 120s approval prompt for an operation
     * that cannot be allowed would only waste the user's time.
     */
    if (options.isReadOnly()) {
      // A planning run refuses every mutation, and that refusal is an answer: it is recorded as one so that
      // "asked but never answered" keeps exactly one meaning — the run was interrupted while waiting.
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
      const allowed = await options.approve?.(
        approval,
        AbortSignal.any([approvalSignal, steering]),
      );
      /**
       * Why the wait ended, which is not the same question as what the answer was.
       *
       * A denied approval and a stopped run both arrive here as `false`, and the difference is only visible in
       * the signals: a person who refuses a write does not abort the call, so an aborted call signal means the
       * wait was *cut short* rather than answered. Recording both as "denied" would tell a reader later that
       * someone looked at this file and refused it, which they never did.
       */
      const cancelled = steering.aborted || approvalSignal.aborted;
      const reason = cancelled
        ? 'cancelled'
        : (options.approve?.decisionSource?.(approval) ?? 'user');
      const decision = {
        approval,
        allow: allowed === true && !steering.aborted,
        reason,
      } as const;
      // The decision is durable, not just live: after a reload the transcript shows a file that was written,
      // and this is the only record that says a person allowed it.
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
     * Asking is not a mutation, so this is the one seam that a read-only or planning run keeps: the
     * model may need a decision before it can plan anything, and refusing to ask would only make it
     * guess. A host with no questioner answers "unavailable" rather than throwing, so the tool result
     * still tells the model what to do next.
     */
    if (!options.question) return { answered: false, answers: [], reason: 'unavailable' };
    const steering = queue.steering.signal;
    if (steering.aborted) return { answered: false, answers: [], reason: 'cancelled' };
    emit('question.required', { request });
    store.recordEvent(sessionId, 'question.required', { request });
    try {
      const outcome = await options.question(request, AbortSignal.any([questionSignal, steering]));
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
  return { approve, ask };
}
