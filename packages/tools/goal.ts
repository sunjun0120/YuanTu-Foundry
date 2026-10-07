import {
  changeGoal,
  goalAuthorityRefusal,
  goalExhausted,
  goalLine,
  GOAL_ACTIONS,
  GOAL_CEILINGS,
  GOAL_DEFAULTS,
  newGoal,
  type Goal,
  type GoalAction,
} from '../protocol/goals.ts';
import type { Tool, ToolContext } from '../protocol/index.ts';

/**
 * The session's goal, as three tools.
 *
 * A goal is one objective a session pursues across runs (see `packages/protocol/goals.ts` for what it is and
 * what it deliberately is not). These are its only writers, and the decisions worth naming are:
 *
 * 1. **They carry no permission.** Nothing here touches the workspace — the goal is session state, like the
 *    checklist — so there is no effect to approve. They are still registered only for a run that may write
 *    (see `packages/core/agent.ts`): a planning run or a delegated child has its own business, and a child
 *    that could rewrite the session's goal could silently redirect the work it was delegated from.
 * 2. **Every answer is the current state, not the change.** Each of the three returns the goal as it now
 *    stands, plus what it means for the budget. "Completed" is not a receipt for the action; it is the fact
 *    the next round reads.
 * 3. **They refuse rather than repair.** An edit that changes nothing is an error, a `blocked` verdict on the
 *    first round is an error, resuming a goal that is not paused is an error — all decided in
 *    `changeGoal`, so the rules are testable without a tool call and there is exactly one copy of them.
 * 4. **The run's own admission is not theirs.** Creating a goal does not reset the round count and no action
 *    can raise it by one: rounds are admitted by the run loop, which is what keeps "how long has this been
 *    going on" a record rather than something the model can edit.
 */
const OBJECTIVE = `at most ${GOAL_CEILINGS.objectiveChars} characters`;
export function goalTools(now: () => string = () => new Date().toISOString()): Tool[] {
  return [createTool(now), getTool(), updateTool(now)];
}
/** The seam is optional on `ToolContext` — a host may have no goal store — so its absence is a loud answer. */
const NO_SEAM =
  'This run has no goal store, so the session goal cannot be recorded. State the objective in your reply instead.';
function report(goal: Goal, note: string): string {
  const budget = goalExhausted(goal)
    ? ` The goal has spent its ${goal.maxGoalRounds} rounds: the runtime will not count more, so raise max_goal_rounds with update_goal, or finish with complete or blocked.`
    : ` ${goal.maxGoalRounds - goal.roundsStarted} round(s) left.`;
  return `${note}\n\nGoal: ${goalLine(goal)}${budget}`;
}
function createTool(now: () => string): Tool {
  return {
    name: 'create_goal',
    description:
      'Record the objective this session is pursuing, so it survives this run and the next one starts knowing it. Use it when the user asks for something that will not fit in one run, not for the immediate request alone. One goal per session: this replaces a paused, completed or blocked goal, and is refused while one is active. The runtime keeps working toward it on its own: when a run ends with the goal still active, the next round starts automatically until the goal is finished or its round budget is spent.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          minLength: 1,
          maxLength: GOAL_CEILINGS.objectiveChars,
          description: `The outcome that would mean this is done (${OBJECTIVE}).`,
        },
        max_goal_rounds: {
          type: 'integer',
          minimum: 1,
          maximum: GOAL_CEILINGS.maxGoalRounds,
          description: `How many runs it may span, at most ${GOAL_CEILINGS.maxGoalRounds}. Defaults to ${GOAL_DEFAULTS.maxGoalRounds}.`,
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      context.signal.throwIfAborted();
      if (!context.goals) return { isError: true, content: NO_SEAM };
      try {
        const existing = context.goals.read();
        if (existing?.status === 'active')
          return {
            isError: true,
            content: `This session already has an active goal: ${goalLine(existing)}. Update it with update_goal (edit, complete or blocked) instead of replacing it.`,
          };
        const goal = newGoal(
          { objective: args.objective, maxGoalRounds: args.max_goal_rounds },
          now(),
        );
        context.goals.write('create', goal);
        return {
          isError: false,
          content: report(
            goal,
            existing
              ? `Goal created, replacing the previous one (${existing.status}): ${existing.objective}`
              : 'Goal created. It is read at the start of every later run in this session, and the runtime starts those runs itself while it stays active; this run counts as its first round.',
          ),
        };
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
function getTool(): Tool {
  return {
    name: 'get_goal',
    description:
      'Read the goal this session is pursuing: its objective, status and how many rounds it has used. Read it before assuming what you are working toward, and after a long stretch of work to check whether it is still the right one. A session with no goal says so.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_args, context: ToolContext) => {
      context.signal.throwIfAborted();
      if (!context.goals) return { isError: true, content: NO_SEAM };
      try {
        const goal = context.goals.read();
        if (!goal)
          return {
            isError: false,
            content:
              'This session has no goal. Use create_goal if the work should outlive this run.',
          };
        return { isError: false, content: report(goal, 'Current goal.') };
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
function updateTool(now: () => string): Tool {
  return {
    name: 'update_goal',
    description: `Change the session's goal: ${GOAL_ACTIONS.join(', ')}. Use complete only when the objective is actually achieved, blocked — with a concrete reason — only after ${GOAL_DEFAULTS.blockedMinRounds} rounds of real attempts, pause when the user wants it out of the way, resume when they want it back, and edit to sharpen the objective or raise max_goal_rounds. edit, pause and resume are refused in a round the runtime started on its own: continuing a goal is not the user asking for it to change, so use complete or blocked and say what you need. The status is a record the user can see, not a claim in your reply.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...GOAL_ACTIONS],
          description: 'What to do with the goal.',
        },
        objective: {
          type: 'string',
          minLength: 1,
          maxLength: GOAL_CEILINGS.objectiveChars,
          description: 'For edit: the replacement objective.',
        },
        max_goal_rounds: {
          type: 'integer',
          minimum: 1,
          maximum: GOAL_CEILINGS.maxGoalRounds,
          description: 'For edit: the new round budget.',
        },
        blocked_reason: {
          type: 'string',
          minLength: 1,
          maxLength: GOAL_CEILINGS.blockedReasonChars,
          description: `For blocked: the concrete condition that stopped the work, at most ${GOAL_CEILINGS.blockedReasonChars} characters.`,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      context.signal.throwIfAborted();
      if (!context.goals) return { isError: true, content: NO_SEAM };
      try {
        const action = String(args.action ?? '') as GoalAction;
        if (!GOAL_ACTIONS.includes(action))
          return {
            isError: true,
            content: `\`action\` must be one of ${GOAL_ACTIONS.join(', ')}.`,
          };
        const goal = context.goals.read();
        if (!goal)
          return {
            isError: true,
            content: 'This session has no goal, so there is nothing to update. Create one first.',
          };
        /**
         * Who is asking decides whether the goal's standing may change at all.
         *
         * Checked before `changeGoal` so the refusal is about authority rather than about the state machine: a
         * round the runtime started gets a sentence it can act on ("report progress, or ask the user"), not a
         * complaint about the transition it asked for.
         */
        const refusal = goalAuthorityRefusal(action, context.goals.human);
        if (refusal) return { isError: true, content: refusal };
        const next = changeGoal(
          goal,
          action,
          {
            ...(args.objective === undefined ? {} : { objective: args.objective }),
            ...(args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds }),
            ...(args.blocked_reason === undefined ? {} : { blockedReason: args.blocked_reason }),
          },
          now(),
        );
        // Unchanged means an `edit` that edited nothing, which `changeGoal` refuses; anything else here is a
        // real transition, so the record is written and the session is told about it in one event.
        context.goals.write(action, next);
        return { isError: false, content: report(next, `Goal ${action}.`) };
      } catch (error) {
        return { isError: true, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
