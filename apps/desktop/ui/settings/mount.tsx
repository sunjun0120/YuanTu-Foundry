/**
 * The legacy-to-React seam for the general settings panel.
 *
 * The settings page is still the legacy shell (the other three panels have not moved), so this adapter does the four
 * things that belong to the page rather than to the form, and then hands the panel's container to React:
 *
 * 1. it empties `#general-settings-content` — the static form in `index.html` must not stay beside the React form;
 * 2. it keeps the page-level chrome translated (the page's own label, the sidebar heading, the navigation's label),
 *    which used to live in `setupGeneralSettings`;
 * 3. it wires the sidebar's "general" button to the one panel switcher and refreshes the environment list;
 * 4. it applies a settings change to the document (language, appearance, size), the same projection the legacy
 *    controller performed — the provider already follows those attributes.
 */
import type { DesktopBridge } from '../../contract.ts';
import { onLocaleChange, setLocale, t } from '../../i18n.ts';
import { showSettingsPanel } from '../../renderer-panels.ts';
import { registerView } from '../views.tsx';
import { createStore } from '../stores.ts';
import type { UiSettings } from '../../ui-settings.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { createGeneralSettingsController } from './settings-model.ts';

/** The document projection every settings change goes through; the React provider reads the same attributes. */
export function applyUiSettings(settings: UiSettings): void {
  document.documentElement.lang = settings.language;
  setLocale(settings.language);
  document.documentElement.dataset.theme = settings.appearance;
  document.documentElement.dataset.fontSize = settings.fontSize;
}

export function mountGeneralSettings(bridge: DesktopBridge): () => void {
  const content = document.getElementById('general-settings-content');
  if (!content) return () => {};
  const page = document.getElementById('settings-page');
  const sidebar = page?.querySelector<HTMLElement>('.settings-sidebar h1');
  const navigation = page?.querySelector<HTMLElement>('.settings-sidebar nav');
  // The legacy page tracked the input modality so focus rings only appear for keyboard use; CSS still reads it.
  const pointer = () => {
    if (page) page.dataset.input = 'pointer';
  };
  const keyboard = () => {
    if (page) page.dataset.input = 'keyboard';
  };
  page?.addEventListener('pointerdown', pointer, true);
  page?.addEventListener('keydown', keyboard, true);
  const controller = createGeneralSettingsController({
    bridge: { uiSettings: (command) => bridge.uiSettings(command) },
    apply: applyUiSettings,
  });
  const environment = createStore<string | null>(null);
  const refreshEnvironment = async (): Promise<void> => {
    try {
      const reply = await bridge.settings({ type: 'get' });
      environment.set(reply.ok ? reply.settings.environmentProblems?.join('\n') || null : null);
    } catch {
      environment.set(null);
    }
  };
  const translateChrome = (): void => {
    page?.setAttribute('aria-label', t('ui.settingsPage'));
    if (sidebar) sidebar.textContent = t('ui.settings');
    navigation?.setAttribute('aria-label', t('ui.settingsMenu'));
  };
  onLocaleChange(translateChrome);
  translateChrome();

  const disposeRegion = registerView(
    'general-settings',
    <SettingsPage controller={controller} environment={environment} />,
  );
  const show = (): void => {
    showSettingsPanel('general-settings-content');
    void refreshEnvironment();
  };
  const button = document.getElementById('general-settings');
  button?.addEventListener('click', show);
  void controller.load();
  void refreshEnvironment();

  return () => {
    disposeRegion();
    controller.dispose();
    button?.removeEventListener('click', show);
    page?.removeEventListener('pointerdown', pointer, true);
    page?.removeEventListener('keydown', keyboard, true);
  };
}
