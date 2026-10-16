import type { CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { HostMethods } from '../../packages/protocol/rpc.ts';
import type {
  WorkspaceMaintenanceCommand,
  WorkspaceMaintenanceReply,
} from './workspace-maintenance-contract.ts';
import { carrierErrorText } from './carrier-errors.ts';
import { locale, onLocaleChange, t } from './i18n.ts';
import { showSettingsPanel } from './renderer-panels.ts';

export function setupWorkspaceMaintenance() {
  const required = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const panel = required('workspace-maintenance-content');
  const entry = required<HTMLButtonElement>('workspace-maintenance-settings');
  const refresh = required<HTMLButtonElement>('workspace-maintenance-refresh');
  const list = required('workspace-maintenance-list');
  const feedback = required('workspace-maintenance-feedback');
  let workspace = '';
  let blocked = true;
  let pending = false;
  let generation = 0;
  let items: HostMethods['workspaces.orphaned']['result'] | null = null;
  let failure: Extract<WorkspaceMaintenanceReply, { ok: false }> | null = null;
  let confirmation: string | null = null;
  const node = (tag: string, text: string, userContent = false) => {
    const value = document.createElement(tag);
    value.textContent = text;
    if (userContent) value.translate = false;
    return value;
  };
  function paint() {
    required('workspace-maintenance-label').textContent = t('orphans.title');
    required('workspace-maintenance-title').textContent = t('orphans.title');
    required('workspace-maintenance-note').textContent = t('orphans.note');
    refresh.textContent = t('orphans.refresh');
    refresh.disabled = pending || !workspace;
    feedback.textContent = failure
      ? carrierErrorText(failure, locale())
      : pending
        ? t('orphans.loading')
        : items?.length === 0
          ? t('orphans.empty')
          : '';
    feedback.classList.toggle('error', failure !== null);
    list.replaceChildren();
    for (const item of items ?? []) {
      const row = node('li', '');
      row.className = 'workspace-maintenance-item';
      row.dataset.bindingId = item.binding.id;
      row.dataset.state = item.binding.state;
      row.append(node('strong', item.binding.executionRoot, true));
      row.append(
        node(
          'small',
          `${t(`orphans.state.${item.binding.state}`)} · ${t('orphans.results', { count: item.results.length })}`,
        ),
      );
      for (const problem of item.problems) row.append(node('p', problem, true));
      const actions = node('div', '');
      const action =
        item.binding.state === 'removed'
          ? 'restore'
          : item.binding.state === 'archived'
            ? 'remove'
            : 'archive';
      const button = node('button', t(`subagent.workspace.action.${action}`)) as HTMLButtonElement;
      button.type = 'button';
      button.className = 'secondary';
      button.dataset.action = action;
      button.disabled =
        blocked ||
        pending ||
        !['ready', 'blocked', 'archived', 'removed'].includes(item.binding.state);
      button.addEventListener('click', () => {
        if (action === 'remove' && confirmation !== item.binding.id) {
          confirmation = item.binding.id;
          paint();
          list
            .querySelector<HTMLButtonElement>(
              `[data-binding-id="${CSS.escape(item.binding.id)}"] [data-action="remove"]`,
            )
            ?.focus();
        } else void request({ type: action, bindingId: item.binding.id });
      });
      actions.append(button);
      if (
        ['blocked', 'archived'].includes(item.binding.state) ||
        (item.problems.length && item.binding.state === 'ready')
      ) {
        const restore = node('button', t('subagent.workspace.action.restore')) as HTMLButtonElement;
        restore.type = 'button';
        restore.className = 'secondary';
        restore.dataset.action = 'restore';
        restore.disabled = blocked || pending;
        restore.addEventListener(
          'click',
          () => void request({ type: 'restore', bindingId: item.binding.id }),
        );
        actions.append(restore);
      }
      if (confirmation === item.binding.id && action === 'remove') {
        row.append(node('p', t('subagent.workspace.removeConfirm')));
        button.textContent = t('orphans.confirmRemove');
        const cancel = node('button', t('orphans.cancel')) as HTMLButtonElement;
        cancel.type = 'button';
        cancel.className = 'secondary';
        cancel.disabled = pending;
        cancel.addEventListener('click', () => {
          confirmation = null;
          paint();
        });
        actions.append(cancel);
      }
      row.append(actions);
      list.append(row);
    }
  }
  async function request(command: WorkspaceMaintenanceCommand) {
    if (pending || !workspace || (command.type !== 'list' && blocked)) return;
    const at = generation,
      project = workspace;
    pending = true;
    failure = null;
    paint();
    try {
      const reply = await window.yuantu.workspaceMaintenance(command);
      if (at !== generation) return;
      if (reply.ok) {
        if (reply.workspace !== project) return;
        items = reply.items;
        confirmation = null;
      } else failure = reply;
    } catch (error) {
      if (at === generation)
        failure = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (at === generation) {
        pending = false;
        paint();
      }
    }
  }
  refresh.addEventListener('click', () => void request({ type: 'list' }));
  entry.addEventListener('click', () => {
    showSettingsPanel('workspace-maintenance-content');
    void request({ type: 'list' });
  });
  onLocaleChange(paint);
  paint();
  return {
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
      if (changed && !panel.hidden) void request({ type: 'list' });
    },
  };
}
