import type { StoredFileChange } from '../storage/sqlite.ts';

export type FileChangeStatus = StoredFileChange['status'];

/** What the session-change list offers for one journal row, and how it describes that row. */
export type FileChangeAction =
  | { kind: 'undo'; actionKey: string; noticeKey: string }
  | { kind: 'resume'; actionKey: string; noticeKey: string }
  | { kind: 'none'; noticeKey: string };

/**
 * Decides the undo affordance and status wording for one file-change journal row.
 *
 * `'undoing'` is deliberately actionable. That status means an undo was interrupted — the app was
 * closed, or the process died — part-way through restoring a group. `undoFileChange` keeps such a
 * row resumable: it accepts a row still in the `'undoing'` state and requires only that each path
 * sit in its exact before or exact after state, so calling undo again finishes the restoration.
 *
 * Offering the button only for `'applied'` made that recovery path unreachable from the UI. The
 * user saw "the result is uncertain" with nothing to click, while `SessionStore.assertMutable`
 * answered "File restoration is busy" for every rename and delete — a dead end that no amount of
 * reading `file-undo.ts` alone would reveal.
 *
 * `'pending'` is intentionally not offered: `reconcilePendingFileChanges` normally resolves it at
 * run boundaries, and when it cannot it settles as `'abandoned'` or `'conflict'`, for which an undo
 * attempt would only fail. Those rows are described rather than made actionable.
 */
export function fileChangeAction(status: FileChangeStatus): FileChangeAction {
  switch (status) {
    case 'applied':
      return { kind: 'undo', actionKey: 'ui.undoChange', noticeKey: 'ui.restoreContent' };
    case 'undoing':
      return { kind: 'resume', actionKey: 'ui.resumeUndo', noticeKey: 'ui.undoInterrupted' };
    case 'undone':
      return { kind: 'none', noticeKey: 'ui.undone' };
    default:
      return { kind: 'none', noticeKey: 'ui.uncertainResult' };
  }
}

/** The label key for the confirmation button, which differs for deleting a created file. */
export function undoConfirmKey(kind: string): string {
  return kind === 'create' ? 'ui.undoNewFile' : 'ui.undoContent';
}
