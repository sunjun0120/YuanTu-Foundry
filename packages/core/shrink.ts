import type { Message, SpilledOutput } from '../protocol/index.ts';

/**
 * Shortening old tool results the model can still see.
 *
 * A tool result is bounded when it is produced (24,000 characters), but a bounded result is replayed in every
 * later request for the rest of the session: twenty 20,000-character results are 400,000 characters of context
 * that the model paid for once and now carries forever. The transcript on disk is already the complete record,
 * so what the model sees can be a view of it.
 *
 * Two properties matter more than how much is saved:
 *
 * - Nothing is deleted. Only the *content* of a tool message is replaced, so the call/result pairing a provider
 *   validates stays intact and `isError` still says what happened. Dropping messages would be cheaper and would
 *   break requests outright.
 * - The model is told, in the result itself, that it is looking at a shortened view and where the rest is. A
 *   model that believes it read the whole output will reason from a false premise, which is worse than a long
 *   result.
 */
export interface ShrinkPolicy {
  /** How many of the newest tool results stay whole. */
  keepRecent: number;
  /**
   * Tokens a shortened result keeps, split between its head and its tail.
   *
   * Tokens rather than characters, because characters are not the same amount of context in every script: 1,200
   * characters is roughly 400 tokens of English and roughly 1,200 tokens of Chinese, so a character budget
   * silently spends three times as much on one conversation as on another. The budget is what the policy is
   * about, so it is stated in the unit the window is measured in; `measure` is what turns that into a character
   * cut for the text in hand.
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
 * Whether a result is worth shortening at all.
 *
 * A result has to cost more than twice the budget, or shortening it would trade information for almost no room.
 * This is a derived floor rather than its own setting: a second knob whose value only ever had one sensible
 * relationship to the first would be a way to configure the runtime into losing detail for nothing.
 */
function worthShortening(content: string, tokens: number, measure: MeasureText): boolean {
  return measure(content) > tokens * 2 && !content.includes(SHRINK_MARK);
}
/**
 * How many characters hold the token budget for *this* text.
 *
 * The density is the text's own — `measure` prices it, and dividing by its length gives tokens per character for
 * exactly the content being cut, which is what makes one budget mean one cost in English, in Chinese and in a
 * mixture of both. The result is clamped to the text: a budget larger than the result must not make the head and
 * the tail overlap, and a very small budget must not produce a slice that removes nothing.
 */
function charactersFor(content: string, tokens: number, measure: MeasureText): number {
  const perCharacter = measure(content) / Math.max(1, content.length);
  return Math.max(1, Math.min(content.length, Math.floor(tokens / perCharacter)));
}
/** The head/tail split. Both ends are kept because both ends are load-bearing: a log's context is at the top,
 * its conclusion at the bottom, and a diff's hunk headers at the top with its last hunks at the bottom. */
function shortenedContent(
  content: string,
  characters: number,
  notice: (removed: number, total: number) => string,
): string {
  const head = Math.floor(characters / 2);
  const tail = characters - head;
  return (
    content.slice(0, head) +
    notice(content.length - characters, content.length) +
    content.slice(content.length - tail)
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
 * Shorten the old tool results in one pass.
 *
 * The newest results are protected twice over, and for different reasons. `keepRecent` protects a count of
 * results, which is what a caller can reason about — and when the conversation has fewer results than that,
 * all of them are protected, because "the newest six stay whole" cannot mean "the newest six, or whatever
 * exists, minus the ones we felt like cutting". The structural rule protects *everything after the last
 * assistant turn that called tools*: that is the batch the tools just produced, which the model has not read
 * once yet, and shortening it would hide the work the run just paid for.
 *
 * Everything eligible is shortened in one pass rather than a few per round: shortening an old message changes
 * the prefix every later request is cached against, so one batch pays one cache miss instead of one per round.
 */
export function shortenMessages(
  messages: readonly Message[],
  policy: ShrinkPolicy,
  spill: (input: { message: Message; content: string }) => SpilledOutput | null,
  measure: MeasureText,
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
    if (message.role !== 'tool' || !worthShortening(message.content, policy.tokens, measure))
      continue;
    let spilled: SpilledOutput | null = null;
    try {
      spilled = spill({ message, content: message.content });
    } catch {
      spilled = null;
    }
    // No file, no shortening: a pointer to nowhere is worse than a long result, because the model would go
    // looking for text that does not exist and report having read it.
    if (!spilled) continue;
    const content = shortenedContent(
      message.content,
      charactersFor(message.content, policy.tokens, measure),
      (removed, total) => shrinkNotice(spilled, removed, total),
    );
    outcome[index] = { ...message, content };
    shortened += 1;
    freedChars += message.content.length - content.length;
  }
  return { messages: outcome, shortened, freedChars };
}
/**
 * Where the newest `keep` tool results begin.
 *
 * A count of *results*, not of trailing messages: tool results are interleaved with the assistant turns that
 * called them, so a rule that only counted a contiguous trailing run would protect one batch and treat every
 * older batch as fair game — which is the opposite of what "the newest six stay whole" promises.
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
