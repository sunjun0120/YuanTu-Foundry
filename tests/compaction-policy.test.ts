/**
 * When to compress, how much to keep, and how hard to try again.
 *
 * Three numbers that used to be two separate ideas — a character ceiling and a "does this request fit" check —
 * which put compression at the model's limit rather than before it, and kept "whatever starts at the previous
 * user turn" rather than a share of the conversation. These tests pin the arithmetic, the two configuration
 * mistakes that must be refused instead of approximated, and the shape of the retained tail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACTION_DEFAULTS,
  resolveCompactionSpec,
  retentionStart,
} from '../packages/core/compaction-policy.ts';
import { estimateMessageTokens } from '../packages/core/budget.ts';
import type { Message } from '../packages/protocol/index.ts';

test('the threshold sits under the window, with the output reservation and headroom taken out first', () => {
  const spec = resolveCompactionSpec({
    contextWindow: 1_000_000,
    reservedCompletionTokens: 256_000,
  });
  assert.equal(
    spec.messageBudgetTokens,
    744_000,
    'the request reserves its own answer out of the window',
  );
  assert.equal(spec.pressureBudgetTokens, 744_000 - 65_536);
  assert.equal(
    spec.thresholdTokens,
    Math.floor(Math.min(1_000_000 * 0.8, 744_000 - 65_536)),
    'the lower of the ratio and the budget left after the reservation is the threshold',
  );
  assert.equal(spec.thresholdTokens, 678_464);
  assert.equal(spec.retainTokens, Math.floor(744_000 * 0.16));
  assert.equal(spec.compactionRetries, COMPACTION_DEFAULTS.compactionRetries);
  assert.equal(spec.maxOverflowRetries, COMPACTION_DEFAULTS.maxOverflowRetries);
});

test('the ratio wins on a window with room to spare, and the budget wins on a tight one', () => {
  // Reservation small enough that 80% of the window is still below what messages may use: the ratio binds.
  const wide = resolveCompactionSpec({ contextWindow: 400_000, reservedCompletionTokens: 8_192 });
  assert.equal(wide.thresholdTokens, 320_000);
  // A reservation big enough to matter: the ratio would land above what is actually left, so the budget binds.
  const tight = resolveCompactionSpec({
    contextWindow: 200_000,
    reservedCompletionTokens: 100_000,
  });
  assert.equal(tight.thresholdTokens, Math.min(160_000, 100_000 - 65_536));
  assert.equal(tight.thresholdTokens, 34_464);
});

test('an operator threshold replaces the computed one rather than adding a second ceiling', () => {
  const spec = resolveCompactionSpec({
    contextWindow: 200_000,
    reservedCompletionTokens: 8_192,
    thresholdTokens: 50_000,
  });
  assert.equal(spec.thresholdTokens, 50_000);
  // ...and it cannot exceed what messages may actually use, or the threshold would be unreachable.
  assert.equal(
    resolveCompactionSpec({
      contextWindow: 200_000,
      reservedCompletionTokens: 8_192,
      thresholdTokens: 500_000,
    }).thresholdTokens,
    191_808,
  );
});

test('a window that cannot carry the reservation and the headroom is refused, with the numbers named', () => {
  /**
   * The alternative — clamping — would compress a conversation into nothing on every round and report it as
   * normal operation. The callers report this and carry on without proactive compression instead, which is
   * why the message has to say which two numbers disagree.
   */
  assert.throws(
    () => resolveCompactionSpec({ contextWindow: 100_000, reservedCompletionTokens: 100_000 }),
    /leaving no room for messages/,
  );
  // Messages have room, but not enough for the headroom on top of it.
  assert.throws(
    () => resolveCompactionSpec({ contextWindow: 70_000, reservedCompletionTokens: 8_192 }),
    /headroom tokens/,
  );
  assert.throws(
    () => resolveCompactionSpec({ contextWindow: 0, reservedCompletionTokens: 0 }),
    /positive context window/,
  );
  assert.throws(
    () =>
      resolveCompactionSpec({
        contextWindow: 200_000,
        reservedCompletionTokens: 8_192,
        thresholdTokens: 1_000,
      }),
    /already reaches the .* threshold/,
  );
});

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content, toolCalls: [] });
/** Turns whose sizes are easy to reason about: each pair is roughly `chars`/3 tokens. */
function transcript(turns: number, chars: number): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < turns; index++) {
    messages.push(user(`u${index} ${'x'.repeat(chars)}`));
    messages.push(assistant(`a${index} ${'y'.repeat(chars)}`));
  }
  return messages;
}
/** Every position at which a compaction may cut: here, after each complete turn. */
function turnCuts(history: Message[]): number[] {
  return history
    .map((_, index) => index + 1)
    .filter((cut) => cut % 2 === 0 || cut === history.length);
}

test('the retained tail is the newest conversation worth the budget, not since the last user turn', () => {
  const history = transcript(6, 3_000);
  const cuts = turnCuts(history);
  /**
   * Each message here is about 3,000 characters, so about 1,010 tokens once measured as a *message* — no
   * request-level protocol margin, which is what `estimateMessageTokens` exists for. The budgets below are read
   * in those tokens: 3,000 reaches back about three messages, 6,000 about six, and a budget past the whole tail
   * has no answer at all.
   */
  const small = retentionStart(history, cuts, 0, 3_000);
  assert.ok(cuts.includes(small!), 'the start is a position a compaction may cut at');
  assert.ok(small! > history.length - 5, `expected a recent cut, got ${String(small)}`);
  const larger = retentionStart(history, cuts, 0, 6_000);
  assert.ok(
    larger !== undefined && smaller(larger, small!),
    'a bigger budget reaches further back',
  );
  // Nothing retained is a real request — an overflow recovery keeps nothing — and it means the newest cut.
  assert.equal(retentionStart(history, cuts, 0, 0), history.length);
  // A budget larger than the whole tail has no answer: the caller decides what "keep everything" means.
  assert.equal(retentionStart(history, cuts, 0, 10_000_000), undefined);
});
/** Smaller of two cut positions, tolerating the `undefined` that "keep everything" answers with. */
function smaller(left: number, right: number | undefined): boolean {
  return right === undefined ? false : left < right;
}

test('the retained tail is measured in the tokens the endpoint bills, not the estimator’s own units', () => {
  const history = transcript(12, 3_000);
  const cuts = turnCuts(history);
  const budget = 6_000;
  const plain = retentionStart(history, cuts, 0, budget)!;
  // A route whose real tokenizer costs three times what the heuristic guessed: the same budget buys a third of
  // the conversation, so the tail starts *later*. Keeping the uncorrected tail is what makes a compaction leave a
  // request that still does not fit the window it was called to clear.
  const corrected = retentionStart(history, cuts, 0, budget, 3)!;
  assert.ok(cuts.includes(corrected), 'the start is still a position a compaction may cut at');
  assert.ok(
    corrected > plain,
    `a correction above one keeps fewer messages (${String(corrected)} vs ${String(plain)})`,
  );
  /**
   * And the size of each answer, in the units the budget is written in: the corrected tail is within one message
   * of the budget, while the uncorrected one is over it by roughly the factor — which is exactly the error the
   * factor removes.
   */
  const measured = (start: number, factor: number) =>
    history
      .slice(start)
      .reduce((total, message) => total + estimateMessageTokens(message, factor), 0);
  const oneMessage = estimateMessageTokens(history[0]!, 3);
  assert.ok(measured(corrected, 3) >= budget, 'the budget is reached, not under-spent');
  assert.ok(
    measured(corrected, 3) < budget + oneMessage,
    'and it stops at the first message that reaches it',
  );
  assert.ok(
    measured(plain, 3) > budget + oneMessage,
    'the uncorrected tail is larger than the budget it was supposed to fit',
  );
  // A cheaper route is the mirror image: the same budget buys more conversation.
  assert.ok(smaller(retentionStart(history, cuts, 0, budget, 0.5)!, plain));
});

test('retention never lands inside a tool-call/result group, and nothing retained means the newest cut', () => {
  const history: Message[] = [
    user('start'),
    assistant(''),
    user('more'),
    assistant(''),
    ...transcript(2, 3_000),
  ];
  history[1] = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }],
  };
  history[2] = { role: 'tool', toolCallId: 'c1', content: 'result', isError: false };
  // Cuts after index 1 would split the call from its result, so the candidate set excludes it.
  const cuts = [0, 2, 3, 5, history.length];
  const start = retentionStart(history, cuts, 0, 1);
  assert.ok(cuts.includes(start!), 'the start is a position a compaction is allowed to cut at');
  assert.equal(
    retentionStart(history, [0, 2, 3, 5, history.length], 0, 0),
    history.length,
    'keeping nothing verbatim cuts at the newest allowed position',
  );
  // A budget nobody can reach keeps the whole conversation: the caller decides whether that is acceptable.
  assert.equal(retentionStart(history, cuts, 0, 10_000_000), undefined);
});
