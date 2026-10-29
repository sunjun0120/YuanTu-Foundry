import type { Message } from '../protocol/index.ts';
import { isRuntimeContext } from '../protocol/context.ts';
import { isPresentedFile, presentTurnFiles, type PresentedFile } from '../protocol/deliverables.ts';
import type { SessionProjection } from './projections.ts';

export interface TurnDeliverablesState {
  messages: number;
  lastUser: number;
  runId: string | null;
  files: PresentedFile[];
}

/** Replay ownership from existing events, including logs written before turn cards existed. */
export const turnDeliverablesProjection: SessionProjection<TurnDeliverablesState> = {
  name: 'turnDeliverables',
  description: 'Presented files by run, with their settled transcript position.',
  initial: () => ({ messages: 0, lastUser: 0, runId: null, files: [] }),
  apply(state, event) {
    if (event.type === 'run.started' && typeof event.data.runId === 'string')
      return { ...state, runId: event.data.runId };
    if (['message.user', 'message.assistant', 'message.tool'].includes(event.type)) {
      const message = event.data.message as Message;
      const lastUser =
        message.role === 'user' && !isRuntimeContext(message.content)
          ? state.messages
          : state.lastUser;
      // Logs without lifecycle events still have visible question intervals. A new question freezes the old one.
      const legacyId = `legacy:${lastUser}`;
      return {
        ...state,
        lastUser,
        messages: state.messages + 1,
        files: state.runId
          ? state.files
          : state.files.map((file) =>
              file.runId === legacyId ? { ...file, afterIndex: state.messages } : file,
            ),
      };
    }
    if (event.type === 'deliverable.presented') {
      if (!Array.isArray(event.data.files)) return state;
      const runId = state.runId ?? `legacy:${state.lastUser}`;
      const files = event.data.files.filter(isPresentedFile).map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        at: file.at,
        ...(file.description ? { description: file.description } : {}),
        runId,
        ...(!state.runId && state.messages > 0 ? { afterIndex: state.messages - 1 } : {}),
      }));
      return { ...state, files: presentTurnFiles(state.files, files) };
    }
    if (
      (event.type === 'run.finished' || event.type === 'run.interrupted') &&
      state.runId !== null &&
      event.data.runId === state.runId
    ) {
      return {
        ...state,
        runId: null,
        files: state.files.map((file) =>
          file.runId === state.runId && state.messages > 0
            ? { ...file, afterIndex: state.messages - 1 }
            : file,
        ),
      };
    }
    return state;
  },
};
