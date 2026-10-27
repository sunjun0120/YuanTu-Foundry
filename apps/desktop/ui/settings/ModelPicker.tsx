import type { ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { Select } from '../primitives.tsx';
import { pickerOptions } from './model-settings-model.ts';
import { modelPicker } from './model-picker-state.ts';

/** The visible control is the only interactive model picker; selecting settings never sends a model command. */
export function ModelPicker(): ReactNode {
  const lang = useLocale();
  const state = useReadable(modelPicker);
  const options = state.view
    ? pickerOptions(state.view, {
        noModel: t('settings.noModel'),
        environment: lang === 'en-US',
      }).map((option) => ({
        ...option,
        value: option.value || '__environment__',
        disabled: !option.value,
      }))
    : [];
  return (
    <Select
      id="model"
      aria-label={t('ui.switchModel')}
      className="model-chip"
      value={state.view?.connectionId || options[0]?.value || null}
      placeholder={t('settings.noModel')}
      disabled={state.locked}
      data={[...options, { value: '__settings__', label: t('settings.modelEntry') }]}
      onChange={(value) => {
        if (value && value !== '__environment__') state.choose(value);
      }}
      title={state.view?.model || t('settings.addModelConnection')}
    />
  );
}
