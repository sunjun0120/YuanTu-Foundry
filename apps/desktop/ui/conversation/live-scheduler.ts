/**
 * The live bubble's scheduling seam: read the running message, coalesce its repaint, and follow the tail.
 *
 * Streamed text arrives on the delta channel rather than as a snapshot per token. `stream-store.ts` accumulates both
 * channels and publishes a complete view on its own 100ms budget; this file only decides which values the React
 * projection draws — the answer and the thinking are read from separate channels, never merged — and when a paint is
 * worth running. Markdown rendering is far too expensive to run per token.
 *
 * `#live` itself stays the stable host: the transcript borrows the fold inside it and moves it into the last process
 * group, so the element cannot be re-created by a repaint. Everything under the host is React's.
 *
 * The snapshot fallback remains: when the store has no view for the message the snapshot announces (right after a
 * session reload, for instance), the snapshot's own copy is what the bubble shows. The store drops that buffer the
 * moment the run stops or a reload replaces the message, so stale text can never reappear under a new message id.
 */
import type { CarrierSnapshot, MessageDelta } from '../../../../packages/carrier/contract.ts';
import type { LiveMessageSurface, LiveMessageView } from './live-model.ts';
import { createStreamStore } from './stream-store.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

/** What the projection shows when there is no running message. */
const NO_LIVE: LiveMessageView = { present: false, text: '', reasoning: '', phase: undefined };

export function createLiveScheduler(options: {
  getState(): CarrierSnapshot | null;
  /** The React-owned bubble: the folded thought and the answer body. */
  live: LiveMessageSurface;
  updateJumpButton(): void;
  /** Whether a sub-agent's page has taken the viewport — the live bubble must not scroll it. */
  isChildPageOpen(): boolean;
  /** Whether a history load is in flight; following the tail then would fight the anchor it is holding. */
  isLoadingOlder(): boolean;
}): {
  sync(): void;
  delta(delta: MessageDelta): void;
  schedule(): void;
  dispose(): void;
} {
  const { live, updateJumpButton, isChildPageOpen, isLoadingOlder } = options;
  const conversation = required('conversation');
  let liveKey = '';
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // Delta merging and its 100ms publish budget live in the stream store; this file only paints.
  const stream = createStreamStore();
  const unsubscribe = stream.view.subscribe(() => schedule());
  /** The answer text the live bubble should show: the streamed view when it matches, else the snapshot. */
  function liveText(): string {
    const live = options.getState()?.session.liveMessage;
    if (!live) return '';
    const view = stream.view.getSnapshot();
    return view?.messageId === live.id ? view.text : live.text;
  }
  /** The same rule for the folded thought, read from its own channel. */
  function liveReasoning(): string {
    const live = options.getState()?.session.liveMessage;
    if (!live) return '';
    const view = stream.view.getSnapshot();
    return view?.messageId === live.id ? view.reasoning : live.reasoning;
  }
  /** Everything one paint draws: presence, the two channels, and what phase the placeholder speaks for. */
  function currentView(): LiveMessageView {
    const snapshot = options.getState();
    const live = snapshot?.session.liveMessage;
    return {
      present: Boolean(live),
      text: live ? liveText() : '',
      reasoning: live ? liveReasoning() : '',
      phase: snapshot?.session.statisticsActivity?.phase,
    };
  }
  /** Markdown rendering is far too expensive to run per token, so paints stay coalesced at 100ms. */
  function schedule(): void {
    if (disposed || liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = undefined;
      const nearBottom =
        conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
      const view = currentView();
      // The host is shown only while there is answer text to read. The thought is hidden by React's own prop and
      // never dropped: its node is the one a reader may have opened and the transcript may have borrowed.
      live.setVisible(view.present && view.text !== '');
      live.paint(view);
      if (
        nearBottom &&
        !isChildPageOpen() &&
        options.getState()?.session.running &&
        !isLoadingOlder()
      )
        conversation.scrollTop = conversation.scrollHeight;
      updateJumpButton();
    }, 100);
  }
  /** Keep the visible bubble in step with the snapshot. */
  function sync(): void {
    if (disposed) return;
    const message = options.getState()?.session.liveMessage;
    live.setVisible(Boolean(message) && liveText() !== '');
    // The store clears its own buffer once the run stops (or a reload replaced the message), so stale text can
    // never reappear under a new message id.
    stream.acceptSnapshot({ liveMessage: message ?? null });
    // A stopped run clears the answer now rather than on the next coalesced paint: the bubble must not keep the
    // last tokens under a session that is already idle.
    if (!message) live.paint(NO_LIVE);
    const nextLive = message?.id ?? '';
    if (nextLive !== liveKey) {
      liveKey = nextLive;
      schedule();
    }
  }
  // Streamed text arrives on its own channel rather than as a snapshot per token. The store buffers even when the
  // snapshot that announces this message has not arrived yet; the subscription above paints once its publish budget
  // closes. The channel says which of a message's two streams a slice belongs to, and a slice must never be added to
  // the wrong one.
  function delta(delta: MessageDelta): void {
    if (disposed) return;
    stream.acceptDelta(delta);
  }
  return {
    sync,
    delta,
    schedule,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (liveTimer) clearTimeout(liveTimer);
      unsubscribe();
      stream.dispose();
    },
  };
}
