/**
 * Mount the transcript rows and answer the renderer's `render`/`updateRunning`/live-thought calls.
 *
 * The adapter keeps `setupTranscript`'s surface so `renderer.ts` changes only the import, the rendering path and the
 * teardown. It owns what a rebuild needs to carry: the built message views (cached by session, language and message
 * value), the group keys of the previous model (so a fold that gains older steps above keeps its node), the scroll
 * position of every fold, and the single live-thought group React draws while no stored group is on screen yet.
 *
 * `flushSync` is deliberate. The legacy transcript updated the DOM inside `render()`, and the renderer reads that DOM
 * in the same turn: it decides whether the reader was at the bottom, restores a history anchor after `loadOlder`
 * resolves, and paints a running call's summary. Committing the rows before returning is what keeps those reads
 * looking at the transcript they describe.
 */
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import type { Message } from '../../../../packages/protocol/index.ts';
import { locale } from '../../i18n.ts';
import { TranscriptCache } from '../../transcript-cache.ts';
import { useReadable } from '../context.tsx';
import { registerView } from '../views.tsx';
import { createStore, type WritableStore } from '../stores.ts';
import {
  Conversation,
  updateProcessSummary,
  type GroupRegistry,
  type MessageFragment,
  type TranscriptState,
} from './Conversation.tsx';
import { completionNotice } from './completion-view.ts';
import { captureAnchor, restoreAnchor, type ScrollAnchor } from './scroll-anchor.ts';
import {
  transcriptModel,
  type TranscriptModel,
  type TranscriptSegment,
} from './transcript-model.ts';

type CardSegment = Extract<TranscriptSegment, { kind: 'card' }>;

export interface TranscriptHandle {
  render(messages: Message[], startIndex: number, runPaused: boolean): void;
  updateRunning(): void;
  placeLiveThought(thought: HTMLElement, visible: boolean): void;
  saveScroll(): void;
  restoreScroll(): void;
  dispose(): void;
}

export interface TranscriptMountOptions {
  getState(): CarrierSnapshot | null;
  /** The hub's message renderer: one message's content, once per transcript rebuild. */
  messageView(message: Message): HTMLElement;
  turnChanges?(): Map<number, HTMLElement>;
  onContinue?(): void;
  onRequestFullAccess?(): void;
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

function emptyModel(): TranscriptModel {
  return {
    rows: [],
    segments: [],
    messageCount: 0,
    tail: null,
    groupKeys: new Map(),
  };
}

function TranscriptHost({
  store,
  registry,
  onContinue,
}: {
  store: WritableStore<TranscriptState>;
  registry: GroupRegistry;
  onContinue?: () => void;
}): ReactNode {
  const state = useReadable(store);
  // A session is a different conversation: folds, caches and the live group all start over. Language and message
  // revisions stay inside the same tree, so a repaint does not remount rows whose content did not change.
  return (
    <Conversation
      key={state.sessionId ?? 'no-session'}
      state={state}
      registry={registry}
      onContinue={onContinue}
    />
  );
}

export function mountTranscript(options: TranscriptMountOptions): TranscriptHandle {
  const { messageView } = options;
  const host = required('messages');
  const live = required('live');
  const chatPage = required('chat-page');
  const cache = new TranscriptCache<MessageFragment>();
  const store = createStore<TranscriptState>({
    sessionId: null,
    revision: 0,
    model: emptyModel(),
    fragments: new Map(),
    cards: new Map(),
    footer: null,
    runPaused: false,
    completion: null,
    tailKey: null,
    liveGroupKey: null,
  });
  /** Step key → group key of the last model; inherited by the next one so a group can gain steps above it. */
  let previousGroups: ReadonlyMap<string, string> = new Map();
  /** Where each fold was scrolled to, keyed by the group key that survives rebuilds. */
  const processScroll = new Map<string, number>();
  /**
   * Whether the reader left each fold open. React owns the fold's state (`Fold`), so this is not a second copy: it is
   * the value a fold React had to recreate starts from, written when the reader toggles and cleared with the session.
   */
  const processOpen = new Map<string, boolean>();
  /** Tool calls whose summary line was already moved to the head of their group. */
  let runningProcessCalls = new Set<string>();
  let sessionId: string | null = null;
  let revision = 0;
  const groups = new Map<string, HTMLDetailsElement>();
  let liveGroupKey: string | null = null;
  /** A live thought waiting for its React group to commit. */
  let pendingThought: HTMLElement | null = null;
  let disposed = false;

  /**
   * The groups React currently owns. The adapter needs the tail by key to put the live thought in it, and the live
   * group to hand it the waiting thought once its element exists.
   */
  const registry: GroupRegistry = {
    register(key, group) {
      if (!group) {
        groups.delete(key);
        return;
      }
      groups.set(key, group);
      if (key !== liveGroupKey || !pendingThought) return;
      const thought = pendingThought;
      pendingThought = null;
      const steps = group.querySelector<HTMLElement>('.process-steps');
      if (steps && thought.parentElement !== steps) steps.append(thought);
      updateProcessSummary(group);
    },
    wasOpen: (key) => processOpen.get(key),
    rememberOpen(key, open) {
      processOpen.set(key, open);
    },
  };

  /** One message's built view, with the foldable pieces lifted out of it (legacy did this once per rebuild too). */
  function buildFragments(model: TranscriptModel, identity: string): Map<number, MessageFragment> {
    const views = cache.views(identity, model.rows, (message) => {
      const view = messageView(message);
      const thought = view.querySelector<HTMLElement>(':scope > .message-reasoning');
      const calls = Array.from(view.querySelectorAll<HTMLElement>(':scope > .tool-call'));
      thought?.remove();
      for (const call of calls) call.remove();
      return { message, view, thought, calls };
    });
    return new Map(model.rows.map((row, index) => [row.index, views[index]!]));
  }

  /**
   * Remember every fold's scroll position and the first visible step inside each open one, before React replaces the
   * steps above it. The scroll positions are the fallback for a fold whose visible step did not survive.
   *
   * The open state is not read from the DOM here: `Fold` records the reader's decision in `processOpen` when it
   * happens, which is both earlier than this pass and stable while a close animation still has `open` set.
   */
  function captureProcessState(): {
    scrolls: Map<string, number>;
    anchors: Map<string, ScrollAnchor>;
  } {
    const visible = !chatPage.hidden;
    const scrolls = new Map<string, number>();
    const anchors = new Map<string, ScrollAnchor>();
    for (const group of host.querySelectorAll<HTMLDetailsElement>(':scope > .process-group')) {
      const key = group.dataset.processKey;
      const steps = group.querySelector<HTMLElement>(':scope > .process-steps');
      if (!key || !steps) continue;
      scrolls.set(key, visible ? steps.scrollTop : (processScroll.get(key) ?? 0));
      if (visible && group.open) anchors.set(key, captureAnchor(steps));
    }
    return { scrolls, anchors };
  }

  /** Put every fold back, following the remembered step when it still exists and the height delta when it does not. */
  function restoreProcessState(saved: {
    scrolls: Map<string, number>;
    anchors: Map<string, ScrollAnchor>;
  }): void {
    const current = new Set<string>();
    for (const group of host.querySelectorAll<HTMLDetailsElement>(':scope > .process-group')) {
      const key = group.dataset.processKey;
      const steps = group.querySelector<HTMLElement>(':scope > .process-steps');
      if (!key || !steps) continue;
      current.add(key);
      // `open` belongs to `Fold` and is applied by the same render that created the node; writing it here would
      // fight a close animation the reader just started.
      const stored = saved.scrolls.get(key) ?? processScroll.get(key) ?? 0;
      steps.scrollTop = stored;
      const anchor = saved.anchors.get(key);
      if (anchor) restoreAnchor(steps, anchor);
      // A fold inside the hidden chat page has no CSS box, so its scrollTop reads back as 0. Keep the number the
      // settings-open `saveScroll` recorded; closing settings applies it once the page is visible again.
      processScroll.set(key, chatPage.hidden ? stored : steps.scrollTop);
    }
    for (const key of processScroll.keys()) if (!current.has(key)) processScroll.delete(key);
  }

  function publish(next: TranscriptState): void {
    flushSync(() => store.set(next));
  }

  function render(messages: Message[], startIndex: number, runPaused: boolean): void {
    if (disposed) return;
    const snapshot = options.getState();
    const nextSessionId = snapshot?.session.sessionId ?? null;
    const sessionChanged = nextSessionId !== sessionId;
    if (sessionChanged) {
      sessionId = nextSessionId;
      previousGroups = new Map();
      processScroll.clear();
      processOpen.clear();
      runningProcessCalls.clear();
      liveGroupKey = null;
      pendingThought = null;
    }
    // The old session's folds are still in the DOM until the commit below; their positions are not this session's.
    const saved = sessionChanged
      ? { scrolls: new Map<string, number>(), anchors: new Map<string, ScrollAnchor>() }
      : captureProcessState();
    const cards = options.turnChanges?.() ?? new Map<number, HTMLElement>();
    const model = transcriptModel(snapshot, messages, startIndex, cards, previousGroups);
    previousGroups = model.groupKeys;
    const fragments = buildFragments(model, `${sessionId}:${locale()}`);
    const segments = [...model.segments];
    const last = segments.at(-1);
    const footer = last?.kind === 'card' ? (segments.pop() as CardSegment) : null;
    const tail = segments.at(-1);
    const tailKey = tail?.kind === 'group' ? tail.key : null;
    // The live thought is moved back to #live just before this call; a group kept only for it must not outlive the
    // rebuild that now has the stored reasoning as a step of its own.
    liveGroupKey = null;
    pendingThought = null;
    revision += 1;
    publish({
      sessionId,
      revision,
      model: { ...model, segments },
      fragments,
      cards,
      footer,
      runPaused,
      completion: completionNotice(snapshot, options.onRequestFullAccess),
      tailKey,
      liveGroupKey: null,
    });
    restoreProcessState(saved);
  }

  function updateRunning(): void {
    if (disposed) return;
    const calls = options.getState()?.session.tools ?? [];
    const started = calls.filter((call) => !runningProcessCalls.has(call.id));
    runningProcessCalls = new Set(calls.map((call) => call.id));
    for (const call of started) {
      const step = Array.from(document.querySelectorAll<HTMLElement>('#messages .tool-call')).find(
        (item) => item.dataset.callId === call.id,
      );
      const group = step?.closest<HTMLDetailsElement>('.process-group');
      const summary = step?.querySelector(':scope > summary');
      if (group && summary) updateProcessSummary(group, summary);
    }
  }

  function setLiveGroup(key: string | null): void {
    liveGroupKey = key;
    const state = store.getSnapshot();
    if (state.liveGroupKey === key) return;
    publish({ ...state, liveGroupKey: key });
  }

  /** The live thought joins the last interval, without rebuilding or closing a reader's open fold. */
  function placeLiveThought(thought: HTMLElement, visible: boolean): void {
    if (disposed) return;
    if (!visible) {
      if (pendingThought === thought) {
        pendingThought = null;
        if (liveGroupKey !== null) setLiveGroup(null);
      }
      if (thought.parentElement?.classList.contains('process-steps')) {
        const group = thought.closest<HTMLDetailsElement>('.process-group');
        live.prepend(thought);
        if (!group) return;
        const steps = group.querySelector<HTMLElement>('.process-steps');
        if (steps && !steps.children.length) {
          if (liveGroupKey === group.dataset.processKey) setLiveGroup(null);
          else group.remove();
        } else updateProcessSummary(group);
      }
      return;
    }
    const state = store.getSnapshot();
    thought.dataset.processKey = `${state.model.messageCount}:reasoning`;
    const tail = state.tailKey ? groups.get(state.tailKey) : undefined;
    if (tail) {
      const steps = tail.querySelector<HTMLElement>('.process-steps');
      if (steps && thought.parentElement !== steps) steps.append(thought);
      updateProcessSummary(tail);
      return;
    }
    const key = `group:${thought.dataset.processKey}`;
    if (liveGroupKey === key) {
      const group = groups.get(key);
      if (group) {
        const steps = group.querySelector<HTMLElement>('.process-steps');
        if (steps && thought.parentElement !== steps) steps.append(thought);
        updateProcessSummary(group);
      } else pendingThought = thought;
      return;
    }
    pendingThought = thought;
    setLiveGroup(key);
    // The registry seam normally runs inside the commit `setLiveGroup` flushed; this covers a thought that arrives
    // before the region's first paint.
    const group = groups.get(key);
    if (group && pendingThought) {
      const steps = group.querySelector<HTMLElement>('.process-steps');
      if (steps) steps.append(pendingThought);
      pendingThought = null;
      updateProcessSummary(group);
    }
  }

  /** Remember where every fold was scrolled to, before something hides the transcript. */
  function saveScroll(): void {
    for (const group of host.querySelectorAll<HTMLElement>(':scope > .process-group')) {
      const key = group.dataset.processKey;
      const steps = group.querySelector<HTMLElement>('.process-steps');
      if (key && steps) processScroll.set(key, steps.scrollTop);
    }
  }
  /** Put every fold back where it was; a rebuilt transcript runs this right after its own rebuild. */
  function restoreScroll(): void {
    for (const group of host.querySelectorAll<HTMLElement>(':scope > .process-group')) {
      const key = group.dataset.processKey;
      const steps = group.querySelector<HTMLElement>('.process-steps');
      if (key && steps) steps.scrollTop = processScroll.get(key) ?? 0;
    }
  }

  const disposeRegion = registerView(
    'transcript',
    <TranscriptHost store={store} registry={registry} onContinue={options.onContinue} />,
  );

  return {
    render,
    updateRunning,
    placeLiveThought,
    saveScroll,
    restoreScroll,
    dispose() {
      if (disposed) return;
      disposed = true;
      // The thought is the product's own node in #live; unmounting a group that borrowed it must give it back.
      const thought = document.getElementById('live-reasoning');
      if (thought?.parentElement?.classList.contains('process-steps')) live.prepend(thought);
      disposeRegion();
    },
  };
}
