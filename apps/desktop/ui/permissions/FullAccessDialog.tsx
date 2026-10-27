/**
 * The full-access confirmation: the one rung that gives up isolation, behind the same risk dialog the window has
 * always used.
 *
 * The dialog is the native `<dialog>` element (top layer, focus trap, Escape) — the same element the legacy markup
 * used; React only decides when it is open and what the buttons do. Focus lands on Cancel, so Enter alone never
 * gives up the sandbox.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import type { PermissionController } from './permission-model.ts';

const RISKS = ['files', 'commands', 'network'] as const;

function RiskIcon({ id }: { id: (typeof RISKS)[number] }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {id === 'files' ? (
        <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
      ) : id === 'commands' ? (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="m8 10 2.5 2L8 14" />
          <path d="M12.5 15h3.5" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17" />
          <path d="M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5Z" />
        </>
      )}
    </svg>
  );
}

export function FullAccessDialog({ controller }: { controller: PermissionController }): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (state.confirming) {
      if (!element.open) {
        element.showModal();
        cancel.current?.focus();
      }
    } else if (element.open) element.close();
  }, [state.confirming]);

  return (
    <dialog
      ref={dialog}
      id="full-access-dialog"
      className="full-access-dialog"
      aria-labelledby="full-access-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!state.pending) controller.cancel();
      }}
      onClose={() => {
        // A close the browser performed (not our effect) still withdraws the question.
        if (state.confirming) controller.cancel();
      }}
    >
      <form
        id="full-access-form"
        className="full-access-form"
        onSubmit={(event) => {
          event.preventDefault();
          controller.confirm();
        }}
      >
        <header className="risk-dialog-head">
          <span className="risk-dialog-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M10.3 4.2 2.8 17.4A2 2 0 0 0 4.5 20.4h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
              <path d="M12 9.6v4.2" />
              <path d="M12 17.1h.01" />
            </svg>
          </span>
          <h2 id="full-access-title">{t('permission.dialog.title')}</h2>
          <button
            id="full-access-close"
            className="full-access-close"
            type="button"
            aria-label={t('permission.dialog.close')}
            onClick={() => controller.cancel()}
          >
            ✕
          </button>
        </header>
        <p id="full-access-description" className="full-access-description">
          {t('permission.dialog.description')}
        </p>
        <ul className="risk-list">
          {RISKS.map((id) => (
            <li key={id} data-risk={id}>
              <span className="risk-list-icon" aria-hidden="true">
                <RiskIcon id={id} />
              </span>
              <span className="risk-list-copy">
                <strong>{t(`permission.risk.${id}Name`)}</strong>
                <small>{t(`permission.risk.${id}Line`)}</small>
              </span>
            </li>
          ))}
        </ul>
        <p id="full-access-risk" className="full-access-risk">
          {t('permission.dialog.risk')}
        </p>
        <div className="session-dialog-actions">
          <button
            ref={cancel}
            id="full-access-cancel"
            type="button"
            disabled={state.pending}
            onClick={() => controller.cancel()}
          >
            {t('permission.dialog.cancel')}
          </button>
          <button
            id="full-access-enable"
            type="submit"
            className="risk-confirm"
            disabled={state.pending}
          >
            {t('permission.dialog.confirm')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
