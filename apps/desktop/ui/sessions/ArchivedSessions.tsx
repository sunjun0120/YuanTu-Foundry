/**
 * The archived-sessions list on the workspace maintenance page.
 *
 * A row is a title and two quiet actions; deleting asks once, in place, with the question beside the row it concerns.
 * The list is the Host's answer (a fresh read after every action), never a local guess.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { locale, t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import type { WorkspaceSettingsController } from '../settings/workspace-settings-model.ts';
import type { SessionInfo } from '../../../../packages/protocol/index.ts';

const UNARCHIVE_ICON = (
  <>
    <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" />
    <path d="M3 4h18v5H3z" />
    <path d="M12 18v-6M9.5 14.5 12 12l2.5 2.5" />
  </>
);
const DELETE_ICON = (
  <>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
  </>
);

function IconAction({
  label,
  action,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  action: string;
  icon: ReactNode;
  disabled: boolean;
  onClick(): void;
}): ReactNode {
  return (
    <button
      type="button"
      className="archived-session-action"
      data-action={action}
      aria-label={label}
      data-tooltip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {icon}
      </svg>
    </button>
  );
}

function ArchivedRow({
  item,
  controller,
  blocked,
  pending,
  confirmation,
}: {
  item: SessionInfo;
  controller: WorkspaceSettingsController;
  blocked: boolean;
  pending: boolean;
  confirmation: string | null;
}): ReactNode {
  const title = item.title || item.id.slice(0, 8);
  const confirming = confirmation === item.id;
  const disabled = blocked || pending;
  return (
    <li className="workspace-maintenance-item archived-session" data-session-id={item.id}>
      <div className="archived-session-copy">
        <strong translate="no">{title}</strong>
        {item.archivedAt ? (
          <small>
            {t('archived.at', { time: new Date(item.archivedAt).toLocaleString(locale()) })}
          </small>
        ) : null}
        {confirming ? <p>{t('archived.deleteConfirm', { title })}</p> : null}
      </div>
      <div className="archived-session-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="secondary danger-text"
              data-action="delete"
              disabled={pending}
              onClick={() => controller.removeArchived(item.id)}
            >
              {t('archived.confirmDelete')}
            </button>
            <button
              type="button"
              className="secondary"
              data-action="cancel"
              disabled={pending}
              onClick={() => controller.cancelArchived()}
            >
              {t('orphans.cancel')}
            </button>
          </>
        ) : (
          <>
            <IconAction
              label={t('archived.unarchive')}
              action="unarchive"
              icon={UNARCHIVE_ICON}
              disabled={disabled}
              onClick={() => controller.unarchive(item.id)}
            />
            <IconAction
              label={t('archived.delete')}
              action="delete"
              icon={DELETE_ICON}
              disabled={disabled}
              onClick={() => controller.removeArchived(item.id)}
            />
          </>
        )}
      </div>
    </li>
  );
}

export function ArchivedSessions({
  controller,
}: {
  controller: WorkspaceSettingsController;
}): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const archived = state.archived;
  const list = useRef<HTMLUListElement>(null);
  // The quiet action that opened the confirmation hands focus to its own Cancel: Enter then withdraws, never confirms.
  useEffect(() => {
    if (!archived.confirmation) return;
    list.current
      ?.querySelector<HTMLButtonElement>(
        `[data-session-id="${CSS.escape(archived.confirmation)}"] [data-action="cancel"]`,
      )
      ?.focus();
  }, [archived.confirmation]);
  const feedback =
    archived.error ??
    (archived.pending && !archived.items
      ? t('archived.loading')
      : archived.items?.length === 0
        ? t('archived.empty')
        : '');
  return (
    <>
      <p
        id="archived-sessions-feedback"
        role="status"
        aria-live="polite"
        className={archived.error ? 'error' : undefined}
      >
        {feedback}
      </p>
      <ul id="archived-sessions-list" className="workspace-maintenance-list" ref={list}>
        {(archived.items ?? []).map((item) => (
          <ArchivedRow
            key={item.id}
            item={item}
            controller={controller}
            blocked={state.blocked}
            pending={archived.pending}
            confirmation={archived.confirmation}
          />
        ))}
      </ul>
    </>
  );
}
