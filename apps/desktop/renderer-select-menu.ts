/**
 * Every `<select>` in the window, drawn as the composer's permission menu is drawn.
 *
 * Chromium paints a native select's popup in the platform's own chrome, which matches neither theme nor the
 * permission chip next to the model chip. Rather than rewrite each form, the native select stays the source of
 * truth — renderers keep reading `.value`, setting it, filling its options and listening for `change` — and a
 * button plus a popover menu are laid over it. Choosing an item sets the select and fires `input` and `change`
 * the way a pointer would; anything the renderers do to the select is mirrored back onto the button.
 *
 * A select opts out with `data-native` (the permission chip's hidden machine-readable value is one), and
 * multi-line selects (`multiple`, `size > 1`) are left alone: they are lists, not menus.
 */

const upgraded = new WeakSet<HTMLSelectElement>();
const CHEVRON =
  '<svg class="select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
let open: { close(focus: boolean): void; popup: HTMLElement } | null = null;

function upgrade(select: HTMLSelectElement): void {
  if (upgraded.has(select) || select.multiple || select.size > 1 || 'native' in select.dataset)
    return;
  // A select inside a React region belongs to React: wrapping it in a button would move the node React owns.
  if (select.closest('[data-react-owned]')) return;
  upgraded.add(select);
  const wrap = document.createElement('span');
  const trigger = document.createElement('button');
  const label = document.createElement('span');
  const popup = document.createElement('div');
  trigger.type = 'button';
  trigger.className = 'select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  label.className = 'select-trigger-label';
  trigger.append(label);
  trigger.insertAdjacentHTML('beforeend', CHEVRON);
  popup.className = 'select-popup';
  popup.setAttribute('role', 'listbox');
  popup.popover = 'manual';
  wrap.className = 'select-menu';
  select.replaceWith(wrap);
  wrap.append(select, trigger, popup);
  select.classList.add('select-native');
  select.tabIndex = -1;

  /** The select's own name, so a screen reader hears the field rather than only its value. */
  const name = () =>
    select.getAttribute('aria-label') ||
    [...(select.labels ?? [])]
      .map((owner) =>
        // A label may wrap the field and its note; only its own words name it.
        [...owner.childNodes]
          .filter((node) => !node.contains(wrap) && node.nodeName !== 'SMALL')
          .map((node) => node.textContent ?? '')
          .join('')
          .trim(),
      )
      .find(Boolean) ||
    '';
  function paint(): void {
    wrap.hidden = select.hidden;
    const current = select.selectedOptions[0];
    label.textContent = current?.textContent ?? '';
    trigger.title = select.title || (current?.textContent ?? '');
    trigger.disabled = select.disabled;
    const aria = name();
    if (aria) trigger.setAttribute('aria-label', `${aria}: ${label.textContent}`);
    else trigger.removeAttribute('aria-label');
    if (select.disabled && open?.popup === popup) close(false);
  }

  function items(): HTMLButtonElement[] {
    return [...popup.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
  }
  function build(): void {
    popup.replaceChildren();
    for (const child of select.children) {
      if (child instanceof HTMLOptGroupElement) {
        const group = document.createElement('div');
        group.className = 'select-group';
        group.textContent = child.label;
        group.setAttribute('role', 'presentation');
        popup.append(group);
        for (const option of child.children)
          if (option instanceof HTMLOptionElement) popup.append(item(option, child.disabled));
      } else if (child instanceof HTMLOptionElement && !child.hidden)
        popup.append(item(child, false));
    }
  }
  function item(option: HTMLOptionElement, groupDisabled: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    const text = document.createElement('span');
    const check = document.createElement('span');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(option.selected));
    button.disabled = option.disabled || groupDisabled;
    button.tabIndex = -1;
    text.className = 'select-option-label';
    text.textContent = option.textContent;
    check.className = 'select-option-check';
    check.textContent = option.selected ? '✓' : '';
    check.setAttribute('aria-hidden', 'true');
    button.append(text, check);
    if (option.title) button.title = option.title;
    button.addEventListener('click', () => choose(option));
    return button;
  }
  function choose(option: HTMLOptionElement): void {
    close(true);
    if (option.selected) return;
    select.value = option.value;
    if (select.selectedOptions[0] !== option) option.selected = true;
    paint();
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  /** Below the button when it fits, above when it does not, never off the window. */
  function place(): void {
    const bounds = trigger.getBoundingClientRect();
    const gap = 6;
    popup.style.minWidth = `${Math.max(bounds.width, 160)}px`;
    popup.style.maxWidth = `${window.innerWidth - 16}px`;
    const below = window.innerHeight - bounds.bottom - gap - 8;
    const above = bounds.top - gap - 8;
    const height = popup.scrollHeight;
    const up = height > below && above > below;
    popup.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
    const size = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - size.width - 8, bounds.left))}px`;
    popup.style.top = up
      ? `${Math.max(8, bounds.top - gap - size.height)}px`
      : `${bounds.bottom + gap}px`;
  }
  function show(focusSelected: boolean): void {
    if (trigger.disabled) return;
    open?.close(false);
    build();
    popup.showPopover();
    place();
    trigger.setAttribute('aria-expanded', 'true');
    open = { close, popup };
    const targets = items();
    const selected = targets.find((button) => button.getAttribute('aria-selected') === 'true');
    selected?.scrollIntoView({ block: 'nearest' });
    if (focusSelected) (selected ?? targets[0])?.focus();
  }
  function close(focus: boolean): void {
    if (open?.popup !== popup) return;
    open = null;
    if (popup.matches(':popover-open')) popup.hidePopover();
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  }

  trigger.addEventListener('click', () => (open?.popup === popup ? close(false) : show(false)));
  trigger.addEventListener('keydown', (event) => {
    if (open?.popup === popup && (event.key === 'Escape' || event.key === 'Tab')) {
      if (event.key === 'Escape') event.preventDefault();
      close(false);
    } else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      show(true);
    }
  });
  popup.addEventListener('keydown', (event) => {
    const targets = items();
    const at = targets.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => targets[(index + targets.length) % targets.length]?.focus();
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(-1);
    else if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') close(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  // A click on the field's label text reaches the hidden select; send it to the button instead.
  for (const owner of select.labels ?? [])
    owner.addEventListener('click', (event) => {
      if (event.target instanceof Node && wrap.contains(event.target)) return;
      event.preventDefault();
      trigger.focus();
    });

  // Renderers write `.value` and `.selectedIndex` directly, which fires nothing; mirror those writes too.
  for (const key of ['value', 'selectedIndex'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key)!;
    Object.defineProperty(select, key, {
      configurable: true,
      get() {
        return descriptor.get!.call(this);
      },
      set(next) {
        descriptor.set!.call(this, next);
        paint();
      },
    });
  }
  select.addEventListener('change', paint);
  new MutationObserver(paint).observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'title', 'aria-label', 'selected', 'label'],
  });
  paint();
}

function upgradeWithin(root: ParentNode): void {
  if (root instanceof HTMLSelectElement) upgrade(root);
  for (const select of root.querySelectorAll('select')) upgrade(select);
}

/** Upgrades the selects already in the document and every one added later. */
export function setupSelectMenus(): void {
  upgradeWithin(document);
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) if (node instanceof Element) upgradeWithin(node);
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!open) return;
      const target = event.target as Node | null;
      const trigger = open.popup.previousElementSibling;
      if (target && (open.popup.contains(target) || trigger?.contains(target))) return;
      open.close(false);
    },
    true,
  );
  document.addEventListener(
    'scroll',
    (event) => {
      if (open && !(event.target instanceof Node && open.popup.contains(event.target)))
        open.close(false);
    },
    true,
  );
  window.addEventListener('resize', () => open?.close(false));
  window.addEventListener('blur', () => open?.close(false));
}
