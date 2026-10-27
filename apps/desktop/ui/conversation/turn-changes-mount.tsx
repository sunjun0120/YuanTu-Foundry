/**
 * Mount the turn-change cards and answer the renderer's `update`/`cards` calls.
 *
 * The adapter keeps `setupTurnChanges`'s surface — a revision string for the transcript key, and the cards by the
 * message they follow — while React draws every card. The transcript still places an element per position, so each
 * card is a shell whose content is a portal into a holder inside it; an open preview is the same idea with the
 * workspace's preview element. Placement, the workspace hand-off and the `cards()` map therefore stay what they
 * were, and the interaction (fold, open, undo) becomes React's.
 *
 * What belongs to the interaction rather than to the snapshot lives here: the unfolded turns, the card shells, and
 * the previews the workspace was given. A session is a different set of turns, so switching clears all three and
 * drops the change previews the previous session left in the workspace — otherwise a turn key from one session
 * would name the next session's card.
 */
import type { ReactNode } from 'react';
import type { CarrierCommand, CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { locale } from '../../i18n.ts';
import { memo } from '../../renderer-memo.ts';
import { collectTurnChanges, type TurnChangedFile, type TurnChanges } from '../../turn-changes.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { registerView } from '../views.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import {
  TurnChangesView,
  type TurnCardView,
  type TurnChangesActions,
  type TurnChangesState,
  type TurnPreviewView,
} from './TurnChanges.tsx';
import { groupTurnCards, visibleTurns } from './turn-changes-model.ts';

export interface TurnChangesMountOptions {
  getState(): CarrierSnapshot | null;
  select(command: CarrierCommand): Promise<unknown>;
  preview(path: string, content: HTMLElement, key: string): void;
  refreshPreview(key: string, content: HTMLElement): boolean;
  clearPreviews(): void;
}

export interface TurnChangesHandle {
  update(blocked: boolean): string;
  cards(): Map<number, HTMLElement>;
  dispose(): void;
}

/** A card's two elements: the shell the transcript places, and the holder React draws into. */
interface CardSlot {
  shell: HTMLElement;
  holder: HTMLElement;
}

/** A preview element the workspace holds, keyed by the turn and path it belongs to. */
interface OpenedPreview {
  turnKey: string;
  path: string;
  element: HTMLElement;
  /** The file as last read, kept so a tab whose turn has gone still shows the diff it was opened on. */
  file: TurnChangedFile;
}

function TurnChangesHost({
  store,
  actions,
}: {
  store: ReadableStore<TurnChangesState>;
  actions: TurnChangesActions;
}): ReactNode {
  const state = useReadable(store);
  const lang = useLocale();
  return <TurnChangesView state={state} lang={lang} actions={actions} />;
}

export function mountTurnChanges(options: TurnChangesMountOptions): TurnChangesHandle {
  const store = createStore<TurnChangesState>({ cards: [], previews: [], blocked: false });
  let identity = '';
  let revision = 0;
  let sessionId: string | null = null;
  let blocked = false;
  let turns: TurnChanges[] = [];
  let cards = new Map<number, HTMLElement>();
  let disposed = false;
  /** Turns whose list the reader unfolded. A session switch empties it because a turn key is not portable. */
  const expanded = new Set<string>();
  const slots = new Map<string, CardSlot>();
  const opened = new Map<string, OpenedPreview>();
  const changesText = memo<string>();

  function currentFile(turnKey: string, path: string): TurnChangedFile | undefined {
    return turns.find((turn) => turn.key === turnKey)?.files.find((file) => file.path === path);
  }

  function slotFor(turnKey: string): CardSlot {
    let slot = slots.get(turnKey);
    if (!slot) {
      const shell = document.createElement('section');
      shell.className = 'turn-changes';
      const holder = document.createElement('div');
      holder.dataset.reactOwned = '';
      shell.append(holder);
      slot = { shell, holder };
      slots.set(turnKey, slot);
    }
    slot.shell.dataset.turnKey = turnKey;
    return slot;
  }

  /** The positions the transcript asks for: one card, or one group of cards when turns end together. */
  function composeCards(): Map<number, HTMLElement> {
    const next = new Map<number, HTMLElement>();
    for (const [afterIndex, grouped] of groupTurnCards(turns)) {
      if (grouped.length === 1) {
        next.set(afterIndex, slotFor(grouped[0]!.key).shell);
        continue;
      }
      const group = document.createElement('div');
      group.className = 'turn-changes-group';
      for (const turn of grouped) group.append(slotFor(turn.key).shell);
      next.set(afterIndex, group);
    }
    return next;
  }

  /** Hand React the current projection; the portal targets keep their identity across publishes. */
  function publish(): void {
    const cardViews: TurnCardView[] = turns.map((turn) => {
      const slot = slotFor(turn.key);
      return {
        key: turn.key,
        turn,
        expanded: expanded.has(turn.key),
        holder: slot.holder,
      };
    });
    const previews: TurnPreviewView[] = [];
    for (const [key, preview] of opened)
      previews.push({ key, file: preview.file, element: preview.element });
    store.set({ cards: cardViews, previews, blocked });
  }

  /**
   * Follow the file a preview belongs to and drop previews the workspace no longer holds.
   *
   * A preview's content element is stable, so a changed diff needs no new node: React redraws what is inside it.
   * The refresh call is still how the card learns that the reader closed the tab — the workspace answers `false`
   * for a key it no longer hosts — which stops this adapter from drawing into an element nobody shows. A file whose
   * turn disappeared keeps its last reading while the tab does, as the built preview did: the tab is the reader's,
   * and emptying it would turn a stale diff into a blank panel.
   */
  function retainOpenedPreviews(): void {
    for (const [key, preview] of [...opened]) {
      const file = currentFile(preview.turnKey, preview.path);
      if (file) preview.file = file;
      if (!options.refreshPreview(key, preview.element)) opened.delete(key);
    }
  }

  function openPreview(turnKey: string, path: string): void {
    const current = currentFile(turnKey, path);
    if (!current) return;
    const key = `${turnKey}:${path}`;
    let preview = opened.get(key);
    if (!preview) {
      const element = document.createElement('section');
      element.className = 'turn-change-preview';
      // Everything inside is React's: the translation walker must not rewrite a label it already owns.
      element.dataset.reactOwned = '';
      preview = { turnKey, path, element, file: current };
      opened.set(key, preview);
    } else preview.file = current;
    publish();
    options.preview(path, preview.element, key);
  }

  const actions: TurnChangesActions = {
    open: openPreview,
    toggle(turnKey) {
      if (!expanded.delete(turnKey)) expanded.add(turnKey);
      publish();
    },
    undo(recordId) {
      void options.select({ type: 'undo', id: recordId });
    },
  };

  const disposeRegion = registerView(
    'turn-changes',
    <TurnChangesHost store={store} actions={actions} />,
  );

  function update(nextBlocked: boolean): string {
    if (disposed) return '';
    const state = options.getState();
    if (!state) return '';
    if (sessionId !== state.session.sessionId) {
      sessionId = state.session.sessionId;
      expanded.clear();
      slots.clear();
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
    turns = visibleTurns(
      collectTurnChanges(
        changes,
        state.session.messages,
        state.session.historyStart ?? 0,
        state.session.running,
      ),
    );
    const retained = new Set(turns.map((turn) => turn.key));
    for (const key of slots.keys()) if (!retained.has(key)) slots.delete(key);
    retainOpenedPreviews();
    cards = composeCards();
    publish();
    return String(revision);
  }

  return {
    update,
    cards: () => cards,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeRegion();
      slots.clear();
      opened.clear();
    },
  };
}
