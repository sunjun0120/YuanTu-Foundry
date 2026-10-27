/**
 * The read-only workspace panel: tabs, a tree or one file, and the width/fullscreen controls around them.
 *
 * The reads and identity rules are in `workspace-model.ts`; this component draws them. Two behaviours are inherited
 * from the legacy panel because the smoke pins them: the width is draggable **and** keyboard-resizable (Home is the
 * minimum, arrows step by 24px, dragging left widens), and Escape steps back — fullscreen, then the file, then the
 * panel — rather than closing everything at once.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import type { MarkdownActions } from '../../markdown.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { navigation } from '../navigation.ts';
import { BrowserPane } from './BrowserPane.tsx';
import { FilePreview } from './FilePreview.tsx';
import { FileTree } from './FileTree.tsx';
import { Icon } from './Icon.tsx';
import { fileName, type WorkspaceController } from './workspace-model.ts';

const STEP = 24;
/** The reading column never drops below this while there is room for it: the composer's readings stay on one line. */
const MIN_CHAT_WIDTH = 620;

function widthLimits(viewportWidth: number): { min: number; max: number } {
  // At the window's minimum size the panel has to shrink with it; above that the chat column wins the space it needs.
  const minChat = Math.max(320, Math.min(MIN_CHAT_WIDTH, viewportWidth - 272 - 280));
  const available = Math.max(0, viewportWidth - 272 - minChat);
  // A narrow window leaves less than the normal minimum for the panel; it may still grow from a smaller floor.
  const minPanel = available < 320 ? Math.min(180, available) : 320;
  return { min: minPanel, max: available };
}

export function WorkspacePanel({
  controller,
  markdownActions,
}: {
  controller: WorkspaceController;
  markdownActions: MarkdownActions;
}): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const [width, setWidth] = useState(() => Math.min(560, window.innerWidth * 0.42));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [tooltip, setTooltip] = useState<{ text: string; left: number; top: number } | null>(null);
  const [newTabError, setNewTabError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const previewBody = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    width: number;
    pointerId: number;
    element: HTMLElement;
  } | null>(null);
  // The scroll of a tab is captured before leaving it: programmatic scroll events can land after the click that
  // switched tabs, and a preview that was already replaced cannot report where it was.
  const rememberScroll = (): void => {
    if (selected !== null && previewBody.current)
      controller.setTabScroll(selected, previewBody.current.scrollTop);
  };

  // The chat column's minimum is a function of the window width, so a resize has to re-run the clamp.
  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const limits = widthLimits(viewportWidth);
  const actualWidth = Math.round(Math.min(limits.max, Math.max(limits.min, width)));
  const fullscreen = state.fullscreen;
  const selected = state.selected;
  const tab = selected === null ? undefined : state.tabs.get(selected);

  useEffect(() => {
    navigation.set({
      ...navigation.getSnapshot(),
      workspaceOpen: state.open,
      workspaceFullscreen: fullscreen,
      workspaceWidth: actualWidth,
    });
    document.body.style.setProperty('--workspace-width', `${actualWidth}px`);
  }, [actualWidth, state.open, fullscreen]);

  useEffect(() => {
    document.body.dataset.workspaceView = !state.open
      ? 'closed'
      : fullscreen
        ? 'fullscreen'
        : 'open';
    document.getElementById('open-workspace')?.setAttribute('aria-expanded', String(state.open));
    document.getElementById('chat-page')!.inert = fullscreen;
    document.getElementById('chat-sidebar')!.inert = fullscreen;
    const element = panel.current;
    if (!element) return;
    if (fullscreen) {
      element.setAttribute('role', 'dialog');
      element.setAttribute('aria-modal', 'true');
    } else {
      element.removeAttribute('role');
      element.removeAttribute('aria-modal');
    }
  }, [state.open, fullscreen, actualWidth]);

  // A newly opened file is scrolled into the tab strip; tabs are compact, and the row shares its width first.
  useLayoutEffect(() => {
    const element = strip.current;
    const active = element?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!element || !active) return;
    const tabBounds = active.getBoundingClientRect();
    const stripBounds = element.getBoundingClientRect();
    if (tabBounds.right > stripBounds.right)
      element.scrollLeft += tabBounds.right - stripBounds.right;
    else if (tabBounds.left < stripBounds.left)
      element.scrollLeft -= stripBounds.left - tabBounds.left;
    // A label can settle one frame later (font metrics, a late icon); re-align once after layout.
    const frame = requestAnimationFrame(() => {
      const lateTab = active.getBoundingClientRect();
      const lateStrip = element.getBoundingClientRect();
      if (lateTab.right > lateStrip.right) element.scrollLeft += lateTab.right - lateStrip.right;
      else if (lateTab.left < lateStrip.left) element.scrollLeft -= lateStrip.left - lateTab.left;
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, state.tabs]);

  // The reading pane keeps the scroll each tab was left at; the content effect runs before this one.
  useLayoutEffect(() => {
    const body = previewBody.current;
    if (!body) return;
    body.scrollTop = tab?.scrollTop ?? 0;
  }, [selected, tab?.shown, tab?.changePreview, tab?.reading, tab?.scrollTop]);

  const endDrag = useCallback(() => {
    const start = drag.current;
    if (start) {
      document.body.classList.remove('workspace-resizing');
      if (start.element.hasPointerCapture?.(start.pointerId))
        start.element.releasePointerCapture(start.pointerId);
    }
    drag.current = null;
  }, []);
  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const start = drag.current;
      if (!start) return;
      setWidth(start.width - (event.clientX - start.x));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, [endDrag]);

  useEffect(() => {
    if (!fullscreen) return;
    const onSettings = (): void => controller.setFullscreen(false);
    window.addEventListener('yuantu-settings-open', onSettings);
    return () => window.removeEventListener('yuantu-settings-open', onSettings);
  }, [fullscreen, controller]);

  const showHint = (target: EventTarget | null): void => {
    if (!(target instanceof Element)) return;
    const control = target.closest<HTMLElement>('[data-tooltip]');
    if (!control || (control instanceof HTMLButtonElement && control.disabled)) return;
    const label = control.dataset.tooltip ?? '';
    if (!label) return;
    const bounds = control.getBoundingClientRect();
    setTooltip({
      text: label,
      left: Math.max(8, Math.min(window.innerWidth - 200, bounds.right - 40)),
      top: Math.min(window.innerHeight - 40, bounds.bottom + 8),
    });
  };

  const active = state.active;
  const activeBrowser = active.kind === 'browser' ? state.browserTabs.get(active.id) : undefined;
  const separator = workspacePath(selected, state.workspace);
  const projectName = workspaceName(state.workspace);
  const tabs: ReactNode[] = [
    <button
      key="new"
      id="workspace-new-tab"
      type="button"
      role="tab"
      aria-controls="workspace-new-tab-page"
      aria-selected={active.kind === 'new'}
      tabIndex={active.kind === 'new' ? 0 : -1}
      className="workspace-tab"
      onClick={() => {
        rememberScroll();
        controller.openNewTab();
      }}
    >
      <Icon kind="plus" />
      <span>{t('workspace.newTab')}</span>
    </button>,
    <button
      key="tree"
      id="workspace-tree-tab"
      type="button"
      role="tab"
      aria-controls="workspace-tree"
      aria-selected={active.kind === 'files'}
      tabIndex={active.kind === 'files' ? 0 : -1}
      className="workspace-tab"
      onClick={() => {
        rememberScroll();
        controller.openFiles();
      }}
    >
      <Icon kind="folder" />
      <span>{t('workspace.open')}</span>
    </button>,
  ];
  for (const path of state.tabOrder) {
    const file = state.tabs.get(path);
    if (!file) continue;
    const isActive = active.kind === 'file' && active.path === path;
    tabs.push(
      <div
        key={file.path}
        className={`workspace-file-tab${isActive ? ' active' : ''}`}
        data-path={file.path}
      >
        <button
          type="button"
          role="tab"
          aria-controls="workspace-preview"
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          title={file.path}
          translate="no"
          className="workspace-tab"
          onClick={() => {
            rememberScroll();
            controller.activate(file.path);
          }}
        >
          <Icon kind={/\.(?:md|markdown|mdown)$/i.test(file.path) ? 'markdown' : 'file'} />
          <span>{fileName(file.path)}</span>
        </button>
        <button
          type="button"
          className="workspace-tab-close"
          aria-label={t('workspace.closeTab', { name: fileName(file.path) })}
          data-tooltip={t('workspace.closeTab', { name: fileName(file.path) })}
          onClick={() => {
            rememberScroll();
            controller.closeTab(file.path);
          }}
        >
          <Icon kind="close" />
        </button>
      </div>,
    );
  }
  for (const id of state.browserOrder) {
    const browser = state.browserTabs.get(id);
    if (!browser) continue;
    const isActive = active.kind === 'browser' && active.id === id;
    tabs.push(
      <div
        key={id}
        className={`workspace-file-tab workspace-browser-tab${isActive ? ' active' : ''}`}
        data-browser-tab={id}
      >
        <button
          type="button"
          role="tab"
          aria-controls={`browser-${id}`}
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          title={browser.url || t('browser.untitled')}
          className="workspace-tab"
          onClick={() => {
            rememberScroll();
            controller.activateBrowser(id);
          }}
        >
          <Icon kind="globe" />
          <span>{browser.title || t('browser.untitled')}</span>
        </button>
        <button
          type="button"
          className="workspace-tab-close"
          aria-label={t('workspace.closeTab', { name: browser.title || t('browser.untitled') })}
          data-tooltip={t('workspace.closeTab', { name: browser.title || t('browser.untitled') })}
          onClick={() => {
            rememberScroll();
            controller.closeBrowserTab(id);
          }}
        >
          <Icon kind="close" />
        </button>
      </div>,
    );
  }

  return (
    <>
      <aside
        ref={panel}
        id="workspace-panel"
        className="workspace-panel"
        aria-label={t('workspace.title')}
        hidden={!state.open}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          event.preventDefault();
          if (fullscreen) controller.setFullscreen(false);
          else if (active.kind === 'file') {
            rememberScroll();
            controller.openNewTab();
          } else {
            controller.setOpen(false);
            document.getElementById('open-workspace')?.focus();
          }
        }}
        onPointerOver={(event) => showHint(event.target)}
        onPointerOut={() => setTooltip(null)}
        onFocusCapture={(event) => showHint(event.target)}
        onBlurCapture={() => setTooltip(null)}
        onClick={() => setTooltip(null)}
        onScrollCapture={() => setTooltip(null)}
      >
        <div
          id="workspace-resize"
          className="workspace-resize"
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          hidden={fullscreen}
          aria-label={t('workspace.resize')}
          aria-valuemin={Math.round(limits.min)}
          aria-valuemax={Math.round(limits.max)}
          aria-valuenow={actualWidth}
          onPointerDown={(event) => {
            const element = event.currentTarget;
            document.body.classList.add('workspace-resizing');
            element.setPointerCapture?.(event.pointerId);
            element.focus();
            drag.current = {
              x: event.clientX,
              width: actualWidth,
              pointerId: event.pointerId,
              element,
            };
            event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Home') setWidth(limits.min);
            else if (event.key === 'End') setWidth(limits.max);
            else if (event.key === 'ArrowLeft') setWidth(actualWidth + STEP);
            else if (event.key === 'ArrowRight') setWidth(actualWidth - STEP);
            else return;
            event.preventDefault();
          }}
        />
        <header className="workspace-panel-header">
          <div
            ref={strip}
            id="workspace-tabs"
            className="workspace-tabs"
            role="tablist"
            aria-label={t('workspace.tabs')}
            onKeyDown={(event) => {
              const all = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
              const current = all.findIndex((tab) => tab === document.activeElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? all.length - 1
                    : event.key === 'ArrowLeft'
                      ? Math.max(0, current - 1)
                      : event.key === 'ArrowRight'
                        ? Math.min(all.length - 1, current + 1)
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              all[next]?.focus();
              all[next]?.click();
            }}
          >
            {tabs}
          </div>
          <button
            id="workspace-new-tab-plus"
            type="button"
            className="workspace-new-tab"
            aria-label={t('workspace.newTab')}
            data-tooltip={t('workspace.newTab')}
            title={t('workspace.newTab')}
            onClick={() => controller.openNewTab()}
          >
            <Icon kind="plus" />
          </button>
          <div className="workspace-panel-actions">
            <button
              id="workspace-fullscreen"
              type="button"
              aria-pressed={fullscreen}
              aria-label={t(fullscreen ? 'workspace.exitFullscreen' : 'workspace.fullscreenTitle')}
              data-tooltip={t(
                fullscreen ? 'workspace.exitFullscreen' : 'workspace.fullscreenTitle',
              )}
              onClick={() => controller.setFullscreen(!fullscreen)}
            >
              <Icon kind={fullscreen ? 'restore' : 'fullscreen'} />
            </button>
            <button
              id="workspace-refresh"
              type="button"
              aria-label={t('workspace.refreshTitle')}
              data-tooltip={t('workspace.refreshTitle')}
              onClick={() => {
                rememberScroll();
                controller.refresh();
              }}
            >
              <Icon kind="refresh" />
            </button>
            <button
              id="workspace-close"
              type="button"
              aria-label={t('workspace.closeTitle')}
              data-tooltip={t('workspace.closeTitle')}
              onClick={() => {
                controller.setOpen(false);
                document.getElementById('open-workspace')?.focus();
              }}
            >
              <Icon kind="collapse" />
            </button>
          </div>
        </header>
        <div
          id="workspace-location"
          className="workspace-location"
          translate="no"
          title={separator}
          aria-label={t('workspace.pathLabel')}
        >
          {separator}
        </div>
        <section
          id="workspace-new-tab-page"
          className="workspace-new-tab-page"
          aria-label={t('workspace.newTab')}
          hidden={active.kind !== 'new'}
        >
          <h2>{t('workspace.newTab')}</h2>
          {state.workspace ? (
            <p className="workspace-new-tab-context">
              {t('workspace.currentWorkspace', { name: projectName })}
            </p>
          ) : null}
          <div className="workspace-new-tab-options">
            <button
              id="workspace-new-files"
              type="button"
              className="workspace-new-tab-option"
              onClick={() => controller.openFiles()}
            >
              <Icon kind="folder" />
              <span className="workspace-new-tab-title">{t('workspace.filesTab')}</span>
              <span className="workspace-new-tab-hint">{t('workspace.filesTabHint')}</span>
            </button>
            <button
              id="workspace-new-browser"
              type="button"
              className="workspace-new-tab-option"
              onClick={() => {
                setNewTabError('');
                void controller
                  .openBrowser()
                  .catch((error: unknown) =>
                    setNewTabError(error instanceof Error ? error.message : String(error)),
                  );
              }}
            >
              <Icon kind="globe" />
              <span className="workspace-new-tab-title">{t('workspace.browserTab')}</span>
              <span className="workspace-new-tab-hint">{t('workspace.browserTabHint')}</span>
            </button>
          </div>
          {newTabError ? (
            <p className="workspace-new-tab-error" role="alert">
              {newTabError}
            </p>
          ) : null}
        </section>
        {active.kind === 'browser' && activeBrowser ? (
          <BrowserPane id={active.id} state={activeBrowser} />
        ) : null}
        <FileTree
          state={state}
          controller={controller}
          hidden={active.kind !== 'files'}
          onBeforeSelect={rememberScroll}
        />
        <section
          id="workspace-preview"
          className="workspace-preview"
          aria-label={selected ?? t('workspace.imageAlt')}
          hidden={active.kind !== 'file'}
        >
          <div
            id="workspace-preview-body"
            className="workspace-preview-body"
            ref={previewBody}
            onScroll={(event) => {
              if (selected !== null)
                controller.setTabScroll(selected, event.currentTarget.scrollTop);
            }}
          >
            {selected !== null && tab ? (
              <FilePreview path={selected} tab={tab} actions={markdownActions} />
            ) : null}
          </div>
        </section>
      </aside>
      <div
        id="workspace-tooltip"
        className="workspace-tooltip"
        role="tooltip"
        hidden={!tooltip}
        style={tooltip ? { left: tooltip.left, top: tooltip.top } : undefined}
      >
        {tooltip?.text ?? ''}
      </div>
    </>
  );
}

/** The path line: the workspace root, or the selected file's full path using the workspace's own separator. */
export function workspacePath(selected: string | null, workspace: string): string {
  const separator = workspace.includes('\\') ? '\\' : '/';
  if (selected && workspace)
    return `${workspace.replace(/[\\/]$/, '')}${separator}${selected.replaceAll('/', separator)}`;
  return selected ?? workspace;
}

/** The workspace's last path segment, for the new-tab page's context line. */
export function workspaceName(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).pop() || normalized;
}
