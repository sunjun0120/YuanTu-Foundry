/**
 * "Which request is the summary request" has exactly one answer, and it is not a fixture's business to restate
 * it.
 *
 * It used to be recognised by its own system prompt — `request.system.includes('context summary')`, the text of
 * the kernel's `summaryPrompt`. The instruction now rides as the request's *last message*, so the mark moved;
 * keeping the mark in one place is what stops the next re-shape of the request from having to be applied to
 * every copy of the old one. That is not hypothetical: the first attempt at this change rewrote eleven
 * compaction tests before discovering that the criteria were spread over ten files, and was reverted.
 *
 * The prefix comes from `packages/core/context.ts` — the constant production code builds the instruction from,
 * not a test-only seam invented for the fixtures.
 */
import type { ModelRequest } from '../packages/protocol/index.ts';
import { SUMMARY_INSTRUCTION_PREFIX } from '../packages/core/context.ts';

/** The text a message carries, whether the wire spelled it as a string or as a content-block array. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('');
}

/** Whether this provider request is the context builder asking for a summary. */
export function isSummaryRequest(request: ModelRequest): boolean {
  return contentText(request.messages.at(-1)?.content).startsWith(SUMMARY_INSTRUCTION_PREFIX);
}

/**
 * The same question asked of a wire body, for the fixtures that answer HTTP rather than a `Provider`.
 *
 * Those see the protocol's own shapes — Anthropic's `system` is a block array and a tool result is a content
 * list — so the text has to be read out of whatever arrived instead of being assumed to be a string.
 */
export function isSummaryBody(body: unknown): boolean {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || !messages.length) return false;
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  return contentText(last?.content).startsWith(SUMMARY_INSTRUCTION_PREFIX);
}
