import type { Plan, Tool, Questioner } from '../protocol/index.ts';
import { normalizePlanBody, planHash, type PlanApprovalStore } from '../protocol/plans.ts';
/**
 * How much of a plan may be put in front of a person as a question.
 *
 * `exit_plan_mode` asks the user to approve the plan it just produced, which only works if the plan is in the
 * question they read — a question that says "approve the plan shown elsewhere" is asking them to approve
 * something they cannot see. A plan longer than this is therefore refused, and the model is told to use
 * `submit_plan`, which records it where it can be read in full. Roughly four times the largest plan a person
 * will read in a dialog, and comfortably above any plan this agent produces: 40 steps at 100 characters.
 */
const MAX_PLAN_QUESTION_CHARS = 6000;
/** Said when a plan for this run is already approved and the model asks again in the same round. */
const PLAN_ALREADY_APPROVED =
  'This plan is already approved and read-only mode ends at the start of your next round. Carry the plan out instead of asking again.';

export interface PlanningTools {
  readonly tools: readonly Tool[];
  readonly submitted: boolean;
  /** Agent consumes this only at a round boundary; the tools never change run authority. */
  takeApproval(): Plan | undefined;
}
export function createPlanningTools(options: {
  store: PlanApprovalStore;
  sessionId: string;
  planId: string;
  ask?: Questioner;
  onProposed?: (plan: Plan) => void;
  onApproved?: (plan: Plan) => void;
}): PlanningTools {
  const { store, sessionId, planId, ask, onProposed, onApproved } = options;
  const tools: Tool[] = [];
  let planSubmitted = false;
  let planApproved: Plan | undefined;
  const planBody = (args: Record<string, unknown>) => ({
    title: String(args.title ?? ''),
    ...(args.summary === undefined ? {} : { summary: String(args.summary) }),
    steps: Array.isArray(args.steps) ? (args.steps as string[]) : [],
  });
  /**
   * How much of a plan may be put in a question.
   *
   * The point of asking here rather than recording the plan for later is that the person decides *now*, so
   * the plan they decide on has to be in the question they read. A plan too long to fit is therefore not
   * asked about at all: the call names `submit_plan` instead, which records it in the plan panel where it
   * can be read in full. Approving a plan nobody could read would be the one failure this tool exists to
   * prevent, so the budget is a refusal, not a truncation.
   */
  const planQuestionText = (plan: {
    title: string;
    summary: string;
    steps: { description: string }[];
  }): string =>
    [
      'Approve this plan and start carrying it out in this run?',
      '',
      `# ${plan.title}`,
      ...(plan.summary ? ['', plan.summary] : []),
      '',
      ...plan.steps.map((step, index) => `${index + 1}. ${step.description}`),
      '',
      // The digest of exactly these fields, which is what the approval will cover: the user can check it
      // against the plan the panel shows afterwards, and a plan edited in between is visibly a different one.
      `Plan digest: ${planHash(plan).slice(0, 12)}…`,
    ].join('\n');
  tools.push({
    name: 'submit_plan',
    description:
      'Submit the implementation plan for human approval and end this planning run. Give a title, a short summary of the approach, and ordered concrete steps. Nothing is executed until a human approves the plan, so describe the work instead of doing it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200 },
        summary: { type: 'string', maxLength: 4000 },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: { type: 'string', maxLength: 500 },
        },
      },
      required: ['title', 'steps'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      context.signal.throwIfAborted();
      try {
        const plan = store.submitPlan(sessionId, planId, planBody(args));
        planSubmitted = true;
        onProposed?.(plan);
        return {
          isError: false,
          content: `Plan recorded for human approval (${plan.steps.length} steps). This planning run is complete; do not call further tools.\nSession: ${sessionId}\nPlan ID: ${plan.id}\nApproval hash: ${plan.hash}`,
        };
      } catch (error) {
        return {
          isError: true,
          content: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
  // Only when someone can answer: with no questioner the tool would ask into the void, and `submit_plan`
  // is the honest version of "the human decides later". A run with no `planId` never reaches here.
  if (ask)
    tools.push({
      name: 'exit_plan_mode',
      description:
        'Present the plan you have arrived at and ask the user to approve it now, so you can carry it out in this same run instead of ending the planning phase. Give a title, a short summary and ordered concrete steps; the user sees exactly that plan. If they approve, read-only mode is lifted for the rest of this run and the next round begins with the full tool set — every write and command still asks for its own approval. If they choose to keep planning, their feedback comes back and you keep the read-only tools. If they do not answer, nothing is recorded: use submit_plan to record the plan for a decision later. Prefer this over submit_plan when the user is present and the plan is the last thing you need to settle.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200 },
          summary: { type: 'string', maxLength: 4000 },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            items: { type: 'string', maxLength: 500 },
            description: 'The ordered steps of the plan, one sentence each.',
          },
        },
        required: ['title', 'steps'],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        context.signal.throwIfAborted();
        try {
          if (planApproved) return { isError: true, content: PLAN_ALREADY_APPROVED };
          // Normalised here and again by `submitPlan`, which is idempotent, so the text in the question is
          // the text that gets hashed and approved. Nothing is written before the answer: a plan the user
          // declined to approve, or never answered, must not appear in the plan panel as proposed.
          const body = normalizePlanBody(planBody(args));
          const rendered = planQuestionText(body);
          if (rendered.length > MAX_PLAN_QUESTION_CHARS)
            return {
              isError: true,
              content: `This plan is ${rendered.length} characters, too long to put in a question the user can read in one go. Call submit_plan instead: it records the plan in the plan panel, where it can be read in full, and the user decides there.`,
            };
          const outcome = await ask!(
            {
              questions: [
                {
                  id: 'plan',
                  header: 'Plan approval',
                  question: rendered,
                  options: [
                    {
                      label: 'Approve and execute',
                      description: 'Lift read-only mode now and carry out the plan in this run.',
                    },
                    {
                      label: 'Keep planning',
                      description: 'Do not start work: stay in planning mode.',
                    },
                  ],
                  allowFreeText: true,
                },
              ],
            },
            context.signal,
          );
          context.signal.throwIfAborted();
          const answer = outcome.answered ? outcome.answers[0] : undefined;
          const chosen = answer?.selected ?? [];
          const feedback = answer?.freeText?.trim() ?? '';
          if (chosen.includes('Approve and execute')) {
            // Submitted and approved through the same two calls the panel and the CLI use, so the hash the
            // user reviewed is the hash that is approved — one code path, one guarantee.
            const plan = store.submitPlan(sessionId, planId, body);
            const approved = store.approvePlan(sessionId, planId, plan.hash);
            planApproved = approved;
            onApproved?.(approved);
            return {
              isError: false,
              content: `The user approved this plan (${approved.steps.length} steps, sha256 ${approved.hash.slice(0, 12)}…). Read-only mode ends at the start of your next round: the full tool set is back and you should carry the plan out, reporting any deviation. Every write and command still asks for approval on its own.`,
            };
          }
          if (outcome.answered)
            return {
              isError: false,
              content: `The user did not approve this plan, so this run is still in planning mode with read-only tools.${feedback ? ` Their feedback: ${feedback}` : chosen.length ? ` They chose: ${chosen.join(', ')}.` : ''}${
                chosen.includes('Keep planning') || feedback
                  ? ' Revise the plan and present it again with exit_plan_mode when it addresses the feedback.'
                  : ' Ask what they would change before presenting another plan.'
              }`,
            };
          return {
            isError: true,
            content: `The user could not be asked (${outcome.reason ?? 'no answer'}), so no plan was recorded and this run is still in planning mode. Call submit_plan to record the plan for a decision later.`,
          };
        } catch (error) {
          return {
            isError: true,
            content: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  return {
    tools,
    get submitted() {
      return planSubmitted;
    },
    takeApproval() {
      const approved = planApproved;
      planApproved = undefined;
      return approved;
    },
  };
}
