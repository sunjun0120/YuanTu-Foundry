/**
 * The composer's model picker and the settings page's entry — the part of model settings still in the legacy shell.
 *
 * The form itself moved to `ui/settings/ModelSettings.tsx` (T11). What is left here is window-level: the picker in the
 * composer, the "open settings / back to chat" page transition, and the two locks that keep a switch and a save from
 * racing each other (`modelLock`). The picker's `__settings__` entry stays an **action**: it opens the settings page
 * and is restored before any command could carry it as a connection id.
 */
import { showSettingsPanel } from './navigation.ts';
import type { ModelSettingsView } from '../../settings-contract.ts';
import { modelLock } from './model-lock.ts';
import { modelPicker } from './model-picker-state.ts';
import { navigation, showPage } from '../navigation.ts';

export function connectModelSelection(
  isBusy: () => boolean,
  onBusy: (busy: boolean) => void,
): {
  updateBusy(): void;
  updateSession(sessionId: string | null, model: string, connectionId?: string): void;
  dispose(): void;
} {
  const lifecycle = new AbortController();
  let disposed = false;
  let requestEpoch = 0;
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
  let view: ModelSettingsView | null = null;
  let pending = false;
  let conversationScroll = 0;
  let sessionKey = '';
  let refreshAfterSelection = false;

  function updateBusy(): void {
    if (disposed) return;
    const locked = pending || isBusy() || modelLock.getSnapshot().form;
    if (modelPicker.getSnapshot().locked !== locked)
      modelPicker.set({ ...modelPicker.getSnapshot(), locked });
  }
  function busy(value: boolean): void {
    if (disposed) return;
    pending = value;
    onBusy(value);
    modelLock.set({ ...modelLock.getSnapshot(), entry: value, busy: isBusy() });
    updateBusy();
  }
  const stopLock = modelLock.subscribe(updateBusy);

  function updatePicker(next: ModelSettingsView): void {
    modelPicker.set({ ...modelPicker.getSnapshot(), view: next });
  }
  async function refreshPicker(): Promise<void> {
    const epoch = ++requestEpoch;
    try {
      const reply = await window.yuantu.settings({ type: 'get' });
      if (!disposed && epoch === requestEpoch && reply.ok) {
        view = reply.settings;
        updatePicker(reply.settings);
      }
    } catch {
      // The picker keeps whatever it showed; the form reports a real read failure itself.
    }
  }

  function openSettings(target: 'general' | 'model' = 'general'): void {
    if (disposed || pending) return;
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
    if (disposed || pending) return;
    modelPicker.set({ ...modelPicker.getSnapshot(), status: null });
    showPage('chat', conversationScroll);
    window.dispatchEvent(new CustomEvent('yuantu-settings-close'));
    void refreshPicker();
  }
  function showModelPanel(): void {
    if (disposed || pending) return;
    showSettingsPanel('model-settings-content');
    document.getElementById('settings-url')?.focus();
  }
  byId('open-settings').addEventListener('click', () => openSettings('general'), {
    signal: lifecycle.signal,
  });
  byId('settings-back').addEventListener('click', backToChat, { signal: lifecycle.signal });
  byId('model-settings').addEventListener('click', showModelPanel, { signal: lifecycle.signal });

  const choose = (id: string): void => {
    if (disposed) return;
    if (id === '__settings__') {
      openSettings('model');
      return;
    }
    if (pending || isBusy() || !id || id === view?.connectionId) {
      return;
    }
    modelPicker.set({ ...modelPicker.getSnapshot(), status: null });
    busy(true);
    const epoch = ++requestEpoch;
    void window.yuantu
      .settings({ type: 'select', connectionId: id })
      .then((reply) => {
        if (disposed || epoch !== requestEpoch) return;
        if (reply.ok) {
          view = reply.settings;
          updatePicker(reply.settings);
          modelPicker.set({ ...modelPicker.getSnapshot(), status: null });
        } else {
          modelPicker.set({ ...modelPicker.getSnapshot(), status: { text: reply.error } });
        }
      })
      .catch(() => {
        if (disposed || epoch !== requestEpoch) return;
        modelPicker.set({
          ...modelPicker.getSnapshot(),
          status: { key: 'settings.connectionError' },
        });
      })
      .finally(() => {
        busy(false);
        if (refreshAfterSelection) {
          refreshAfterSelection = false;
          void refreshPicker();
        }
      });
  };
  modelPicker.set({ ...modelPicker.getSnapshot(), choose });

  void refreshPicker();
  return {
    updateBusy,
    updateSession(sessionId, model, connectionId) {
      const key = JSON.stringify([sessionId, model, connectionId]);
      if (key === sessionKey) return;
      sessionKey = key;
      if (pending) refreshAfterSelection = true;
      else void refreshPicker();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      requestEpoch++;
      lifecycle.abort();
      stopLock();
    },
  };
}
