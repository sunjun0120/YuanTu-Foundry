import { Modal } from '@mantine/core';
import { AssetIcon } from '../icons/AssetIcon.tsx';
import { usePrefersReducedMotion } from '../reduced-motion.ts';
import { EASING_CSS, MOTION } from '../motion-tokens.ts';
import { chrome } from '../chrome.ts';
import { PageTransition } from '../transitions.tsx';
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { navigation } from '../navigation.ts';
import { ViewSlot } from '../views.tsx';
import { PanelSlot } from '../slots.tsx';
import { DesktopShell } from './DesktopShell.tsx';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useSidebarWidth } from './sidebar-resize.ts';
import { ModelPicker } from '../settings/ModelPicker.tsx';
import { modelPicker } from '../settings/model-picker-state.ts';
import { ProjectSidebar } from '../projects/ProjectSidebar.tsx';
import { SidebarTooltip } from '../icons/SidebarTooltip.tsx';
import { OrganicLogo } from '../welcome/OrganicLogo.tsx';

/** Product chrome is owned by React. Child panel containers remain stable across navigation. */
export function ProductShell(): ReactNode {
  useLocale();
  const view = useReadable(navigation);
  const status = useReadable(chrome);
  const picker = useReadable(modelPicker);
  const reduced = usePrefersReducedMotion();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebar = useSidebarWidth();
  const sidebarWidth = sidebarCollapsed ? 56 : sidebar.width;
  // The workspace panel sizes itself against what the sidebar leaves of the window.
  useEffect(() => {
    if (navigation.getSnapshot().sidebarWidth !== sidebarWidth)
      navigation.set({ ...navigation.getSnapshot(), sidebarWidth });
  }, [sidebarWidth]);
  const closeSettings = (): void => {
    document.getElementById('settings-back')?.click();
  };
  useLayoutEffect(() => {
    document.body.dataset.page = view.page;
    if (view.page === 'chat')
      document.getElementById('conversation')?.scrollTo({ top: view.chatScroll });
  }, [view.page, view.chatScroll]);
  return (
    <>
      <DesktopShell
        navbarWidth={sidebarWidth}
        asideWidth={view.workspaceWidth}
        asideVisible={view.workspaceOpen && view.page === 'chat'}
        asideExpanded={view.workspaceFullscreen}
        navbar={
          <>
            <aside
              id="chat-sidebar"
              className="sidebar chat-sidebar"
              data-collapsed={sidebarCollapsed}
              inert={view.page !== 'chat'}
            >
              <div className="brand">
                <div className="brand-logo" role="img" aria-label={t('ui.brandName')}>
                  <img className="brand-mark" src="./assets/icons/brand-sidebar.svg" alt="" />
                  <span className="brand-name" aria-hidden="true">
                    {t('ui.brandName')}
                  </span>
                </div>
                <button
                  id="toggle-sidebar"
                  type="button"
                  className="sidebar-toggle"
                  aria-label={t(sidebarCollapsed ? 'ui.expandSidebar' : 'ui.collapseSidebar')}
                  data-sidebar-tooltip={t(
                    sidebarCollapsed ? 'ui.expandSidebar' : 'ui.collapseSidebar',
                  )}
                  aria-expanded={!sidebarCollapsed}
                  aria-controls="sidebar-content"
                  onClick={() => setSidebarCollapsed((value) => !value)}
                >
                  <AssetIcon name="sidebar-collapse" />
                </button>
              </div>
              <button
                id="new-session"
                className="new-session"
                aria-label={t('ui.newTask')}
                data-sidebar-tooltip={sidebarCollapsed ? t('ui.newTask') : undefined}
                disabled={!status.canCreate}
              >
                <AssetIcon name="new-task" />{' '}
                <span className="new-session-label">{t('ui.newTask')}</span>
              </button>

              <div id="sidebar-content" className="sidebar-content">
                <ProjectSidebar
                  collapsed={sidebarCollapsed}
                  canChange={status.canSelectProject}
                  legacyCanChange={status.canChangeWorkspace}
                />
              </div>
              <div
                id="sidebar-resize"
                className="sidebar-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('ui.resizeSidebar')}
                aria-valuemin={SIDEBAR_MIN_WIDTH}
                aria-valuemax={SIDEBAR_MAX_WIDTH}
                aria-valuenow={sidebar.width}
                tabIndex={0}
                hidden={sidebarCollapsed}
                onPointerDown={sidebar.startDrag}
                onKeyDown={sidebar.onKeyDown}
              />
              <div className="sidebar-footer">
                <button
                  id="open-settings"
                  className="settings-entry"
                  type="button"
                  aria-label={t('ui.settings')}
                  data-sidebar-tooltip={sidebarCollapsed ? t('ui.settings') : undefined}
                  disabled={picker.locked}
                >
                  <AssetIcon name="settings" />
                  <span id="settings-label" className="settings-label">
                    {t('ui.settings')}
                  </span>
                </button>
              </div>
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
              className={status.welcomeVisible ? 'chat-page chat-page-home' : 'chat-page'}
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
                <div id="welcome" hidden={!status.welcomeVisible} className="welcome">
                  <h1 className="welcome-brand">
                    <span className="welcome-icon">
                      {status.welcomeVisible && view.page === 'chat' && <OrganicLogo />}
                    </span>
                    <span>{t('ui.brandName')}</span>
                  </h1>
                </div>
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
                    placeholder={t(
                      status.welcomeVisible ? 'ui.newTaskPlaceholder' : 'ui.promptPlaceholder',
                    )}
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
                      <AssetIcon name="attach" size={20} />
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
            {/* Keep hosts mounted synchronously for the existing controller bindings. The shell owns scrolling. */}
            <Modal
              opened={view.page === 'settings'}
              onClose={closeSettings}
              keepMounted
              keepMountedMode="display-none"
              withinPortal={false}
              lockScroll={false}
              centered
              withCloseButton={false}
              closeOnEscape={!picker.locked}
              closeOnClickOutside={!picker.locked}
              trapFocus
              returnFocus
              padding={0}
              size="1080px"
              classNames={{
                content: 'settings-dialog',
                inner: 'settings-dialog-inner',
                body: 'settings-dialog-body',
                overlay: 'settings-dialog-overlay',
              }}
              overlayProps={{ backgroundOpacity: 0.28, blur: 4 }}
              transitionProps={{
                transition: 'fade',
                duration: reduced ? 0 : MOTION.modal.enter,
                exitDuration: reduced ? 0 : MOTION.modal.exit,
                timingFunction: EASING_CSS,
              }}
              aria-label={t('shell.settingsPage')}
            >
              <div id="settings-page" className="settings-page">
                <aside className="settings-sidebar">
                  <h1>{t('ui.settings')}</h1>
                  <nav aria-label={t('shell.settingsMenu')}>
                    <button
                      id="general-settings"
                      type="button"
                      aria-current={view.panel === 'general-settings-content' ? 'page' : undefined}
                    >
                      <AssetIcon name="sliders-horizontal" size={17} />
                      {t('ui.general')}
                    </button>
                    <button
                      id="model-settings"
                      type="button"
                      aria-current={view.panel === 'model-settings-content' ? 'page' : undefined}
                    >
                      <AssetIcon name="cpu" size={17} />
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
                      <span
                        id="workspace-maintenance-label"
                        className="workspace-maintenance-label"
                      >
                        {t('archived.title')}
                      </span>
                    </button>
                  </nav>
                </aside>
                <div className="settings-main">
                  <button
                    id="settings-back"
                    type="button"
                    className="settings-close"
                    disabled={picker.locked}
                    aria-label={t('ui.backToChat')}
                    title={t('ui.backToChat')}
                    data-autofocus
                  >
                    <AssetIcon name="x" size={20} />
                  </button>
                  <PageTransition
                    viewKey="workspace-maintenance-content"
                    kind="settings"
                    active={
                      view.page === 'settings' && view.panel === 'workspace-maintenance-content'
                    }
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
                </div>
              </div>
            </Modal>
          </>
        }
        aside={
          <div id="workspace-root" className="workspace-root">
            <PanelSlot name="sidebar.right" />
          </div>
        }
      />
      <ViewSlot name="turn-changes" />
      <SidebarTooltip />
      <div id="session-dialog-root">
        <ViewSlot name="session-dialog" />
      </div>
      <div id="full-access-root" className="full-access-root">
        <ViewSlot name="permission-dialog" />
      </div>
    </>
  );
}
