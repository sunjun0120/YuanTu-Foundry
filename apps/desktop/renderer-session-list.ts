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

/** A speech bubble with a question mark: the session is waiting on the user. */
const WAITING_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5c3.6 0 6.5 2.5 6.5 5.6S11.6 12.7 8 12.7c-.7 0-1.4-.1-2-.3L2.6 14l.9-2.8C2.2 10.2 1.5 8.7 1.5 7.1 1.5 4 4.4 1.5 8 1.5Z" fill="currentColor"/><path d="M6.4 5.6c.1-.9.8-1.5 1.7-1.5.9 0 1.6.6 1.6 1.4 0 .6-.3 1-.9 1.3-.5.3-.7.5-.7 1v.2" fill="none" stroke="var(--status-icon-ink, #fff)" stroke-width="1.2" stroke-linecap="round"/><circle cx="8.1" cy="9.6" r=".75" fill="var(--status-icon-ink, #fff)"/></svg>';

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
  ): void;
} {
  const count = required('session-count');
  const list = required('sessions');
  let sessionKey = '';
  const rowsKey = memo<string>();
  function render(
    sessions: SessionInfo[],
    currentId: string | null,
    blocked: boolean,
    hasMore = false,
    activity: ReadonlyMap<string, SessionActivity> = new Map(),
  ): void {
    // locale() belongs in the key: these rows carry a formatted date and a
    // translated aria-label, so a language switch has to rebuild them.
    const activityKey = JSON.stringify([...activity]);
    const nextSessionKey = rowsKey(
      [sessions, currentId, blocked, hasMore, activityKey, locale()],
      () => JSON.stringify([sessions, currentId, blocked, hasMore, activityKey, locale()]),
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
    list.replaceChildren(
      ...sessions.map((item) => {
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
        button.append(
          title,
          node(
            'small',
            new Date(item.createdAt).toLocaleString(locale(), {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          ),
        );
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
      ...(hasMore ? [more] : []),
    );
  }
  required('new-session').addEventListener('click', () => void options.select({ type: 'create' }));
  required('choose-workspace').addEventListener(
    'click',
    () => void options.select({ type: 'chooseWorkspace' }),
  );
  return { render };
}
