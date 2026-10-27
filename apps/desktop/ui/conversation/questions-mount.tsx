/**
 * Mount the React question panel and answer the renderer's `render(questions)` call.
 *
 * The adapter keeps `setupQuestions`'s two-call shape (`render`, and now `dispose`) so `renderer.ts` only changes the
 * import and the teardown. Drafts live in the adapter rather than in React state: the host component is a projection
 * of `questionCards`, so a snapshot or a language change recomputes the labels without touching what was chosen.
 *
 * The container is handed to the single React root through `mountRegion`, the same seam every migrated region uses.
 * Its static `aria-label` is translated here because the i18n walker deliberately stops at `data-react-owned`: once
 * React owns the region, an attribute left in `index.html` would never follow the language again.
 */
import type { ReactNode } from 'react';
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { PendingQuestion } from '../../../../packages/client/session-controller.ts';
import { locale, onLocaleChange, translate } from '../../i18n.ts';
import type { MarkdownActions } from '../../markdown.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { registerView } from '../views.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import { Questions, type QuestionPanelActions } from './Questions.tsx';
import {
  beginQuestionAnswer,
  createQuestionDrafts,
  endQuestionAnswer,
  pendingQuestionRequests,
  questionAnswers,
  questionCards,
  questionDraft,
  retainPendingQuestions,
  setQuestionPage,
  setQuestionText,
  toggleQuestionCollapsed,
  toggleQuestionOption,
  type QuestionDrafts,
} from './question-model.ts';

export interface QuestionPanelState {
  questions: PendingQuestion[];
  drafts: QuestionDrafts;
}

export interface QuestionHandle {
  render(questions: PendingQuestion[]): void;
  dispose(): void;
}

export interface QuestionMountActions {
  markdownActions: MarkdownActions;
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  setError(message: string | null): void;
  /**
   * The renderer's frame-coalesced repaint, still used to clear a banner when an answer starts. React redraws the
   * card itself; this is not a way to make the panel show its own state.
   */
  requestRender?(): void;
}

function QuestionsHost({
  store,
  actions,
  markdownActions,
}: {
  store: ReadableStore<QuestionPanelState>;
  actions: QuestionPanelActions;
  markdownActions: MarkdownActions;
}): ReactNode {
  const state = useReadable(store);
  // A language switch redraws the labels through the pure model; the drafts the model reads are untouched.
  const lang = useLocale();
  return (
    <Questions
      cards={questionCards(state.questions, state.drafts, lang)}
      actions={actions}
      markdownActions={markdownActions}
    />
  );
}

export function mountQuestions(actions: QuestionMountActions): QuestionHandle {
  const drafts = createQuestionDrafts();
  const store = createStore<QuestionPanelState>({ questions: [], drafts });
  // The legacy panel skipped a repaint when nothing crossed the panel's edge; keeping that comparison here keeps a
  // 50 ms progress snapshot from re-rendering every open question card for no reason.
  let key = '';
  let disposed = false;
  const notify = (): void => {
    if (disposed) return;
    const state = store.getSnapshot();
    store.set({ questions: state.questions, drafts });
  };
  const find = (requestId: string): PendingQuestion | undefined =>
    store.getSnapshot().questions.find((item) => item.id === requestId);
  const panelActions: QuestionPanelActions = {
    selectOption(requestId, questionId, value) {
      const question = find(requestId)?.request.questions.find((entry) => entry.id === questionId);
      if (!question) return;
      toggleQuestionOption(drafts, requestId, question, value);
      notify();
    },
    setFreeText(requestId, questionId, value) {
      // No `notify` on purpose: the input owns its own rendering while typing, as it did before the migration.
      setQuestionText(drafts, requestId, questionId, value);
    },
    setPage(requestId, page) {
      const item = find(requestId);
      if (!item) return;
      setQuestionPage(drafts, requestId, page, item.request.questions.length);
      notify();
    },
    toggleCollapsed(requestId) {
      toggleQuestionCollapsed(drafts, requestId);
      notify();
    },
    submit(requestId) {
      const item = find(requestId);
      if (!item || !beginQuestionAnswer(drafts, requestId)) return;
      const answers = questionAnswers(item.request, questionDraft(drafts, requestId));
      actions.setError(null);
      notify();
      actions.requestRender?.();
      void actions.invoke({ type: 'questionAnswer', id: requestId, answers }).finally(() => {
        endQuestionAnswer(drafts, requestId);
        notify();
      });
    },
    cancel(requestId) {
      if (!find(requestId) || !beginQuestionAnswer(drafts, requestId)) return;
      actions.setError(null);
      notify();
      actions.requestRender?.();
      void actions
        .invoke({ type: 'questionAnswer', id: requestId, cancelled: true })
        .finally(() => {
          endQuestionAnswer(drafts, requestId);
          notify();
        });
    },
  };
  const host = document.getElementById('questions');
  let stopLocale: (() => void) | undefined;
  if (host) {
    const label = (): void => {
      host.setAttribute('aria-label', translate('ui.questionLabel', locale()));
    };
    label();
    stopLocale = onLocaleChange(label);
  }
  const disposeRegion = host
    ? registerView(
        'questions',
        <QuestionsHost
          store={store}
          actions={panelActions}
          markdownActions={actions.markdownActions}
        />,
      )
    : () => {};
  return {
    render(questions) {
      if (disposed) return;
      // The pending ids are part of the key so state for a finished request is dropped rather than remembered.
      const nextKey = JSON.stringify(questions);
      if (nextKey === key) return;
      key = nextKey;
      retainPendingQuestions(
        drafts,
        pendingQuestionRequests(questions).map((item) => item.id),
      );
      store.set({ questions, drafts });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopLocale?.();
      disposeRegion();
    },
  };
}
