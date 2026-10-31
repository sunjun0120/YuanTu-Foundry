import type { Message, SpilledOutput } from '../../protocol/index.ts';
import { codePointLength } from './text.ts';

/**
 * Shortening old tool results the model can still see. Bounded results are still replayed every
 * request, so later requests see a view of the complete on-disk transcript.
 *
 * - Nothing is deleted: only a tool message's content is replaced, so call/result pairing and
 *   `isError` stay intact.
 * - The result says it is shortened and where the rest is.
 */
export interface ShrinkPolicy {
  /** How many of the newest tool results stay whole. */
  keepRecent: number;
  /**
   * Tokens a shortened result keeps, split between head and tail. Tokens rather than characters so
   * the budget costs the same in every script; `measure` converts it to a character cut.
   */
  tokens: number;
}
/** How a piece of text is priced, which is the caller's calibrated estimate rather than a tokenizer. */
export type MeasureText = (text: string) => number;
/** Marks a result that is already a shortened view, so projecting twice is a no-op rather than a re-cut. */
export const SHRINK_MARK = '[shortened for context:';
export interface ShrinkOutcome {
  messages: Message[];
  /** How many results this pass shortened. */
  shortened: number;
  /** Characters the model no longer has to carry: what was removed, minus what the notices added. */
  freedChars: number;
}
/**
 * Worth shortening only if the result costs more than twice the budget; a derived floor, not a
 * setting.
 */
function worthShortening(content: string, tokens: number, measure: MeasureText): boolean {
  // Check the marker first; it is cheaper than measuring.
  return !content.includes(SHRINK_MARK) && measure(content) > tokens * 2;
}
/**
 * Characters that hold the token budget for this text, from its own density. Code points, not
 * UTF-16 units (as in `prune.ts`), clamped to the text.
 */
function charactersFor(content: string, tokens: number, measure: MeasureText): number {
  const characters = codePointLength(content);
  const perCharacter = measure(content) / Math.max(1, characters);
  return Math.max(1, Math.min(characters, Math.floor(tokens / perCharacter)));
}
/**
 * The head/tail split on code point boundaries, so surrogate pairs are never split (grapheme
 * clusters may be). Both ends matter: context at the top, conclusion at the bottom.
 */
function shortenedContent(
  content: string,
  characters: number,
  notice: (removed: number, total: number) => string,
): string {
  const points = [...content];
  const head = Math.floor(characters / 2);
  const tail = characters - head;
  return (
    points.slice(0, head).join('') +
    notice(points.length - characters, points.length) +
    points.slice(points.length - tail).join('')
  );
}
/** The line that replaces the removed middle. It says what was cut, and what to do to see it. */
export function shrinkNotice(spill: SpilledOutput, removed: number, total: number): string {
  return (
    `\n${SHRINK_MARK} ${removed} of ${total} characters removed to keep this conversation within budget; ` +
    `the full text is in ${spill.path} — read it with read_file using start_line and end_line]\n`
  );
}
/**
 * Shorten old tool results in one pass. Protected: the newest `keepRecent` results (all of them if
 * fewer exist), and everything after the last tool-calling assistant turn, which the model has not
 * read yet. One pass means one cache miss.
 */
export function shortenMessages(
  messages: readonly Message[],
  policy: ShrinkPolicy,
  spill: (input: { message: Message; content: string }) => SpilledOutput | null,
  measure: MeasureText,
  preserved?: ReadonlySet<Message>,
): ShrinkOutcome {
  let lastCall = -1;
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.toolCalls.length) lastCall = index;
  });
  const outcome = messages.map((message) => message);
  const protectedFrom = Math.min(lastCall + 1, recentStart(messages, policy.keepRecent));
  let shortened = 0;
  let freedChars = 0;
  for (let index = 0; index < messages.length; index++) {
    if (index >= protectedFrom) break;
    const message = messages[index]!;
    if (
      message.role !== 'tool' ||
      preserved?.has(message) ||
      !worthShortening(message.content, policy.tokens, measure)
    )
      continue;
    let spilled: SpilledOutput | null = null;
    try {
      spilled = spill({ message, content: message.content });
    } catch {
      spilled = null;
    }
    // No spill file, no shortening: a pointer to nowhere is worse than a long result.
    if (!spilled) continue;
    const content = shortenedContent(
      message.content,
      charactersFor(message.content, policy.tokens, measure),
      (removed, total) => shrinkNotice(spilled, removed, total),
    );
    outcome[index] = { ...message, content };
    shortened += 1;
    // Counted in code points, the unit the budget is stated in, so the reported saving cannot disagree with it.
    freedChars += codePointLength(message.content) - codePointLength(content);
  }
  return { messages: outcome, shortened, freedChars };
}
/**
 * Where the newest `keep` tool results begin, counting results (not trailing messages) across
 * interleaved batches.
 */
export function recentStart(messages: readonly Message[], keep: number): number {
  if (keep < 1) return messages.length;
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role !== 'tool') continue;
    seen += 1;
    if (seen >= keep) return index;
  }
  // Fewer results than the caller asked to keep: every one of them is recent.
  return 0;
}
