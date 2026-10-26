import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAnchor, restoreAnchor } from '../apps/desktop/ui/conversation/scroll-anchor.ts';

/**
 * The reading position survives a rebuild: the first visible message is remembered by node and screen position, and a
 * node that no longer exists falls back to the height that was inserted above the reader.
 */
function nodeBox(
  top: number,
  bottom: number,
): { getBoundingClientRect(): { top: number; bottom: number } } {
  return { getBoundingClientRect: () => ({ top, bottom }) };
}

function container(
  boxes: { getBoundingClientRect(): { top: number; bottom: number }; isConnected?: boolean }[],
  state: { scrollTop: number; scrollHeight: number; top: number },
): HTMLElement {
  return {
    getBoundingClientRect: () => ({ top: state.top, bottom: state.top + 600 }),
    scrollTop: state.scrollTop,
    scrollHeight: state.scrollHeight,
    querySelectorAll: () => boxes,
  } as unknown as HTMLElement;
}

test('capture keeps the first node below the container top', () => {
  const first = nodeBox(-80, 20);
  const second = nodeBox(30, 120);
  const element = container([first, second], { scrollTop: 40, scrollHeight: 1000, top: 0 });
  const anchor = captureAnchor(element);
  assert.equal(anchor.node, first as unknown as Element);
  assert.equal(anchor.nodeTop, -80);
  assert.equal(anchor.scrollTop, 40);
});

test('restore moves the remembered node back to its screen position', () => {
  const state = { scrollTop: 40, scrollHeight: 1000, top: 0 };
  // After the rebuild the node sits 180px lower than it did when the anchor was captured.
  const node = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: 100, bottom: 0 }),
  };
  const element = container([], state);
  const anchor = {
    node: node as unknown as Element,
    nodeTop: -80,
    scrollTop: 40,
    scrollHeight: 1000,
  };
  restoreAnchor(element, anchor);
  // The node's top moved from -80 to 100 (+180), so the container follows by the same amount.
  assert.equal(element.scrollTop, 220);
});

test('a missing node falls back to the height inserted above the reader', () => {
  const element = container([], { scrollTop: 40, scrollHeight: 1200, top: 0 });
  restoreAnchor(element, {
    node: null,
    nodeTop: null,
    scrollTop: 40,
    scrollHeight: 1000,
  });
  assert.equal(element.scrollTop, 240);
});
