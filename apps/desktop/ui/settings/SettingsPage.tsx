/**
 * The general settings panel: its heading, the form, and the startup-environment list.
 *
 * For now this component is the panel's whole content, mounted into the existing `#general-settings-content`
 * container. The settings *shell* (sidebar navigation and the other three panels) is still the legacy one — those
 * panels migrate in T11–T13, and a React shell that blanked them would be a functional regression rather than a
 * migration. The shell and its page transition follow once every panel is React (T13/T24).
 *
 * The environment list is read through the bridge on mount and whenever the panel is opened, because a save can be
 * the thing that changes it. It is rendered here, not by the old `setupGeneralSettings`, so the panel has one owner.
 */
import type { ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { Stack } from '../primitives.tsx';
import type { ReadableStore } from '../stores.ts';
import { GeneralSettings } from './GeneralSettings.tsx';
import type { GeneralSettingsController } from './settings-model.ts';

export function SettingsPage({
  controller,
  environment,
}: {
  controller: GeneralSettingsController;
  environment: ReadableStore<string | null>;
}): ReactNode {
  useLocale();
  const problems = useReadable(environment);
  return (
    <Stack gap="lg">
      <div className="settings-page-header">
        <div className="eyebrow">
          {t('ui.settingsPage')} / {t('general.title')}
        </div>
        <h2 id="general-settings-title">{t('general.title')}</h2>
        <p>{t('general.description')}</p>
      </div>
      <GeneralSettings controller={controller} />
      {problems ? (
        <section id="general-environment" className="settings-field">
          <h3>{t('general.environment')}</h3>
          <small>{t('general.environmentHint')}</small>
          <p id="general-environment-problems" className="settings-feedback" role="status">
            {problems}
          </p>
        </section>
      ) : null}
    </Stack>
  );
}
