/**
 * The general settings form, rendered from the controller rather than owning any state itself.
 *
 * Every change is applied immediately (language, appearance and size are visible as you pick them) and saved by the
 * controller, which serialises the writes and rolls the form back with a message when a save is refused or the
 * channel rejects. The component only reads the draft and calls `change`, so a StrictMode remount or a second
 * render cannot duplicate a save: the controller owns the in-flight state, not the component.
 */
import type { ReactNode } from 'react';
import { t } from '../../i18n.ts';
import type { UiAppearance, UiFontSize, UiLanguage } from '../../ui-settings.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { Alert, Select, Stack, Switch } from '../primitives.tsx';
import { AssetIcon } from '../icons/AssetIcon.tsx';
import type { GeneralSettingsController } from './settings-model.ts';

const languageData = (): { value: UiLanguage; label: string }[] => [
  { value: 'zh-CN', label: t('general.languageZh') },
  { value: 'en-US', label: t('general.languageEn') },
];
const appearanceData = (): {
  value: UiAppearance;
  label: string;
  icon: 'sun' | 'moon' | 'monitor';
}[] => [
  { value: 'light', label: t('general.appearanceLight'), icon: 'sun' },
  { value: 'dark', label: t('general.appearanceDark'), icon: 'moon' },
  { value: 'system', label: t('general.appearanceSystem'), icon: 'monitor' },
];
const fontSizeData = (): { value: UiFontSize; label: string }[] => [
  { value: 'small', label: t('general.fontSmall') },
  { value: 'medium', label: t('general.fontMedium') },
  { value: 'large', label: t('general.fontLarge') },
];

export function GeneralSettings({
  controller,
}: {
  controller: GeneralSettingsController;
}): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  return (
    <Stack gap={0} className="settings-form-rows general-settings-form">
      <section className="settings-group">
        <Select
          id="ui-language"
          className="settings-language"
          label={t('general.language')}
          data={languageData()}
          value={state.draft.language}
          allowDeselect={false}
          onChange={(value) => {
            if (value) controller.change({ language: value as UiLanguage });
          }}
        />
      </section>
      <section className="settings-group">
        <h3 id="ui-appearance-label">{t('general.appearance')}</h3>
        <div
          id="ui-appearance"
          className="appearance-options"
          role="group"
          aria-labelledby="ui-appearance-label"
        >
          {appearanceData().map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={state.draft.appearance === item.value}
              data-value={item.value}
              onClick={() => controller.change({ appearance: item.value })}
            >
              <AssetIcon name={item.icon} size={19} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <h3 id="ui-font-size-label">{t('general.fontSize')}</h3>
        <div
          id="ui-font-size"
          className="font-options"
          role="group"
          aria-labelledby="ui-font-size-label"
        >
          {fontSizeData().map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={state.draft.fontSize === item.value}
              data-value={item.value}
              onClick={() => controller.change({ fontSize: item.value })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <Switch
        id="ui-notifications"
        className="settings-group settings-notification"
        label={t('general.notifications')}
        checked={state.draft.notifications}
        onChange={(event) => controller.change({ notifications: event.currentTarget.checked })}
      />
      {state.error ? (
        <Alert color="red" role="status" aria-live="polite" data-settings-error="">
          {state.error}
        </Alert>
      ) : null}
    </Stack>
  );
}
