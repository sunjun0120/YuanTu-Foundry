/**
 * The workspace maintenance settings page: archived sessions, and the retained workspaces of deleted sessions.
 *
 * Both lists live here because they are one page and one refresh. The retained section stays hidden while there is
 * nothing to retain and no failure to report — most projects never leave a directory behind — which is why the page
 * opens on just the archived list.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { locale, t } from '../../i18n.ts';
import { carrierErrorText } from '../../carrier-errors.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { ArchivedSessions } from '../sessions/ArchivedSessions.tsx';
import type { OrphanItem, WorkspaceSettingsController } from './workspace-settings-model.ts';

function OrphanRow({
  item,
  controller,
  blocked,
  pending,
  confirmation,
}: {
  item: OrphanItem;
  controller: WorkspaceSettingsController;
  blocked: boolean;
  pending: boolean;
  confirmation: string | null;
}): ReactNode {
  const state = item.binding.state;
  const action: 'archive' | 'remove' | 'restore' =
    state === 'removed' ? 'restore' : state === 'archived' ? 'remove' : 'archive';
  const actionable = ['ready', 'blocked', 'archived', 'removed'].includes(state);
  const confirming = confirmation === item.binding.id && action === 'remove';
  const restore =
    ['blocked', 'archived'].includes(state) || (item.problems.length > 0 && state === 'ready');
  return (
    <li className="workspace-maintenance-item" data-binding-id={item.binding.id} data-state={state}>
      <strong translate="no">{item.binding.executionRoot}</strong>
      <small>
        {t(`orphans.state.${state}`)} · {t('orphans.results', { count: item.results.length })}
      </small>
      {item.problems.map((problem) => (
        <p key={problem} translate="no">
          {problem}
        </p>
      ))}
      <div>
        <button
          type="button"
          className="secondary"
          data-action={action}
          disabled={blocked || pending || !actionable}
          onClick={() => controller.act(item.binding.id, action)}
        >
          {confirming ? t('orphans.confirmRemove') : t(`subagent.workspace.action.${action}`)}
        </button>
        {restore ? (
          <button
            type="button"
            className="secondary"
            data-action="restore"
            disabled={blocked || pending}
            onClick={() => controller.act(item.binding.id, 'restore')}
          >
            {t('subagent.workspace.action.restore')}
          </button>
        ) : null}
        {confirming ? (
          <button
            type="button"
            className="secondary"
            data-action="cancel"
            disabled={pending}
            onClick={() => controller.cancelOrphan()}
          >
            {t('orphans.cancel')}
          </button>
        ) : null}
      </div>
      {confirming ? <p>{t('subagent.workspace.removeConfirm')}</p> : null}
    </li>
  );
}

export function WorkspaceMaintenance({
  controller,
}: {
  controller: WorkspaceSettingsController;
}): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const orphans = state.orphans;
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!orphans.confirmation) return;
    list.current
      ?.querySelector<HTMLButtonElement>(
        `[data-binding-id="${CSS.escape(orphans.confirmation)}"] [data-action="cancel"]`,
      )
      ?.focus();
  }, [orphans.confirmation]);
  const failureText = orphans.failure ? carrierErrorText(orphans.failure, locale()) : '';
  const feedback =
    failureText ||
    (orphans.pending
      ? t('orphans.loading')
      : orphans.items?.length === 0
        ? t('orphans.empty')
        : '');
  const showSection = orphans.failure !== null || (orphans.items?.length ?? 0) > 0;
  return (
    <>
      <div className="settings-page-header">
        <h2 id="archived-sessions-title">{t('archived.title')}</h2>
        <p id="archived-sessions-note">{t('archived.note')}</p>
      </div>
      <div className="workspace-maintenance-body">
        <button
          id="workspace-maintenance-refresh"
          type="button"
          className="secondary"
          disabled={orphans.pending || state.archived.pending || !state.workspace}
          onClick={() => controller.refresh()}
        >
          {t('orphans.refresh')}
        </button>
        <ArchivedSessions controller={controller} />
        <section
          id="workspace-maintenance-section"
          className="workspace-maintenance-section"
          aria-labelledby="workspace-maintenance-title"
          hidden={!showSection}
        >
          <h3 id="workspace-maintenance-title">{t('orphans.title')}</h3>
          <p id="workspace-maintenance-note">{t('orphans.note')}</p>
          <p
            id="workspace-maintenance-feedback"
            role="status"
            aria-live="polite"
            className={orphans.failure ? 'error' : undefined}
          >
            {feedback}
          </p>
          <ul id="workspace-maintenance-list" className="workspace-maintenance-list" ref={list}>
            {(orphans.items ?? []).map((item) => (
              <OrphanRow
                key={item.binding.id}
                item={item}
                controller={controller}
                blocked={state.blocked}
                pending={orphans.pending}
                confirmation={orphans.confirmation}
              />
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
