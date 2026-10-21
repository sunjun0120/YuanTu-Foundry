import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import { fileChangeAction, undoConfirmKey } from '../../packages/client/change-actions.ts';
import { collectTurnChanges, type TurnChangedFile, type TurnChanges } from './turn-changes.ts';
import { diffView } from './diff-view.ts';
import { locale, t } from './i18n.ts';
import { memo } from './renderer-memo.ts';

/** Rows a collapsed card previews before the whole-list toggle appears. */
const COLLAPSED_ROWS = 3;

/**
 * A preview file the agent created only to look at the document.
 *
 * `office_preview` writes `收入报告.preview.html` next to the deliverable, and the task then deletes it. Counting
 * that create/delete pair as "2 files edited" makes the summary say the agent changed something it did not keep.
 */
function transientPreview(path: string): boolean {
  return /\.preview\.[a-z0-9]+$/iu.test(path);
}
function visibleFiles(turn: TurnChanges): TurnChangedFile[] {
  return turn.files.filter((file) => !transientPreview(file.path));
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

export function setupTurnChanges(options: {
  getState(): CarrierSnapshot | null;
  select(command: CarrierCommand): Promise<unknown>;
  preview(path: string, content: HTMLElement, key: string): void;
  refreshPreview(key: string, content: HTMLElement): boolean;
  clearPreviews(): void;
}): { update(blocked: boolean): string; cards(): Map<number, HTMLElement> } {
  let identity = '';
  let revision = 0;
  let sessionId: string | null = null;
  let blocked = false;
  let cards = new Map<number, HTMLElement>();
  const expanded = new Set<string>();
  const cardCache = new Map<string, { identity: string; view: HTMLElement }>();
  const opened = new Map<
    string,
    { key: string; path: string; identity: string; view: HTMLElement }
  >();
  const changesText = memo<string>();
  const previewIdentity = (file: TurnChangedFile) => JSON.stringify([file.entries, locale()]);

  function previewView(file: TurnChangedFile): HTMLElement {
    const root = node('section', '', 'turn-change-preview');
    const actions = new Set<string>();
    for (const { record, change } of file.entries) {
      const panel = diffView(change, true);
      const attribution = change.subagent ?? record.change.subagent;
      if (attribution)
        panel.prepend(
          node(
            'p',
            t('subagent.attribution', { objective: attribution.objective.slice(0, 120) }),
            'subagent-badge',
          ),
        );
      const action = fileChangeAction(record.status);
      panel.append(
        node(
          'p',
          record.id.startsWith('legacy:') ? t('ui.legacyChange') : t(action.noticeKey),
          'diff-notice',
        ),
      );
      if (!actions.has(record.id) && !record.id.startsWith('legacy:') && action.kind !== 'none') {
        actions.add(record.id);
        const undo = node('button', t(action.actionKey), 'undo-change');
        undo.type = 'button';
        undo.disabled = blocked;
        undo.addEventListener('click', () => {
          const confirm = node('button', t(undoConfirmKey(record.change.kind)), 'confirm-undo');
          const cancel = node('button', t('ui.cancel'));
          confirm.type = cancel.type = 'button';
          confirm.disabled = blocked;
          confirm.addEventListener(
            'click',
            () => void options.select({ type: 'undo', id: record.id }),
          );
          cancel.addEventListener('click', () => {
            confirm.remove();
            cancel.remove();
            undo.hidden = false;
          });
          undo.hidden = true;
          panel.append(confirm, cancel);
        });
        panel.append(undo);
      }
      root.append(panel);
    }
    return root;
  }

  function card(turn: TurnChanges): HTMLElement {
    const root = node('section', '', 'turn-changes');
    const files = visibleFiles(turn);
    root.dataset.turnKey = turn.key;
    const open = (file: TurnChangedFile) => {
      const view = previewView(file);
      opened.set(`${turn.key}:${file.path}`, {
        key: turn.key,
        path: file.path,
        identity: previewIdentity(file),
        view,
      });
      options.preview(file.path, view, `${turn.key}:${file.path}`);
    };
    const heading = node('button', '', 'turn-changes-heading');
    heading.type = 'button';
    const icon = node('span', '', 'turn-changes-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg viewBox="0 0 32 36"><path fill="currentColor" d="M6 1h15l9 9v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Z"/><path fill="#b9d0ff" d="M21 1v9h9Z"/><path fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m11 17-4 4 4 4m10-8 4 4-4 4m-4-9-2 10"/></svg>';
    const labels = node('span', '', 'turn-changes-labels');
    labels.append(
      node('strong', t('ui.editedFiles', { count: String(files.length) }), 'turn-changes-title'),
      node('span', t('ui.previewChanges'), 'turn-changes-hint'),
    );
    heading.append(icon, labels);
    heading.addEventListener('click', () => {
      if (files[0]) open(files[0]);
    });
    const list = node('div', '', 'turn-changes-list');
    const toggle = node('button', '', 'turn-changes-toggle');
    toggle.type = 'button';
    const paint = () => {
      const all = expanded.has(turn.key);
      list.replaceChildren(
        ...(all ? files : files.slice(0, COLLAPSED_ROWS)).map((file) => {
          const row = node('button', '', 'turn-change-row');
          row.type = 'button';
          row.title = file.path;
          row.translate = false;
          row.append(node('span', file.path, 'turn-change-path'));
          const counts = node('span', '', 'turn-change-counts');
          counts.append(
            node('span', `+${file.added}`, 'turn-change-added'),
            node('span', `-${file.removed}`, 'turn-change-removed'),
          );
          row.append(counts);
          row.addEventListener('click', () => open(file));
          return row;
        }),
      );
      toggle.textContent = t(all ? 'ui.collapseChangedFiles' : 'ui.allChangedFiles', {
        count: String(turn.files.length),
      });
      toggle.setAttribute('aria-expanded', String(all));
      toggle.append(node('span', '', 'turn-changes-chevron'));
    };
    toggle.addEventListener('click', () => {
      if (!expanded.delete(turn.key)) expanded.add(turn.key);
      paint();
    });
    root.append(heading, list);
    if (turn.files.length > COLLAPSED_ROWS) root.append(toggle);
    paint();
    return root;
  }

  function update(nextBlocked: boolean): string {
    const state = options.getState();
    if (!state) return '';
    if (sessionId !== state.session.sessionId) {
      sessionId = state.session.sessionId;
      expanded.clear();
      cardCache.clear();
      opened.clear();
      options.clearPreviews();
    }
    blocked = nextBlocked;
    const changes = state.changes;
    const next = JSON.stringify([
      sessionId,
      changesText([changes], () => JSON.stringify(changes)),
      state.session.messageRevision,
      state.session.historyStart,
      state.session.running,
      blocked,
      locale(),
    ]);
    if (next === identity) return String(revision);
    identity = next;
    revision++;
    const turns = collectTurnChanges(
      state.changes,
      state.session.messages,
      state.session.historyStart ?? 0,
      state.session.running,
    )
      .map((turn) => ({ ...turn, files: visibleFiles(turn) }))
      .filter((turn) => turn.files.length > 0);
    cards = new Map();
    for (const turn of turns) {
      const contentKey = JSON.stringify([turn.files, locale()]);
      let cached = cardCache.get(turn.key);
      if (cached?.identity !== contentKey) {
        cached = { identity: contentKey, view: card(turn) };
        cardCache.set(turn.key, cached);
      }
      const previous = cards.get(turn.afterIndex);
      if (previous) {
        const group = node('div', '', 'turn-changes-group');
        group.append(previous, cached.view);
        cards.set(turn.afterIndex, group);
      } else cards.set(turn.afterIndex, cached.view);
    }
    const retained = new Set(turns.map((turn) => turn.key));
    for (const key of cardCache.keys()) if (!retained.has(key)) cardCache.delete(key);
    for (const [previewKey, openedFile] of opened) {
      const file = turns
        .find((turn) => turn.key === openedFile.key)
        ?.files.find((file) => file.path === openedFile.path);
      if (!file) {
        opened.delete(previewKey);
        continue;
      }
      const contentKey = previewIdentity(file);
      if (contentKey !== openedFile.identity) {
        openedFile.identity = contentKey;
        openedFile.view = previewView(file);
      }
      for (const button of openedFile.view.querySelectorAll<HTMLButtonElement>(
        '.undo-change, .confirm-undo',
      ))
        button.disabled = blocked;
      if (!options.refreshPreview(previewKey, openedFile.view)) opened.delete(previewKey);
    }
    return String(revision);
  }
  return { update, cards: () => cards };
}
