import { goalExhausted, type Goal } from '../protocol/goals.ts';
/**
 * The rounds a goal may start on its own, bounded by the goal's round budget.
 *
 * - One round is one run; the kernel's `admitGoalRound` spends a round at run start, so the count
 *   lives in the log.
 * - Only an active goal continues; `paused`, `completed`, `blocked` and an exhausted budget stop
 *   the loop.
 * - A failed or cancelled round stops the loop.
 * - Each round keeps its own run ceilings, and a person can always stop the session.
 */
export interface GoalContinuation {
  prompt: string;
  /** The round this continuation will be, for the record: `roundsStarted` counts runs, this is the next one. */
  round: number;
}
/**
 * The continuation prompt, or nothing. It restates the objective and the count, and asks the model
 * to keep working and finish with `update_goal` rather than a question.
 */
export function goalContinuation(goal: Goal | null | undefined): GoalContinuation | undefined {
  if (!goal) return undefined;
  if (goal.status !== 'active') return undefined;
  if (goalExhausted(goal)) return undefined;
  return {
    round: goal.roundsStarted + 1,
    prompt:
      `Continue working toward the session goal: ${goal.objective}\n\n` +
      `This is round ${goal.roundsStarted + 1} of ${goal.maxGoalRounds}, started automatically because the goal ` +
      'is still active. Carry the work forward from what the session already established; do not ask for ' +
      'confirmation and do not restate the plan. When the objective is actually achieved, record it with ' +
      'update_goal { action: "complete" }; if a concrete condition blocks it after real attempts, record that ' +
      'with action: "blocked" and the reason; if the round is not enough, just end it and the next round ' +
      'continues.',
  };
}
/**
 * Run rounds until the goal stops asking. Each `runOnce` is an ordinary run; this only decides
 * whether another may start.
 */
export async function runGoalRounds(input: {
  /** Start one run with this prompt and answer with its status and how much substantive tool work it did. */
  runOnce: (
    prompt: string,
    round: number,
  ) => Promise<{ status: string; toolCalls?: number; tokens?: number }>;
  /** The goal as it now stands — read from the durable log, not from a cache. */
  goalOf: () => Goal | null | undefined;
  /** Called before each continuation, so a caller can log or observe the round it is about to start. */
  onRound?: (continuation: GoalContinuation) => void;
  /**
   * Called when the loop stops only because the goal's budget is spent. The driver owns no store;
   * the caller writes the `exhaustedGoalVerdict` so the goal does not stay `active`.
   */
  onExhausted?: (goal: Goal) => void;
  /**
   * Most continuations this loop may start. A second bound because the model can raise the goal's
   * own budget via `update_goal`.
   */
  maxContinuations: number;
  /**
   * Most tokens the continuations of one request may spend. Checked after each round; the crossing
   * round finishes, but no further round starts.
   */
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<{
  continuations: number;
  stopped: 'goal' | 'rounds' | 'run' | 'cancelled' | 'no-progress' | 'tokens';
}> {
  let continuations = 0;
  let tokens = 0;
  const reportExhausted = (goal: Goal | null | undefined): void => {
    if (goal?.status === 'active' && goalExhausted(goal)) input.onExhausted?.(goal);
  };
  for (;;) {
    if (input.signal?.aborted) return { continuations, stopped: 'cancelled' };
    const goal = input.goalOf();
    const continuation = goalContinuation(goal);
    if (!continuation) {
      reportExhausted(goal);
      return { continuations, stopped: 'goal' };
    }
    if (continuations >= input.maxContinuations) return { continuations, stopped: 'rounds' };
    input.onRound?.(continuation);
    const result = await input.runOnce(continuation.prompt, continuation.round);
    continuations++;
    tokens += result.tokens ?? 0;
    if (result.status !== 'completed') return { continuations, stopped: 'run' };
    /** A round that completed the goal is reported as the goal stopping, not as no progress. */
    const settled = input.goalOf();
    if (!goalContinuation(settled)) {
      reportExhausted(settled);
      return { continuations, stopped: 'goal' };
    }
    /**
     * A round with no substantive tool work does not buy another round. State-recording tools
     * (todo, goal lifecycle, `completion_step`/`completion_scope`) are excluded, and the Host
     * counts only results that changed a file or are new this request. A missing count also stops
     * the loop.
     */
    if ((result.toolCalls ?? 0) <= 0) return { continuations, stopped: 'no-progress' };
    if (input.maxTokens !== undefined && input.maxTokens > 0 && tokens >= input.maxTokens)
      return { continuations, stopped: 'tokens' };
  }
}
