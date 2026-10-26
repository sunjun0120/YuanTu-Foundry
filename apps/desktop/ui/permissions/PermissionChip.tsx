/**
 * The composer's permission chip: one trigger, one menu of rungs, and the machine-readable select the smoke reads.
 *
 * The rungs come from `permission-model.ts`; this file only draws them and moves focus. `custom` is rendered as a
 * reading in the menu footer, never as a button: it has no target to apply.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { CUSTOM_PRESET, type PermissionPresetId } from '../../permission-presets.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import {
  chipLabel,
  chipTitle,
  customReading,
  permissionBoundary,
  permissionIds,
  permissionLabel,
  permissionLocked,
  permissionReading,
  permissionSummary,
  type PermissionController,
  type PermissionReading,
} from './permission-model.ts';

const SHIELD = 'm12 3 8 4v6c0 4-4 7-8 9-4-2-8-5-8-9V7l8-4Z';
const ICONS: Record<PermissionReading, string[]> = {
  observe: [`${SHIELD}`, 'm9.2 12.1 1.9 1.9 3.7-3.7'],
  guarded: [`${SHIELD}`, 'm15.1 9.6 1.3 1.3-4.4 4.4-1.9.6.6-1.9z'],
  auto: [`${SHIELD}`, 'm9 10.2 2 1.8-2 1.8', 'M12.6 14.4h2.6'],
  unconfined: [`${SHIELD}`, 'M12 10.2v3.6', 'M12 16.4h.01'],
  custom: [`${SHIELD}`, 'M12 10.2v3.6', 'M12 16.4h.01'],
};

function PresetIcon({ reading }: { reading: PermissionReading }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[reading].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

export function PermissionChip({
  controller,
  windowsHost,
}: {
  controller: PermissionController;
  windowsHost: boolean;
}): ReactNode {
  useLocale();
  const state = useReadable(controller.store);
  const reading = permissionReading(state);
  const locked = permissionLocked(state);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const custom = customReading(state);

  // Mirror the current reading into the hidden select and let a native change run the same `choose` a click does.
  useEffect(() => {
    if (select.current && select.current.value !== reading) select.current.value = reading;
  }, [reading]);
  useEffect(() => {
    const element = select.current;
    if (!element) return;
    const onChange = (): void => controller.choose(element.value as PermissionReading);
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, [controller]);

  // The open menu owns the keyboard: focus the current rung, close on Escape or a click outside.
  useEffect(() => {
    if (!state.menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onPointer = (event: PointerEvent): void => {
      if (!container.current?.contains(event.target as Node)) controller.closeMenu();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      controller.closeMenu();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [state.menuOpen, controller]);

  const moveFocus = (direction: 1 | -1): void => {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + direction + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={container}>
      <div className="permission-picker">
        <button
          ref={trigger}
          id="permission-trigger"
          type="button"
          aria-label={t('permission.aria')}
          aria-haspopup="menu"
          aria-expanded={state.menuOpen}
          aria-controls="permission-menu"
          disabled={state.pending || !state.ready}
          data-preset={state.unreadable ? 'unknown' : reading}
          title={chipTitle(state, windowsHost)}
          onClick={() => controller.toggleMenu()}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            if (!state.menuOpen) controller.toggleMenu();
            // The menu's focus effect runs after the state change; the key's direction is kept for the first item.
            requestAnimationFrame(() => {
              const buttons = [
                ...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []),
              ];
              if (event.key === 'ArrowDown') buttons[0]?.focus();
              else buttons.at(-1)?.focus();
            });
          }}
        >
          <PresetIcon reading={state.unreadable ? 'custom' : reading} />
          <span>{chipLabel(state)}</span>
        </button>
        <div
          ref={menu}
          id="permission-menu"
          role="menu"
          aria-label={t('permission.aria')}
          hidden={!state.menuOpen}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Tab') controller.closeMenu();
          }}
        >
          <p className="permission-heading" role="presentation">
            {t('permission.heading')}
          </p>
          {permissionIds().map((id: PermissionPresetId) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              data-preset={id}
              aria-checked={reading === id}
              title={permissionBoundary(id, state.view?.sandbox.mode, windowsHost)}
              disabled={locked}
              onClick={() => {
                controller.closeMenu();
                controller.choose(id);
              }}
            >
              <PresetIcon reading={id} />
              <span className="permission-copy">
                <span>{permissionLabel(id)}</span>
                <small>{permissionSummary(id)}</small>
              </span>
              <span className="permission-check">{reading === id ? '✓' : ''}</span>
            </button>
          ))}
          <div className="permission-environment" role="presentation">
            <p id="permission-custom" hidden={custom.hidden} title={custom.title}>
              {custom.text}
            </p>
          </div>
        </div>
      </div>
      {/*
        The machine-readable current value; the menu is the visible control.
        Deliberately **not** a React-controlled `<select>`: React installs a value tracker on a controlled select, so
        a programmatic `el.value = …` (which the smoke uses to drive the same path a click does) is treated as "no
        change" and its change event is ignored. The value is mirrored imperatively instead, and a native listener
        runs the same `choose` a menu click runs.
      */}
      <select
        ref={select}
        id="permission-mode"
        aria-label={t('permission.aria')}
        data-native
        hidden
        disabled={locked}
        defaultValue={reading}
      >
        {permissionIds().map((id) => (
          <option key={id} value={id}>
            {permissionLabel(id)}
          </option>
        ))}
        <option value={CUSTOM_PRESET}>{permissionLabel(CUSTOM_PRESET)}</option>
      </select>
    </div>
  );
}
