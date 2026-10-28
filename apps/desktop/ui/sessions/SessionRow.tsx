/**
 * One session row: the load button and its `⋯` menu trigger.
 *
 * The row says whether its session runs or waits on a person, but it is **not disabled** for a run: several sessions
 * run at once, and switching to another one has to stay possible. The status icon sits where the menu trigger appears
 * on hover; the label goes on the row, because the icon is drawn but never hovered.
 *
 * Rename edits the title in place, like a project name: the row becomes a field until Enter saves or Escape leaves.
 */
import type { ReactNode } from 'react';
import { locale, t } from '../../i18n.ts';
import {
  sessionAge,
  sessionStatusLabel,
  sessionTitle,
  sessionTooltip,
  type SessionActivity,
  type SessionSidebarController,
  type SessionSidebarState,
} from './session-model.ts';
import type { SessionInfo } from '../../../../packages/protocol/index.ts';

const WAITING_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path
      d="M8 1.5c3.6 0 6.5 2.5 6.5 5.6S11.6 12.7 8 12.7c-.7 0-1.4-.1-2-.3L2.6 14l.9-2.8C2.2 10.2 1.5 8.7 1.5 7.1 1.5 4 4.4 1.5 8 1.5Z"
      fill="currentColor"
    />
    <path
      d="M6.4 5.6c.1-.9.8-1.5 1.7-1.5.9 0 1.6.6 1.6 1.4 0 .6-.3 1-.9 1.3-.5.3-.7.5-.7 1v.2"
      fill="none"
      stroke="var(--status-icon-ink, #fff)"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <circle cx="8.1" cy="9.6" r=".75" fill="var(--status-icon-ink, #fff)" />
  </svg>
);

const MORE_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.5" cy="8" r="1.25" />
  </svg>
);

export function SessionRow({
  item,
  state,
  controller,
  onMenu,
  onMenuKeyboard,
  onMenuLeave,
}: {
  item: SessionInfo;
  state: SessionSidebarState;
  controller: SessionSidebarController;
  onMenu(anchor: HTMLButtonElement, sessionId: string): void;
  onMenuKeyboard(anchor: HTMLButtonElement, sessionId: string): void;
  onMenuLeave(): void;
}): ReactNode {
  const activity: SessionActivity | undefined = state.activity.get(item.id);
  const label = sessionStatusLabel(activity);
  const selected = item.id === state.currentId;
  const editing = state.dialog?.kind === 'rename' && state.dialog.targetId === item.id;
  if (editing && state.dialog) {
    const dialog = state.dialog;
    return (
      <div className="session-row session-row-editing">
        <form
          className="project-rename session-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void controller.confirmDialog();
          }}
        >
          <input
            id="session-title-input"
            aria-label={t('session.nameLabel')}
            aria-invalid={dialog.error ? 'true' : undefined}
            title={dialog.error || undefined}
            maxLength={120}
            autoComplete="off"
            autoFocus
            disabled={dialog.saving}
            value={dialog.value}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => controller.setDialogValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              controller.cancelDialog();
            }}
          />
          <button
            type="submit"
            aria-label={t('session.saveName')}
            disabled={dialog.saving || !dialog.value.trim()}
          >
            ✓
          </button>
        </form>
        {dialog.error ? (
          <p className="session-rename-error" role="alert">
            {dialog.error}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className={`session-row${label ? ' has-status' : ''}`}>
      <button
        type="button"
        className={`session-item${selected ? ' selected' : ''}`}
        data-session-id={item.id}
        disabled={state.blocked}
        title={sessionTooltip(item, activity)}
        aria-current={selected ? 'true' : 'false'}
        onClick={() => void controller.selectSession(item.id)}
      >
        <strong translate="no">{sessionTitle(item)}</strong>
        <small
          title={new Date(item.createdAt).toLocaleString(locale(), {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        >
          {sessionAge(item.createdAt, locale())}
        </small>
        {activity?.running || activity?.waiting ? (
          <span
            className={`session-status ${activity.waiting ? 'waiting' : 'running'}`}
            role="img"
            aria-label={label}
          >
            {activity.waiting ? WAITING_ICON : <span className="session-spinner" />}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="session-more"
        data-menu-session-id={item.id}
        disabled={state.blocked}
        aria-label={`${t('session.actions')}: ${item.title || item.id.slice(0, 8)}`}
        aria-haspopup="menu"
        aria-controls="session-menu"
        aria-expanded={state.menuSessionId === item.id}
        onMouseEnter={(event) => onMenu(event.currentTarget, item.id)}
        onMouseLeave={() => onMenuLeave()}
        onClick={(event) => onMenu(event.currentTarget, item.id)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          onMenuKeyboard(event.currentTarget, item.id);
        }}
      >
        {MORE_ICON}
      </button>
    </div>
  );
}
