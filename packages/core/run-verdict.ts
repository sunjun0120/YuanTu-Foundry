import type { RunStatus, Task } from '../protocol/index.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import type { RunCompletion } from './run-completion.ts';
import type { RunEmit } from './run-emit.ts';

/**
 * What a round that answered without asking for tools means for the run.
 *
 * Either the run ends with a status, or the completion contract asked for a repair round and the loop goes on. This
 * is the one decision in the loop that depends on the contract, the task's effect ledger and the verification round
 * together, which is why it lives on its own: the loop only has to act on the answer.
 */
export type AnswerVerdict =
  { next: 'repair' } | { next: 'stop'; status: RunStatus; error?: string };
const UNKNOWN_EFFECT = 'Task side effect outcome unknown; inspect state before retrying.';
export async function settleAnswerRound(options: {
  store: Pick<SessionStore, 'hasPendingTaskEffects' | 'append'>;
  sessionId: string;
  emit: RunEmit;
  completion: RunCompletion;
  task: Task | undefined;
  taskAttempt: { id: string } | undefined;
}): Promise<AnswerVerdict> {
  const { store, sessionId, emit, completion, task, taskAttempt } = options;
  const pendingEffects = () =>
    Boolean(task && taskAttempt && store.hasPendingTaskEffects(sessionId, task.id, taskAttempt.id));
  if (!completion.state.contractId || !completion.state.contractSpec) {
    // A task run whose contract could not be built still refuses to claim success with an unknown effect standing:
    // the effect ledger is a separate promise from the contract and outlives it.
    return pendingEffects()
      ? { next: 'stop', status: 'needs_review', error: UNKNOWN_EFFECT }
      : { next: 'stop', status: 'completed' };
  }
  if (pendingEffects()) return { next: 'stop', status: 'needs_review', error: UNKNOWN_EFFECT };
  const decision = await completion.verifyRound();
  if (decision?.action === 'repair') {
    // The budget is charged when the next request is about to be made, which is exactly here: a run that stops for
    // any other reason never spent the round it was allowed.
    completion.state.repairRounds += 1;
    completion.state.repeatedFailures = decision.summary.repeatedFailures;
    completion.state.previousFailureFingerprint = completion.state.lastFailureFingerprint;
    completion.state.repairStartedAt ??= Date.now();
    store.append(sessionId, { role: 'user', content: decision.feedback });
    // Announced as well as appended: a client watching the run sees that a repair round began rather than reading a
    // silently longer transcript.
    emit('context.injected', {
      source: 'completion-repair',
      round: completion.state.verificationRound,
    });
    return { next: 'repair' };
  }
  if (decision?.action === 'complete') {
    // A candidate only. Cleanup, the final fingerprint and persistence all still have to succeed before anything may
    // call this verified.
    completion.state.candidate = decision.summary;
    return { next: 'stop', status: 'completed' };
  }
  if (decision?.action === 'limit')
    return {
      next: 'stop',
      status: 'limited',
      error:
        completion.state.taskVerification?.error ??
        `Acceptance repair stopped: ${decision.summary.reason}`,
    };
  if (decision)
    return {
      next: 'stop',
      status: 'needs_review',
      error:
        completion.state.taskVerification?.error ??
        `Acceptance review required: ${decision.summary.reason}`,
    };
  return { next: 'stop', status: 'completed' };
}
