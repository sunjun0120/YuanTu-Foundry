/**
 * The Chinese wording of questions the kernel asks in English.
 *
 * The kernel writes questions for the model as much as for the person — its strings are English, and the
 * renderer draws them verbatim. That is right for a model's own question, whose text is content. It is wrong for
 * the one question the product itself asks: `exit_plan_mode` produces a fixed header, a fixed intro, two fixed
 * options and an internal digest line, and a Chinese interface showed all of it in English, `Plan digest:
 * f04f4f93e4c9…` included.
 *
 * Only these fixed strings are translated, and only for display: the option *value* the renderer sends back stays
 * the kernel's label, because `plan-tools.ts` matches it exactly. A question the model wrote is never reworded —
 * it is the model's text, not the product's.
 */
import { translate } from './i18n.ts';

const PLAN_HEADER = 'Plan approval';
const PLAN_INTRO = 'Approve this plan and start carrying it out in this run?';
/** The kernel's option labels are the keys of the product's own two translations. */
const PLAN_LABELS: Record<string, string> = {
  'Approve and execute': 'question.plan.approve',
  'Keep planning': 'question.plan.keepPlanning',
};
const PLAN_DESCRIPTIONS: Record<string, string> = {
  'Lift read-only mode now and carry out the plan in this run.': 'question.plan.approveDescription',
  'Do not start work: stay in planning mode.': 'question.plan.keepPlanningDescription',
};
/** The digest exists so the approved plan can be checked against the one that was read; it is not for the reader. */
const PLAN_DIGEST = /^Plan digest: .*$/m;

export interface QuestionCopy {
  header: string;
  question: string;
  /** The plan body is ordinary reading content, separate from the short approval prompt. */
  plan?: string;
  /** The label as it should be read. The value sent back is the caller's original string. */
  label(original: string): string;
  description(original: string): string;
}
const identity = (value: string): string => value;
export function localizedQuestion(
  header: string,
  question: string,
  english: boolean,
): QuestionCopy {
  const isPlan = header.trim() === PLAN_HEADER;
  if (!isPlan) return { header, question, label: identity, description: identity };
  const [intro = '', ...lines] = question.replace(PLAN_DIGEST, '').trim().split('\n');
  const plan = lines.join('\n').trim();
  const language = english ? 'en-US' : 'zh-CN';
  return {
    header: english ? header : translate('question.plan.header', language),
    question: english
      ? intro
      : intro.replace(PLAN_INTRO, translate('question.plan.intro', language)),
    ...(plan ? { plan } : {}),
    label: english
      ? identity
      : (value) => {
          const key = PLAN_LABELS[value];
          return key ? translate(key, language) : value;
        },
    description: english
      ? identity
      : (value) => {
          const key = PLAN_DESCRIPTIONS[value];
          return key ? translate(key, language) : value;
        },
  };
}
