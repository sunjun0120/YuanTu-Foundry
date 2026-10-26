/**
 * Keeping the reading position across a rebuild.
 *
 * Before history is replaced, the first message still visible is remembered by node and screen position. After the
 * rebuild, that same node is moved back to where it was — the browser keeps the rest aligned with it. When the node
 * itself is gone (the window slid past it), the change in `scrollHeight` is the fallback: content inserted above keeps
 * the reader looking at the same words, not at the same scrollTop.
 */
export interface ScrollAnchor {
  node: Element | null;
  nodeTop: number | null;
  scrollTop: number;
  scrollHeight: number;
}

export function captureAnchor(container: HTMLElement, selector = ':scope > *'): ScrollAnchor {
  const bounds = container.getBoundingClientRect();
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(selector));
  const node = candidates.find(
    (candidate) => candidate.getBoundingClientRect().bottom > bounds.top,
  );
  return anchorAt(container, node ?? null);
}

/** Remember one already-chosen node, for callers whose idea of "the first visible thing" is more specific. */
export function anchorAt(container: HTMLElement, node: Element | null): ScrollAnchor {
  return {
    node,
    nodeTop: node ? node.getBoundingClientRect().top : null,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
  };
}

/**
 * The reading position of a history load: the first visible transcript row, or — when that row is an open process
 * group — the first step inside it.
 *
 * The group's own top is the wrong anchor once the reader has scrolled into its steps: older steps are inserted above
 * that step, not above the group, so holding the group still would move the words the reader is looking at.
 */
export function captureHistoryAnchor(
  conversation: HTMLElement,
  messages: HTMLElement,
): ScrollAnchor {
  let node = messages.firstElementChild as HTMLElement | null;
  const open = (node as { open?: boolean } | null)?.open === true;
  if (node && open) {
    const steps = node.querySelector<HTMLElement>(':scope > .process-steps');
    const visible = steps
      ? [...steps.children].find(
          (step) => step.getBoundingClientRect().bottom > steps.getBoundingClientRect().top,
        )
      : undefined;
    if (visible) node = visible as HTMLElement;
  }
  return anchorAt(conversation, node);
}

export function restoreAnchor(container: HTMLElement, anchor: ScrollAnchor): void {
  if (anchor.node?.isConnected && anchor.nodeTop !== null) {
    container.scrollTop += anchor.node.getBoundingClientRect().top - anchor.nodeTop;
    return;
  }
  container.scrollTop = anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight);
}
