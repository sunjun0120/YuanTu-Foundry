import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Delegated icon tips also cover menu triggers without nesting competing trigger components. */
export function SidebarTooltip(): ReactNode {
  const anchor = useRef<HTMLElement | null>(null);
  const [tip, setTip] = useState<{ label: string; left: number; top: number } | null>(null);
  useEffect(() => {
    const hide = (): void => {
      if (anchor.current?.getAttribute('aria-describedby') === 'sidebar-icon-tooltip')
        anchor.current.removeAttribute('aria-describedby');
      anchor.current = null;
      setTip(null);
    };
    const show = (event: Event): void => {
      const control = (event.target as Element | null)?.closest<HTMLElement>(
        '[data-sidebar-tooltip]',
      );
      if (
        !control ||
        control === anchor.current ||
        control.matches('[aria-haspopup="menu"][aria-expanded="true"]')
      )
        return;
      hide();
      const label = control.dataset.sidebarTooltip;
      if (!label) return;
      // A row title only needs a tip when the ellipsis has cut it.
      if (control.hasAttribute('data-sidebar-tooltip-overflow')) {
        const text = control.querySelector<HTMLElement>('[data-tooltip-text]') ?? control;
        if (text.scrollWidth <= text.clientWidth) return;
      }
      const rect = control.getBoundingClientRect();
      anchor.current = control;
      control.setAttribute('aria-describedby', 'sidebar-icon-tooltip');
      setTip({
        label,
        left: Math.min(rect.right + 8, Math.max(8, innerWidth - 240)),
        top: Math.max(20, Math.min(rect.top + rect.height / 2, innerHeight - 20)),
      });
    };
    const leave = (event: Event): void => {
      const related = (event as MouseEvent).relatedTarget as Node | null;
      if (anchor.current && !anchor.current.contains(related)) hide();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    const lifecycle = new AbortController();
    const options = { capture: true, signal: lifecycle.signal };
    document.addEventListener('pointerover', show, options);
    document.addEventListener('focusin', show, options);
    document.addEventListener('pointerout', leave, options);
    document.addEventListener('focusout', leave, options);
    document.addEventListener('pointerdown', hide, options);
    document.addEventListener('click', hide, options);
    document.addEventListener('scroll', hide, options);
    document.addEventListener('keydown', key, options);
    return () => {
      lifecycle.abort();
      if (anchor.current?.getAttribute('aria-describedby') === 'sidebar-icon-tooltip')
        anchor.current.removeAttribute('aria-describedby');
    };
  }, []);
  return tip
    ? createPortal(
        <div
          id="sidebar-icon-tooltip"
          className="sidebar-tooltip"
          role="tooltip"
          style={{ left: tip.left, top: tip.top }}
        >
          {tip.label}
        </div>,
        document.body,
      )
    : null;
}
