import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { Select } from '../primitives.tsx';
import { pickerOptions } from './model-settings-model.ts';
import { modelPicker } from './model-picker-state.ts';

/**
 * The visible control is the only interactive model picker; selecting settings never sends a model command.
 *
 * The field is sized from the *longest option*, not the selected one: a menu whose entries differ in length would
 * otherwise resize the composer row every time the choice changed. The probe is invisible and never participates in
 * layout; it only gives the labels their real rendered width.
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
  const labels = options.length ? options.map((option) => option.label) : [t('settings.noModel')];
  const labelsKey = labels.join('\n');
  const probe = useRef<HTMLSpanElement>(null);
  const [fieldWidth, setFieldWidth] = useState(150);
  useLayoutEffect(() => {
    const node = probe.current;
    if (!node) return;
    let widest = 0;
    for (const child of node.children)
      widest = Math.max(widest, child.getBoundingClientRect().width);
    const next = Math.min(360, Math.max(150, Math.ceil(widest) + 50));
    setFieldWidth((current) => (current === next ? current : next));
  }, [labelsKey]);
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
        {labels.map((label, index) => (
          <span key={index}>{label}</span>
        ))}
      </span>
      <div className="model-picker-frame" style={{ width: fieldWidth }}>
        <Select
          id="model"
          aria-label={t('ui.switchModel')}
          className="model"
          value={state.view?.connectionId || options[0]?.value || null}
          placeholder={t('settings.noModel')}
          disabled={state.locked}
          data={[...options, { value: '__settings__', label: t('settings.modelEntry') }]}
          comboboxProps={{ width: 'max-content', position: 'bottom-end' }}
          onChange={(value) => {
            if (value && value !== '__environment__') state.choose(value);
          }}
          title={state.view?.model || t('settings.addModelConnection')}
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
