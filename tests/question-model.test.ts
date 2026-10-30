import test from 'node:test';
import assert from 'node:assert/strict';
import type { PendingQuestion } from '../packages/client/session-controller.ts';
import type { Question, QuestionRequest } from '../packages/protocol/index.ts';
import {
  beginQuestionAnswer,
  createQuestionDrafts,
  endQuestionAnswer,
  pendingQuestionRequests,
  questionAnswers,
  questionCards,
  questionDraft,
  questionPage,
  retainPendingQuestions,
  setQuestionPage,
  setQuestionText,
  toggleQuestionCollapsed,
  toggleQuestionOption,
} from '../apps/desktop/ui/conversation/question-model.ts';
import { translate } from '../apps/desktop/i18n.ts';

/**
 * The question panel's state, away from the DOM.
 *
 * The point of these tests is the promise the panel makes: what the person chose is still there after a snapshot,
 * a statistics delta or a language switch rebuilt the card, and what is sent back is the kernel's own option
 * value — not the translated label that happened to be on screen.
 */
function pending(
  id: string,
  questions: Question[],
  extra: Partial<QuestionRequest> = {},
): PendingQuestion {
  return { id, request: { questions, ...extra } };
}

const colour = (): Question => ({
  id: 'color',
  question: 'Which colour?',
  options: [{ label: 'red' }, { label: 'blue' }],
});
const targets = (): Question => ({
  id: 'targets',
  question: 'Which targets?',
  multiSelect: true,
  options: [{ label: 'lint' }, { label: 'test' }],
});
const note = (): Question => ({ id: 'note', question: 'Anything else?' });

test('a draft is kept per request and question, and the answer carries the original labels', () => {
  const requests = [pending('r1', [colour(), targets(), note()])];
  const drafts = createQuestionDrafts();
  // The first page is the only one on screen; the other questions keep their own draft behind the pager.
  toggleQuestionOption(drafts, 'r1', colour(), 'red');
  toggleQuestionOption(drafts, 'r1', colour(), 'blue');
  toggleQuestionOption(drafts, 'r1', targets(), 'lint');
  toggleQuestionOption(drafts, 'r1', targets(), 'test');
  toggleQuestionOption(drafts, 'r1', targets(), 'lint');
  setQuestionText(drafts, 'r1', 'note', '  because the answer matters  ');
  setQuestionPage(drafts, 'r1', 1, 3);
  assert.deepEqual(
    questionCards(requests, drafts, 'en-US')[0]!.options.map((option) => option.selected),
    [false, true],
    'the second page draws the targets question, not the colour one',
  );
  setQuestionPage(drafts, 'r1', 0, 3);
  assert.deepEqual(
    questionCards(requests, drafts, 'en-US')[0]!.options.map((option) => option.selected),
    [false, true],
    'single-select replaces the previous choice',
  );
  assert.deepEqual(questionAnswers(requests[0]!.request, questionDraft(drafts, 'r1')), [
    { id: 'color', selected: ['blue'] },
    { id: 'targets', selected: ['test'] },
    { id: 'note', selected: [], freeText: 'because the answer matters' },
  ]);
});

test('snapshot and language refreshes keep selection, page, free text and collapse state', () => {
  const drafts = createQuestionDrafts();
  const first = pending('r1', [colour(), targets()]);
  setQuestionPage(drafts, 'r1', 1, 2);
  toggleQuestionOption(drafts, 'r1', targets(), 'test');
  setQuestionText(drafts, 'r1', 'targets', 'keep me');
  toggleQuestionCollapsed(drafts, 'r1');
  // A new snapshot is a fresh object graph, exactly what the carrier pushes; the drafts are ours and survive it.
  const refreshed = structuredClone([first]);
  const chinese = questionCards(refreshed, drafts, 'zh-CN')[0]!;
  assert.equal(chinese.page, 1);
  assert.equal(chinese.activeQuestionId, 'targets');
  assert.equal(chinese.freeText, 'keep me');
  assert.equal(chinese.collapsed, true);
  assert.equal(chinese.options.find((option) => option.value === 'test')?.selected, true);
  toggleQuestionCollapsed(drafts, 'r1');
  const english = questionCards(structuredClone([first]), drafts, 'en-US')[0]!;
  assert.equal(english.page, 1);
  assert.equal(english.freeText, 'keep me');
  assert.equal(english.options.find((option) => option.value === 'test')?.selected, true);
  assert.equal(english.collapsed, false);
});

test('a request that stops being pending releases its draft and cannot leak into the next one', () => {
  const drafts = createQuestionDrafts();
  toggleQuestionOption(drafts, 'finished', colour(), 'red');
  setQuestionText(drafts, 'finished', 'color', 'typed');
  setQuestionPage(drafts, 'finished', 0, 1);
  toggleQuestionCollapsed(drafts, 'finished');
  beginQuestionAnswer(drafts, 'finished');
  assert.equal(retainPendingQuestions(drafts, ['next']), true);
  assert.equal(drafts.requests.has('finished'), false);
  assert.equal(drafts.pages.has('finished'), false);
  assert.equal(drafts.collapsed.has('finished'), false);
  assert.equal(drafts.busy.has('finished'), false);
  const next = questionCards([pending('next', [colour()])], drafts, 'zh-CN')[0]!;
  assert.equal(next.page, 0);
  assert.equal(next.freeText, '');
  assert.deepEqual(
    next.options.map((option) => option.selected),
    [false, false],
  );
  // The request that is still pending keeps everything.
  assert.equal(retainPendingQuestions(drafts, ['next']), false);
});

test('the pending-answer guard admits one answer and the busy state reaches the card', () => {
  const drafts = createQuestionDrafts();
  const requests = [pending('r1', [colour()])];
  assert.equal(beginQuestionAnswer(drafts, 'r1'), true);
  assert.equal(beginQuestionAnswer(drafts, 'r1'), false, 'a second click or key repeat is refused');
  assert.equal(questionCards(requests, drafts, 'en-US')[0]!.busy, true);
  endQuestionAnswer(drafts, 'r1');
  assert.equal(questionCards(requests, drafts, 'en-US')[0]!.busy, false);
  assert.equal(beginQuestionAnswer(drafts, 'r1'), true, 'a settled answer may be asked again');
});

test('the pager clamps to the questions the request actually has', () => {
  const drafts = createQuestionDrafts();
  setQuestionPage(drafts, 'r1', 99, 2);
  assert.equal(questionPage(drafts, 'r1', 2), 1);
  setQuestionPage(drafts, 'r1', -3, 2);
  assert.equal(questionPage(drafts, 'r1', 2), 0);
  const cards = questionCards([pending('r1', [colour(), targets()])], drafts, 'en-US');
  assert.equal(cards[0]!.canPrevious, false);
  assert.equal(cards[0]!.canNext, true);
  setQuestionPage(drafts, 'r1', 1, 2);
  const second = questionCards([pending('r1', [colour(), targets()])], drafts, 'en-US')[0]!;
  assert.equal(second.canPrevious, true);
  assert.equal(second.canNext, false);
});

test('a request with no questions is not drawn and a repeated request id is one card', () => {
  const item = pending('same', [colour()]);
  const duplicate = pending('same', [targets()]);
  const requests = pendingQuestionRequests([item, duplicate, pending('empty', [])]);
  assert.deepEqual(
    requests.map((entry) => entry.id),
    ['same'],
  );
  assert.equal(requests[0]!.request.questions[0]!.id, 'color', 'the first occurrence wins');
  assert.equal(
    questionCards([item, duplicate, pending('empty', [])], createQuestionDrafts(), 'en-US').length,
    1,
  );
});

test('free text is offered when there are no options, or when the question allows it', () => {
  const drafts = createQuestionDrafts();
  const free = (questions: Question[]): boolean =>
    questionCards([pending('r', questions)], drafts, 'en-US')[0]!.allowFreeText;
  assert.equal(free([note()]), true);
  assert.equal(free([colour()]), true);
  assert.equal(free([{ ...colour(), allowFreeText: false }]), false);
});

test('the plan approval card separates the prompt from the plan and keeps the kernel values', () => {
  const question = [
    'Approve this plan and start carrying it out in this run?',
    '',
    '# README 补充',
    '',
    '1. 读取 README',
    '',
    'Plan digest: f04f4f93e4c9…',
  ].join('\n');
  const plan = pending('approval', [
    {
      id: 'approve',
      header: 'Plan approval',
      question,
      options: [
        {
          label: 'Approve and execute',
          description: 'Lift read-only mode now and carry out the plan in this run.',
        },
        { label: 'Keep planning' },
      ],
    },
  ]);
  const drafts = createQuestionDrafts();
  const chinese = questionCards([plan], drafts, 'zh-CN')[0]!;
  assert.equal(chinese.header, translate('question.plan.header', 'zh-CN'));
  assert.equal(chinese.question, translate('question.plan.intro', 'zh-CN'));
  assert.equal(chinese.plan, '# README 补充\n\n1. 读取 README');
  assert.doesNotMatch(chinese.plan!, /Plan digest/);
  assert.equal(chinese.isPlan, true);
  assert.deepEqual(
    chinese.options.map((option) => [option.value, option.label]),
    [
      ['Approve and execute', translate('question.plan.approve', 'zh-CN')],
      ['Keep planning', translate('question.plan.keepPlanning', 'zh-CN')],
    ],
  );
  assert.equal(
    chinese.options[0]!.description,
    translate('question.plan.approveDescription', 'zh-CN'),
  );
  // The translation changes the label only: selecting the translated row answers with the kernel's value.
  toggleQuestionOption(drafts, 'approval', plan.request.questions[0]!, chinese.options[0]!.value);
  assert.deepEqual(questionAnswers(plan.request, questionDraft(drafts, 'approval')), [
    { id: 'approve', selected: ['Approve and execute'] },
  ]);
  const english = questionCards([plan], drafts, 'en-US')[0]!;
  assert.equal(english.header, translate('question.plan.header', 'en-US'));
  assert.equal(english.question, translate('question.plan.intro', 'en-US'));
  assert.equal(english.options[0]!.label, translate('question.plan.approve', 'en-US'));
  assert.equal(english.plan, '# README 补充\n\n1. 读取 README');
});

test('a question the model wrote is never reworded, and a sub-agent is attributed', () => {
  const drafts = createQuestionDrafts();
  const asked = pending('model', [{ id: 'db', header: '模型提问', question: 'Which database?' }], {
    subagent: { id: 'child', role: 'explore', objective: 'read the loader' },
  });
  const card = questionCards([asked], drafts, 'zh-CN')[0]!;
  assert.equal(card.header, '模型提问');
  assert.equal(card.question, 'Which database?');
  assert.match(card.subagent ?? '', /^子代理：/);
});
