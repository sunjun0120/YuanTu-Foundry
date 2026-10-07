import type {
  Question,
  QuestionOutcome,
  QuestionOption,
  Tool,
  ToolResult,
} from '../protocol/index.ts';

/**
 * Asking the human is deliberately not a declaration of `permission`.
 *
 * Every permission-declaring tool is a workspace mutation, a command or an external call, and a run that
 * may not do those still has to be able to ask: a planning run that needs a decision before it can plan
 * anything is the normal case, not an exception. So this tool survives the read-only filter, and it is in
 * `EXPLORE_TOOLS` for the same reason.
 */
const QUESTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * The stem of every unanswered result.
 *
 * The model reads this and has to know what to do next: waiting again is not one of the options, because
 * the question was already asked and the run cannot get a different answer by repeating it.
 */
const UNANSWERED =
  'Do not wait and do not ask again in this run: continue on the most reasonable assumption, state it explicitly in your reply, or stop and report what you still need from the user.';

function why(outcome: QuestionOutcome): string {
  if (outcome.reason === 'timeout') return 'The user did not answer before the wait timed out.';
  if (outcome.reason === 'cancelled') return 'The question was cancelled with the run.';
  return 'No user is available to answer in this run (scheduled or non-interactive).';
}

/** The model-facing result: its own questions, the answers keyed by question id, or why there are none. */
export function questionResult(request: Question[], outcome: QuestionOutcome): string {
  if (!outcome.answered) return `${why(outcome)}\n\n${UNANSWERED}`;
  const lines = ['The user answered:'];
  for (const question of request) {
    const answer = outcome.answers.find((entry) => entry.id === question.id);
    lines.push(
      `- ${question.id}: ${question.question}${question.header ? ` (${question.header})` : ''}`,
    );
    if (answer?.selected.length) lines.push(`  selected: ${answer.selected.join(', ')}`);
    if (answer?.freeText) lines.push(`  free text: ${answer.freeText}`);
    if (!answer?.selected.length && !answer?.freeText) lines.push('  (answered with no content)');
  }
  return lines.join('\n');
}

/**
 * The questions as the protocol wants them, or a throw the registry turns into an error result.
 *
 * The schema already bounds the shape; what is checked here is what a schema cannot express — a duplicate
 * question id would make an answer ambiguous, and a duplicate option label would make a selection one.
 */
function normalize(value: unknown): Question[] {
  if (!Array.isArray(value) || !value.length || value.length > 4)
    throw new Error('questions must be an array of 1 to 4 questions');
  const ids = new Set<string>();
  return value.map((entry) => {
    const question = entry as Record<string, unknown>;
    const id = String(question.id);
    if (!QUESTION_ID.test(id))
      throw new Error(
        `Invalid question id "${id}": use 1-32 lowercase letters, digits, "_" or "-"`,
      );
    if (ids.has(id)) throw new Error(`Duplicate question id "${id}"`);
    ids.add(id);
    const options = Array.isArray(question.options)
      ? question.options.map((option) => {
          const value = option as Record<string, unknown>;
          return {
            label: String(value.label),
            ...(value.description === undefined ? {} : { description: String(value.description) }),
            ...(value.recommended === true ? { recommended: true } : {}),
          } satisfies QuestionOption;
        })
      : undefined;
    if (options) {
      if (options.length > 6) throw new Error('A question may offer at most 6 options');
      const labels = new Set(options.map((option) => option.label));
      if (labels.size !== options.length)
        throw new Error(`Question "${id}" repeats an option label`);
      /**
       * At most one recommendation, because the interface draws it as *the* one the asker would pick: two badges
       * would be a question with two answers, which is worse than no badge at all.
       */
      if (options.filter((option) => option.recommended).length > 1)
        throw new Error(`Question "${id}" marks more than one option as recommended`);
    }
    return {
      id,
      question: String(question.question),
      ...(question.header === undefined ? {} : { header: String(question.header) }),
      ...(options ? { options } : {}),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect === true }),
      ...(question.allowFreeText === undefined
        ? {}
        : { allowFreeText: question.allowFreeText === true }),
    };
  });
}

/**
 * Waits for the answer, and never lets the wait itself fail the run.
 *
 * `timeoutMs` is the model's own bound on this call; the host additionally bounds the same wait from its
 * settings, which is the bound that applies when the model does not choose one. Both end the same way — an
 * unanswered outcome the model can act on — because a question is a request for information, not an effect,
 * and an unavailable answer must not be reported as a broken tool.
 */
export function questionTool(): Tool {
  return {
    name: 'ask_user_question',
    description:
      'Ask the user one to four structured questions and wait for the answer: options to choose from, optional multi-select, optional free text. Use it when a decision only the user can make blocks the work (which of two existing conventions to follow, a credential destination, a scope choice) instead of guessing or stopping. Put the option you would choose first and mark it `recommended: true` (at most one per question) — the interface shows it as a badge and the user may still pick another. The answer arrives as a tool result; if nobody answers in time the result says so and the run continues, so never wait for an answer that has already been reported missing.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' },
              question: { type: 'string', minLength: 1, maxLength: 2000 },
              header: { type: 'string', minLength: 1, maxLength: 120 },
              options: {
                type: 'array',
                minItems: 1,
                maxItems: 6,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', minLength: 1, maxLength: 200 },
                    description: { type: 'string', maxLength: 500 },
                    recommended: { type: 'boolean' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean' },
              allowFreeText: { type: 'boolean' },
            },
            required: ['id', 'question'],
            additionalProperties: false,
          },
        },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    execute: async (args, context): Promise<ToolResult> => {
      const questions = normalize(args.questions);
      const ask = context.ask;
      // An embedder without a questioner is not an error: the tool reports what it could not learn, and the
      // model proceeds on a stated assumption exactly as it does when a real user lets the wait expire.
      if (!ask)
        return {
          isError: false,
          content: questionResult(questions, {
            answered: false,
            answers: [],
            reason: 'unavailable',
          }),
        };
      const controller = new AbortController();
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
      let expired = false;
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              expired = true;
              controller.abort();
            }, timeoutMs);
      const signal =
        timer === undefined ? context.signal : AbortSignal.any([context.signal, controller.signal]);
      const settle = (outcome: QuestionOutcome): QuestionOutcome => {
        if (outcome.answered) return outcome;
        if (expired) return { answered: false, answers: [], timedOut: true, reason: 'timeout' };
        if (context.signal.aborted) return { answered: false, answers: [], reason: 'cancelled' };
        return outcome;
      };
      try {
        const asker = ask(
          { questions, ...(context.callId ? { callId: context.callId } : {}) },
          signal,
        );
        // The timeout has to bound the wait, not merely label an answer that arrives after it: a questioner
        // that ignores the signal would otherwise hold the run open forever. Racing is what makes `timeoutMs`
        // a promise the tool can keep. A late rejection from `asker` is still observed by the race.
        const outcome = await (timer === undefined
          ? asker
          : Promise.race([
              asker,
              new Promise<QuestionOutcome>((resolve) => {
                controller.signal.addEventListener('abort', () =>
                  resolve({ answered: false, answers: [], timedOut: true, reason: 'timeout' }),
                );
              }),
            ]));
        return { isError: false, content: questionResult(questions, settle(outcome)) };
      } catch {
        // A questioner that throws still answered nothing; the model must be told that, not handed a failure
        // it would retry.
        return {
          isError: false,
          content: questionResult(
            questions,
            settle({ answered: false, answers: [], reason: 'unavailable' }),
          ),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
