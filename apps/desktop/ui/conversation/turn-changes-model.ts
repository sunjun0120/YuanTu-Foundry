/**
 * What a turn-changes card shows: which files count, how many rows are collapsed, where the card belongs, and what a
 * file's preview offers.
 *
 * A preview file the agent created only to look at a document is not a change it kept; counting its create/delete pair
 * would make the summary claim the agent edited something it did not. Two turns that end after the same message share
 * one position and are drawn as one group. And a journal row that has no recovery snapshot — or that a batch change
 * repeats for the same path — is described once rather than given an undo it cannot honour.
 */
import { fileChangeAction, undoConfirmKey } from '../../../../packages/client/change-actions.ts';
import type { FileChange } from '../../../../packages/protocol/index.ts';
import type { TurnChangedFile, TurnChanges } from '../../turn-changes.ts';
import { translate } from '../../i18n.ts';
import type { UiLanguage } from '../../ui-settings.ts';

const COLLAPSED_ROWS = 3;

export function transientPreview(path: string): boolean {
  return /\.preview\.[a-z0-9]+$/iu.test(path);
}

export function visibleTurnFiles(turn: TurnChanges): TurnChangedFile[] {
  return turn.files.filter((file) => !transientPreview(file.path));
}

/** The turns a card is drawn for: the scratch previews are gone, and a turn that kept no file is not a card. */
export function visibleTurns(turns: readonly TurnChanges[]): TurnChanges[] {
  return turns
    .map((turn) => ({ ...turn, files: visibleTurnFiles(turn) }))
    .filter((turn) => turn.files.length > 0);
}

export interface TurnCardReading {
  key: string;
  afterIndex: number;
  title: string;
  hint: string;
  rows: { path: string; added: number; removed: number }[];
  hiddenRows: number;
  toggleLabel: string | null;
  expanded: boolean;
}

export function turnCardReading(
  turn: TurnChanges,
  expanded: boolean,
  lang: UiLanguage,
): TurnCardReading {
  const files = visibleTurnFiles(turn);
  const shown = expanded ? files : files.slice(0, COLLAPSED_ROWS);
  return {
    key: turn.key,
    afterIndex: turn.afterIndex,
    title: translate('ui.editedFiles', lang, { count: String(files.length) }),
    hint: translate('ui.clickFileForChanges', lang),
    rows: shown.map((file) => ({ path: file.path, added: file.added, removed: file.removed })),
    hiddenRows: Math.max(0, files.length - shown.length),
    toggleLabel:
      files.length > COLLAPSED_ROWS
        ? translate(expanded ? 'ui.collapseChangedFiles' : 'ui.allChangedFiles', lang, {
            count: String(files.length),
          })
        : null,
    expanded,
  };
}

/** One journal row's undo affordance, when that row can still be restored. */
export interface TurnPreviewUndo {
  recordId: string;
  label: string;
  confirmLabel: string;
}

/** One diff panel inside a preview: the change, who made it, what happened to the row, and how to undo it. */
export interface TurnPreviewEntry {
  /** Stable list key. A batch row can produce several entries for the same path, so the row id alone is not unique. */
  key: string;
  change: FileChange;
  /** The sub-agent badge, already sliced to the objective a card can show. */
  attribution: string | null;
  notice: string;
  undo: TurnPreviewUndo | null;
}

/**
 * The reading of one file's preview, entry by entry.
 *
 * A legacy receipt has no recovery snapshot, so it is described rather than made actionable; and one journal row
 * can appear several times in a file's entries (a batch change is flattened per path), so it offers its undo once.
 * Both rules used to live inside the card builder and are kept here, where they can be read and tested without a
 * document.
 */
export function turnPreviewEntries(file: TurnChangedFile, lang: UiLanguage): TurnPreviewEntry[] {
  const entries: TurnPreviewEntry[] = [];
  const offered = new Set<string>();
  file.entries.forEach(({ record, change }, index) => {
    const action = fileChangeAction(record.status);
    const legacy = record.id.startsWith('legacy:');
    const tag = change.subagent ?? record.change.subagent;
    const undo =
      !legacy && action.kind !== 'none' && !offered.has(record.id)
        ? {
            recordId: record.id,
            label: translate(action.actionKey, lang),
            confirmLabel: translate(undoConfirmKey(record.change.kind), lang),
          }
        : null;
    if (undo) offered.add(record.id);
    entries.push({
      key: `${record.id}:${String(index)}`,
      change,
      attribution: tag
        ? translate('subagent.attribution', lang, { objective: tag.objective.slice(0, 120) })
        : null,
      notice: legacy ? translate('ui.legacyChange', lang) : translate(action.noticeKey, lang),
      undo,
    });
  });
  return entries;
}

/** One position can hold several turns; the list keeps them together instead of choosing a winner. */
export function groupTurnCards(turns: TurnChanges[]): Map<number, TurnChanges[]> {
  const grouped = new Map<number, TurnChanges[]>();
  for (const turn of turns) {
    const list = grouped.get(turn.afterIndex) ?? [];
    list.push(turn);
    grouped.set(turn.afterIndex, list);
  }
  return grouped;
}
