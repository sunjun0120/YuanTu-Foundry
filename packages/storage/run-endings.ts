import type { Message } from '../protocol/index.ts';
import { isRuntimeContext } from '../protocol/context.ts';
import type { CancelReason, RunEnding } from '../protocol/run-cancellation.ts';
import type { SessionProjection } from './projections.ts';

export interface RunEndingsState {
  messages: number;
  lastUser: number | null;
  open: { id: string; user: number | null; answered: boolean } | null;
  endings: RunEnding[];
}
const reasons = new Set<CancelReason>([
  'user',
  'shutdown',
  'background-budget',
  'background-policy',
]);
/** Derived separately from messages so restoring a window never invents model input. */
export const runEndingsProjection: SessionProjection<RunEndingsState> = {
  name: 'runEndings',
  description: 'Unanswered runs and their recorded ending causes.',
  initial: () => ({ messages: 0, lastUser: null, open: null, endings: [] }),
  apply(state, event) {
    if (event.type === 'run.started')
      return {
        ...state,
        open: { id: String(event.data.runId), user: state.lastUser, answered: false },
      };
    if (['message.user', 'message.assistant', 'message.tool'].includes(event.type)) {
      const message = event.data.message as Message;
      const visibleUser = message.role === 'user' && !isRuntimeContext(message.content);
      return {
        ...state,
        messages: state.messages + 1,
        lastUser: visibleUser ? state.messages : state.lastUser,
        open: state.open
          ? {
              ...state.open,
              user: visibleUser ? state.messages : state.open.user,
              answered:
                state.open.answered || (message.role === 'assistant' && !!message.content.trim()),
            }
          : null,
      };
    }
    if (event.type !== 'run.finished' && event.type !== 'run.interrupted') return state;
    if (!state.open || state.open.id !== event.data.runId) return state;
    const status = event.type === 'run.interrupted' ? 'interrupted' : event.data.status;
    if (
      state.open.answered ||
      state.open.user === null ||
      !['cancelled', 'failed', 'limited', 'interrupted'].includes(String(status))
    )
      return { ...state, open: null };
    const reason = event.data.cancelReason as CancelReason;
    const ending: RunEnding = {
      runId: state.open.id,
      afterIndex: state.messages - 1,
      status: status as RunEnding['status'],
      ...(status === 'cancelled' && reasons.has(reason) ? { cancelReason: reason } : {}),
      ...(typeof event.data.error === 'string' ? { error: event.data.error } : {}),
    };
    return { ...state, open: null, endings: [...state.endings, ending] };
  },
};
