/**
 * The rename/delete dialog for one session.
 *
 * The native `<dialog>` gives the window's usual focus trap and Escape; React decides when it is open and what the
 * buttons do. Rename focuses and selects the title; delete puts focus on Cancel, so Enter alone never deletes.
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
  const title = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const current = state.dialog;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (current) {
      if (!element.open) {
        element.showModal();
        if (current.kind === 'rename') {
          title.current?.focus();
          title.current?.select();
        } else cancel.current?.focus();
      }
    } else if (element.open) element.close();
  }, [current]);

  return (
    <dialog
      ref={dialog}
      id="session-dialog"
      aria-labelledby="session-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        controller.cancelDialog();
      }}
      onClose={() => {
        if (controller.store.getSnapshot().dialog) controller.cancelDialog();
      }}
    >
      <form
        id="session-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.confirmDialog();
        }}
      >
        <h2 id="session-dialog-title">
          {current?.kind === 'delete' ? t('session.deleteTitle') : t('session.renameTitle')}
        </h2>
        <p id="session-dialog-description">{current ? dialogDescription(current) : ''}</p>
        <label
          id="session-title-label"
          htmlFor="session-title-input"
          hidden={current?.kind !== 'rename'}
        >
          {t('session.nameLabel')}
        </label>
        <input
          ref={title}
          id="session-title-input"
          maxLength={120}
          autoComplete="off"
          hidden={current?.kind !== 'rename'}
          required={current?.kind === 'rename'}
          disabled={!current || current.saving}
          value={current?.value ?? ''}
          onChange={(event) => controller.setDialogValue(event.currentTarget.value)}
        />
        <p id="session-dialog-error" role="alert" hidden={!current?.error}>
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
            {current?.kind === 'delete' ? t('session.confirmDelete') : t('session.saveName')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
