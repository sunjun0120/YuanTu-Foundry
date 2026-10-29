/**
 * The question panel, as a projection of `question-model.ts`.
 *
 * Stable ids and classes keep the renderer and smoke suites connected while the presentation follows the
 * reference clarification card. Selection, drafts, paging and submission still belong to the question model.
 *
 * The short prompt is the title; the plan itself is a Markdown island under it with its own `question-plan`
 * class. The digest never reaches this component: `localizedQuestion` strips it before the body gets here.
 * The conversation owns scrolling; cards grow to fit their contents without a nested scroll region.
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
  return (
    <section
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
            aria-label={t(card.collapsed ? 'ui.questionExpand' : 'ui.questionCollapse')}
            onClick={() => actions.toggleCollapsed(card.requestId)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m6 9 6 6 6-6" />
            </svg>
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
                  <svg className="question-option-arrow" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                </button>
              </li>
            ))}
          </ol>
        )}
        {card.allowFreeText ? (
          <label className="question-free">
            {/*
             * Uncontrolled on purpose: typing must not redraw the card, so the input keeps focus and the caret stays
             * where the person left it. The draft is written on every keystroke and is what Submit reads; the key
             * changes only when the pager moves to another question, which is the one time the value must change.
             */}
            <textarea
              key={card.activeQuestionId}
              rows={1}
              className="question-input"
              aria-label={t('ui.questionFreeText')}
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
