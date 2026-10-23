import { showSettingsPanel } from './renderer-panels.ts';
import type { UiSettings } from './ui-settings.ts';
import { setLocale, t, onLocaleChange } from './i18n.ts';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

function apply(settings: UiSettings): void {
  document.documentElement.lang = settings.language;
  setLocale(settings.language);
  document.documentElement.dataset.theme = settings.appearance;
  document.documentElement.dataset.fontSize = settings.fontSize;
}

export function setupGeneralSettings(): { show(): void } {
  const page = byId('settings-page');
  page.addEventListener(
    'pointerdown',
    () => {
      page.dataset.input = 'pointer';
    },
    true,
  );
  page.addEventListener(
    'keydown',
    () => {
      page.dataset.input = 'keyboard';
    },
    true,
  );
  const translate = () => {
    byId('settings-page').setAttribute('aria-label', t('ui.settingsPage'));
    byId('settings-page').querySelector<HTMLElement>('.settings-sidebar h1')!.textContent =
      t('ui.settings');
    byId('settings-page')
      .querySelector<HTMLElement>('.settings-sidebar nav')!
      .setAttribute('aria-label', t('ui.settingsMenu'));
    byId('general-settings-title').textContent = t('general.title');
    byId('general-settings-content').querySelector<HTMLElement>(
      '.settings-page-header p',
    )!.textContent = t('general.description');
    const labels = byId('general-settings-form').querySelectorAll('label');
    labels[0]!.firstChild!.textContent = t('general.language');
    labels[1]!.firstChild!.textContent = t('general.appearance');
    labels[2]!.firstChild!.textContent = t('general.fontSize');
    byId('general-settings-form').querySelectorAll('small')[0]!.textContent =
      t('general.languageNote');
    byId('general-settings-form').querySelectorAll('small')[1]!.textContent =
      t('general.appearanceNote');
    byId('general-settings-form').querySelectorAll('small')[2]!.textContent =
      t('general.fontSizeNote');
    byId<HTMLSelectElement>('ui-language').options[0]!.textContent = t('general.languageZh');
    byId<HTMLSelectElement>('ui-language').options[1]!.textContent = t('general.languageEn');
    byId<HTMLSelectElement>('ui-appearance').options[0]!.textContent = t(
      'general.appearanceSystem',
    );
    byId<HTMLSelectElement>('ui-appearance').options[1]!.textContent = t('general.appearanceLight');
    byId<HTMLSelectElement>('ui-appearance').options[2]!.textContent = t('general.appearanceDark');
    byId<HTMLSelectElement>('ui-font-size').options[0]!.textContent = t('general.fontSmall');
    byId<HTMLSelectElement>('ui-font-size').options[1]!.textContent = t('general.fontMedium');
    byId<HTMLSelectElement>('ui-font-size').options[2]!.textContent = t('general.fontLarge');
    byId('ui-notifications-title').textContent = t('general.notifications');
    byId('ui-notifications-note').textContent = t('general.notificationsNote');
  };
  onLocaleChange(translate);
  translate();

  const language = byId<HTMLSelectElement>('ui-language');
  const appearance = byId<HTMLSelectElement>('ui-appearance');
  const fontSize = byId<HTMLSelectElement>('ui-font-size');
  const notifications = byId<HTMLInputElement>('ui-notifications');
  const feedback = byId('general-settings-feedback');
  let persisted: UiSettings | undefined;
  // One save in flight at a time; a change made meanwhile is sent once that save answers.
  let saving = false;
  let again = false;

  const current = (): UiSettings => ({
    language: language.value as UiSettings['language'],
    appearance: appearance.value as UiSettings['appearance'],
    fontSize: fontSize.value as UiSettings['fontSize'],
    notifications: notifications.checked,
  });
  const fill = (settings: UiSettings) => {
    persisted = settings;
    language.value = settings.language;
    appearance.value = settings.appearance;
    fontSize.value = settings.fontSize;
    notifications.checked = settings.notifications;
    apply(settings);
  };
  const status = (text: string, error = false) => {
    feedback.textContent = text;
    feedback.hidden = !text;
    feedback.classList.toggle('error', error);
  };
  const show = () => {
    showSettingsPanel('general-settings-content');
  };
  /**
   * Every change is saved as it is made. A failed save — a refusal, or a promise that rejects because the answer
   * never arrived — puts the form back to what is persisted and says why, so the page never shows a value that
   * is not stored. `saving` is released on every path, the throwing one included: a save that never answers
   * must not swallow every later change.
   */
  const save = async (): Promise<void> => {
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    try {
      do {
        again = false;
        const settings = current();
        if (persisted && JSON.stringify(settings) === JSON.stringify(persisted)) continue;
        try {
          const reply = await window.yuantu.uiSettings({ type: 'save', settings });
          if (reply.ok && reply.kind === 'settings') {
            // A newer edit waiting to be sent stays on screen; only the stored copy moves forward.
            if (again) persisted = reply.settings;
            else fill(reply.settings);
            status('');
          } else {
            again = false;
            if (persisted) fill(persisted);
            // A refusal, or an answer to a question this form did not ask: either way the form keeps what it had.
            status(reply.ok ? t('ui.settingsRequestInvalid') : reply.error, true);
          }
        } catch (error) {
          again = false;
          if (persisted) fill(persisted);
          status(
            error instanceof Error && error.message ? error.message : t('ui.operationFailed'),
            true,
          );
        }
      } while (again);
    } finally {
      saving = false;
    }
  };

  for (const control of [language, appearance, fontSize, notifications])
    control.addEventListener('change', () => {
      apply(current());
      void save();
    });
  byId('general-settings').addEventListener('click', show);
  byId<HTMLFormElement>('general-settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
  });
  void window.yuantu.uiSettings({ type: 'get' }).then((reply) => {
    if (reply.ok && reply.kind === 'settings') fill(reply.settings);
    else status(reply.ok ? t('ui.settingsRequestInvalid') : reply.error, true);
  });
  return { show };
}
