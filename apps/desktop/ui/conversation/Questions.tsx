/**
 * The question panel, as a projection of `question-model.ts`.
 *
 * The ids, classes and nesting are the legacy panel's: the smoke suites read `#questions .question-option.selected`
 * and the stylesheet writes `#questions .question-input`, so a visual rewrite is not part of moving the ownership.
 *
 * Two behaviours are deliberately encoded here rather than left to chance:
 *
 * - **The plan card.** The short prompt is the title; the plan itself is a Markdown island under it with its own
 *   `question-plan` class, because a plan is reading material and the question "approve this?" is one line. The
 *   digest never reaches this component: `localizedQuestion` strips it before the body gets here.
 * - **The reading position.** A selection or a submit redraws the same question, so the card keeps its scroll
 *   position; switching to another question is a new decision and starts that card at the top.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { renderMarkdown, type MarkdownActions } from '../../markdown.ts';
import type { QuestionCardView } from './question-model.ts';

export interface QuestionPanelActions {
  selectOption(requestId: string, questionId: string, value: string): void;
  setFreeText(requestId: string, questionId: string, value: string): void;
  setPage(requestId: string, page: number): void;
  toggleCollapsed(requestId: string): void;
  submit(requestId: string): void;
  cancel(requestId: string): void;
}

export function Questions({
  cards,
  actions,
  markdownActions,
}: {
  cards: QuestionCardView[];
  actions: QuestionPanelActions;
  markdownActions: MarkdownActions;
}): ReactNode {
  return (
    <>
      {cards.map((card) => (
        <QuestionCard
          key={card.requestId}
          card={card}
          actions={actions}
          markdownActions={markdownActions}
        />
      ))}
    </>
  );
}

/**
 * The plan as one Markdown document.
 *
 * Not `MarkdownView`: that one parses block by block because a streamed answer only changes at its tail. A plan is
 * read whole, and a numbered list with blank lines between its items is still one list — splitting it at those blank
 * lines would restart the numbering at every step. The rendered nodes stay a DOM island inside the React-owned card.
 */
function PlanBody({ text, actions }: { text: string; actions: MarkdownActions }): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    const body = renderMarkdown(text, actions);
    // The over-long fallback is a class `renderMarkdown` puts on its own root; the panel classes are ours.
    container.classList.toggle('plain-fallback', body.classList.contains('plain-fallback'));
    container.replaceChildren(...body.childNodes);
    return () => container.replaceChildren();
  }, [text, actions]);
  return <div ref={host} className="message-content markdown question-plan" />;
}

function QuestionCard({
  card,
  actions,
  markdownActions,
}: {
  card: QuestionCardView;
  actions: QuestionPanelActions;
  markdownActions: MarkdownActions;
}): ReactNode {
  const element = useRef<HTMLElement>(null);
  const shownQuestion = useRef(card.activeQuestionId);
  useLayoutEffect(() => {
    if (shownQuestion.current === card.activeQuestionId) return;
    shownQuestion.current = card.activeQuestionId;
    // A different question is a different decision: its card starts at its top. Choosing an option or submitting
    // leaves the same question on screen and must not move the reader, so no other render touches this.
    if (element.current) element.current.scrollTop = 0;
  }, [card.activeQuestionId]);
  return (
    <section
      ref={element}
      className={card.isPlan ? 'question-card question-plan-card' : 'question-card'}
      data-question-id={card.requestId}
      data-active-question={card.activeQuestionId}
    >
      <div className="question-head">
        <div className="question-headings">
          <span className="question-eyebrow">{card.header}</span>
          <h2 className="question-title">{card.question}</h2>
          {card.subagent === null ? null : <p className="subagent-badge">{card.subagent}</p>}
        </div>
        <div className="question-chrome">
          <button
            type="button"
            className="question-collapse"
            aria-expanded={!card.collapsed}
            aria-label={t('ui.questionCollapse')}
            onClick={() => actions.toggleCollapsed(card.requestId)}
          >
            {card.collapsed ? '⌄' : '⌃'}
          </button>
          <button
            type="button"
            className="question-close"
            aria-label={t('ui.questionClose')}
            onClick={() => actions.cancel(card.requestId)}
          >
            ✕
          </button>
        </div>
      </div>
      <div className="question-body" hidden={card.collapsed}>
        {card.plan === null ? null : <PlanBody text={card.plan} actions={markdownActions} />}
        {card.options.length === 0 ? null : (
          <ol className="question-options">
            {card.options.map((option) => (
              <li key={option.value} className="question-option-row">
                <button
                  type="button"
                  className={option.selected ? 'question-option selected' : 'question-option'}
                  aria-pressed={option.selected}
                  onClick={() =>
                    actions.selectOption(card.requestId, card.activeQuestionId, option.value)
                  }
                >
                  <span className="question-index">{option.index + 1}</span>
                  <span className="question-option-text">
                    <span className="question-option-head">
                      <span className="question-option-label">{option.label}</span>
                      {option.recommended ? (
                        <span className="question-recommended">{t('ui.questionRecommended')}</span>
                      ) : null}
                    </span>
                    {option.description === undefined ? null : (
                      <span className="question-option-description">{option.description}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {card.allowFreeText ? (
          <label className="question-free">
            <span className="question-free-icon">✎</span>
            {/*
             * Uncontrolled on purpose: typing must not redraw the card, so the input keeps focus and the caret stays
             * where the person left it. The draft is written on every keystroke and is what Submit reads; the key
             * changes only when the pager moves to another question, which is the one time the value must change.
             */}
            <input
              key={card.activeQuestionId}
              type="text"
              className="question-input"
              placeholder={t('ui.questionFreeText')}
              defaultValue={card.freeText}
              onInput={(event) =>
                actions.setFreeText(
                  card.requestId,
                  card.activeQuestionId,
                  event.currentTarget.value,
                )
              }
            />
          </label>
        ) : null}
      </div>
      <div className="question-actions">
        <div className="question-pager">
          <button
            type="button"
            className="question-prev"
            aria-label={t('ui.questionPrevious')}
            disabled={!card.canPrevious}
            onClick={() => actions.setPage(card.requestId, card.page - 1)}
          >
            ‹
          </button>
          <span className="question-count">
            {card.page + 1}/{card.total}
          </span>
          <button
            type="button"
            className="question-next"
            aria-label={t('ui.questionNext')}
            disabled={!card.canNext}
            onClick={() => actions.setPage(card.requestId, card.page + 1)}
          >
            ›
          </button>
        </div>
        <button
          type="button"
          className="secondary question-skip"
          disabled={card.busy}
          onClick={() => actions.cancel(card.requestId)}
        >
          {t('ui.questionSkip')}
        </button>
        <button
          type="button"
          className="primary question-submit"
          disabled={card.busy}
          onClick={() => actions.submit(card.requestId)}
        >
          {t('ui.questionSubmit')}
        </button>
      </div>
    </section>
  );
}
