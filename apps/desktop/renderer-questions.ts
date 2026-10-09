/**
 * The question panel: one card per pending request, one question at a time inside it.
 *
 * An approval's answer is a boolean; a question's is a shape — options, possibly several of them, plus optional
 * free text. What the user has chosen therefore lives outside the render (`questionAnswers`, `questionPages`,
 * `questionCollapsed`) rather than in this closure: progress events arrive constantly during a run, and with a
 * pager a re-render is a normal event, not an edge case — losing a selection because the run reported progress
 * would be the panel lying about what it will submit.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { PendingQuestion } from '../../packages/client/session-controller.ts';
import { format, locale, t } from './i18n.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

export function setupQuestions(actions: {
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  setError(message: string | null): void;
  requestRender(): void;
}): { render(questions: PendingQuestion[]): void } {
  const questionAnswers = new Map<
    string,
    { selected: Map<string, string[]>; text: Map<string, string> }
  >();
  const questionPages = new Map<string, number>();
  const questionCollapsed = new Set<string>();
  const questionBusy = new Set<string>();
  let questionKey = '';
  function questionState(id: string): {
    selected: Map<string, string[]>;
    text: Map<string, string>;
  } {
    const existing = questionAnswers.get(id);
    if (existing) return existing;
    const created = { selected: new Map<string, string[]>(), text: new Map<string, string>() };
    questionAnswers.set(id, created);
    return created;
  }
  function render(questions: PendingQuestion[]): void {
    /**
     * Progress state belongs to a request that is still pending: a request that has been answered keeps its page
     * and selections in these maps otherwise, and the next question would open on the previous one's page.
     */
    const pending = new Set(questions.map((item) => item.id));
    for (const id of [...questionAnswers.keys()]) if (!pending.has(id)) questionAnswers.delete(id);
    for (const id of [...questionPages.keys()]) if (!pending.has(id)) questionPages.delete(id);
    for (const id of [...questionCollapsed]) if (!pending.has(id)) questionCollapsed.delete(id);
    // The pending ids are part of the key so state for a finished request is dropped rather than remembered.
    const nextKey = JSON.stringify([
      questions,
      [...questionBusy],
      locale(),
      [...questionPages],
      [...questionCollapsed],
      [...questionAnswers].map(([id, draft]) => [id, [...draft.selected], [...draft.text]]),
    ]);
    if (nextKey === questionKey) return;
    questionKey = nextKey;
    required('questions').replaceChildren(
      ...questions.map((item) => {
        const draft = questionState(item.id);
        const total = item.request.questions.length;
        const page = Math.min(questionPages.get(item.id) ?? 0, total - 1);
        const question = item.request.questions[page]!;
        const collapsed = questionCollapsed.has(item.id);
        const card = node('section', '', 'question-card');
        const head = node('div', '', 'question-head');
        const headings = node('div', '', 'question-headings');
        headings.append(
          node('span', question.header || t('ui.questionLabel'), 'question-eyebrow'),
          node('h2', question.question, 'question-title'),
        );
        const chrome = node('div', '', 'question-chrome');
        const collapse = node('button', collapsed ? '⌄' : '⌃', 'question-collapse');
        collapse.type = 'button';
        collapse.setAttribute('aria-expanded', String(!collapsed));
        collapse.setAttribute('aria-label', t('ui.questionCollapse'));
        collapse.addEventListener('click', () => {
          if (collapsed) questionCollapsed.delete(item.id);
          else questionCollapsed.add(item.id);
          actions.requestRender();
        });
        const close = node('button', '✕', 'question-close');
        close.type = 'button';
        close.setAttribute('aria-label', t('ui.questionClose'));
        close.addEventListener('click', () => cancelQuestion(item.id));
        chrome.append(collapse, close);
        head.append(headings, chrome);
        card.append(head);
        const body = node('div', '', 'question-body');
        body.hidden = collapsed;
        if (item.request.subagent)
          headings.append(
            node(
              'p',
              format(t('subagent.attribution'), {
                objective: item.request.subagent.objective.slice(0, 120),
              }),
              'subagent-badge',
            ),
          );
        const options = question.options ?? [];
        /**
         * The choices as numbered rows with their own descriptions, rather than one button whose text is
         * "label — description": the number is what the answer is *about* when there are three of them, and the
         * description belongs under the label it explains. `recommended` is drawn as a badge and nothing else — it
         * is the asker's opinion, not a default that answers the question for the user.
         */
        if (options.length) {
          const list = node('ol', '', 'question-options');
          options.forEach((option, index) => {
            const selected = (draft.selected.get(question.id) ?? []).includes(option.label);
            const button = node('button', '', 'question-option');
            button.type = 'button';
            button.setAttribute('aria-pressed', String(selected));
            if (selected) button.classList.add('selected');
            const text = node('span', '', 'question-option-text');
            const label = node('span', '', 'question-option-head');
            label.append(node('span', option.label, 'question-option-label'));
            if (option.recommended)
              label.append(node('span', t('ui.questionRecommended'), 'question-recommended'));
            text.append(label);
            if (option.description)
              text.append(node('span', option.description, 'question-option-description'));
            button.append(node('span', String(index + 1), 'question-index'), text);
            button.addEventListener('click', () => {
              const current = draft.selected.get(question.id) ?? [];
              const chosen = current.includes(option.label);
              draft.selected.set(
                question.id,
                question.multiSelect
                  ? chosen
                    ? current.filter((entry) => entry !== option.label)
                    : [...current, option.label]
                  : chosen
                    ? []
                    : [option.label],
              );
              actions.requestRender();
            });
            const row = node('li', '', 'question-option-row');
            row.append(button);
            list.append(row);
          });
          body.append(list);
        }
        if (!options.length || question.allowFreeText !== false) {
          const free = node('label', '', 'question-free');
          free.append(node('span', '✎', 'question-free-icon'));
          const input = node('input', '', 'question-input');
          input.type = 'text';
          input.placeholder = t('ui.questionFreeText');
          input.value = draft.text.get(question.id) ?? '';
          /**
           * Typing does not re-render: the value is kept where the submit reads it, so the input keeps focus and
           * the caret stays where the user left it.
           */
          input.addEventListener('input', () => draft.text.set(question.id, input.value));
          free.append(input);
          body.append(free);
        }
        card.append(body);
        const actionsElement = node('div', '', 'question-actions');
        const pager = node('div', '', 'question-pager');
        const previous = node('button', '‹', 'question-prev');
        previous.type = 'button';
        previous.setAttribute('aria-label', t('ui.questionPrevious'));
        previous.disabled = page === 0;
        previous.addEventListener('click', () => {
          questionPages.set(item.id, page - 1);
          actions.requestRender();
        });
        const next = node('button', '›', 'question-next');
        next.type = 'button';
        next.setAttribute('aria-label', t('ui.questionNext'));
        next.disabled = page >= total - 1;
        next.addEventListener('click', () => {
          questionPages.set(item.id, page + 1);
          actions.requestRender();
        });
        pager.append(previous, node('span', `${page + 1}/${total}`, 'question-count'), next);
        const skip = node('button', t('ui.questionSkip'), 'secondary question-skip');
        skip.type = 'button';
        skip.disabled = questionBusy.has(item.id);
        skip.addEventListener('click', () => cancelQuestion(item.id));
        const submit = node('button', t('ui.questionSubmit'), 'primary question-submit');
        submit.type = 'button';
        submit.disabled = questionBusy.has(item.id);
        submit.addEventListener('click', () => {
          const answers = item.request.questions.map((entry) => {
            const typed = draft.text.get(entry.id)?.trim();
            return {
              id: entry.id,
              selected: draft.selected.get(entry.id) ?? [],
              ...(typed ? { freeText: typed } : {}),
            };
          });
          questionBusy.add(item.id);
          actions.setError(null);
          actions.requestRender();
          void actions.invoke({ type: 'questionAnswer', id: item.id, answers }).finally(() => {
            questionBusy.delete(item.id);
            actions.requestRender();
          });
        });
        actionsElement.append(pager, skip, submit);
        card.append(actionsElement);
        return card;
      }),
    );
  }
  /**
   * Ending a question without an answer: the model is told nobody answered and proceeds on its own assumption.
   *
   * Both the × in the corner and 跳过本题 do this, because they are the same act — the request is what the run is
   * waiting on, so there is no such thing as answering "some of it" by leaving.
   */
  function cancelQuestion(id: string): void {
    questionBusy.add(id);
    actions.setError(null);
    actions.requestRender();
    void actions.invoke({ type: 'questionAnswer', id, cancelled: true }).finally(() => {
      questionBusy.delete(id);
      actions.requestRender();
    });
  }
  return { render };
}
