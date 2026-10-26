/**
 * The general settings form's state, as a controller with no DOM in it.
 *
 * The old renderer owned this logic inside `setupGeneralSettings` and was driven by a hand-written fake document in
 * the test, which is how the interesting property was never really tested: a *rejected* save (the IPC channel is
 * gone, or the main-process handler threw) must still release the in-flight flag. An `await` that throws before the
 * reset swallowed every later change for the rest of the window's life.
 *
 * The controller keeps three facts apart, which is the whole difficulty of the form:
 *
 * - **persisted** — what the main process last confirmed;
 * - **draft** — what the controls show, which may be newer than anything confirmed;
 * - **error** — the last save/read failure, cleared by the next success.
 *
 * Saves are serialised: while one is in flight, a change only marks that another is wanted. When the answer
 * arrives, the stored copy moves forward but a newer draft stays on screen; only an idle form is filled from the
 * reply. A failure puts the draft back to the persisted value and says why, so the page never shows a value that is
 * not stored.
 */
import type { DesktopBridge } from '../../contract.ts';
import { t } from '../../i18n.ts';
import { defaultUiSettings, type UiSettings } from '../../ui-settings.ts';
import { createStore, type ReadableStore } from '../stores.ts';

export interface GeneralSettingsState {
  persisted: UiSettings;
  draft: UiSettings;
  saving: boolean;
  error: string | null;
  /** False until the first read answered, successfully or not. */
  loaded: boolean;
}

export interface GeneralSettingsController {
  readonly store: ReadableStore<GeneralSettingsState>;
  /** Read the stored settings once; the caller may call this again to retry. */
  load(): Promise<void>;
  /** Show the change at once (language, theme, size are visible immediately) and persist it. */
  change(patch: Partial<UiSettings>): void;
  dispose(): void;
}

export function createGeneralSettingsController(deps: {
  bridge: Pick<DesktopBridge, 'uiSettings'>;
  /** Apply settings to the document (language, appearance, size); called for the draft and for a rollback. */
  apply(settings: UiSettings): void;
}): GeneralSettingsController {
  const store = createStore<GeneralSettingsState>({
    persisted: defaultUiSettings(),
    draft: defaultUiSettings(),
    saving: false,
    error: null,
    loaded: false,
  });
  let saving = false;
  let again = false;
  let disposed = false;

  const update = (patch: Partial<GeneralSettingsState>): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), ...patch });
  };
  const fill = (settings: UiSettings): void => {
    deps.apply(settings);
    update({ persisted: settings, draft: settings, error: null, loaded: true });
  };
  const fail = (message: string): void => {
    const { persisted } = store.getSnapshot();
    deps.apply(persisted);
    update({ draft: persisted, error: message });
  };
  const messageOf = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : t('ui.operationFailed');

  const load = async (): Promise<void> => {
    try {
      const reply = await deps.bridge.uiSettings({ type: 'get' });
      if (disposed) return;
      if (reply.ok && reply.kind === 'settings') fill(reply.settings);
      else update({ error: reply.ok ? t('ui.settingsRequestInvalid') : reply.error, loaded: true });
    } catch (error) {
      if (disposed) return;
      update({ error: messageOf(error), loaded: true });
    }
  };

  const save = async (): Promise<void> => {
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    update({ saving: true });
    try {
      do {
        again = false;
        const { draft, persisted } = store.getSnapshot();
        if (JSON.stringify(draft) === JSON.stringify(persisted)) continue;
        try {
          const reply = await deps.bridge.uiSettings({ type: 'save', settings: draft });
          if (disposed) return;
          if (reply.ok && reply.kind === 'settings') {
            // A newer edit waiting to be sent stays on screen; only the stored copy moves forward.
            if (again) update({ persisted: reply.settings, error: null });
            else fill(reply.settings);
          } else {
            again = false;
            fail(reply.ok ? t('ui.settingsRequestInvalid') : reply.error);
          }
        } catch (error) {
          again = false;
          fail(messageOf(error));
        }
      } while (again);
    } finally {
      saving = false;
      update({ saving: false });
    }
  };

  return {
    store,
    load,
    change(patch) {
      const draft = { ...store.getSnapshot().draft, ...patch };
      deps.apply(draft);
      update({ draft });
      void save();
    },
    dispose() {
      disposed = true;
    },
  };
}
