import type { Message } from '../protocol/index.ts';
import { recentStart } from './shrink.ts';

/**
 * Dropping the middle of a tool result the model has already read, without writing anything anywhere.
 *
 * A tool result is bounded when it is produced and `shrink.ts` bounds it again for later rounds, but both of
 * those are *records*: the producer writes the full text to a file and the result carries a pointer to it. That
 * is the right shape when the text still has to exist — and the wrong one when it does not need to. A 200,000
 * character build log or `git diff` whose head and tail already say what happened is context the model carries
 * for the rest of the session, and the middle of it is the part nobody reads twice.
 *
 * So this pass keeps the head and the tail and puts a marker where the middle was. Three consequences, and each
 * one is the reason for a rule below:
 *
 * - **It costs no I/O and no model request.** Nothing is written and nothing is asked, so it works in a
 *   read-only workspace, on a full disk, and in a session whose spill directory is gone — the cases where a
 *   pointer to a file that cannot be created would have left the conversation unshortened.
 * - **It is bounded by construction, not by estimate.** {@link PRUNE_MARKER} is counted in the invariant that the
 *   head, the marker and the tail together fit the threshold, so one pass leaves the result *within* the budget
 *   rather than near it, and a second pass finds nothing to do.
 * - **It never deletes.** Only the `content` of a tool message is replaced, so the call/result pairing a provider
 *   validates is untouched and `isError` still says what happened. The transcript on disk keeps every character.
 *
 * The result says so itself. A model told "this was shortened" reasons about a gap it knows about; a model that
 * believes it read the whole log reasons from a false premise, which is the failure this notice exists to
 * prevent.
 */
export interface PrunePolicy {
  /**
   * Code points a result keeps before its middle is dropped.
   *
   * Below the 24,000-character bound a result is produced with, which is what gives this pass a range in which
   * it can fire; a threshold above that bound would be a setting that can never do anything.
   */
  thresholdChars: number;
  /** Code points kept at the head, where a log states what it is doing. */
  headChars: number;
  /** Code points kept at the tail, where a log states how it ended. */
  tailChars: number;
}
/**
 * What replaces a dropped middle.
 *
 * Counted as code points in {@link assertPrunePolicy}, because it sits between the head and the tail and the
 * three together are what has to fit the threshold. A marker that pushed the result back over the budget would
 * make the pass a way to spend context rather than to save it.
 */
export const PRUNE_MARKER = '\n\n[... middle pruned ...]\n\n';
/** Marks a result this pass has already pruned, so projecting twice is a no-op rather than a second cut. */
export const PRUNE_MARK = '[... middle pruned ...]';
export interface PruneOutcome {
  messages: Message[];
  /** How many results this pass pruned. */
  pruned: number;
  /** Characters the model no longer has to carry: what was removed, minus what the markers added. */
  prunedChars: number;
}
/**
 * Code points in `text`, which is the unit a budget is stated in.
 *
 * Not `.length`: that counts UTF-16 code units, so an emoji or any character outside the basic plane counts as
 * two, and a cut placed on an odd count splits the surrogate pair and produces a lone half that every encoder
 * then has to decide what to do with. Counting code points keeps every cut on a character boundary.
 */
export function codePointLength(text: string): number {
  return [...text].length;
}
/**
 * Whether a result is short enough to leave alone.
 *
 * A result at or under the threshold is not worth touching even when it could be made smaller: the saving is
 * what pays for the gap the model then has to reason around, and below the threshold there is not enough of it.
 */
export function worthPruning(content: string, policy: PrunePolicy): boolean {
  return !content.includes(PRUNE_MARK) && codePointLength(content) > policy.thresholdChars;
}
/**
 * Replace one result's middle, keeping its head and its tail.
 *
 * @returns the pruned text, or `null` when the content is within budget or carries no middle to drop.
 */
export function pruneContent(content: string, policy: PrunePolicy): string | null {
  if (!worthPruning(content, policy)) return null;
  // Code points, cut on character boundaries: `[...content]` iterates characters, so a slice of it can never
  // split a surrogate pair. A multi-character grapheme cluster can still be split, which is the documented
  // limit of a character budget rather than a bug in it.
  const characters = [...content];
  const removed = characters.length - policy.headChars - policy.tailChars;
  if (removed <= 0) return null;
  const head = characters.slice(0, policy.headChars).join('');
  const tail = characters.slice(characters.length - policy.tailChars).join('');
  return head + notice(removed, characters.length) + tail;
}
/** The line that replaces a dropped middle. It is model-visible, so it says what happened and where the copy is. */
function notice(removed: number, total: number): string {
  return `\n\n${PRUNE_MARK} ${removed} of ${total} characters removed to keep this conversation within budget; the full result is in the session transcript\n\n`;
}
/**
 * Prune the old tool results in one pass.
 *
 * The newest results are protected by the same two rules `shrink.ts` uses, and for the same reasons: `keepRecent`
 * protects a count of results, which is what a caller can reason about, and the structural rule protects
 * everything after the last assistant turn that called tools — the batch the model has not read once yet, which
 * pruning would hide before it was ever seen. Sharing `recentStart` rather than restating the rule is what keeps
 * the two passes agreeing about which results are recent.
 *
 * Everything eligible is pruned in one pass rather than a few per round: replacing an old message changes the
 * prefix every later request is cached against, so one batch pays one cache miss instead of one per round.
 */
export function pruneMessages(
  messages: readonly Message[],
  policy: PrunePolicy,
  keepRecent: number,
): PruneOutcome {
  const protectedFrom = protectedBoundary(messages, keepRecent);
  const outcome = messages.map((message) => message);
  let pruned = 0;
  let prunedChars = 0;
  for (let index = 0; index < protectedFrom; index++) {
    const message = messages[index]!;
    if (message.role !== 'tool') continue;
    const content = pruneContent(message.content, policy);
    if (content === null) continue;
    outcome[index] = { ...message, content };
    pruned += 1;
    prunedChars += message.content.length - content.length;
  }
  return { messages: outcome, pruned, prunedChars };
}
/**
 * Where the newest results begin: the earlier of the newest `keep` results and the batch the last call produced.
 *
 * Exported for the test that asserts the two passes agree, and because "which results are protected" is the one
 * rule here that a caller can get wrong without noticing.
 */
export function protectedBoundary(messages: readonly Message[], keepRecent: number): number {
  let lastCall = -1;
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.toolCalls.length) lastCall = index;
  });
  return Math.min(lastCall + 1, recentStart(messages, keepRecent));
}
/**
 * Refuse a policy whose marker cannot fit between its head and its tail.
 *
 * This is the invariant the bounded-by-construction claim rests on: `head + marker + tail <= threshold` is what
 * makes one pass land inside the budget for *every* content, rather than for the contents someone happened to
 * test. A policy that violated it would prune a result into something still over the threshold and then prune it
 * again on the next round, which is the shape of a loop rather than of a saving.
 *
 * Checked where the policy is resolved, so a bad one is a startup failure rather than a session that quietly
 * rewrites its own history every round.
 */
export function assertPrunePolicy(policy: PrunePolicy): void {
  const marker = codePointLength(PRUNE_MARKER);
  const fits = policy.headChars + marker + policy.tailChars;
  if (fits > policy.thresholdChars)
    throw new Error(
      `Prune policy keeps ${policy.headChars} head and ${policy.tailChars} tail characters plus a ` +
        `${marker}-character marker, which does not fit its ${policy.thresholdChars}-character threshold; ` +
        'the marker would push a pruned result back over the budget it was pruned for',
    );
}
