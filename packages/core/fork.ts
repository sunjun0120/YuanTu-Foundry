import type { Message } from '../protocol/index.ts';
/**
 * What a forked child inherits from its parent.
 *
 * A fork copies the parent's transcript into a new child session, and the only hard part is that a
 * transcript is not a list of independent items: a tool result means nothing without the assistant call it
 * answers, and a conversation that begins with a tool result is corrupt rather than merely short. So the
 * budget trims from the oldest end and then moves the cut forward to the first user turn. Before budgeting,
 * an incomplete trailing tool batch is removed: a fork is often requested while the parent's batch is still
 * executing, and the child must not inherit calls whose results have not been recorded yet.
 *
 * The budget is measured in characters of JSON, which is what the transcript costs the child: base64 images
 * and provider continuation state are counted at their real size, because they are exactly what makes an
 * unbounded copy dangerous.
 */
export interface ForkBudget {
  /** Characters of transcript the child starts with. */
  chars: number;
  /** Messages the child starts with, so a long conversation of tiny messages is bounded too. */
  messages: number;
}
export interface ForkSeed {
  /** The parent's messages to copy, oldest first, beginning at a user turn. */
  messages: Message[];
  /** What this seed is worth against the budget. */
  chars: number;
  /** Messages left out by the budget or because the parent's trailing tool batch is incomplete. */
  dropped: number;
}
function messageSize(message: Message): number {
  return JSON.stringify(message).length;
}
/**
 * The suffix of `messages` that fits the budget.
 *
 * An empty seed is a legitimate answer — a single message larger than the whole budget leaves nothing that
 * can be copied — and the caller reports it rather than pretending the child inherited a conversation.
 */
export function forkSeed(messages: readonly Message[], budget: ForkBudget): ForkSeed {
  const sizes = messages.map(messageSize);
  let end = messages.length;
  let batchStart = end - 1;
  while (batchStart >= 0 && messages[batchStart]!.role === 'tool') batchStart--;
  const batch = messages[batchStart];
  if (batch?.role === 'assistant' && batch.toolCalls.length) {
    const pending = new Set(batch.toolCalls.map((call) => call.id));
    let complete = pending.size === batch.toolCalls.length;
    for (let index = batchStart + 1; index < end; index++) {
      const result = messages[index]!;
      if (result.role !== 'tool' || !pending.delete(result.toolCallId)) complete = false;
    }
    if (!complete || pending.size) end = batchStart;
  }
  let start = end;
  let chars = 0;
  let kept = 0;
  for (let index = end - 1; index >= 0; index--) {
    if (kept >= budget.messages || chars + sizes[index]! > budget.chars) break;
    chars += sizes[index]!;
    kept++;
    start = index;
  }
  // Start at a user turn. That is what keeps an orphan tool result out of the child's transcript: a tool
  // message can only ever follow the assistant call it answers, and a conversation has to begin with the
  // user anyway for a provider to accept it.
  while (start < end && messages[start]!.role !== 'user') {
    chars -= sizes[start]!;
    start++;
  }
  return { messages: messages.slice(start, end), chars, dropped: start + messages.length - end };
}
/** How much of the parent's transcript a child inherited, as the model-facing result states it. */
export interface SeedReport {
  messages: number;
  chars: number;
  dropped: number;
}
export function seedReport(seed: ForkSeed): SeedReport {
  return { messages: seed.messages.length, chars: seed.chars, dropped: seed.dropped };
}
