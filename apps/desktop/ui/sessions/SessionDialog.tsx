/**
 * The delete dialog for one session. Rename shares the controller's dialog state but edits in the row itself.
 *
 * The native `<dialog>` gives the window's usual focus trap and Escape; React decides when it is open and what the
 * buttons do. Focus starts on Cancel, so Enter alone never deletes.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { dialogDescription, type SessionSidebarController } from './session-model.ts';

export function SessionDialog({ controller }: { controller: SessionSidebarController }): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const current = state.dialog?.kind === 'delete' ? state.dialog : null;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (current) {
      if (!element.open) {
        element.showModal();
        cancel.current?.focus();
      }
    } else if (element.open) element.close();
  }, [current]);

  return (
    <dialog
      ref={dialog}
      id="session-dialog"
      className="session-dialog"
      aria-labelledby="session-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        controller.cancelDialog();
      }}
      onClose={() => {
        if (controller.store.getSnapshot().dialog?.kind === 'delete') controller.cancelDialog();
      }}
    >
      <form
        id="session-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.confirmDialog();
        }}
      >
        <h2 id="session-dialog-title">{t('session.deleteTitle')}</h2>
        <p id="session-dialog-description">{current ? dialogDescription(current) : ''}</p>
        <p
          id="session-dialog-error"
          className="session-dialog-error"
          role="alert"
          hidden={!current?.error}
        >
          {current?.error ?? ''}
        </p>
        <div className="session-dialog-actions">
          <button
            ref={cancel}
            id="session-dialog-cancel"
            type="button"
            disabled={current?.saving ?? false}
            onClick={() => controller.cancelDialog()}
          >
            {t('session.cancel')}
          </button>
          <button
            id="session-dialog-confirm"
            type="submit"
            className="primary"
            disabled={current?.saving ?? false}
          >
            {t('session.confirmDelete')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
