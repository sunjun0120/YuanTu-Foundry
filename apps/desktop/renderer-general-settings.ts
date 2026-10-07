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
    byId<HTMLButtonElement>('general-settings-save').textContent = t('general.save');
  };
  onLocaleChange(translate);
  translate();

  const language = byId<HTMLSelectElement>('ui-language');
  const appearance = byId<HTMLSelectElement>('ui-appearance');
  const fontSize = byId<HTMLSelectElement>('ui-font-size');
  const feedback = byId('general-settings-feedback');
  const save = byId<HTMLButtonElement>('general-settings-save');
  let persisted: UiSettings | undefined;
  let pending = false;

  const current = (): UiSettings => ({
    language: language.value as UiSettings['language'],
    appearance: appearance.value as UiSettings['appearance'],
    fontSize: fontSize.value as UiSettings['fontSize'],
  });
  const fill = (settings: UiSettings) => {
    persisted = settings;
    language.value = settings.language;
    appearance.value = settings.appearance;
    fontSize.value = settings.fontSize;
    apply(settings);
    update();
  };
  const update = () => {
    const changed = persisted && JSON.stringify(current()) !== JSON.stringify(persisted);
    save.disabled = pending || !changed;
    language.disabled = pending;
    appearance.disabled = pending;
    fontSize.disabled = pending;
  };
  const status = (text: string, error = false) => {
    feedback.textContent = text;
    feedback.hidden = !text;
    feedback.classList.toggle('error', error);
  };
  const show = () => {
    showSettingsPanel('general-settings-content');
  };

  for (const control of [language, appearance, fontSize])
    control.addEventListener('change', () => {
      apply(current());
      status('');
      update();
    });
  byId('general-settings').addEventListener('click', show);
  byId<HTMLFormElement>('general-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    pending = true;
    status(t('general.saving'));
    update();
    const reply = await window.yuantu.uiSettings({ type: 'save', settings: current() });
    pending = false;
    if (reply.ok && reply.kind === 'settings') {
      fill(reply.settings);
      status(t('general.saved'));
    } else {
      if (persisted) fill(persisted);
      // A refusal, or an answer to a question this form did not ask: either way the form keeps what it had.
      status(reply.ok ? t('ui.settingsRequestInvalid') : reply.error, true);
    }
    update();
  });
  void window.yuantu.uiSettings({ type: 'get' }).then((reply) => {
    if (reply.ok && reply.kind === 'settings') fill(reply.settings);
    else status(reply.ok ? t('ui.settingsRequestInvalid') : reply.error, true);
  });
  return { show };
}
