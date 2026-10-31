import type { Message } from '../../protocol/index.ts';
import { assertPrunePolicyFits, pruneNotice } from '../../protocol/prune-policy.ts';
import { codePointLength } from './text.ts';
import { recentStart } from './shrink.ts';

/**
 * Drops the middle of a tool result the model has already read, keeping head and tail with a
 * marker.
 *
 * - No I/O and no model request, so it works where spilling cannot (read-only workspace, full
 *   disk).
 * - Bounded by construction: head, full notice and tail fit the threshold, so one pass suffices.
 * - Never deletes: only a tool message's `content` changes; pairing and `isError` are untouched,
 *   and the stored transcript keeps everything.
 *
 * The notice tells the model the result was shortened.
 */
export interface PrunePolicy {
  /**
   * Code points a result keeps before its middle is dropped; below the 24,000-character production
   * bound so it can fire.
   */
  thresholdChars: number;
  /** Code points kept at the head, where a log states what it is doing. */
  headChars: number;
  /** Code points kept at the tail, where a log states how it ended. */
  tailChars: number;
}
/**
 * Legacy short marker, still exported. Validation reserves the full notice's maximum length
 * instead.
 */
export { PRUNE_MARKER } from '../../protocol/prune-policy.ts';
/** Marks a result this pass has already pruned, so projecting twice is a no-op rather than a second cut. */
export const PRUNE_MARK = '[... middle pruned ...]';
export interface PruneOutcome {
  messages: Message[];
  /** How many results this pass pruned. */
  pruned: number;
  /** Code points the model no longer has to carry: what was removed, minus what the markers added. */
  prunedChars: number;
}
/** Code points in `text`, the unit budgets use; defined in `text.ts`. */
export { codePointLength };
/** Whether a result is short enough to leave alone (at or under the threshold). */
export function worthPruning(content: string, policy: PrunePolicy): boolean {
  return !content.includes(PRUNE_MARK) && codePointLength(content) > policy.thresholdChars;
}
/**
 * Replace one result's middle, keeping head and tail.
 *
 * @returns the pruned text, or `null` when within budget or there is no middle to drop.
 */
export function pruneContent(content: string, policy: PrunePolicy): string | null {
  if (!worthPruning(content, policy)) return null;
  // Cut on code points so surrogate pairs are never split; grapheme clusters may be.
  const characters = [...content];
  const removed = characters.length - policy.headChars - policy.tailChars;
  if (removed <= 0) return null;
  const head = characters.slice(0, policy.headChars).join('');
  const tail = characters.slice(characters.length - policy.tailChars).join('');
  return head + pruneNotice(removed, characters.length) + tail;
}
/**
 * Prune old tool results in one pass. Recent results are protected by the same rules as `shrink.ts`
 * (`recentStart`): the newest `keepRecent` and everything after the last tool-calling assistant
 * turn. One pass means one cache miss.
 */
export function pruneMessages(
  messages: readonly Message[],
  policy: PrunePolicy,
  keepRecent: number,
  preserved?: ReadonlySet<Message>,
): PruneOutcome {
  const protectedFrom = protectedBoundary(messages, keepRecent);
  const outcome = messages.map((message) => message);
  let pruned = 0;
  let prunedChars = 0;
  for (let index = 0; index < protectedFrom; index++) {
    const message = messages[index]!;
    if (message.role !== 'tool' || preserved?.has(message)) continue;
    const content = pruneContent(message.content, policy);
    if (content === null) continue;
    outcome[index] = { ...message, content };
    pruned += 1;
    // Report the saving in code points, the budget's unit.
    prunedChars += codePointLength(message.content) - codePointLength(content);
  }
  return { messages: outcome, pruned, prunedChars };
}
/**
 * Where protected results begin: the earlier of the newest `keep` results and the last call's
 * batch. Exported for the agreement test.
 */
export function protectedBoundary(messages: readonly Message[], keepRecent: number): number {
  let lastCall = -1;
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.toolCalls.length) lastCall = index;
  });
  return Math.min(lastCall + 1, recentStart(messages, keepRecent));
}
/**
 * Refuse a policy unless `head + marker + tail <= threshold`, so one pass always lands within
 * budget. Checked at startup.
 */
export function assertPrunePolicy(policy: PrunePolicy): void {
  assertPrunePolicyFits(policy);
}
