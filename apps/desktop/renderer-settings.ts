/**
 * The composer's model picker and the settings page's entry — the part of model settings still in the legacy shell.
 *
 * The form itself moved to `ui/settings/ModelSettings.tsx` (T11). What is left here is window-level: the picker in the
 * composer, the "open settings / back to chat" page transition, and the two locks that keep a switch and a save from
 * racing each other (`modelLock`). The picker's `__settings__` entry stays an **action**: it opens the settings page
 * and is restored before any command could carry it as a connection id.
 */
import { onLocaleChange, t } from './i18n.ts';
import { showSettingsPanel } from './renderer-panels.ts';
import type { ModelSettingsView } from './settings-contract.ts';
import { modelLock } from './ui/settings/model-lock.ts';
import { modelPicker } from './ui/settings/model-picker-state.ts';
import { navigation, showPage } from './ui/navigation.ts';

export function setupModelSettingsEntry(
  isBusy: () => boolean,
  onBusy: (busy: boolean) => void,
): { updateBusy(): void } {
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
  const switchStatus = byId<HTMLElement>('model-switch-status');
  let view: ModelSettingsView | null = null;
  let pending = false;
  let conversationScroll = 0;

  function updateBusy(): void {
    const locked = pending || isBusy() || modelLock.getSnapshot().form;
    modelPicker.set({ ...modelPicker.getSnapshot(), locked });
    byId<HTMLButtonElement>('settings-back').disabled = locked;
    byId<HTMLButtonElement>('open-settings').disabled = locked;
  }
  function busy(value: boolean): void {
    pending = value;
    onBusy(value);
    modelLock.set({ ...modelLock.getSnapshot(), entry: value, busy: isBusy() });
    updateBusy();
  }
  modelLock.subscribe(updateBusy);

  function updatePicker(next: ModelSettingsView): void {
    modelPicker.set({ ...modelPicker.getSnapshot(), view: next });
  }
  async function refreshPicker(): Promise<void> {
    try {
      const reply = await window.yuantu.settings({ type: 'get' });
      if (reply.ok) {
        view = reply.settings;
        updatePicker(reply.settings);
      }
    } catch {
      // The picker keeps whatever it showed; the form reports a real read failure itself.
    }
  }
  const translate = (): void => {
    switchStatus.textContent = switchStatus.hidden ? '' : t('settings.selectHint');
    if (view) updatePicker(view);
  };
  onLocaleChange(translate);

  function openSettings(target: 'general' | 'model' = 'general'): void {
    if (pending) return;
    if (navigation.getSnapshot().page === 'chat')
      conversationScroll = byId('conversation').scrollTop;
    window.dispatchEvent(new CustomEvent('yuantu-settings-open'));
    showPage('settings', conversationScroll);
    byId(target === 'model' ? 'model-settings' : 'general-settings').dispatchEvent(
      new Event('click'),
    );
    void refreshPicker();
  }
  function backToChat(): void {
    if (pending) return;
    switchStatus.hidden = true;
    showPage('chat', conversationScroll);
    window.dispatchEvent(new CustomEvent('yuantu-settings-close'));
    void refreshPicker();
  }
  function showModelPanel(): void {
    if (pending) return;
    showSettingsPanel('model-settings-content');
    document.getElementById('settings-url')?.focus();
  }
  byId('open-settings').addEventListener('click', () => openSettings('general'));
  byId('settings-back').addEventListener('click', backToChat);
  byId('model-settings').addEventListener('click', showModelPanel);

  const choose = (id: string): void => {
    if (id === '__settings__') {
      openSettings('model');
      return;
    }
    if (pending || isBusy() || !id || id === view?.connectionId) {
      return;
    }
    switchStatus.hidden = false;
    switchStatus.textContent = t('settings.selectHint');
    busy(true);
    void window.yuantu
      .settings({ type: 'select', connectionId: id })
      .then((reply) => {
        if (reply.ok) {
          view = reply.settings;
          updatePicker(reply.settings);
          switchStatus.hidden = true;
        } else {
          switchStatus.textContent = reply.error;
        }
      })
      .catch(() => {
        switchStatus.textContent = t('settings.connectionError');
      })
      .finally(() => busy(false));
  };
  modelPicker.set({ ...modelPicker.getSnapshot(), choose });

  void refreshPicker();
  return { updateBusy };
}
