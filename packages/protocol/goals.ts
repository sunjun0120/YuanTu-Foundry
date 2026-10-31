/**
 * A goal: one objective a session pursues across runs, recorded so it outlives the run that
 * declared it. Unlike a task (user-defined, with acceptance checks) or a todo list (the model's
 * in-run plan), a goal is the model's own statement of intent, one per session, with a round count
 * and a terminal state.
 *
 * The record schedules nothing. A carrier starts further rounds via `runGoalRounds`
 * (`packages/core/goal-driver.ts`), and `admitGoalRound` spends one round at run start. Transitions
 * are pure so the rules can be tested directly.
 */
export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked';
export const GOAL_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked'] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];
export interface Goal {
  objective: string;
  status: GoalStatus;
  /**
   * Runs that began with this goal active, including the one that created it. The blocked floor is
   * expressed in this count.
   */
  roundsStarted: number;
  maxGoalRounds: number;
  blockedReason?: string;
  /**
   * Why the runtime stopped continuing this goal while leaving it active (no progress, or the
   * request's continuation limit), so a window can say so. Cleared by the next admitted round or
   * any goal change.
   */
  standDown?: GoalStandDown;
  createdAt: string;
  updatedAt: string;
}
export const GOAL_STAND_DOWN_REASONS = ['no-progress', 'request-limit', 'token-limit'] as const;
export interface GoalStandDown {
  reason: (typeof GOAL_STAND_DOWN_REASONS)[number];
  /** Continuation rounds the request ran before it stopped. */
  continuations: number;
  at: string;
}
export const GOAL_CEILINGS = {
  /**
   * Most runs one goal may span. Large on purpose: each round is an ordinary bounded run and a
   * person can stop the session.
   */
  maxGoalRounds: 4_096,
  objectiveChars: 4000,
  blockedReasonChars: 500,
} as const;
export const GOAL_DEFAULTS = {
  /** Runs a goal spans when the model does not ask for a number. */
  maxGoalRounds: 256,
  /**
   * Admitted rounds required before a `blocked` verdict is recorded, so `blocked` means repeated
   * attempts. The model can still stop and explain in prose.
   */
  blockedMinRounds: 3,
} as const;
/**
 * Most continuation rounds one request may start on its own. Separate from
 * `GOAL_CEILINGS.maxGoalRounds` because that one the model can raise via `update_goal`; this one no
 * tool can reach. Further rounds need another user request; the goal's count carries over.
 */
export const GOAL_CONTINUATIONS_PER_REQUEST = 32;
/**
 * Most tokens one request's automatic continuations may spend. Not reachable from a tool call; each
 * user request starts a fresh allowance.
 */
export const GOAL_TOKENS_PER_REQUEST = 20_000_000;
/**
 * Goal actions only a person's own turn may take. `edit` would let a model widen its own autonomy
 * (`max_goal_rounds`), and `pause`/`resume` decide whether the runtime keeps going. A turn carrying
 * the user's input (a run they started, or a round that consumed their message) may take all three.
 *
 * `complete` and `blocked` stay with the model: they are its only way to end a goal.
 */
export const HUMAN_ONLY_GOAL_ACTIONS = ['edit', 'pause', 'resume'] as const;
/** Why this action may not be taken in this turn, or `undefined` when it may. */
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
  /** `unknown` on purpose: these are model proposals, validated only by the functions below. */
  objective?: unknown;
  maxGoalRounds?: unknown;
  blockedReason?: unknown;
}
/**
 * Every label a recorded change can carry: the five tool actions plus `create`, `round` and
 * `stand-down`, which only the runtime performs. One event shape keeps the goal's history in one
 * fold.
 */
export type GoalChangeAction = GoalAction | 'create' | 'round' | 'stand-down';
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
 * One accepted action, or a throw naming why not. A terminal goal takes no edits except one that
 * reopens it, `blocked` needs a reason and a worked-on goal, and only a changed objective reopens a
 * completed goal.
 */
export function changeGoal(goal: Goal, action: GoalAction, input: GoalChange, now: string): Goal {
  const next: Goal = { ...goal, updatedAt: now };
  // Any accepted change clears a stand-down.
  delete next.standDown;
  switch (action) {
    case 'edit': {
      if (input.objective !== undefined) next.objective = objective(input.objective);
      if (input.maxGoalRounds !== undefined) next.maxGoalRounds = rounds(input.maxGoalRounds);
      if (input.objective === undefined && input.maxGoalRounds === undefined)
        throw new GoalError('edit needs an objective or a max_goal_rounds to change');
      /**
       * Changing the objective reopens a terminal goal, since the verdict belonged to the old
       * objective.
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
 * The goal with one more round, or unchanged at its limit. Clamped rather than thrown so the model
 * decides whether to raise the ceiling, complete or block.
 */
export function admitGoalRound(goal: Goal, now: string): Goal {
  if (goal.status !== 'active' || goal.roundsStarted >= goal.maxGoalRounds) return goal;
  const next: Goal = { ...goal, roundsStarted: goal.roundsStarted + 1, updatedAt: now };
  // A round is running again, so the runtime has not stood down any more.
  delete next.standDown;
  return next;
}
/** The goal with the runtime's stand-down recorded, or `undefined` when there is nothing to record. */
export function standDownGoal(
  goal: Goal,
  reason: GoalStandDown['reason'],
  continuations: number,
  now: string,
): Goal | undefined {
  if (goal.status !== 'active') return undefined;
  return { ...goal, updatedAt: now, standDown: { reason, continuations, at: now } };
}
/** Whether the goal has spent every round it was given. */
export function goalExhausted(goal: Goal): boolean {
  return goal.roundsStarted >= goal.maxGoalRounds;
}
/**
 * The verdict for a goal whose rounds are spent, or `undefined`. Skips the blocked floor because
 * this is the runtime's statement, not the model's; the reason carries the counts. A spent goal
 * must not stay `active`, or the next request would start another round.
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const goal = value as Record<string, unknown>;
  return (
    typeof goal.objective === 'string' &&
    goal.objective.trim().length > 0 &&
    goal.objective.length <= GOAL_CEILINGS.objectiveChars &&
    (goal.status === 'active' ||
      goal.status === 'paused' ||
      goal.status === 'completed' ||
      goal.status === 'blocked') &&
    Number.isSafeInteger(goal.roundsStarted) &&
    (goal.roundsStarted as number) >= 0 &&
    (goal.roundsStarted as number) <= GOAL_CEILINGS.maxGoalRounds &&
    Number.isSafeInteger(goal.maxGoalRounds) &&
    (goal.maxGoalRounds as number) > 0 &&
    (goal.maxGoalRounds as number) <= GOAL_CEILINGS.maxGoalRounds &&
    typeof goal.createdAt === 'string' &&
    typeof goal.updatedAt === 'string' &&
    (goal.blockedReason === undefined ||
      (typeof goal.blockedReason === 'string' &&
        goal.blockedReason.length <= GOAL_CEILINGS.blockedReasonChars)) &&
    (goal.standDown === undefined || isStandDown(goal.standDown))
  );
}
function isStandDown(value: unknown): value is GoalStandDown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const standDown = value as Record<string, unknown>;
  return (
    (GOAL_STAND_DOWN_REASONS as readonly unknown[]).includes(standDown.reason) &&
    Number.isSafeInteger(standDown.continuations) &&
    (standDown.continuations as number) >= 0 &&
    typeof standDown.at === 'string'
  );
}
/** One line for a tool result, a notice or a log line: the state first, because that decides what to do. */
export function goalLine(goal: Goal): string {
  const rounds = `${goal.roundsStarted}/${goal.maxGoalRounds} round(s)`;
  const reason = goal.blockedReason ? ` — blocked: ${goal.blockedReason}` : '';
  return `[${goal.status}] ${goal.objective} (${rounds})${reason}`;
}
