import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureAnchor,
  captureHistoryAnchor,
  restoreAnchor,
} from '../apps/desktop/ui/conversation/scroll-anchor.ts';

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

test('history loading anchors the visible step of an open fold, not only the fold boundary', () => {
  const firstStep = nodeBox(-40, 30);
  const secondStep = nodeBox(40, 120);
  const steps = {
    children: [firstStep, secondStep],
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
  };
  const group = {
    open: true,
    getBoundingClientRect: () => ({ top: -200, bottom: 400 }),
    querySelector: (selector: string) => (selector.includes('process-steps') ? steps : null),
  };
  const messages = { firstElementChild: group } as unknown as HTMLElement;
  const conversation = container([], { scrollTop: 200, scrollHeight: 2000, top: 0 });
  const anchor = captureHistoryAnchor(conversation, messages);
  assert.equal(anchor.node, firstStep as unknown as Element);
  assert.equal(anchor.nodeTop, -40);
  assert.equal(anchor.scrollTop, 200);
});

test('a closed fold anchors its own boundary', () => {
  const group = {
    open: false,
    getBoundingClientRect: () => ({ top: 20, bottom: 60 }),
    querySelector: () => null,
  };
  const messages = { firstElementChild: group } as unknown as HTMLElement;
  const conversation = container([], { scrollTop: 0, scrollHeight: 1000, top: 0 });
  const anchor = captureHistoryAnchor(conversation, messages);
  assert.equal(anchor.node, group as unknown as Element);
});
