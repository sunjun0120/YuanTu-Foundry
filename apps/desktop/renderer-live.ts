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
import { renderMarkdown, type MarkdownActions } from './markdown.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

export function setupLiveMessage(options: {
  getState(): CarrierSnapshot | null;
  /** The hub's bridge-backed markdown actions. */
  markdownActions: MarkdownActions;
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
    markdownActions,
    reasoningView,
    placeLiveThought,
    updateJumpButton,
    isChildPageOpen,
    isLoadingOlder,
  } = options;
  const conversation = required('conversation');
  let liveKey = '';
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Streamed text accumulated from the delta channel. Snapshots no longer arrive per token, so the
   * live bubble reads from this buffer and falls back to the snapshot's own copy (which the controller
   * also keeps current) whenever the two disagree — for example right after a session reload.
   *
   * `reasoning` is a second buffer, not a second half of the first: the two channels are painted into
   * different places, and mixing them here is how thinking would end up rendered as the answer.
   */
  let liveDelta: { id: string; text: string; reasoning: string } | null = null;
  /** The text the live bubble should show: the streamed buffer when it matches, else the snapshot. */
  function liveText(): string {
    const live = options.getState()?.session.liveMessage;
    if (!live) return '';
    return liveDelta?.id === live.id ? liveDelta.text : live.text;
  }
  /** The same rule for the folded thought, read from its own buffer. */
  function liveReasoning(): string {
    const live = options.getState()?.session.liveMessage;
    if (!live) return '';
    return liveDelta?.id === live.id ? liveDelta.reasoning : live.reasoning;
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
      required('live').hidden = !options.getState()?.session.liveMessage || !full;
      const target = required('live').querySelector('.message-content');
      if (target && options.getState()?.session.liveMessage) {
        const preview =
          full.length > 120_000
            ? `${format(t('ui.liveTail'), { count: full.length })}\n\n${full.slice(-120_000)}`
            : full || livePlaceholder();
        target.replaceWith(renderMarkdown(preview, markdownActions));
      } else target?.replaceWith(node('div', '', 'message-content'));
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
    // Drop the buffer once the run stops (or a reload replaced the message) so stale text can never
    // reappear under a new message id.
    if (!live) {
      liveDelta = null;
      const target = required('live').querySelector<HTMLElement>('.message-content')!;
      if (target.childNodes.length || target.className !== 'message-content')
        target.replaceWith(node('div', '', 'message-content'));
    } else if (liveDelta && liveDelta.id !== live.id) liveDelta = null;
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
    const live = options.getState()?.session.liveMessage;
    const channel = delta.channel === 'reasoning' ? 'reasoning' : 'text';
    if (!live || live.id !== delta.messageId) {
      // The snapshot that announces this message has not been rendered yet. Buffer the slice; render()
      // shows it from the buffer as soon as that snapshot arrives, and later deltas take the cheap
      // path. Calling render() here would be wrong — with no live message it clears the buffer.
      liveDelta = { id: delta.messageId, text: '', reasoning: '' };
      liveDelta[channel] = delta.reset ? '' : delta.text;
      return;
    }
    if (liveDelta?.id !== delta.messageId)
      liveDelta = { id: delta.messageId, text: '', reasoning: '' };
    // A reset means the attempt that produced what is buffered was thrown away, so the buffer is replaced
    // rather than appended to. The answer's buffer can only be reset while it is still empty.
    liveDelta[channel] = delta.reset ? delta.text : liveDelta[channel] + delta.text;
    schedule();
  }
  return { sync, delta, schedule };
}
