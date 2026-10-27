import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { Select } from '../primitives.tsx';
import { pickerOptions } from './model-settings-model.ts';
import { modelFieldWidth, modelPicker } from './model-picker-state.ts';

/**
 * The visible control is the only interactive model picker; selecting settings never sends a model command.
 *
 * The field is sized from the *selected* label: the arrow stays close to the text, while the menu keeps its own
 * `max-content` width so every model name stays readable. The probe is invisible and never participates in layout;
 * it only gives the selected label its real rendered width.
 */
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
  const selectedValue = state.view?.connectionId || options[0]?.value || null;
  const selectedLabel =
    options.find((option) => option.value === selectedValue)?.label ??
    options[0]?.label ??
    t('settings.noModel');
  const probe = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState(0);
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) setFontTick((value) => value + 1);
    });
    return () => {
      live = false;
    };
  }, []);
  useLayoutEffect(() => {
    const node = probe.current;
    if (!node) return;
    const width = node.getBoundingClientRect().width;
    setMeasured((current) => (current === width ? current : width));
  }, [selectedLabel, lang, state.locked, fontTick]);
  const { width: fieldWidth, compact } = modelFieldWidth(measured);
  const status = state.status;
  const statusText =
    !status || ('key' in status && status.key === 'settings.selectHint')
      ? ''
      : 'key' in status
        ? t(status.key)
        : status.text;
  return (
    <>
      <span ref={probe} className="model-width-probe" aria-hidden="true">
        {selectedLabel}
      </span>
      <div
        className="model-picker-frame"
        data-compact={compact ? 'true' : undefined}
        style={{ width: fieldWidth }}
      >
        <Select
          id="model"
          aria-label={t('ui.switchModel')}
          className="model"
          value={selectedValue}
          placeholder={t('settings.noModel')}
          disabled={state.locked}
          data={[...options, { value: '__settings__', label: t('settings.modelEntry') }]}
          comboboxProps={{ width: 'max-content', position: 'bottom-end' }}
          rightSectionWidth={24}
          onChange={(value) => {
            if (value && value !== '__environment__') state.choose(value);
          }}
          title={selectedLabel}
        />
      </div>
      <span
        id="model-switch-status"
        className="model-switch-status"
        role="status"
        hidden={!statusText}
      >
        {statusText}
      </span>
    </>
  );
}
