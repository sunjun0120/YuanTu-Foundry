/**
 * The sidebar's session list and row menu. Global search lives beside the project heading.
 *
 * The list is a keyed render rather than a patch; the window (three rows) only grows when the person asks, and a
 * search shows every match. The menu is one popup for every row, positioned beside the anchor and closed by Escape,
 * an outside click, scrolling or a switch — the same lifetime the legacy popup had.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import {
  sessionsFoldable,
  visibleSessions,
  type SessionSidebarController,
} from './session-model.ts';
import { SessionRow } from './SessionRow.tsx';

export function SessionSidebar({
  controller,
}: {
  controller: SessionSidebarController;
}): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFirst = useRef(false);

  const cancelClose = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = (): void => {
    cancelClose();
    const check = (): void => {
      // While the pointer is on the trigger or inside the popup the menu stays; the timer only measures the time
      // *after* leaving both. A fixed delay alone closed it under a slow hover-to-click in a loaded window.
      const over =
        (anchor?.matches(':hover') ?? false) || (menu.current?.matches(':hover') ?? false);
      if (over) {
        closeTimer.current = setTimeout(check, 120);
        return;
      }
      controller.closeMenu();
    };
    closeTimer.current = setTimeout(check, 120);
  };
  const openMenu = (button: HTMLButtonElement, sessionId: string): void => {
    if (state.blocked) return;
    // A close scheduled by the previous row must not close the menu that is opening now.
    cancelClose();
    const rect = button.getBoundingClientRect();
    setAnchor(button);
    setPosition({
      left: Math.max(8, Math.min(rect.right - 160, innerWidth - 168)),
      top: Math.max(8, Math.min(rect.bottom, innerHeight - 96)),
    });
    controller.openMenu(sessionId);
  };

  useEffect(() => {
    if (!state.menuSessionId) {
      setAnchor(null);
      setPosition(null);
      return;
    }
    if (focusFirst.current) {
      menu.current?.querySelector('button')?.focus();
      focusFirst.current = false;
    }
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !anchor?.contains(target)) controller.closeMenu();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const trigger = anchor;
      controller.closeMenu();
      trigger?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [state.menuSessionId, anchor, controller]);

  useEffect(() => () => cancelClose(), []);

  const showAll = state.expanded || state.searching;
  const foldable = sessionsFoldable(state);

  return (
    <>
      <nav
        id="sessions"
        aria-label={t('ui.sessionList')}
        className={(showAll ? 'expanded' : '') + ' sessions'}
        onScroll={() => controller.closeMenu()}
      >
        {visibleSessions(state).map((item) => (
          <SessionRow
            key={item.id}
            item={item}
            state={state}
            controller={controller}
            onMenu={(button, sessionId) => {
              focusFirst.current = false;
              openMenu(button, sessionId);
            }}
            onMenuKeyboard={(button, sessionId) => {
              focusFirst.current = true;
              openMenu(button, sessionId);
            }}
            onMenuLeave={scheduleClose}
          />
        ))}
        {showAll && state.hasMore ? (
          <button
            id="load-more-sessions"
            type="button"
            className="session-load-more"
            disabled={state.blocked}
            onClick={() => controller.loadMore()}
          >
            {t('ui.loadMoreSessions')}
          </button>
        ) : null}
        {foldable ? (
          <button
            type="button"
            className="session-load-more session-toggle"
            aria-expanded={state.expanded}
            onClick={() => controller.toggleExpanded()}
          >
            {state.expanded ? t('ui.showFewerSessions') : t('projects.showMoreSessions')}
          </button>
        ) : null}
      </nav>
      {/* The menu lives at the body: inside the scrolling sidebar a fixed popup is clipped by the aside. */}
      {createPortal(
        <div
          ref={menu}
          id="session-menu"
          className="session-menu"
          role="menu"
          aria-label={t('session.actions')}
          hidden={!state.menuSessionId}
          style={position ? { left: position.left, top: position.top } : undefined}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onBlur={(event) => {
            if (!menu.current?.contains(event.relatedTarget as Node)) scheduleClose();
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-action="rename"
            onClick={() => {
              if (state.menuSessionId) controller.openDialog('rename', state.menuSessionId);
            }}
          >
            {t('session.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-action="delete"
            className="danger-text"
            onClick={() => {
              if (state.menuSessionId) controller.openDialog('delete', state.menuSessionId);
            }}
          >
            {t('session.delete')}
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
