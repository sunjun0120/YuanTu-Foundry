/**
 * The session list in the sidebar: one row per session, the current one marked, each with its own menu.
 *
 * The list is a keyed rebuild rather than a patch, because every row carries a locale-formatted date and a
 * translated `aria-label`: the key holds the sessions, the current id, whether the window is blocked and the
 * locale, so a language switch or a run starting rebuilds the rows and nothing else does. A streaming run
 * reports progress constantly, and re-creating the buttons under the pointer on each of those is how a row
 * becomes unclickable.
 *
 * The rows are also where the two session controls in the header lead — a new session and a workspace picker —
 * so they are wired here, next to what they change.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { SessionInfo } from '../../packages/protocol/index.ts';
import { locale } from './i18n.ts';

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
  render(sessions: SessionInfo[], currentId: string | null, blocked: boolean): void;
} {
  const count = required('session-count');
  const list = required('sessions');
  let sessionKey = '';
  function render(sessions: SessionInfo[], currentId: string | null, blocked: boolean): void {
    // locale() belongs in the key: these rows carry a formatted date and a
    // translated aria-label, so a language switch has to rebuild them.
    const nextSessionKey = JSON.stringify([sessions, currentId, blocked, locale()]);
    if (nextSessionKey === sessionKey) return;
    sessionKey = nextSessionKey;
    count.textContent = String(sessions.length);
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
        button.append(
          node('strong', item.title || `会话 ${item.id.slice(0, 8)}`),
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
        button.setAttribute('aria-current', item.id === currentId ? 'true' : 'false');
        button.addEventListener('click', () => void options.select({ type: 'load', id: item.id }));
        const row = node('div', '', 'session-row');
        row.append(button, options.createMenuButton(item, blocked));
        return row;
      }),
    );
  }
  required('new-session').addEventListener('click', () => void options.select({ type: 'create' }));
  required('choose-workspace').addEventListener(
    'click',
    () => void options.select({ type: 'chooseWorkspace' }),
  );
  return { render };
}
