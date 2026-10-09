import type { QuestionAnswer } from '../../../packages/protocol/index.ts';
import { required } from '../params.ts';
import type { Handler } from '../dispatch.ts';

/**
 * The two answers a client sends back for a question the Host asked it.
 *
 * Both are late: the Host holds the pending approval or question *inside* the run, and the answer arrives on a
 * separate request from a separate place — the desktop's dialog, the CLI's prompt. So the work here is only
 * lookup and settle, and the settle goes through the pending entry because that entry owns the cleanup: deleting
 * it here first would make the run's own settle path see an unknown id, return, and leave the run waiting
 * forever.
 */
export const interactionHandlers: Readonly<Record<string, Handler>> = {
  'approval.respond': async (ctx, params) => {
    const id = required(params, 'approvalId'),
      entry = ctx.approvals.get(id);
    if (!entry) throw new Error('Approval is no longer pending');
    if (typeof params.allow !== 'boolean') throw new Error('allow must be a boolean');
    entry.resolve(params.allow);
    ctx.approvals.delete(id);
    return { accepted: true };
  },
  'question.respond': async (ctx, params) => {
    const entry = ctx.questions.get(required(params, 'questionId'));
    if (!entry) throw new Error('Question is no longer pending');
    const cancelled = params.cancelled === true;
    if (!cancelled && params.answers !== undefined && !Array.isArray(params.answers))
      throw new Error('answers must be an array');
    const answers = Array.isArray(params.answers) ? (params.answers as QuestionAnswer[]) : [];
    entry.resolve(
      cancelled
        ? { answered: false, answers: [], reason: 'cancelled' }
        : { answered: true, answers },
    );
    return { accepted: true };
  },
};
