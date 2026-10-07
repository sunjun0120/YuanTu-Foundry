import { goalExhausted, type Goal } from '../protocol/goals.ts';
/**
 * The rounds a goal is allowed to start on its own.
 *
 * A goal is a session's objective; until now it was only *read* — the next run in the session was told about it,
 * and nothing ever started that run. That boundary was deliberate while there was no way to bound autonomous
 * work: a runtime that restarts itself is a runtime that can spend without anyone watching.
 *
 * The bound is the goal's own round budget, which is what makes this half buildable at all:
 *
 * - **One round is one run.** Admission lives in the kernel (`admitGoalRound` at run start), so every
 *   continuation this driver starts spends exactly one of the goal's rounds — the count stays a record in the
 *   log rather than a counter this loop keeps.
 * - **Only an active goal continues.** `paused`, `completed` and `blocked` are answers, not pauses: the loop
 *   stops on all three, and so does an exhausted budget.
 * - **A round that did not finish stops the loop.** A failed or cancelled run is not progress, and continuing
 *   past it would turn one broken round into an unbounded bill.
 * - **The loop is not the only bound.** The run's own ceilings (the window, the output limit, tool wall clocks,
 *   cancellation) still apply to each round, and a person can always stop the session.
 */
export interface GoalContinuation {
  prompt: string;
  /** The round this continuation will be, for the record: `roundsStarted` counts runs, this is the next one. */
  round: number;
}
/**
 * What to send when a goal may take another round, or nothing.
 *
 * The prompt is deliberately plain: it restates the objective (a run started by a loop has no human turn to
 * carry it), says where the count stands, and says what "keep going" means — report progress, do not stop to
 * ask for confirmation, and finish with `update_goal` rather than with a question. Everything else the model
 * needs is already in the session: the goal is durable, and the run-start notice reads it back.
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
 * Run rounds until the goal stops asking for them.
 *
 * The driver is a loop over `runOnce`, not over the kernel: each call is an ordinary run — its own steps, its own
 * limits, its own events — and this function only decides whether another one may start. That is what keeps the
 * bound honest: the count that limits this loop is the same one an operator can read, raise, or close.
 */
export async function runGoalRounds(input: {
  /** Start one run with this prompt and answer with its status. */
  runOnce: (prompt: string, round: number) => Promise<{ status: string }>;
  /** The goal as it now stands — read from the durable log, not from a cache. */
  goalOf: () => Goal | null | undefined;
  /** Called before each continuation, so a caller can log or observe the round it is about to start. */
  onRound?: (continuation: GoalContinuation) => void;
  /**
   * Called when the loop stops *only* because the goal's own round budget is spent.
   *
   * The driver reports it rather than recording it, because the driver owns no store: a caller writes the
   * verdict `exhaustedGoalVerdict` derives, and one that writes nothing leaves the goal `active`, which is the
   * state this hook exists to keep out of a session's log.
   */
  onExhausted?: (goal: Goal) => void;
  /**
   * The most continuations this loop may start, whatever the goal's own budget says.
   *
   * A second bound on purpose: the goal's budget is a record the *model* may raise through `update_goal`, and a
   * loop with exactly one bound is a loop the thing it bounds can extend. A host that wants the goal's number to
   * be the only one passes its ceiling.
   */
  maxContinuations: number;
  signal?: AbortSignal;
}): Promise<{ continuations: number; stopped: 'goal' | 'rounds' | 'run' | 'cancelled' }> {
  let continuations = 0;
  for (;;) {
    if (input.signal?.aborted) return { continuations, stopped: 'cancelled' };
    const goal = input.goalOf();
    const continuation = goalContinuation(goal);
    if (!continuation) {
      if (goal?.status === 'active' && goalExhausted(goal)) input.onExhausted?.(goal);
      return { continuations, stopped: 'goal' };
    }
    if (continuations >= input.maxContinuations) return { continuations, stopped: 'rounds' };
    input.onRound?.(continuation);
    const result = await input.runOnce(continuation.prompt, continuation.round);
    continuations++;
    if (result.status !== 'completed') return { continuations, stopped: 'run' };
  }
}
