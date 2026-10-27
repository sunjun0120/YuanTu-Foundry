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
import type { GeneralSettingsController } from './settings-model.ts';

const languageData = (): { value: UiLanguage; label: string }[] => [
  { value: 'zh-CN', label: t('general.languageZh') },
  { value: 'en-US', label: t('general.languageEn') },
];
const appearanceData = (): { value: UiAppearance; label: string }[] => [
  { value: 'system', label: t('general.appearanceSystem') },
  { value: 'light', label: t('general.appearanceLight') },
  { value: 'dark', label: t('general.appearanceDark') },
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
    <Stack gap={0} className="settings-form-rows settings-card">
      <Select
        id="ui-language"
        className="settings-row"
        label={t('general.language')}
        description={t('general.languageNote')}
        data={languageData()}
        value={state.draft.language}
        allowDeselect={false}
        onChange={(value) => {
          if (value) controller.change({ language: value as UiLanguage });
        }}
      />
      <Select
        id="ui-appearance"
        className="settings-row"
        label={t('general.appearance')}
        description={t('general.appearanceNote')}
        data={appearanceData()}
        value={state.draft.appearance}
        allowDeselect={false}
        onChange={(value) => {
          if (value) controller.change({ appearance: value as UiAppearance });
        }}
      />
      <Select
        id="ui-font-size"
        className="settings-row"
        label={t('general.fontSize')}
        description={t('general.fontSizeNote')}
        data={fontSizeData()}
        value={state.draft.fontSize}
        allowDeselect={false}
        onChange={(value) => {
          if (value) controller.change({ fontSize: value as UiFontSize });
        }}
      />
      <Switch
        id="ui-notifications"
        className="settings-row-switch"
        label={t('general.notifications')}
        description={t('general.notificationsNote')}
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
