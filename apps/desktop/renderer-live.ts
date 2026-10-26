/**
 * The live bubble: the answer and the folded thought a running session is still writing.
 *
 * Streamed text arrives on the delta channel rather than as a snapshot per token, so it is accumulated in a
 * buffer here and the bubble is repainted from it on a coalesced timer — markdown rendering is far too expensive
 * to run per token. The buffer falls back to the snapshot's own copy whenever the two disagree (right after a
 * session reload, for instance), and it is dropped the moment the run stops or a reload replaces the message, so
 * stale text can never reappear under a new message id.
 *
 * `reasoning` is a second buffer, not a second half of the first: the two channels are painted into different
 * places — the answer into the bubble, the thinking into the fold on the last process group — and mixing them
 * here is how thinking would end up rendered as the answer.
 *
 * The three methods are the three halves of that: `sync` is what `render()` calls, `delta` is the channel, and
 * `schedule` is the coalesced repaint both of them ask for.
 */
import type { CarrierSnapshot, MessageDelta } from '../../packages/carrier/contract.ts';
import { format, t } from './i18n.ts';
import { createStreamStore } from './ui/conversation/stream-store.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
export function setupLiveMessage(options: {
  getState(): CarrierSnapshot | null;
  /** Draw the answer body; the React projection lives in the window, which owns its lifetime. */
  paintLive(text: string): void;
  /** The folded-thought view, drawn in place so an expanded fold is not closed under the reader. */
  reasoningView(text: string): HTMLElement;
  /** Put the live thought into the last process group, or take it back out. */
  placeLiveThought(thought: HTMLElement, visible: boolean): void;
  updateJumpButton(): void;
  /** Whether a sub-agent's page has taken the viewport — the live bubble must not scroll it. */
  isChildPageOpen(): boolean;
  /** Whether a history load is in flight; following the tail then would fight the anchor it is holding. */
  isLoadingOlder(): boolean;
}): {
  sync(): void;
  delta(delta: MessageDelta): void;
  schedule(): void;
} {
  const {
    paintLive,
    reasoningView,
    placeLiveThought,
    updateJumpButton,
    isChildPageOpen,
    isLoadingOlder,
  } = options;
  const conversation = required('conversation');
  let liveKey = '';
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  // Delta merging and its 100ms publish budget live in the stream store; this file only paints.
  const stream = createStreamStore();
  stream.view.subscribe(() => schedule());
  /** The text the live bubble should show: the streamed view when it matches, else the snapshot. */
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
  /** Markdown rendering is far too expensive to run per token, so paints stay coalesced at 100ms. */
  function livePlaceholder(): string {
    const phase = options.getState()?.session.statisticsActivity?.phase;
    return phase === 'reasoning'
      ? t('ui.modelReasoning')
      : phase === 'tool_call'
        ? t('ui.modelToolCall')
        : t('ui.thinking');
  }
  function schedule(): void {
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = undefined;
      const nearBottom =
        conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
      // The folded thought is painted in place rather than replaced: it is a `<details>` the user may have
      // expanded, and swapping the node would close it under them on every paint.
      const thought = required('live-reasoning');
      const reasoning = liveReasoning();
      thought.hidden = !reasoning;
      if (reasoning) thought.replaceChildren(...Array.from(reasoningView(reasoning).childNodes));
      placeLiveThought(thought, Boolean(reasoning));
      const full = liveText();
      const live = options.getState()?.session.liveMessage;
      required('live').hidden = !live || !full;
      if (live) {
        const preview =
          full.length > 120_000
            ? `${format(t('ui.liveTail'), { count: full.length })}\n\n${full.slice(-120_000)}`
            : full || livePlaceholder();
        paintLive(preview);
      } else paintLive('');
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
  /** Keep the buffer and the visible bubble in step with the snapshot. */
  function sync(): void {
    const live = options.getState()?.session.liveMessage;
    required('live').hidden = !live || !liveText();
    // The store clears its own buffer once the run stops (or a reload replaced the message), so stale text
    // can never reappear under a new message id.
    stream.acceptSnapshot({ liveMessage: live ?? null });
    if (!live) paintLive('');
    const nextLive = live?.id ?? '';
    if (nextLive !== liveKey) {
      liveKey = nextLive;
      schedule();
    }
  }
  // Streamed text arrives on its own channel rather than as a snapshot per token. Accumulating it
  // here keeps a token cheap: nothing is cloned, nothing is re-serialised, and only the live bubble is
  // repainted (coalesced) instead of the whole surface. The channel says which of a message's two
  // streams a slice belongs to — the answer or the thinking — and a slice must never be added to the
  // wrong one.
  function delta(delta: MessageDelta): void {
    // The store buffers even when the snapshot that announces this message has not arrived yet; the
    // subscription above paints once its publish budget closes.
    stream.acceptDelta(delta);
  }
  return { sync, delta, schedule };
}
