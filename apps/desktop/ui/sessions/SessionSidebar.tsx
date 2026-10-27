/**
 * The sidebar's session list, search box and row menu.
 *
 * The list is a keyed render rather than a patch; the window (four rows) only grows when the person asks, and a
 * search shows every match. The menu is one popup for every row, positioned beside the anchor and closed by Escape,
 * an outside click, scrolling or a switch — the same lifetime the legacy popup had.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import {
  searchEmpty,
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
  const search = useRef<HTMLInputElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Search lifecycle: opening resets and focuses, an outside click or Escape closes and re-reads the whole list.
  useEffect(() => {
    if (!state.searchOpen) return;
    const focus = (): void => {
      if (!state.blocked) search.current?.focus();
    };
    focus();
    requestAnimationFrame(focus);
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (search.current?.contains(target) || openButton.current?.contains(target)) return;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      controller.closeSearch();
      void controller.submitQuery('');
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [state.searchOpen, state.blocked, controller]);

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  const closeSearch = (refocus: boolean): void => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    controller.closeSearch();
    void controller.submitQuery('');
    if (refocus) openButton.current?.focus();
  };

  const showAll = state.expanded || state.searching;
  const foldable = sessionsFoldable(state);
  const empty = searchEmpty(state);

  return (
    <>
      <div id="session-search-row" className="session-search-row">
        <div id="recent-sessions-label" className="section-label" hidden={state.searchOpen}>
          {t('ui.recentSessions')}{' '}
          <span id="session-count">
            {state.sessions.length}
            {state.hasMore ? '+' : ''}
          </span>
        </div>
        <button
          ref={openButton}
          id="open-session-search"
          className="open-session-search"
          aria-expanded={state.searchOpen}
          aria-controls="session-search"
          type="button"
          aria-label={t('ui.searchSessions')}
          title={t('ui.searchSessions')}
          disabled={state.blocked}
          hidden={state.searchOpen}
          onClick={() => {
            controller.openSearch();
            void controller.submitQuery('');
          }}
        >
          <span className="search-icon" aria-hidden="true" />
        </button>
        <input
          ref={search}
          id="session-search"
          className="session-search"
          type="search"
          maxLength={200}
          placeholder={t('ui.searchSessionsOrMessages')}
          aria-label={t('ui.searchSessions')}
          hidden={!state.searchOpen}
          disabled={state.blocked}
          value={state.query}
          onChange={(event) => {
            const query = event.currentTarget.value;
            controller.setQuery(query);
            if (searchTimer.current) clearTimeout(searchTimer.current);
            searchTimer.current = setTimeout(() => void controller.submitQuery(query), 180);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeSearch(true);
          }}
        />
        <button
          id="clear-session-search"
          className="clear-session-search"
          type="button"
          aria-label={t('ui.clearSessionSearch')}
          title={t('ui.clearSessionSearch')}
          hidden={!state.searchOpen}
          disabled={state.blocked}
          onClick={() => closeSearch(true)}
        >
          ×
        </button>
      </div>
      <p id="session-search-note" className="session-search-note" hidden>
        {t('ui.searchNameOnly')}
      </p>
      <p id="session-search-empty" className="session-empty session-search-empty" hidden={!empty}>
        {t('ui.noMatchingSessions')}
      </p>
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
            {state.expanded ? t('ui.showFewerSessions') : t('ui.showMoreSessions')}
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
