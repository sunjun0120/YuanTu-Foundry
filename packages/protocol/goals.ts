/**
 * A goal: one objective a session is pursuing across runs, recorded so it survives the run that declared it.
 *
 * The durable session already has two things that look adjacent and are not:
 *
 * - A **task** is created by the user, carries acceptance checks and triggers, and is what an attempt is
 *   verified against. It is the operator's definition of done.
 * - A **todo list** is the model's plan *inside* one session, replaced wholesale on every write, and
 *   deliberately not carried anywhere: it is progress the user watches, not a promise the runtime keeps.
 *
 * A goal is the missing third thing: the model's own statement of what it is trying to achieve, one per
 * session, with a round count that makes "how long has this been going on" answerable and a terminal state
 * that makes "is it still running" answerable. The record schedules nothing by itself: the transitions here
 * are pure, and an active goal is inert until something runs it. What runs it is not this module — a carrier
 * starts the next round through `runGoalRounds` (`packages/core/goal-driver.ts`) after a run finishes, and
 * admission at run start (`admitGoalRound` below, applied by the kernel) spends one of the goal's rounds.
 * The split is stated here rather than implied, because a record that looked like it would continue on its
 * own would be trusted to.
 *
 * The transitions are pure and live here, away from the tools that drive them, for the same reason
 * `todoDiff` does: the rules that decide whether an update is allowed are the part worth testing directly.
 */
export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked';
export const GOAL_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked'] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];
export interface Goal {
  objective: string;
  status: GoalStatus;
  /**
   * Runs that began with this goal active, including the one that created it.
   *
   * This is the count the blocked floor is expressed in: "I could not do this" is a claim that costs
   * something, so it needs to be a claim that has actually been worked on.
   */
  roundsStarted: number;
  maxGoalRounds: number;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}
export const GOAL_CEILINGS = {
  /**
   * How many runs one goal may span, at most.
   *
   * The same ceiling DeepSeek Harness resolves for its continuation driver, and for the same reason: a round
   * is one *run*, and the bound has to be large enough that a long task finishes rather than a number chosen to
   * be cautious. What keeps it safe is not this number being small — it is that every round is an ordinary run
   * with its own step, tool and time limits, and that a person can stop the session.
   */
  maxGoalRounds: 4_096,
  objectiveChars: 4000,
  blockedReasonChars: 500,
} as const;
export const GOAL_DEFAULTS = {
  /** Runs a goal spans when the model does not ask for a number. */
  maxGoalRounds: 256,
  /**
   * How many admitted rounds a `blocked` verdict needs before it is accepted.
   *
   * Not a veto on stopping — the model can always stop and explain itself in prose. It is a veto on
   * *recording* the verdict on the first round, which is what makes the recorded state worth reading:
   * a `blocked` goal means the work was attempted repeatedly, not that the first attempt was awkward.
   */
  blockedMinRounds: 3,
} as const;
/**
 * The most continuation rounds one request may start on its own, whatever the goal's budget says.
 *
 * A *second* bound, and the reason it is not `GOAL_CEILINGS.maxGoalRounds` is the whole point of having it:
 * that ceiling is a number the model can raise through `update_goal`, so a host that passed it here had one
 * bound wearing two names — a model that edited `max_goal_rounds` to the ceiling also decided how many rounds
 * the host would run unattended. This one is not reachable from a tool call at all.
 *
 * Its value is the shipped default budget, which is the amount of unattended work a user who never thought
 * about the question has already agreed to: a goal that asks for more than this gets another request from the
 * user, which is the cheap way to spend more than somebody agreed to.
 */
export const GOAL_CONTINUATIONS_PER_REQUEST = GOAL_DEFAULTS.maxGoalRounds;
/**
 * The goal actions only a person's own turn may take.
 *
 * The goal exists so an objective outlives the run that declared it, and the runtime is what starts the rounds
 * nobody asked for. That makes the record's own standing the one thing a model must not be able to rewrite by
 * itself: `edit` is how a model would widen its own autonomy (`max_goal_rounds` is the autonomy budget), and
 * `pause` / `resume` decide whether the runtime keeps going at all — so `resume` is how a model would overrule
 * a person who paused the work, and `pause` is how it would quietly stop work a person is waiting for.
 *
 * A turn that carries the user's own input may do all three, because then it is the user's turn doing it: both
 * a run the user started and a round that consumed a message the user typed while it was working.
 *
 * `complete` and `blocked` are deliberately absent. Recording that the objective is achieved, or that a
 * concrete condition stopped it, is the model's job and its only way to end a goal; gating those would leave
 * every goal `active` forever and make the watchdog below meaningless.
 */
export const HUMAN_ONLY_GOAL_ACTIONS = ['edit', 'pause', 'resume'] as const;
/**
 * Why this action may not be taken in this turn, or `undefined` when it may.
 *
 * A pure function rather than a check inside the tool body for the reason `changeGoal` is: this is a rule about
 * who is allowed to do what, and a rule worth having is worth testing without a tool call.
 */
export function goalAuthorityRefusal(action: GoalAction, humanTurn: boolean): string | undefined {
  if (humanTurn || !(HUMAN_ONLY_GOAL_ACTIONS as readonly GoalAction[]).includes(action))
    return undefined;
  const what =
    action === 'edit'
      ? 'changing the objective or the round budget'
      : action === 'resume'
        ? 'starting the work again'
        : 'stopping work the user is waiting for';
  return (
    `\`${action}\` is refused: it is ${what}, which changes who is in charge of this goal, and this round ` +
    'was started by the runtime rather than by the user. Report progress with `complete` or `blocked` instead, ' +
    `or ask the user to ${action} it.`
  );
}
/** What one accepted action changes. Every field is optional: an action names only what it means. */
export interface GoalChange {
  /**
   * Deliberately `unknown`: these are what the model proposed, and the validating functions below are the only
   * place that turns a proposal into a value. Typing them as strings here would move half the check into the
   * type system and leave the other half — the length, the emptiness, the range — in a second copy.
   */
  objective?: unknown;
  maxGoalRounds?: unknown;
  blockedReason?: unknown;
}
/**
 * Every label a recorded change can carry: the five a tool can ask for, plus the two the runtime performs.
 *
 * `create` and `round` are not actions the model may request — they are what the runtime does when a goal is
 * declared and when a later run is admitted to it. They are labels on the same event because a reader of the
 * log should see the goal's whole history in one shape, and because a projection that folded two event types
 * would have two chances to disagree.
 */
export type GoalChangeAction = GoalAction | 'create' | 'round';
export class GoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalError';
  }
}
function objective(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new GoalError('A goal needs an objective');
  const text = value.trim();
  if (text.length > GOAL_CEILINGS.objectiveChars)
    throw new GoalError(`An objective may be at most ${GOAL_CEILINGS.objectiveChars} characters`);
  return text;
}
function rounds(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > GOAL_CEILINGS.maxGoalRounds
  )
    throw new GoalError(
      `max_goal_rounds must be an integer from 1 to ${GOAL_CEILINGS.maxGoalRounds}`,
    );
  return value as number;
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new GoalError('A blocked goal needs a blocked_reason: what stopped it, concretely');
  const text = value.trim();
  if (text.length > GOAL_CEILINGS.blockedReasonChars)
    throw new GoalError(
      `A blocked reason may be at most ${GOAL_CEILINGS.blockedReasonChars} characters`,
    );
  return text;
}
/** The goal a session starts with. `roundsStarted` is 1: the run that declares it is its first round. */
export function newGoal(input: { objective: unknown; maxGoalRounds?: unknown }, now: string): Goal {
  return {
    objective: objective(input.objective),
    status: 'active',
    roundsStarted: 1,
    maxGoalRounds:
      input.maxGoalRounds === undefined ? GOAL_DEFAULTS.maxGoalRounds : rounds(input.maxGoalRounds),
    createdAt: now,
    updatedAt: now,
  };
}
/**
 * One accepted action, or a throw naming why it is not one.
 *
 * The three authority-adjacent rules a reader should be able to find here rather than in a tool body:
 * a terminal goal takes no edits except the one that reopens it, `blocked` needs a reason *and* a
 * worked-on goal, and nothing here can resurrect a completed objective except a changed objective.
 */
export function changeGoal(goal: Goal, action: GoalAction, input: GoalChange, now: string): Goal {
  const next: Goal = { ...goal, updatedAt: now };
  switch (action) {
    case 'edit': {
      if (input.objective !== undefined) next.objective = objective(input.objective);
      if (input.maxGoalRounds !== undefined) next.maxGoalRounds = rounds(input.maxGoalRounds);
      if (input.objective === undefined && input.maxGoalRounds === undefined)
        throw new GoalError('edit needs an objective or a max_goal_rounds to change');
      /**
       * A verdict belongs to the objective it was reached against. Changing that objective therefore
       * reopens the goal rather than leaving a `blocked` row that describes work nobody is doing any more.
       */
      if (next.status === 'blocked' || next.status === 'completed') {
        next.status = 'active';
        delete next.blockedReason;
      }
      return next;
    }
    case 'pause':
      if (goal.status !== 'active')
        throw new GoalError(`Only an active goal can be paused (this one is ${goal.status})`);
      next.status = 'paused';
      return next;
    case 'resume':
      if (goal.status !== 'paused')
        throw new GoalError(`Only a paused goal can be resumed (this one is ${goal.status})`);
      next.status = 'active';
      return next;
    case 'complete':
      if (goal.status === 'completed') throw new GoalError('The goal is already completed');
      next.status = 'completed';
      delete next.blockedReason;
      return next;
    case 'blocked': {
      if (goal.status === 'completed')
        throw new GoalError('A completed goal cannot become blocked');
      if (goal.status === 'blocked') throw new GoalError('The goal is already blocked');
      const blockedReason = reason(input.blockedReason);
      if (goal.roundsStarted < GOAL_DEFAULTS.blockedMinRounds)
        throw new GoalError(
          `A goal can only be recorded as blocked after ${GOAL_DEFAULTS.blockedMinRounds} rounds of work; this one has ${goal.roundsStarted}. Report the blocker in your reply instead.`,
        );
      next.status = 'blocked';
      next.blockedReason = blockedReason;
      return next;
    }
  }
}
/**
 * The goal one more round belongs to, or the same goal when its limit is reached.
 *
 * Clamped rather than thrown: reaching the limit is not an error the run should die on, and it is not a
 * state that changes what the model may do — it is a fact the next `get_goal` reports and the run-start
 * notice states, so the decision to raise the ceiling, complete the goal or record it blocked stays with
 * the model instead of being made silently on its behalf.
 */
export function admitGoalRound(goal: Goal, now: string): Goal {
  if (goal.status !== 'active' || goal.roundsStarted >= goal.maxGoalRounds) return goal;
  return { ...goal, roundsStarted: goal.roundsStarted + 1, updatedAt: now };
}
/** Whether the goal has spent every round it was given. */
export function goalExhausted(goal: Goal): boolean {
  return goal.roundsStarted >= goal.maxGoalRounds;
}
/**
 * The verdict to record for a goal whose rounds are spent, or `undefined` when there is nothing to say.
 *
 * This is a transition of its own rather than a call to `changeGoal` because of one rule it deliberately does
 * not apply: the blocked floor. That floor exists so a *model* cannot take the easy exit on its first round —
 * it is what makes a recorded `blocked` mean "attempted repeatedly" rather than "the first attempt was
 * awkward". This verdict is not the model's claim. It is the runtime stating the one thing it knows for
 * certain, that its own loop will not start another round, and the reason it writes carries the counts the
 * verdict rests on so a reader can weigh it.
 *
 * A goal left `active` after its budget is spent is the state that must not survive, because `active` is
 * exactly what tells the next request to start another round.
 */
export function exhaustedGoalVerdict(goal: Goal, now: string): Goal | undefined {
  if (goal.status !== 'active' || !goalExhausted(goal)) return undefined;
  return {
    ...goal,
    updatedAt: now,
    status: 'blocked',
    blockedReason:
      `Round budget spent: ${goal.roundsStarted}/${goal.maxGoalRounds} round(s) without the objective being ` +
      'achieved, so the runtime will not start another one on its own. Raise max_goal_rounds, or say what to ' +
      'do next.',
  };
}
export function isGoal(value: unknown): value is Goal {
  if (!value || typeof value !== 'object') return false;
  const goal = value as Record<string, unknown>;
  return (
    typeof goal.objective === 'string' &&
    goal.objective.length > 0 &&
    (goal.status === 'active' ||
      goal.status === 'paused' ||
      goal.status === 'completed' ||
      goal.status === 'blocked') &&
    Number.isSafeInteger(goal.roundsStarted) &&
    Number.isSafeInteger(goal.maxGoalRounds) &&
    typeof goal.createdAt === 'string' &&
    typeof goal.updatedAt === 'string' &&
    (goal.blockedReason === undefined || typeof goal.blockedReason === 'string')
  );
}
/** One line for a tool result, a notice or a log line: the state first, because that decides what to do. */
export function goalLine(goal: Goal): string {
  const rounds = `${goal.roundsStarted}/${goal.maxGoalRounds} round(s)`;
  const reason = goal.blockedReason ? ` — blocked: ${goal.blockedReason}` : '';
  return `[${goal.status}] ${goal.objective} (${rounds})${reason}`;
}
