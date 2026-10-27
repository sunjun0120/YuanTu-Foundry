/**
 * A disclosure that animates its height through `PanelTransition`.
 *
 * The element is still a native `<details>`: a `<summary>` first child, the body after it, and a real `open` attribute
 * that a screen reader and the existing smoke suites read. What changes is who owns the toggle. The browser would hide
 * the body the moment the summary is clicked, which is exactly when an animation would need it visible, so the click is
 * intercepted and the fold keeps its body mounted for the length of the close (`PanelTransition` → Mantine `Collapse`).
 *
 * Two rules keep this from fighting its hosts:
 *
 * - The open state is React's, keyed by the fold's own key, which is stable across a repaint. The transcript adapter's
 *   per-key map is the initial value for a fold that React had to recreate, so a reader's open group stays open.
 * - A native `toggle` is still obeyed. `history.smoke` (and any assistive technology) sets `.open` directly; adopting
 *   that write is what keeps the attribute and React's state from disagreeing, and it is why the listener also records
 *   the decision for a future mount.
 */
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import { usePrefersReducedMotion } from '../reduced-motion.ts';
import { PanelTransition } from '../transitions.tsx';

export interface FoldProps {
  className: string;
  summary: ReactNode;
  summaryClassName?: string;
  id?: string;
  /** `data-process-key`: the transcript's key for this fold, also what makes a recreated fold reopen. */
  processKey?: string;
  initiallyOpen?: boolean;
  hidden?: boolean;
  onOpenChange?(open: boolean): void;
  detailsRef?: Ref<HTMLDetailsElement>;
  children: ReactNode;
}

export function Fold({
  className,
  summary,
  summaryClassName,
  id,
  processKey,
  initiallyOpen = false,
  hidden,
  onOpenChange,
  detailsRef,
  children,
}: FoldProps): ReactNode {
  const [open, setOpen] = useState(initiallyOpen);
  /** The `open` attribute: stays true while the close animation runs, so the body keeps its box. */
  const [visible, setVisible] = useState(initiallyOpen);
  const reduced = usePrefersReducedMotion();
  const element = useRef<HTMLDetailsElement | null>(null);
  /** The latest callback without re-subscribing the toggle listener on every parent render. */
  const changed = useRef(onOpenChange);
  changed.current = onOpenChange;

  // A write to `.open` from outside React (a test, a browser tool) is a decision too: adopt it instead of letting the
  // next render silently undo it.
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const adopt = () => {
      setOpen(node.open);
      setVisible(node.open);
      changed.current?.(node.open);
    };
    node.addEventListener('toggle', adopt);
    return () => node.removeEventListener('toggle', adopt);
  }, []);

  const toggle = (event: MouseEvent<HTMLElement>) => {
    // The browser's own toggle would hide the body before the close animation could show it.
    event.preventDefault();
    const next = !open;
    changed.current?.(next);
    if (next) {
      setVisible(true);
      setOpen(true);
      return;
    }
    setOpen(false);
    if (reduced) setVisible(false);
  };
  return (
    <details
      ref={(node) => {
        element.current = node;
        if (typeof detailsRef === 'function') detailsRef(node);
        else if (detailsRef) detailsRef.current = node;
      }}
      id={id}
      className={className}
      data-process-key={processKey}
      hidden={hidden}
      open={visible}
    >
      <summary className={summaryClassName} onClick={toggle}>
        {summary}
      </summary>
      <PanelTransition
        opened={open}
        onTransitionEnd={() => {
          if (!open) setVisible(false);
        }}
      >
        {children}
      </PanelTransition>
    </details>
  );
}
