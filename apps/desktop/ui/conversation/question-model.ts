/**
 * The question panel as data: one card per pending request, one question inside it at a time.
 *
 * What a person has chosen lives here rather than in the render for the reason the legacy panel gave: progress
 * events arrive constantly during a run, and with a pager a redraw is a normal event, not an edge case. A snapshot, a
 * statistics delta or a language switch that rebuilt the card must not drop a selection, a page or a typed answer —
 * losing one would make the panel lie about what it is about to submit.
 *
 * The drafts are keyed by request id and, inside it, by question id. A request that is no longer pending releases its
 * whole draft, so the next question in the same window opens clean rather than on the previous one's page.
 *
 * An approval's answer is a boolean and a question's is a shape; this module is only the shape. `localizedQuestion`
 * still owns the product's own plan-approval wording, and it keeps the option *value* the kernel sent: translations
 * change what is read, never what is answered.
 *
 * Two guards mirror the ones the approval panel keeps in `renderer.ts`: a pending request list is de-duplicated by
 * request id (one request is one card), and an answer already in flight refuses a second one. The approval list's own
 * dedupe and busy set are left where they are; moving jobs that did not change with this panel is not this task.
 */
import type { PendingQuestion } from '../../../../packages/client/session-controller.ts';
import type {
  Question,
  QuestionAnswer,
  QuestionRequest,
} from '../../../../packages/protocol/index.ts';
import { format, translate } from '../../i18n.ts';
import { localizedQuestion } from '../../renderer-question-copy.ts';
import type { UiLanguage } from '../../ui-settings.ts';

/** What a person has chosen for one request, keyed by the question's own id. */
export interface QuestionDraft {
  /** Original option labels, in the order they were chosen. */
  readonly selected: Map<string, string[]>;
  /** The free-text row's text, trimmed only when an answer is built. */
  readonly text: Map<string, string>;
}

/**
 * Drafts for every pending request, plus the presentation state that belongs to a request rather than to a question.
 *
 * `pages` and `collapsed` are per request because the card is per request. `busy` is the pending-answer guard: an
 * answer that has been sent but not settled must not be sent twice, by a second click or by a keyboard repeat.
 */
export interface QuestionDrafts {
  readonly requests: Map<string, QuestionDraft>;
  readonly pages: Map<string, number>;
  readonly collapsed: Set<string>;
  readonly busy: Set<string>;
}

export function createQuestionDrafts(): QuestionDrafts {
  return {
    requests: new Map(),
    pages: new Map(),
    collapsed: new Set(),
    busy: new Set(),
  };
}

/** The draft for one request, created on first use so every caller shares the same maps. */
export function questionDraft(drafts: QuestionDrafts, requestId: string): QuestionDraft {
  const existing = drafts.requests.get(requestId);
  if (existing) return existing;
  const created: QuestionDraft = { selected: new Map(), text: new Map() };
  drafts.requests.set(requestId, created);
  return created;
}

/**
 * Drop every request's state once that request stops being pending; returns whether anything was released.
 *
 * A request that has been answered keeps its page and selections otherwise, and the next question would open on the
 * previous one's page. The busy set is released with the draft for the same reason: a promise that settles after the
 * request disappeared has nothing left to guard.
 */
export function retainPendingQuestions(drafts: QuestionDrafts, pending: Iterable<string>): boolean {
  const ids = new Set(pending);
  let released = false;
  for (const id of [...drafts.requests.keys()]) {
    if (ids.has(id)) continue;
    drafts.requests.delete(id);
    released = true;
  }
  for (const id of [...drafts.pages.keys()]) {
    if (ids.has(id)) continue;
    drafts.pages.delete(id);
    released = true;
  }
  for (const id of [...drafts.collapsed]) {
    if (ids.has(id)) continue;
    drafts.collapsed.delete(id);
    released = true;
  }
  for (const id of [...drafts.busy]) {
    if (ids.has(id)) continue;
    drafts.busy.delete(id);
    released = true;
  }
  return released;
}

/**
 * The requests that can actually be drawn, in the order the Host reported them.
 *
 * A request with no questions has nothing to ask and used to make the panel index past the end of an empty list. A
 * duplicated request id is the same pending request arriving twice; drawing it twice would present one answer as two
 * decisions, so the first occurrence wins.
 */
export function pendingQuestionRequests(questions: readonly PendingQuestion[]): PendingQuestion[] {
  const seen = new Set<string>();
  const drawable: PendingQuestion[] = [];
  for (const item of questions) {
    if (!item.request.questions.length) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    drawable.push(item);
  }
  return drawable;
}

/**
 * The page a request is on, clamped to its questions.
 *
 * Clamping happens on read as well as on write because a request can shrink between snapshots (the Host replaces a
 * pending request), and a stale page must never index outside the list.
 */
export function questionPage(drafts: QuestionDrafts, requestId: string, total: number): number {
  if (total <= 0) return 0;
  const page = drafts.pages.get(requestId) ?? 0;
  return Math.min(Math.max(0, page), total - 1);
}

export function setQuestionPage(
  drafts: QuestionDrafts,
  requestId: string,
  page: number,
  total: number,
): void {
  drafts.pages.set(requestId, Math.min(Math.max(0, page), Math.max(0, total - 1)));
}

/** A single-select answer replaces the previous choice; multi-select adds or removes one label. */
export function toggleQuestionOption(
  drafts: QuestionDrafts,
  requestId: string,
  question: Question,
  label: string,
): void {
  const draft = questionDraft(drafts, requestId);
  const current = draft.selected.get(question.id) ?? [];
  const chosen = current.includes(label);
  draft.selected.set(
    question.id,
    question.multiSelect
      ? chosen
        ? current.filter((entry) => entry !== label)
        : [...current, label]
      : chosen
        ? []
        : [label],
  );
}

export function setQuestionText(
  drafts: QuestionDrafts,
  requestId: string,
  questionId: string,
  value: string,
): void {
  questionDraft(drafts, requestId).text.set(questionId, value);
}

/** Collapsing hides the answer rows without throwing away the answer being built behind them. */
export function toggleQuestionCollapsed(drafts: QuestionDrafts, requestId: string): void {
  if (drafts.collapsed.has(requestId)) drafts.collapsed.delete(requestId);
  else drafts.collapsed.add(requestId);
}

/**
 * Claim the one answer slot of a request; false means an answer is already in flight.
 *
 * This is the pending-answer guard, not a UI detail: the same request must never be answered twice, whichever control
 * the second attempt came from (Submit, Skip or the close button).
 */
export function beginQuestionAnswer(drafts: QuestionDrafts, requestId: string): boolean {
  if (drafts.busy.has(requestId)) return false;
  drafts.busy.add(requestId);
  return true;
}

export function endQuestionAnswer(drafts: QuestionDrafts, requestId: string): void {
  drafts.busy.delete(requestId);
}

/**
 * The answer payload: every question of the request, its original option labels, and free text only when it is not
 * blank. An empty free-text row is an absent answer, not an answer that says "".
 */
export function questionAnswers(request: QuestionRequest, draft: QuestionDraft): QuestionAnswer[] {
  return request.questions.map((question) => {
    const typed = draft.text.get(question.id)?.trim();
    return {
      id: question.id,
      selected: draft.selected.get(question.id) ?? [],
      ...(typed ? { freeText: typed } : {}),
    };
  });
}

export interface QuestionOptionView {
  /** The value sent back in the answer: the kernel's label, never its translation. */
  value: string;
  /** What the option reads as; only the product's own plan question is translated. */
  label: string;
  description?: string;
  recommended: boolean;
  selected: boolean;
  index: number;
}

export interface QuestionCardView {
  requestId: string;
  /** The question currently on screen; a change here is what resets the card's reading position. */
  activeQuestionId: string;
  header: string;
  question: string;
  /** The plan body, kept separate from the short prompt and already stripped of its digest. */
  plan: string | null;
  subagent: string | null;
  page: number;
  total: number;
  canPrevious: boolean;
  canNext: boolean;
  collapsed: boolean;
  busy: boolean;
  options: QuestionOptionView[];
  allowFreeText: boolean;
  freeText: string;
  isPlan: boolean;
}

/**
 * The cards to draw, in Host order.
 *
 * This is a read: an empty draft is not created here, so asking what a fresh request looks like cannot make the
 * request look half-answered to anything that inspects the drafts.
 */
export function questionCards(
  questions: readonly PendingQuestion[],
  drafts: QuestionDrafts,
  lang: UiLanguage,
): QuestionCardView[] {
  return pendingQuestionRequests(questions).map((item) => {
    const total = item.request.questions.length;
    const page = questionPage(drafts, item.id, total);
    const question = item.request.questions[page]!;
    const draft = drafts.requests.get(item.id);
    // The product's own question (plan approval) is translated for display; the value sent back stays the
    // kernel's label. A question the model wrote is shown exactly as it wrote it.
    const copy = localizedQuestion(
      question.header || translate('ui.questionLabel', lang),
      question.question,
      lang === 'en-US',
    );
    const selected = new Set(draft?.selected.get(question.id) ?? []);
    const rawOptions = question.options ?? [];
    const options = rawOptions.map((option, index) => ({
      value: option.label,
      label: copy.label(option.label),
      ...(option.description ? { description: copy.description(option.description) } : {}),
      recommended: option.recommended === true,
      selected: selected.has(option.label),
      index,
    }));
    return {
      requestId: item.id,
      activeQuestionId: question.id,
      header: copy.header,
      question: copy.question,
      plan: copy.plan ?? null,
      subagent: item.request.subagent
        ? format(translate('subagent.attribution', lang), {
            objective: item.request.subagent.objective.slice(0, 120),
          })
        : null,
      page,
      total,
      canPrevious: page > 0,
      canNext: page < total - 1,
      collapsed: drafts.collapsed.has(item.id),
      busy: drafts.busy.has(item.id),
      options,
      // A question with no options is free text by definition; one with options opts in explicitly.
      allowFreeText: rawOptions.length === 0 || question.allowFreeText !== false,
      freeText: draft?.text.get(question.id) ?? '',
      isPlan: copy.plan !== undefined,
    };
  });
}
