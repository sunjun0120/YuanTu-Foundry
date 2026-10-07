import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { SessionInfo } from '../../packages/protocol/index.ts';
import { t } from './i18n.ts';

export function setupSessionManagement(actions: {
  select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
}) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = el<HTMLDialogElement>('session-dialog');
  const titleInput = el<HTMLInputElement>('session-title-input');
  const search = el<HTMLInputElement>('session-search');
  const searchOpen = el<HTMLButtonElement>('open-session-search');
  const recentLabel = el('recent-sessions-label');
  const searchClear = el<HTMLButtonElement>('clear-session-search');
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  menu.id = 'session-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('session.actions'));
  menu.hidden = true;
  document.body.append(menu);
  let blocked = true,
    saving = false;
  let lastSession: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wantsSearchFocus = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let anchor: HTMLButtonElement | null = null;
  let target: SessionInfo | null = null;
  let pending: CarrierCommand | null = null;
  const hideMenu = () => {
    clearTimeout(closeTimer);
    menu.hidden = true;
    anchor?.setAttribute('aria-expanded', 'false');
    anchor = null;
    target = null;
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(hideMenu, 180);
  };
  menu.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  menu.addEventListener('mouseleave', scheduleClose);
  menu.addEventListener('focusout', (event) => {
    if (!menu.contains(event.relatedTarget as Node)) scheduleClose();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      const trigger = anchor;
      hideMenu();
      trigger?.focus();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target as Node) && !anchor?.contains(event.target as Node)) hideMenu();
  });
  el('sessions').addEventListener('scroll', hideMenu);
  window.addEventListener('resize', hideMenu);
  const open = (kind: 'rename' | 'delete') => {
    if (!target || blocked) return;
    const { id } = target;
    const title = target.title || `会话 ${id.slice(0, 8)}`;
    pending = kind === 'rename' ? { type: 'rename', id, title } : { type: 'deleteSession', id };
    hideMenu();
    el('session-dialog-title').textContent =
      kind === 'rename' ? t('session.renameTitle') : t('session.deleteTitle');
    el('session-dialog-description').textContent =
      kind === 'delete'
        ? t('session.deleteDescription', { title })
        : t('session.renameDescription');
    titleInput.hidden = kind !== 'rename';
    el('session-title-label').hidden = kind !== 'rename';
    titleInput.required = kind === 'rename';
    titleInput.value = title;
    el('session-dialog-error').hidden = true;
    el('session-dialog-confirm').textContent =
      kind === 'delete' ? t('session.confirmDelete') : t('session.saveName');
    dialog.showModal();
    if (kind === 'rename') {
      titleInput.focus();
      titleInput.select();
    } else el('session-dialog-cancel').focus();
  };
  for (const [kind, label] of [
    ['rename', t('session.rename')],
    ['delete', t('session.delete')],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('role', 'menuitem');
    if (kind === 'delete') button.className = 'danger-text';
    button.addEventListener('click', () => open(kind));
    menu.append(button);
  }
  el('session-dialog-cancel').addEventListener('click', () => {
    if (!saving) {
      dialog.close();
      pending = null;
    }
  });
  dialog.addEventListener('cancel', (event) => {
    if (saving) event.preventDefault();
    else pending = null;
  });
  el('session-dialog-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pending || blocked || saving) return;
    const command =
      pending.type === 'rename' ? { ...pending, title: titleInput.value.trim() } : pending;
    if (command.type === 'rename' && !command.title) {
      el('session-dialog-error').textContent = t('session.enterName');
      el('session-dialog-error').hidden = false;
      return;
    }
    saving = true;
    el<HTMLButtonElement>('session-dialog-confirm').disabled = true;
    el<HTMLButtonElement>('session-dialog-cancel').disabled = true;
    void actions
      .select(command)
      .then((result) => {
        if (result) {
          dialog.close();
          pending = null;
        } else {
          el('session-dialog-error').textContent = t('session.operationFailed');
          el('session-dialog-error').hidden = false;
        }
      })
      .finally(() => {
        saving = false;
        el<HTMLButtonElement>('session-dialog-confirm').disabled = false;
        el<HTMLButtonElement>('session-dialog-cancel').disabled = false;
      });
  });
  const setSearchOpen = (open: boolean) => {
    recentLabel.hidden = open;
    searchOpen.hidden = open;
    search.hidden = !open;
    searchClear.hidden = !open;
    searchOpen.setAttribute('aria-expanded', String(open));
    if (open) {
      wantsSearchFocus = true;
      search.focus();
      requestAnimationFrame(() => {
        if (
          wantsSearchFocus &&
          !search.hidden &&
          !search.disabled &&
          (document.activeElement === document.body || document.activeElement === searchOpen)
        )
          search.focus();
      });
    } else wantsSearchFocus = false;
  };
  const clearSearch = () => {
    clearTimeout(timer);
    search.value = '';
    setSearchOpen(false);
    el('session-search-empty').hidden = true;
    el('session-search-note').hidden = true;
    void actions.select({ type: 'searchSessions', query: '' });
  };
  searchClear.addEventListener('click', () => {
    clearSearch();
    searchOpen.focus();
  });
  searchOpen.addEventListener('click', () => {
    clearTimeout(timer);
    search.value = '';
    setSearchOpen(true);
    void actions.select({ type: 'searchSessions', query: '' }).finally(() => {
      if (wantsSearchFocus && !search.hidden && !search.disabled) search.focus();
    });
  });
  document.addEventListener('click', (event) => {
    if (
      !search.hidden &&
      !search.contains(event.target as Node) &&
      !searchOpen.contains(event.target as Node)
    )
      clearSearch();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      clearSearch();
      searchOpen.focus();
    }
  });
  search.addEventListener('input', () => {
    clearTimeout(timer);
    const query = search.value;
    timer = setTimeout(() => {
      void actions.select({ type: 'searchSessions', query }).finally(() => {
        if (wantsSearchFocus && !search.hidden && !search.disabled) search.focus();
      });
    }, 180);
  });
  return {
    createMenuButton(item: SessionInfo, disabled: boolean) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-more';
      button.textContent = '⋯';
      button.disabled = disabled;
      button.dataset.menuSessionId = item.id;
      button.setAttribute(
        'aria-label',
        `${t('session.actions')}: ${item.title || item.id.slice(0, 8)}`,
      );
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-controls', menu.id);
      button.setAttribute('aria-expanded', 'false');
      const show = () => {
        if (blocked || disabled) return;
        hideMenu();
        anchor = button;
        target = item;
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        const rect = button.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.bottom, innerHeight - menu.offsetHeight - 8))}px`;
      };
      button.addEventListener('mouseenter', show);
      button.addEventListener('mouseleave', scheduleClose);
      button.addEventListener('click', show);
      button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          show();
          menu.querySelector('button')?.focus();
        }
      });
      return button;
    },
    render(next: CarrierSnapshot, isBlocked: boolean) {
      blocked = isBlocked;
      if (blocked || (target && !next.sessions.some((item) => item.id === target?.id))) hideMenu();
      const id = next.session.sessionId;
      if (lastSession !== id) {
        lastSession = id;
        if (search.hidden) search.value = next.sessionQuery ?? '';
        clearTimeout(timer);
        hideMenu();
      } else if (search.hidden) search.value = next.sessionQuery ?? '';
      search.disabled = blocked;
      searchOpen.disabled = blocked;
      searchClear.disabled = blocked;
      searchClear.setAttribute('aria-label', t('ui.clearSessionSearch'));
      searchClear.title = t('ui.clearSessionSearch');
      if (
        wantsSearchFocus &&
        !blocked &&
        !search.hidden &&
        document.activeElement === document.body
      )
        search.focus();
      const noMatches =
        !search.hidden &&
        !next.sessions.length &&
        Boolean(search.value.trim() || next.sessionQuery?.trim());
      el('session-search-note').hidden = true;
      el('session-search-note').textContent = t('ui.searchNameOnly');
      el('session-search-empty').textContent = t('ui.noMatchingSessions');
      el('session-search-empty').hidden = !noMatches;
    },
  };
}
