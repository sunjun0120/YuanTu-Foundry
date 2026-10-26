/**
 * What the live bubble shows, and the one rule that turns the streamed answer into its body.
 *
 * The view holds the *displayed* value, not the stream buffer: `renderer-live.ts` falls back to the snapshot's own
 * copy when the store has nothing for the current message, so the bubble and the snapshot cannot disagree about which
 * message is on screen. The body keeps the legacy truncation — markdown rendering of an unbounded answer is expensive
 * and nobody reads the first hundred thousand characters of a running reply — and the legacy placeholder for the gap
 * before the first answer token. Both are presentation, so they belong with the component rather than the scheduler.
 */
import { format, t } from '../../i18n.ts';

/** The request phase the statistics channel reports, narrowed to what the live placeholder distinguishes. */
export type LivePhase = 'reasoning' | 'tool_call' | 'text' | undefined;

export interface LiveMessageView {
  /** A live message exists. A running message with no answer yet is not the same state as no message at all. */
  present: boolean;
  /** The answer's accumulated text — never the thinking. */
  text: string;
  /** The folded thought, from its own channel. */
  reasoning: string;
  /** What the running request is doing, for the placeholder shown before the first answer token. */
  phase: LivePhase;
}

/** The live bubble as the scheduler sees it: the values to draw, and the one host attribute a portal cannot own. */
export interface LiveMessageSurface {
  /** Draw the fold and the answer body. */
  paint(view: LiveMessageView): void;
  /** `#live` is the portal's container, so its own visibility is the mount's to set, not a child's. */
  setVisible(visible: boolean): void;
}

/** Characters of a too-long answer the live bubble shows while the run is still writing it. */
export const LIVE_TAIL_CHARS = 120_000;

/** How much of the thought fits the fold's one-line preview. */
const REASONING_PREVIEW_CHARS = 240;

/** The fold's preview line: whitespace collapsed, then cut, exactly as the shared reasoning view built it. */
export function liveReasoningPreview(reasoning: string): string {
  return reasoning.replace(/\s+/g, ' ').slice(0, REASONING_PREVIEW_CHARS);
}

/**
 * The body markdown: the answer, its tail when it is too long, or what the model is doing before it has written any.
 *
 * An absent message paints nothing at all; the placeholder is only for a message that exists and has not answered
 * yet, which is what keeps the last reply from lingering in the bubble after a stop.
 */
export function liveBodyText(view: LiveMessageView): string {
  if (!view.present) return '';
  if (view.text.length > LIVE_TAIL_CHARS)
    return `${format(t('ui.liveTail'), { count: view.text.length })}\n\n${view.text.slice(-LIVE_TAIL_CHARS)}`;
  return view.text || livePlaceholder(view.phase);
}

function livePlaceholder(phase: LivePhase): string {
  return phase === 'reasoning'
    ? t('ui.modelReasoning')
    : phase === 'tool_call'
      ? t('ui.modelToolCall')
      : t('ui.thinking');
}
