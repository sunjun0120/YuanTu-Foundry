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
import { FilePreview } from './FilePreview.tsx';
import { FileTree } from './FileTree.tsx';
import { Icon } from './Icon.tsx';
import { fileName, type WorkspaceController } from './workspace-model.ts';

const STEP = 24;

function widthLimits(): { min: number; max: number } {
  const available =
    window.innerWidth <= 1000 ? window.innerWidth - 24 : window.innerWidth - 272 - 320;
  return { min: Math.min(320, Math.max(0, available)), max: Math.max(0, available) };
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
  const [tooltip, setTooltip] = useState<{ text: string; left: number; top: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const previewBody = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  // The scroll of a tab is captured before leaving it: programmatic scroll events can land after the click that
  // switched tabs, and a preview that was already replaced cannot report where it was.
  const rememberScroll = (): void => {
    if (selected !== null && previewBody.current)
      controller.setTabScroll(selected, previewBody.current.scrollTop);
  };

  const limits = widthLimits();
  const actualWidth = Math.round(Math.min(limits.max, Math.max(limits.min, width)));
  const fullscreen = state.fullscreen;
  const selected = state.selected;
  const tab = selected === null ? undefined : state.tabs.get(selected);

  useEffect(() => {
    document.body.style.setProperty('--workspace-width', `${actualWidth}px`);
  }, [actualWidth]);

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
  }, [state.open, fullscreen]);

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

  const separator = workspacePath(selected, state.workspace);
  const tabs: ReactNode[] = [
    <button
      key="tree"
      id="workspace-tree-tab"
      type="button"
      role="tab"
      aria-controls="workspace-tree"
      aria-selected={selected === null}
      tabIndex={selected === null ? 0 : -1}
      className="workspace-tab"
      onClick={() => {
        rememberScroll();
        controller.backToTree();
      }}
    >
      <Icon kind="folder" />
      <span>{t('workspace.open')}</span>
    </button>,
  ];
  for (const file of state.tabs.values()) {
    const active = selected === file.path;
    tabs.push(
      <div
        key={file.path}
        className={`workspace-file-tab${active ? ' active' : ''}`}
        data-path={file.path}
      >
        <button
          type="button"
          role="tab"
          aria-controls="workspace-preview"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
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
          else if (selected !== null) {
            rememberScroll();
            controller.backToTree();
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
            drag.current = { x: event.clientX, width: actualWidth };
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
        <FileTree
          state={state}
          controller={controller}
          hidden={selected !== null}
          onBeforeSelect={rememberScroll}
        />
        <section
          id="workspace-preview"
          className="workspace-preview"
          aria-label={selected ?? t('workspace.imageAlt')}
          hidden={selected === null}
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
