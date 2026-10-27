import { chrome } from '../chrome.ts';
import { PageTransition } from '../transitions.tsx';
import { useLayoutEffect, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { navigation } from '../navigation.ts';
import { ViewSlot } from '../views.tsx';
import { PanelSlot } from '../slots.tsx';
import { DesktopShell } from './DesktopShell.tsx';
import { ModelPicker } from '../settings/ModelPicker.tsx';
import { modelPicker } from '../settings/model-picker-state.ts';

/** Product chrome is owned by React. Child panel containers remain stable across navigation. */
export function ProductShell(): ReactNode {
  useLocale();
  const view = useReadable(navigation);
  const status = useReadable(chrome);
  const picker = useReadable(modelPicker);
  useLayoutEffect(() => {
    document.body.dataset.page = view.page;
    if (view.page === 'chat')
      document.getElementById('conversation')?.scrollTo({ top: view.chatScroll });
  }, [view.page, view.chatScroll]);
  return (
    <>
      <DesktopShell
        navbarWidth={272}
        asideWidth={view.workspaceWidth}
        asideVisible={view.workspaceOpen && view.page === 'chat'}
        navbar={
          <>
            <aside id="chat-sidebar" className="sidebar chat-sidebar" hidden={view.page !== 'chat'}>
              <div className="brand">
                <div className="brand-logo" role="img" aria-label={t('ui.appName')}>
                  <img className="logo-light" src="./img/logo-light.png" alt="" />
                  <img className="logo-dark" src="./img/logo-dark.png" alt="" />
                </div>
              </div>
              <button id="new-session" className="new-session" disabled={!status.canCreate}>
                <span aria-hidden="true">＋</span> {t('ui.newSession')}
              </button>
              <div className="workspace-box">
                <div className="section-label">{t('ui.workspace')}</div>
                <div id="workspace" title={status.workspace} className="workspace" translate="no">
                  {status.workspace}
                </div>
                <button
                  id="choose-workspace"
                  className="text-button choose-workspace"
                  disabled={!status.canChangeWorkspace}
                >
                  {t('ui.changeFolder')}
                  <span aria-hidden="true">↗</span>
                </button>
              </div>
              <div id="session-sidebar-root" className="session-sidebar-root">
                <ViewSlot name="session-sidebar" />
              </div>
              <div className="sidebar-footer">
                <button
                  id="open-settings"
                  className="settings-entry"
                  type="button"
                  disabled={picker.locked}
                >
                  <span aria-hidden="true">⚙</span>
                  <span id="settings-label">{t('ui.settings')}</span>
                </button>
              </div>
            </aside>
            <aside className="settings-sidebar" hidden={view.page !== 'settings'}>
              <button
                id="settings-back"
                className="settings-back"
                type="button"
                disabled={picker.locked}
              >
                <span aria-hidden="true">←</span>
                {t('ui.backToChat')}
              </button>
              <h1>{t('ui.settings')}</h1>
              <nav aria-label={t('shell.settingsMenu')}>
                <button
                  id="general-settings"
                  type="button"
                  aria-current={view.panel === 'general-settings-content' ? 'page' : undefined}
                >
                  <span aria-hidden="true">
                    <svg
                      className="settings-nav-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      focusable="false"
                    >
                      <path d="M4 7h7m6 0h3M4 17h3m6 0h7"></path>
                      <circle cx="14" cy="7" r="3"></circle>
                      <circle cx="10" cy="17" r="3"></circle>
                    </svg>
                  </span>
                  {t('ui.general')}
                </button>
                <button
                  id="model-settings"
                  type="button"
                  aria-current={view.panel === 'model-settings-content' ? 'page' : undefined}
                >
                  <span aria-hidden="true">
                    <svg
                      className="settings-nav-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      focusable="false"
                    >
                      <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                      <path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"></path>
                      <rect x="9" y="9" width="6" height="6" rx="1"></rect>
                    </svg>
                  </span>
                  {t('ui.models')}
                </button>
                <button id="workspace-maintenance-settings" type="button" hidden>
                  <span aria-hidden="true">
                    <svg
                      className="settings-nav-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                    >
                      <rect x="3" y="4" width="18" height="5" rx="1"></rect>
                      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"></path>
                    </svg>
                  </span>
                  <span id="workspace-maintenance-label" className="workspace-maintenance-label">
                    {t('archived.title')}
                  </span>
                </button>
              </nav>
            </aside>
          </>
        }
        main={
          <>
            <PageTransition
              viewKey="chat-page"
              kind="page"
              active={view.page === 'chat'}
              focusId="open-settings"
              id="chat-page"
              className="chat-page"
            >
              <header>
                <div className="chat-heading">
                  <strong
                    id="chat-title"
                    title={status.title}
                    className="chat-title"
                    translate="no"
                  >
                    {status.title}
                  </strong>
                  <span
                    id="chat-breadcrumb-sep"
                    className="chat-breadcrumb-sep"
                    aria-hidden="true"
                    hidden
                  >
                    /
                  </span>
                  <strong
                    id="subagent-transcript-title"
                    className="chat-breadcrumb-child"
                    translate="no"
                    hidden
                  ></strong>
                  <div className="subagent-anchor">
                    <button
                      id="open-subagents"
                      className="open-subagents"
                      type="button"
                      aria-expanded="false"
                      aria-controls="subagents-popover"
                      hidden
                    >
                      <span
                        id="subagents-pulse"
                        className="subagent-pulse"
                        aria-hidden="true"
                        hidden
                      ></span>
                      <span id="subagents-label">{t('subagent.title')}</span>
                    </button>
                    <section
                      id="subagents-popover"
                      className="subagents-popover"
                      aria-label={t('subagent.title')}
                      hidden
                    >
                      <div
                        id="subagent-catalog"
                        className="subagent-catalog"
                        role="tree"
                        aria-label={t('subagent.catalogLabel')}
                      >
                        <ViewSlot name="subagents-catalog" />
                      </div>
                    </section>
                  </div>
                  <div id="background-root">
                    <ViewSlot name="background" />
                  </div>
                </div>
                <div className="workspace-anchor">
                  <button
                    id="open-workspace"
                    className="open-workspace"
                    type="button"
                    aria-expanded="false"
                    aria-controls="workspace-panel"
                    aria-label={t('workspace.title')}
                    title={t('workspace.openTitle')}
                  >
                    {t('workspace.open')}
                  </button>
                </div>
              </header>
              <div
                id="error"
                title={status.errorTitle}
                className="error-banner"
                role="alert"
                hidden={!status.errorVisible}
              >
                <span id="error-text">{status.errorText}</span>
                <button
                  id="error-action"
                  data-action={status.errorAction ?? undefined}
                  disabled={status.errorActionDisabled}
                  type="button"
                  className="text-button error-action"
                  hidden={!status.errorAction}
                >
                  {status.errorActionText}
                </button>
                <span id="error-note" className="error-note" role="status">
                  {status.errorNote}
                </span>
              </div>
              <div id="notice" className="notice-banner" role="status" hidden={!status.notice}>
                {status.notice}
              </div>
              <div id="configuration" className="configuration" hidden={!status.configVisible}>
                {t('ui.noModelConfigured')}
              </div>
              <section
                id="conversation"
                className="conversation"
                aria-label={t('ui.conversation')}
                tabIndex={0}
              >
                <div id="welcome" hidden={!status.welcomeVisible} className="welcome">
                  <div className="eyebrow">{t('ui.welcomeEyebrow')}</div>
                  <h1>{t('ui.welcomeStart')}</h1>
                  <p>{t('ui.welcomeSubtitle')}</p>
                  <div className="suggestions">
                    <button data-prompt={t('shell.explorePrompt')}>
                      <span>01</span>
                      <strong>{t('ui.exploreProject')}</strong>
                      <small>{t('ui.learnFolders')}</small>
                    </button>
                    <button data-prompt={t('shell.runPrompt')}>
                      <span>02</span>
                      <strong>{t('ui.findHowToRun')}</strong>
                      <small>{t('ui.startWithGuide')}</small>
                    </button>
                  </div>
                </div>
                <div id="plan-root">
                  <ViewSlot name="plan" />
                </div>
                <section
                  id="subagents-panel"
                  className="subagents-panel"
                  aria-label={t('subagent.title')}
                  hidden
                >
                  <div className="subagents-panel-header">
                    <h2>{t('subagent.title')}</h2>
                  </div>
                  <div id="subagent-list" className="subagent-list">
                    <ViewSlot name="subagents-list" />
                  </div>
                </section>
                <section
                  id="tasks-panel"
                  className="tasks-panel"
                  aria-label={t('shell.taskProgress')}
                  hidden
                >
                  <div className="tasks-panel-header">
                    <h2>{t('shell.taskLoop')}</h2>
                    <button id="refresh-tasks" type="button" className="text-button">
                      {t('workspace.refresh')}
                    </button>
                  </div>
                  <div id="task-list" className="task-list">
                    <ViewSlot name="tasks" />
                  </div>
                </section>
                <button
                  id="load-older-history"
                  disabled={status.olderDisabled}
                  type="button"
                  className="text-button"
                  hidden={!status.olderVisible}
                >
                  {status.olderText}
                </button>
                <div id="messages">
                  <ViewSlot name="transcript" />
                </div>
                <section
                  id="subagent-transcript"
                  className="subagent-page subagent-transcript"
                  aria-label={t('subagent.pageLabel')}
                  hidden
                >
                  <div id="subagent-transcript-root">
                    <ViewSlot name="subagents-page" />
                  </div>
                </section>
                <div id="live" className="message assistant" hidden>
                  <ViewSlot name="live-message" />
                </div>
                <div id="tools" className="tool-progress" hidden></div>
                <div id="goal-root">
                  <ViewSlot name="goal-root" />
                </div>
                {/*
                 * Off for now: the session's deliverable list is drawn at the tail of the transcript, where the newest
                 * turn reads it as that turn's output. The files are still recorded (`deliverable.presented`); the
                 * panel comes back by dropping this attribute once its placement is settled.
                 */}
                <div id="deliverables-root" hidden>
                  <ViewSlot name="deliverables-root" />
                </div>
                <div id="approvals" aria-label={t('ui.pendingApprovals')}>
                  <ViewSlot name="approvals" />
                </div>
                <div id="questions" className="questions" aria-label={t('ui.questionLabel')}>
                  <ViewSlot name="questions" />
                </div>
              </section>
              <button
                id="jump-to-latest"
                className="jump-to-latest"
                type="button"
                aria-label={t('ui.jumpToLatest')}
                title={t('ui.jumpToLatest')}
                hidden={!status.jumpVisible}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="m5 9 7 7 7-7"></path>
                </svg>
              </button>
              <footer className="composer-area">
                <div className="run-status">
                  <span id="run-status" role="status">
                    {status.runStatus || t('shell.connecting')}
                  </span>
                </div>
                <div id="todos-root">
                  <ViewSlot name="todos-root" />
                </div>
                <div id="sandbox-prompt-root">
                  <ViewSlot name="sandbox-prompt" />
                </div>
                <PanelSlot name="composer.above" />
                <form id="composer" className="composer">
                  <div id="attachments-root">
                    <ViewSlot name="attachments" />
                  </div>
                  <div id="command-menu-root">
                    <ViewSlot name="command-palette" />
                  </div>
                  <textarea
                    id="prompt"
                    className="prompt"
                    aria-label={t('ui.taskDescription')}
                    placeholder={t('ui.promptPlaceholder')}
                    rows={2}
                    maxLength={100000}
                    disabled={status.promptDisabled}
                  ></textarea>
                  <div className="composer-bottom">
                    <input id="image-input" type="file" multiple hidden />
                    <button
                      type="button"
                      id="attach-image"
                      disabled={status.attachDisabled}
                      className="secondary attach-image"
                      aria-label={t('ui.addAttachment')}
                      title={t('ui.addAttachment')}
                    >
                      +
                    </button>
                    <div id="permission-root" className="permission-root">
                      <ViewSlot name="permission-chip" />
                    </div>
                    <div className="chat-model">
                      <label htmlFor="model">{t('ui.model')}</label>
                      <ModelPicker />
                    </div>
                    <button
                      id="send"
                      type="submit"
                      className="primary send"
                      aria-label={status.sendLabel || t('ui.send')}
                      title={status.sendLabel || t('ui.send')}
                      data-mode={status.sendMode}
                      disabled={status.sendDisabled}
                    >
                      <svg
                        className="send-arrow"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M12 19V5m-6 6 6-6 6 6"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        ></path>
                      </svg>
                      <svg
                        className="send-stop"
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        aria-hidden="true"
                      >
                        <rect width="12" height="12" rx="2" fill="currentColor"></rect>
                      </svg>
                    </button>
                  </div>
                </form>
                <div
                  id="composer-statistics"
                  className="composer-statistics"
                  aria-label={t('ui.sessionUsage')}
                >
                  <ViewSlot name="statistics" />
                </div>
                <div id="queue" className="queue-status" aria-live="polite">
                  {status.queueText}
                </div>
                <button
                  type="button"
                  id="clear-queue"
                  disabled={status.queueDisabled}
                  className="text-button"
                  hidden={!status.queueVisible}
                >
                  {t('ui.clearQueue')}
                </button>
              </footer>
            </PageTransition>
            <PageTransition
              viewKey="settings-page"
              kind="page"
              active={view.page === 'settings'}
              focusId="settings-back"
              id="settings-page"
              className="settings-page"
              aria-label={t('shell.settingsPage')}
            >
              <PageTransition
                viewKey="workspace-maintenance-content"
                kind="settings"
                active={view.page === 'settings' && view.panel === 'workspace-maintenance-content'}
                id="workspace-maintenance-content"
                className="settings-content"
                aria-labelledby="archived-sessions-title"
              >
                <ViewSlot name="workspace-settings" />
              </PageTransition>
              <PageTransition
                viewKey="general-settings-content"
                kind="settings"
                active={view.page === 'settings' && view.panel === 'general-settings-content'}
                id="general-settings-content"
                className="settings-content"
                aria-labelledby="general-settings-title"
              >
                <ViewSlot name="general-settings" />
              </PageTransition>
              <PageTransition
                viewKey="model-settings-content"
                kind="settings"
                active={view.page === 'settings' && view.panel === 'model-settings-content'}
                id="model-settings-content"
                className="settings-content"
                aria-labelledby="settings-title"
              >
                <ViewSlot name="model-settings" />
              </PageTransition>
            </PageTransition>
          </>
        }
        aside={
          <div id="workspace-root" className="workspace-root">
            <PanelSlot name="sidebar.right" />
          </div>
        }
      />
      <ViewSlot name="turn-changes" />
      <div id="session-dialog-root">
        <ViewSlot name="session-dialog" />
      </div>
      <div id="full-access-root" className="full-access-root">
        <ViewSlot name="permission-dialog" />
      </div>
    </>
  );
}
