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
  return {
    node: node ?? null,
    nodeTop: node ? node.getBoundingClientRect().top : null,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
  };
}

export function restoreAnchor(container: HTMLElement, anchor: ScrollAnchor): void {
  if (anchor.node?.isConnected && anchor.nodeTop !== null) {
    container.scrollTop += anchor.node.getBoundingClientRect().top - anchor.nodeTop;
    return;
  }
  container.scrollTop = anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight);
}
