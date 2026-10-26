/**
 * The composer's model picker and the settings page's entry — the part of model settings still in the legacy shell.
 *
 * The form itself moved to `ui/settings/ModelSettings.tsx` (T11). What is left here is window-level: the picker in the
 * composer, the "open settings / back to chat" page transition, and the two locks that keep a switch and a save from
 * racing each other (`modelLock`). The picker's `__settings__` entry stays an **action**: it opens the settings page
 * and is restored before any command could carry it as a connection id.
 */
import { locale, onLocaleChange, t } from './i18n.ts';
import { showSettingsPanel } from './renderer-panels.ts';
import type { ModelSettingsView } from './settings-contract.ts';
import { modelLock } from './ui/settings/model-lock.ts';
import { pickerOptions } from './ui/settings/model-settings-model.ts';

export function setupModelSettingsEntry(
  isBusy: () => boolean,
  onBusy: (busy: boolean) => void,
): { updateBusy(): void } {
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
  const page = byId('settings-page');
  const picker = byId<HTMLSelectElement>('model');
  const switchStatus = byId<HTMLElement>('model-switch-status');
  let view: ModelSettingsView | null = null;
  let pending = false;
  let conversationScroll = 0;

  function updateBusy(): void {
    const locked = pending || isBusy() || modelLock.getSnapshot().form;
    picker.disabled = locked;
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
    picker.replaceChildren();
    for (const option of pickerOptions(next, {
      noModel: t('settings.noModel'),
      environment: locale() === 'en-US',
    }))
      picker.add(new Option(option.label, option.value));
    // An action, not a connection: never left in the select's value.
    picker.add(new Option(t('settings.modelEntry'), '__settings__'));
    picker.value = next.connectionId || '';
    picker.title = next.model || t('settings.addModelConnection');
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
    if (page.hidden) conversationScroll = byId('conversation').scrollTop;
    window.dispatchEvent(new CustomEvent('yuantu-settings-open'));
    byId('chat-page').hidden = true;
    byId('chat-sidebar').hidden = true;
    page.hidden = false;
    document.body.dataset.page = 'settings';
    byId(target === 'model' ? 'model-settings' : 'general-settings').dispatchEvent(
      new Event('click'),
    );
    busy(true);
    void refreshPicker().finally(() => busy(false));
    byId<HTMLButtonElement>('settings-back').focus();
  }
  function backToChat(): void {
    if (pending) return;
    switchStatus.hidden = true;
    page.hidden = true;
    byId('chat-page').hidden = false;
    byId('chat-sidebar').hidden = false;
    document.body.dataset.page = 'chat';
    window.dispatchEvent(new CustomEvent('yuantu-settings-close'));
    byId('conversation').scrollTop = conversationScroll;
    byId<HTMLButtonElement>('open-settings').focus();
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

  picker.addEventListener('change', () => {
    const id = picker.value;
    if (id === '__settings__') {
      picker.value = view?.connectionId || '';
      openSettings('model');
      return;
    }
    if (pending || isBusy() || !id || id === view?.connectionId) {
      picker.value = view?.connectionId || '';
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
          picker.value = view?.connectionId || '';
          switchStatus.textContent = reply.error;
        }
      })
      .catch(() => {
        picker.value = view?.connectionId || '';
        switchStatus.textContent = t('settings.connectionError');
      })
      .finally(() => busy(false));
  });

  void refreshPicker();
  return { updateBusy };
}
