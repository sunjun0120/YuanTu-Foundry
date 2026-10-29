/**
 * The sidebar's draggable width, after the reference sidebar: 240–360px, dragged by its right edge or stepped with
 * the arrow keys on the separator (Home restores the default).
 *
 * While a drag is under way `body.sidebar-resizing` is set: the shell drops its offset transition, and the cursor and
 * selection rules hold for the whole window rather than only over the thin handle.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

export const SIDEBAR_DEFAULT_WIDTH = 272;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 360;
const STEP = 8;

const clamp = (value: number): number =>
  Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value)));

export function useSidebarWidth(): {
  width: number;
  startDrag(event: PointerEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
} {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const drag = useRef<{ x: number; width: number } | null>(null);

  const stop = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('sidebar-resizing');
  }, []);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent): void => {
      const start = drag.current;
      if (start) setWidth(clamp(start.width + event.clientX - start.x));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      stop();
    };
  }, [stop]);

  const startDrag = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { x: event.clientX, width };
    document.body.classList.add('sidebar-resizing');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowLeft') setWidth(clamp(width - STEP));
    else if (event.key === 'ArrowRight') setWidth(clamp(width + STEP));
    else if (event.key === 'Home') setWidth(SIDEBAR_DEFAULT_WIDTH);
    else return;
    event.preventDefault();
  };

  return { width, startDrag, onKeyDown };
}
