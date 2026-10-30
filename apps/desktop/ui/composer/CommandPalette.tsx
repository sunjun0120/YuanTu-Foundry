/**
 * The command palette above the composer.
 *
 * Rows come from `command-model.ts`, so the menu and the typed slash form share one vocabulary. The composer's
 * textarea stays legacy for now (the composer region moves after attachments), so this component owns the menu
 * only; the adapter outside React keeps the textarea's value and `aria-activedescendant` in step.
 */
import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { paletteItems, type CommandPaletteController, type PaletteItem } from './command-model.ts';

export function CommandPalette({
  controller,
}: {
  controller: CommandPaletteController;
}): ReactNode {
  const language = useLocale();
  const state = useReadable(controller.store);
  const items = paletteItems(state.text, state.dismissed, state.skills);
  const open = items.length > 0 && !state.disabled;
  const menu = useRef<HTMLDivElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const selectedItem = items[state.selected];
  const selectedKey = selectedItem ? `${selectedItem.kind}:${selectedItem.value}` : undefined;
  useLayoutEffect(() => {
    const list = menu.current;
    const option = activeOption.current;
    if (!open || !list || !option) return;
    // Keep virtual focus on screen after React has selected the new row. Scroll only the palette:
    // scrollIntoView would also move ancestor conversation containers and the prompt must retain focus.
    const bounds = list.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    const top = bounds.top + list.clientTop;
    const bottom = top + list.clientHeight;
    if (row.top < top) list.scrollTop += row.top - top;
    else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
  }, [open, state.selected, state.text, selectedKey, language]);
  return (
    <div
      ref={menu}
      id="command-menu"
      className="command-menu"
      role="listbox"
      aria-label={t('ui.commandAndSkills')}
      hidden={!open}
      aria-activedescendant={open ? `command-option-${state.selected}` : undefined}
    >
      {open
        ? items.map((item: PaletteItem, index) => {
            const previous = items[index - 1];
            const header = index === 0 || previous?.kind !== item.kind;
            return (
              <Fragment key={`${item.kind}:${item.value}`}>
                {header ? (
                  <div className="command-menu-group">
                    {item.kind === 'command' ? t('ui.commands') : t('ui.skills')}
                  </div>
                ) : null}
                <button
                  ref={index === state.selected ? activeOption : undefined}
                  id={`command-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === state.selected}
                  className={index === state.selected ? 'selected' : ''}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => controller.choose(item)}
                >
                  <strong>{item.kind === 'command' ? `/${item.value}` : item.name}</strong>
                  <small>{item.description}</small>
                </button>
              </Fragment>
            );
          })
        : null}
    </div>
  );
}
