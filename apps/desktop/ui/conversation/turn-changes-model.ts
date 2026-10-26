/**
 * What a turn-changes card shows: which files count, how many rows are collapsed, and where the card belongs.
 *
 * A preview file the agent created only to look at a document is not a change it kept; counting its create/delete pair
 * would make the summary claim the agent edited something it did not. Two turns that end after the same message share
 * one position and are drawn as one group.
 */
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
    hint: translate('ui.previewChanges', lang),
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
