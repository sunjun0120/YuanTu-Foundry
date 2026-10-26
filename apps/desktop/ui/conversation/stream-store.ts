/**
 * The live bubble's stream, accumulated away from the DOM.
 *
 * Streamed text arrives on its own channel rather than as a snapshot per token, and markdown rendering is far too
 * expensive to run per token, so the slices are accumulated here and published to the view at most once per 100ms.
 *
 * The two channels are separate buffers, not two halves of one: the answer is painted into the bubble and the thinking
 * into the fold, and mixing them would render thinking as the answer. A reset replaces the channel it names (the
 * attempt that produced what was buffered was thrown away), and a slice that arrives before the snapshot that
 * announces its message is buffered rather than dropped — the snapshot then shows it, and later slices take the cheap
 * path.
 *
 * The store is the only place deltas are merged; the UI reads the published view and never accumulates raw slices.
 */
import type { MessageDelta } from '../../../../packages/carrier/contract.ts';
import type { SessionSnapshot } from '../../../../packages/client/session-controller.ts';
import { createStore, type ReadableStore } from '../stores.ts';

export interface StreamView {
  messageId: string;
  text: string;
  reasoning: string;
}

/** Repaint budget: a hundred slices in one window publish one complete view. */
export const STREAM_PUBLISH_MS = 100;

export interface StreamStore {
  readonly view: ReadableStore<StreamView | null>;
  acceptSnapshot(session: Pick<SessionSnapshot, 'liveMessage'>): void;
  acceptDelta(delta: MessageDelta): void;
  dispose(): void;
}

export function createStreamStore(): StreamStore {
  const view = createStore<StreamView | null>(null);
  let buffer: StreamView | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function publish(): void {
    if (disposed) return;
    view.set(buffer === null ? null : { ...buffer });
  }

  function schedule(): void {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      publish();
    }, STREAM_PUBLISH_MS);
  }

  return {
    view,
    acceptSnapshot(session) {
      if (disposed) return;
      const live = session.liveMessage;
      if (!live) {
        // The run stopped (or a reload replaced the message): stale text must never reappear under a new id.
        buffer = null;
        schedule();
        return;
      }
      if (!buffer || buffer.messageId !== live.id) {
        // A snapshot for a message nothing has streamed yet is the view's starting point; one for a message whose
        // slices arrived first keeps the slices, because the delta channel is ahead of the snapshot.
        buffer = { messageId: live.id, text: live.text, reasoning: live.reasoning };
      }
      schedule();
    },
    acceptDelta(delta) {
      if (disposed) return;
      const channel = delta.channel === 'reasoning' ? 'reasoning' : 'text';
      if (!buffer || buffer.messageId !== delta.messageId) {
        buffer = { messageId: delta.messageId, text: '', reasoning: '' };
      }
      buffer[channel] = delta.reset ? delta.text : buffer[channel] + delta.text;
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
