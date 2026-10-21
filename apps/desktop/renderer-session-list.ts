/**
 * The session list in the sidebar: one row per session, the current one marked, each with its own menu.
 *
 * The list is a keyed rebuild rather than a patch, because every row carries a locale-formatted date and a
 * translated `aria-label`: the key holds the sessions, the current id, whether the window is blocked and the
 * locale, so a language switch or a run starting rebuilds the rows and nothing else does.
 *
 * A row also says whether its session is running and how many approvals or questions it is waiting on. The Host
 * runs several sessions at once, so the list stays usable while one of them runs: opening another session leaves
 * the running one going, and its row is where a person sees that it still needs them. A streaming run
 * reports progress constantly, and re-creating the buttons under the pointer on each of those is how a row
 * becomes unclickable.
 *
 * The rows are also where the two session controls in the header lead — a new session and a workspace picker —
 * so they are wired here, next to what they change.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { SessionInfo } from '../../packages/protocol/index.ts';

/** What a row says about its session's live run: running at all, and how many interactions wait on a person. */
export interface SessionActivity {
  running: boolean;
  waiting: number;
}
import { locale, t } from './i18n.ts';
import { memo } from './renderer-memo.ts';

/** How many rows the list shows before the person asks for the rest; a search always shows every match. */
const COLLAPSED_ROWS = 4;

/** A speech bubble with a question mark: the session is waiting on the user. */
const WAITING_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5c3.6 0 6.5 2.5 6.5 5.6S11.6 12.7 8 12.7c-.7 0-1.4-.1-2-.3L2.6 14l.9-2.8C2.2 10.2 1.5 8.7 1.5 7.1 1.5 4 4.4 1.5 8 1.5Z" fill="currentColor"/><path d="M6.4 5.6c.1-.9.8-1.5 1.7-1.5.9 0 1.6.6 1.6 1.4 0 .6-.3 1-.9 1.3-.5.3-.7.5-.7 1v.2" fill="none" stroke="var(--status-icon-ink, #fff)" stroke-width="1.2" stroke-linecap="round"/><circle cx="8.1" cy="9.6" r=".75" fill="var(--status-icon-ink, #fff)"/></svg>';

/**
 * How long ago a session started, in the row's compact form ("10小时", "3d"): the largest whole unit, with the
 * date itself once it is over a month old. The exact time is the row's tooltip.
 */
function sessionAge(createdAt: string | number): string {
  const then = new Date(createdAt);
  const minutes = Math.max(0, Math.floor((Date.now() - then.getTime()) / 60_000));
  const unit = (value: number, name: 'minute' | 'hour' | 'day'): string =>
    new Intl.NumberFormat(locale(), { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(
      value,
    );
  if (minutes < 60) return unit(Math.max(1, minutes), 'minute');
  if (minutes < 24 * 60) return unit(Math.floor(minutes / 60), 'hour');
  if (minutes < 30 * 24 * 60) return unit(Math.floor(minutes / (24 * 60)), 'day');
  return then.toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

export function setupSessionList(options: {
  select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  /** The row's own `⋯` menu, built by the module that owns its actions. */
  createMenuButton(item: SessionInfo, disabled: boolean): HTMLButtonElement;
}): {
  render(
    sessions: SessionInfo[],
    currentId: string | null,
    blocked: boolean,
    hasMore?: boolean,
    activity?: ReadonlyMap<string, SessionActivity>,
    searching?: boolean,
  ): void;
} {
  const count = required('session-count');
  const list = required('sessions');
  let sessionKey = '';
  const rowsKey = memo<string>();
  /** Whether the person opened the full list; kept across renders so a run's progress does not fold it back. */
  let expanded = false;
  let last: Parameters<typeof render> | null = null;
  function render(
    sessions: SessionInfo[],
    currentId: string | null,
    blocked: boolean,
    hasMore = false,
    activity: ReadonlyMap<string, SessionActivity> = new Map(),
    searching = false,
  ): void {
    last = [sessions, currentId, blocked, hasMore, activity, searching];
    // locale() belongs in the key: these rows carry a formatted date and a
    // translated aria-label, so a language switch has to rebuild them.
    const activityKey = JSON.stringify([...activity]);
    // The rows show each session's age, so a render in a later minute rebuilds them with the new one.
    const minute = Math.floor(Date.now() / 60_000);
    const nextSessionKey = rowsKey(
      [sessions, currentId, blocked, hasMore, activityKey, locale(), expanded, searching, minute],
      () =>
        JSON.stringify([
          sessions,
          currentId,
          blocked,
          hasMore,
          activityKey,
          locale(),
          expanded,
          searching,
          minute,
        ]),
    );
    if (nextSessionKey === sessionKey) return;
    sessionKey = nextSessionKey;
    // The list is a window over the newest sessions; `+` says the count is of the window, not of all of them.
    count.textContent = `${sessions.length}${hasMore ? '+' : ''}`;
    const more = node('button', t('ui.loadMoreSessions'), 'session-load-more');
    more.id = 'load-more-sessions';
    more.type = 'button';
    more.disabled = blocked;
    more.addEventListener('click', () => void options.select({ type: 'loadMoreSessions' }));
    const showAll = expanded || searching;
    const visible = showAll ? sessions : sessions.slice(0, COLLAPSED_ROWS);
    const foldable = !searching && (sessions.length > COLLAPSED_ROWS || hasMore);
    const toggle = node(
      'button',
      expanded ? t('ui.showFewerSessions') : t('ui.showMoreSessions'),
      'session-load-more session-toggle',
    );
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      if (!expanded) list.scrollTop = 0;
      if (last) render(...last);
    });
    list.classList.toggle('expanded', showAll);
    list.replaceChildren(
      ...visible.map((item) => {
        const button = node(
          'button',
          '',
          `session-item${item.id === currentId ? ' selected' : ''}`,
        );
        button.dataset.sessionId = item.id;
        button.disabled = blocked;
        button.title = item.id;
        const title = node(
          'strong',
          item.title || t('ui.sessionShort', { id: item.id.slice(0, 8) }),
        );
        title.translate = false;
        const time = node('small', sessionAge(item.createdAt));
        time.title = new Date(item.createdAt).toLocaleString(locale(), {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        button.append(title, time);
        /**
         * The row's state is one icon in the place the `⋯` takes on hover: a spinner while the session runs, and
         * a waiting mark when an approval or question needs the user — that one wins, because it is the one asking
         * for something. The label goes on the row itself, since the icon is drawn but never hovered.
         */
        const live = activity.get(item.id);
        const row = node('div', '', 'session-row');
        if (live?.running || live?.waiting) {
          const label = live.waiting
            ? t('ui.sessionWaitingLabel', { count: live.waiting })
            : t('ui.sessionRunning');
          const status = node('span', '', `session-status ${live.waiting ? 'waiting' : 'running'}`);
          status.setAttribute('role', 'img');
          status.setAttribute('aria-label', label);
          status.innerHTML = live.waiting ? WAITING_ICON : '<span class="session-spinner"></span>';
          button.append(status);
          button.title = `${item.title || item.id}\n${label}`;
          row.classList.add('has-status');
        }
        button.setAttribute('aria-current', item.id === currentId ? 'true' : 'false');
        button.addEventListener('click', () => void options.select({ type: 'load', id: item.id }));
        row.append(button, options.createMenuButton(item, blocked));
        return row;
      }),
      ...(showAll && hasMore ? [more] : []),
      ...(foldable ? [toggle] : []),
    );
  }
  required('new-session').addEventListener('click', () => void options.select({ type: 'create' }));
  required('choose-workspace').addEventListener(
    'click',
    () => void options.select({ type: 'chooseWorkspace' }),
  );
  return { render };
}
