/**
 * Mount the React model settings panel into the legacy settings page.
 *
 * Two seams remain, both temporary and both removed when the settings shell moves (T13/T24):
 *
 * - the legacy page still opens the screen and drives the composer picker, so it announces an open with
 *   `yuantu-settings-open` and this adapter refreshes the form then;
 * - the picker and the form share `modelLock`: the form reports its writes, the picker reports its switches and the
 *   window's run state, and the controller treats either as "locked".
 *
 * The legacy static form is removed with `replaceChildren`; the React form renders the same ids the smoke drives.
 */
import type { DesktopBridge } from '../../contract.ts';
import { registerView } from '../views.tsx';
import { ModelSettings } from './ModelSettings.tsx';
import { modelLock } from './model-lock.ts';
import { createModelSettingsController } from './model-settings-model.ts';

export function mountModelSettings(bridge: DesktopBridge): () => void {
  const content = document.getElementById('model-settings-content');
  if (!content) return () => {};
  const controller = createModelSettingsController({
    bridge: { settings: (command) => bridge.settings(command) },
    onPending: (pending) => modelLock.set({ ...modelLock.getSnapshot(), form: pending }),
  });
  const unsubscribe = modelLock.subscribe(() => {
    const lock = modelLock.getSnapshot();
    controller.setBusy(lock.entry || lock.busy);
  });
  const onOpen = (): void => void controller.refresh();
  window.addEventListener('yuantu-settings-open', onOpen);
  const disposeRegion = registerView('model-settings', <ModelSettings controller={controller} />);
  void controller.refresh();
  return () => {
    unsubscribe();
    window.removeEventListener('yuantu-settings-open', onOpen);
    disposeRegion();
    controller.dispose();
  };
}
