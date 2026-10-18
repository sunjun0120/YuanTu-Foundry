import { dialog, type BrowserWindow } from 'electron';
import { describeHookDeclarations } from '../../packages/resources/hook-trust.ts';
import {
  HookTrustReview,
  type HookTrustAnswer,
  type HookTrustQuestion,
} from './hook-trust-review.ts';
import { mainText } from './i18n.ts';
import { safeError } from './main-context.ts';

/**
 * The workspace-hook trust prompt: every command and the file that declared it, then "trust" or "not now".
 *
 * A native dialog rather than a renderer panel because it has to be answered *before* the Host starts — the
 * first run of a new Host is when an untrusted `SessionStart` would otherwise execute — and the renderer is
 * not connected to anything yet at that point.
 */
function asker(
  window: () => BrowserWindow | null,
): (question: HookTrustQuestion) => Promise<HookTrustAnswer> {
  return async (question) => {
    const detail = `${mainText('hookTrust.detail', { workspace: question.workspace })}\n\n${describeHookDeclarations(question.declarations)}`;
    const options = (buttons: string[], message: string): Electron.MessageBoxOptions => ({
      type: 'warning',
      title: mainText('hookTrust.title'),
      message,
      detail,
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const show = (box: Electron.MessageBoxOptions) => {
      const parent = window();
      return parent && !parent.isDestroyed()
        ? dialog.showMessageBox(parent, box)
        : dialog.showMessageBox(box);
    };
    if (question.reason === 'unavailable') {
      await show(
        options(
          [mainText('hookTrust.skip')],
          mainText('hookTrust.unavailable', { detail: question.detail ?? '' }),
        ),
      );
      return 'skip';
    }
    const message = mainText('hookTrust.message', { count: question.declarations.length });
    const result = await show(
      options(
        [mainText('hookTrust.skip'), mainText('hookTrust.trust')],
        question.reason === 'changed' ? `${mainText('hookTrust.changed')}\n${message}` : message,
      ),
    );
    return result.response === 1 ? 'trust' : 'skip';
  };
}

/** Asked before every Host start; a failure to ask leaves the hooks off, which the Host enforces anyway. */
export function workspaceHookReviewer(
  window: () => BrowserWindow | null,
): (workspace: string) => Promise<void> {
  const hookTrust = new HookTrustReview(asker(window));
  return async (workspace) => {
    try {
      await hookTrust.review(workspace);
    } catch (error) {
      console.error(`[desktop] workspace hook review failed: ${safeError(error)}`);
    }
  };
}
