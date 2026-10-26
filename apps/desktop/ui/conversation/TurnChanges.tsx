/**
 * A turn's changed files, as React.
 *
 * The card is a projection of `turn-changes-model.ts`: the model decides which files count, which rows are folded,
 * what every label says and what a preview offers; this file draws those readings and owns the interaction — opening
 * a preview, folding the list, and the two-step undo. Only the patch body is a DOM island, built by the shared
 * `diff-view.ts` so the approval card and this preview cannot disagree about how a diff is drawn.
 *
 * The transcript places each card by an element the adapter hands it, so the card content is a portal into a holder
 * inside that element. React owns everything in the holder; the transcript keeps owning where the element sits.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FileChange } from '../../../../packages/protocol/index.ts';
import { diffBody, diffSummaryText } from '../../diff-view.ts';
import { translate } from '../../i18n.ts';
import type { TurnChangedFile, TurnChanges } from '../../turn-changes.ts';
import type { UiLanguage } from '../../ui-settings.ts';
import { useLocale } from '../i18n.ts';
import {
  turnCardReading,
  turnPreviewEntries,
  visibleTurnFiles,
  type TurnPreviewUndo,
} from './turn-changes-model.ts';

/** One card's place in the transcript, and the element React draws its content into. */
export interface TurnCardView {
  key: string;
  turn: TurnChanges;
  expanded: boolean;
  holder: HTMLElement;
}

/** One preview the workspace holds open, and the element React draws its panels into. */
export interface TurnPreviewView {
  key: string;
  file: TurnChangedFile;
  element: HTMLElement;
}

export interface TurnChangesState {
  cards: readonly TurnCardView[];
  previews: readonly TurnPreviewView[];
  blocked: boolean;
}

export interface TurnChangesActions {
  open(turnKey: string, path: string): void;
  toggle(turnKey: string): void;
  undo(recordId: string): void;
}

/** The document-with-pen the card heads itself with; the mark is decoration, so it stays out of the reading. */
function CardIcon(): ReactNode {
  return (
    <span className="turn-changes-icon" aria-hidden="true">
      <svg viewBox="0 0 32 36">
        <path
          fill="currentColor"
          d="M6 1h15l9 9v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Z"
        />
        <path fill="#b9d0ff" d="M21 1v9h9Z" />
        <path
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m11 17-4 4 4 4m10-8 4 4-4 4m-4-9-2 10"
        />
      </svg>
    </span>
  );
}

/**
 * The patch body, hosted under the React-owned `details`.
 *
 * The body is rebuilt when the change or the language changes: a batch's nested folds carry a translated summary,
 * and the effect owns the body rather than React because `diffBody` is the one place a patch is classified. The
 * `details` itself stays mounted, so a reader's fold state survives a repaint.
 */
function DiffBody({ change }: { change: FileChange }): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const lang = useLocale();
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    container.replaceChildren(...diffBody(change, true));
    return () => container.replaceChildren();
  }, [change, lang]);
  return <div className="file-diff-body" ref={host} />;
}

/** One changed file's row: the path on the left, the two counts on the right. */
function TurnChangeRow({
  path,
  added,
  removed,
  onOpen,
}: {
  path: string;
  added: number;
  removed: number;
  onOpen(): void;
}): ReactNode {
  return (
    // The path is data, not copy: the DOM walker must not try to translate a file name.
    <button type="button" className="turn-change-row" title={path} translate="no" onClick={onOpen}>
      <span className="turn-change-path">{path}</span>
      <span className="turn-change-counts">
        <span className="turn-change-added">{`+${String(added)}`}</span>
        <span className="turn-change-removed">{`-${String(removed)}`}</span>
      </span>
    </button>
  );
}

/** One card: the heading opens the first file, the rows open theirs, and the toggle unfolds the rest. */
function TurnChangesCard({
  card,
  lang,
  actions,
}: {
  card: TurnCardView;
  lang: UiLanguage;
  actions: TurnChangesActions;
}): ReactNode {
  const reading = turnCardReading(card.turn, card.expanded, lang);
  const first = visibleTurnFiles(card.turn)[0];
  return (
    <>
      <button
        type="button"
        className="turn-changes-heading"
        onClick={() => {
          if (first) actions.open(card.key, first.path);
        }}
      >
        <CardIcon />
        <span className="turn-changes-labels">
          <strong className="turn-changes-title">{reading.title}</strong>
          <span className="turn-changes-hint">{reading.hint}</span>
        </span>
      </button>
      <div className="turn-changes-list">
        {reading.rows.map((row) => (
          <TurnChangeRow
            key={row.path}
            path={row.path}
            added={row.added}
            removed={row.removed}
            onOpen={() => actions.open(card.key, row.path)}
          />
        ))}
      </div>
      {reading.toggleLabel === null ? null : (
        <button
          type="button"
          className="turn-changes-toggle"
          aria-expanded={reading.expanded}
          onClick={() => actions.toggle(card.key)}
        >
          {reading.toggleLabel}
          <span className="turn-changes-chevron" />
        </button>
      )}
    </>
  );
}

/**
 * The one action a journal row offers inside a preview.
 *
 * Asking first is the point: restoring a file is not undoable by a second click. The legacy button swapped itself
 * for a confirmation and a cancel; the same two-step stays, now as React state, and `blocked` reaches both the
 * button and the confirmation because a run in progress is not the moment to restore a file underneath it.
 */
function UndoAction({
  undo,
  blocked,
  lang,
  onConfirm,
}: {
  undo: TurnPreviewUndo;
  blocked: boolean;
  lang: UiLanguage;
  onConfirm(): void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <button
        type="button"
        className="undo-change"
        disabled={blocked}
        onClick={() => setConfirming(true)}
      >
        {undo.label}
      </button>
    );
  return (
    <>
      <button type="button" className="confirm-undo" disabled={blocked} onClick={onConfirm}>
        {undo.confirmLabel}
      </button>
      <button type="button" onClick={() => setConfirming(false)}>
        {translate('ui.cancel', lang)}
      </button>
    </>
  );
}

/** One file's preview: a diff fold per journal entry, each with its attribution, notice and undo. */
function TurnPreview({
  preview,
  lang,
  blocked,
  actions,
}: {
  preview: TurnPreviewView;
  lang: UiLanguage;
  blocked: boolean;
  actions: TurnChangesActions;
}): ReactNode {
  return (
    <>
      {turnPreviewEntries(preview.file, lang).map((entry) => {
        const undo = entry.undo;
        return (
          <details className="file-diff" open key={entry.key}>
            {entry.attribution === null ? null : (
              <p className="subagent-badge">{entry.attribution}</p>
            )}
            <summary>{diffSummaryText(entry.change)}</summary>
            <DiffBody change={entry.change} />
            <p className="diff-notice">{entry.notice}</p>
            {undo === null ? null : (
              <UndoAction
                undo={undo}
                blocked={blocked}
                lang={lang}
                onConfirm={() => actions.undo(undo.recordId)}
              />
            )}
          </details>
        );
      })}
    </>
  );
}

/**
 * The whole surface: one portal per card holder and one per open preview.
 *
 * The portal targets are the elements the adapter handed to the transcript and the workspace; moving such an
 * element — a session rebuild, a tab switch — moves the content with it. A language change re-renders this tree
 * through `useLocale`, which is what keeps a label and a diff summary in the interface's language without the
 * transcript having to be rebuilt for a card that did not change.
 */
export function TurnChangesView({
  state,
  lang,
  actions,
}: {
  state: TurnChangesState;
  lang: UiLanguage;
  actions: TurnChangesActions;
}): ReactNode {
  return (
    <>
      {state.cards.map((card) =>
        createPortal(
          <TurnChangesCard card={card} lang={lang} actions={actions} />,
          card.holder,
          card.key,
        ),
      )}
      {state.previews.map((preview) =>
        createPortal(
          <TurnPreview preview={preview} lang={lang} blocked={state.blocked} actions={actions} />,
          preview.element,
          preview.key,
        ),
      )}
    </>
  );
}
