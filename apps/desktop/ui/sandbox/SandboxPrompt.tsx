/**
 * The sandbox-account prompt above the composer.
 *
 * It is drawn only while the accounts need something from the person: an uninitialized or damaged backend that this
 * session's commands actually use, and that has not been dismissed. Ready accounts are not drawn anywhere — there is
 * nothing to manage. The legacy ids are kept (`#sandbox-prompt`, `-title`, `-initialize`, …) because the Windows
 * account smoke drives them; the buttons stay native because the prompt's look is the composer's, not a settings form.
 */
import type { ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import {
  sandboxPromptFeedback,
  sandboxPromptNote,
  sandboxPromptTitleKey,
  sandboxPromptVisible,
  sandboxStateNeedsSetup,
  type SandboxSetupController,
} from './sandbox-setup-model.ts';

export function SandboxPrompt({ controller }: { controller: SandboxSetupController }): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const stateName = state.view?.state;
  const visible = sandboxPromptVisible(state);
  const note = sandboxPromptNote(state);
  const feedback = sandboxPromptFeedback(state);
  const damaged = stateName === 'damaged';
  return (
    <section
      id="sandbox-prompt"
      className="sandbox-prompt"
      aria-labelledby="sandbox-prompt-title"
      hidden={!visible}
    >
      <div className="sandbox-prompt-text">
        <strong id="sandbox-prompt-title">{t(sandboxPromptTitleKey(stateName))}</strong>
        <p id="sandbox-prompt-note" title={damaged ? (state.view?.details ?? []).join('; ') : ''}>
          {note}
        </p>
        <p id="sandbox-prompt-feedback" role="status" aria-live="polite" hidden={!feedback}>
          {feedback}
        </p>
      </div>
      <div className="sandbox-prompt-actions">
        <button
          id="sandbox-prompt-weak"
          type="button"
          className="link"
          disabled={state.pending}
          title={t('sandboxSetup.prompt.weakNote')}
          onClick={() => void controller.chooseWeak()}
        >
          {t('sandboxSetup.prompt.weak')}
        </button>
        <button
          id="sandbox-prompt-dismiss"
          type="button"
          className="secondary"
          disabled={state.pending}
          onClick={() => controller.dismiss()}
        >
          {t('sandboxSetup.prompt.dismiss')}
        </button>
        <button
          id="sandbox-prompt-initialize"
          type="button"
          disabled={state.pending}
          onClick={() => void controller.request({ type: 'initialize', acknowledge: true })}
        >
          {sandboxStateNeedsSetup(stateName) && damaged
            ? t('sandboxSetup.repair')
            : t('sandboxSetup.initialize')}
        </button>
      </div>
    </section>
  );
}
