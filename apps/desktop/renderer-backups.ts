import type { BackupCommand, BackupView } from './backup-contract.ts';
import { locale, onLocaleChange, t } from './i18n.ts';
import { showSettingsPanel } from './renderer-panels.ts';

export function setupBackups(
  isBusy: () => boolean,
  onBusy: (busy: boolean) => void,
): { updateBusy(): void } {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = document.createElement('section');
  panel.id = 'backup-settings-content';
  panel.className = 'settings-content';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'backup-title');
  panel.innerHTML = `<div class="settings-page-header"><div class="eyebrow">PREFERENCES / DATA</div><h2 id="backup-title"></h2><p id="backup-description"></p></div>
    <label class="backup-enabled"><input id="backup-enabled" type="checkbox" /><span id="backup-enabled-label"></span></label>
    <p id="backup-schedule-note" class="backup-note"></p>
    <p id="backup-scope" class="backup-note"></p>
    <label class="settings-field" for="backup-list"><span id="backup-list-label"></span><select id="backup-list"></select></label>
    <p id="backup-feedback" class="settings-feedback" role="status" aria-live="polite" hidden></p>
    <div class="settings-actions"><button id="backup-create" type="button" class="primary"></button><button id="backup-refresh" type="button" class="secondary"></button><button id="backup-restore" type="button" class="secondary"></button></div>`;
  byId('settings-page').append(panel);
  const nav = document.createElement('button');
  nav.id = 'backup-settings';
  nav.type = 'button';
  byId('settings-page').querySelector('nav')!.append(nav);
  const enabled = byId<HTMLInputElement>('backup-enabled');
  const list = byId<HTMLSelectElement>('backup-list');
  const feedback = byId('backup-feedback');
  let view: BackupView | undefined;
  let pending = false;
  function status(message: string, error = false) {
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.dataset.error = String(error);
  }
  function fill() {
    const selected = list.value;
    list.replaceChildren();
    for (const backup of view?.backups ?? [])
      list.add(
        new Option(
          `${new Date(backup.createdAt).toLocaleString(locale())} · ${(backup.bytes / 1048576).toFixed(1)} MB`,
          backup.id,
        ),
      );
    if (!list.options.length) list.add(new Option(t('backup.empty'), ''));
    if ([...list.options].some((option) => option.value === selected)) list.value = selected;
    enabled.checked = view?.enabled ?? false;
  }
  function updateBusy() {
    const locked = pending || isBusy();
    for (const control of panel.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >('input, button, select'))
      control.disabled = locked;
    byId<HTMLButtonElement>('backup-restore').disabled = locked || !list.value;
  }
  async function invoke(command: BackupCommand) {
    if (pending) return;
    pending = true;
    onBusy(true);
    updateBusy();
    status(t('backup.working'));
    try {
      const reply = await window.yuantu.backups(command);
      if (!reply.ok) status(reply.error, true);
      else {
        view = reply.view;
        status(
          view.error ??
            (reply.recoveryDirectory
              ? t('backup.restored', { path: reply.recoveryDirectory })
              : reply.cancelled
                ? t('backup.cancelled')
                : command.type === 'get'
                  ? ''
                  : t('backup.saved')),
          Boolean(view.error),
        );
      }
    } catch {
      status(t('backup.failed'), true);
    } finally {
      fill();
      pending = false;
      onBusy(false);
      updateBusy();
    }
  }
  const translate = () => {
    nav.textContent = t('backup.title');
    for (const [id, key] of Object.entries({
      'backup-title': 'backup.title',
      'backup-description': 'backup.description',
      'backup-enabled-label': 'backup.enabled',
      'backup-schedule-note': 'backup.scheduleNote',
      'backup-scope': 'backup.scope',
      'backup-list-label': 'backup.list',
      'backup-create': 'backup.create',
      'backup-refresh': 'backup.refresh',
      'backup-restore': 'backup.restore',
    }))
      byId(id).textContent = t(key);
    fill();
  };
  onLocaleChange(translate);
  translate();
  nav.addEventListener('click', () => {
    showSettingsPanel('backup-settings-content');
    void invoke({ type: 'get' });
  });
  enabled.addEventListener(
    'change',
    () => void invoke({ type: 'configure', enabled: enabled.checked }),
  );
  byId('backup-create').addEventListener('click', () => void invoke({ type: 'create' }));
  byId('backup-refresh').addEventListener('click', () => void invoke({ type: 'get' }));
  byId('backup-restore').addEventListener(
    'click',
    () => void invoke({ type: 'restore', id: list.value }),
  );
  list.addEventListener('change', updateBusy);
  updateBusy();
  return { updateBusy };
}
