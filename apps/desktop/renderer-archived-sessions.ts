import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { SessionInfo } from '../../packages/protocol/index.ts';
import { locale, onLocaleChange, t } from './i18n.ts';

/** A box with an arrow leaving it upward: the session goes back to the sidebar. */
const UNARCHIVE_ICON =
  '<path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 4h18v5H3z"/><path d="M12 18v-6M9.5 14.5 12 12l2.5 2.5"/>';
const DELETE_ICON =
  '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>';

/**
 * The archived-sessions settings page: list what was archived, bring a session back, or delete it.
 *
 * The list is read on demand, like the retained workspaces below it on the same page, so a snapshot never carries
 * sessions the sidebar does not show. Unarchiving and deleting are ordinary carrier commands, sent through the
 * renderer's own `select` so they wait for a run the same way the sidebar menu's actions do.
 */
export function setupArchivedSessions(actions: {
  select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
}) {
  const required = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const panel = required('workspace-maintenance-content');
  const entry = required<HTMLButtonElement>('workspace-maintenance-settings');
  const refresh = required<HTMLButtonElement>('workspace-maintenance-refresh');
  const list = required('archived-sessions-list');
  const feedback = required('archived-sessions-feedback');
  let workspace = '';
  let blocked = true;
  let pending = false;
  let generation = 0;
  let items: SessionInfo[] | null = null;
  let failure: string | null = null;
  let confirmation: string | null = null;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string) => {
    const value = document.createElement(tag);
    value.textContent = text;
    return value;
  };
  const button = (label: string, action: string, onClick: () => void) => {
    const value = node('button', label);
    value.type = 'button';
    value.className = 'secondary';
    value.dataset.action = action;
    value.disabled = blocked || pending;
    value.addEventListener('click', onClick);
    return value;
  };
  /** A row's quiet action: an icon, with its name as the tooltip and the accessible label. */
  const iconButton = (label: string, action: string, icon: string, onClick: () => void) => {
    const value = button('', action, onClick);
    value.className = 'archived-session-action';
    value.setAttribute('aria-label', label);
    value.dataset.tooltip = label;
    value.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
    return value;
  };
  function paint() {
    required('workspace-maintenance-label').textContent = t('archived.title');
    required('archived-sessions-title').textContent = t('archived.title');
    required('archived-sessions-note').textContent = t('archived.note');
    feedback.textContent =
      failure ??
      (pending && !items ? t('archived.loading') : items?.length === 0 ? t('archived.empty') : '');
    feedback.classList.toggle('error', failure !== null);
    list.replaceChildren();
    for (const item of items ?? []) {
      const title = item.title || item.id.slice(0, 8);
      const row = node('li', '');
      row.className = 'workspace-maintenance-item';
      row.dataset.sessionId = item.id;
      row.classList.add('archived-session');
      const copy = node('div', '');
      copy.className = 'archived-session-copy';
      const name = node('strong', title);
      name.translate = false;
      copy.append(name);
      if (item.archivedAt)
        copy.append(
          node(
            'small',
            t('archived.at', { time: new Date(item.archivedAt).toLocaleString(locale()) }),
          ),
        );
      row.append(copy);
      const controls = node('div', '');
      controls.className = 'archived-session-actions';
      if (confirmation === item.id) {
        copy.append(node('p', t('archived.deleteConfirm', { title })));
        const confirm = button(t('archived.confirmDelete'), 'delete', () => {
          void run({ type: 'deleteSession', id: item.id });
        });
        confirm.classList.add('danger-text');
        controls.append(
          confirm,
          button(t('orphans.cancel'), 'cancel', () => {
            confirmation = null;
            paint();
          }),
        );
      } else
        controls.append(
          iconButton(t('archived.unarchive'), 'unarchive', UNARCHIVE_ICON, () => {
            void run({ type: 'archiveSession', id: item.id, archived: false });
          }),
          iconButton(t('archived.delete'), 'delete', DELETE_ICON, () => {
            confirmation = item.id;
            paint();
            list
              .querySelector<HTMLButtonElement>(
                `[data-session-id="${CSS.escape(item.id)}"] [data-action="cancel"]`,
              )
              ?.focus();
          }),
        );
      row.append(controls);
      list.append(row);
    }
  }
  async function load() {
    const bridge = window.yuantu.archivedSessions;
    if (!bridge || !workspace) return;
    const at = ++generation,
      project = workspace;
    pending = true;
    paint();
    try {
      const reply = await bridge();
      if (at !== generation) return;
      if (reply.ok) {
        if (reply.workspace !== project) return;
        items = reply.sessions;
        failure = null;
      } else failure = reply.error;
    } catch (error) {
      if (at === generation) failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (at === generation) {
        pending = false;
        paint();
      }
    }
  }
  /** One action, then a fresh read: the list is the Host's answer, not a local guess at what changed. */
  async function run(command: CarrierCommand) {
    if (pending || blocked) return;
    pending = true;
    failure = null;
    paint();
    let done: CarrierSnapshot | null = null;
    try {
      done = await actions.select(command);
    } catch {
      done = null;
    } finally {
      pending = false;
    }
    confirmation = null;
    await load();
    if (!done) {
      failure = t('archived.failed');
      paint();
    }
  }
  refresh.addEventListener('click', () => void load());
  entry.addEventListener('click', () => void load());
  onLocaleChange(paint);
  paint();
  return {
    /** Re-read when the project changes; follow the run so actions wait for it, as the sidebar's do. */
    update(state: CarrierSnapshot) {
      const changed = workspace !== state.workspace;
      if (changed) {
        workspace = state.workspace;
        generation++;
        pending = false;
        items = null;
        failure = null;
        confirmation = null;
      }
      const nextBlocked = !state.ready || state.session.running || state.session.loading;
      if (changed || blocked !== nextBlocked) {
        blocked = nextBlocked;
        paint();
      }
      if (changed && !panel.hidden) void load();
    },
  };
}
