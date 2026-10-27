/**
 * Mount the live bubble's React surface and answer the scheduler's paints.
 *
 * The adapter owns the one `<details>` the transcript borrows: `placeLiveThought` moves it into the last process group
 * and back. Every paint re-offers it, not only a paint whose text changed, because a transcript rebuild returns the
 * fold to `#live` outside this component and the next coalesced paint is what puts it back in the tail.
 *
 * The store update uses `flushSync` for the same reason the transcript adapter does: `renderer-live.ts` measures the
 * conversation and follows the tail in the same tick, and the new text has to be in the layout before that measurement.
 */
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';
import type { MarkdownActions } from '../../markdown.ts';
import { useReadable } from '../context.tsx';
import { registerView } from '../views.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import { LiveMessage } from './LiveMessage.tsx';
import type { LiveMessageSurface, LiveMessageView } from './live-model.ts';

/** What the bubble shows before the first paint. */
const EMPTY_VIEW: LiveMessageView = { present: false, text: '', reasoning: '', phase: undefined };

function LiveMessageHost({
  store,
  actions,
}: {
  store: ReadableStore<LiveMessageView>;
  actions: MarkdownActions;
}): ReactNode {
  const view = useReadable(store);
  return <LiveMessage view={view} actions={actions} />;
}

export function mountLiveMessage(options: {
  actions: MarkdownActions;
  /** Put the live thought into the last process group, or take it back out. */
  placeLiveThought(thought: HTMLElement, visible: boolean): void;
}): LiveMessageSurface & { releaseThought(): void; dispose(): void } {
  const store = createStore<LiveMessageView>(EMPTY_VIEW);
  const host = document.getElementById('live');
  const dispose = host
    ? registerView('live-message', <LiveMessageHost store={store} actions={options.actions} />)
    : () => {};
  return {
    paint(view) {
      const current = store.getSnapshot();
      if (
        current.present !== view.present ||
        current.text !== view.text ||
        current.reasoning !== view.reasoning ||
        current.phase !== view.phase
      )
        flushSync(() => store.set(view));
      // The fold is the transcript's to borrow; offer it on every paint so a rebuild cannot strand it in #live.
      const thought = document.getElementById('live-reasoning');
      if (thought) options.placeLiveThought(thought, view.reasoning !== '');
    },
    /** The portal container cannot be hidden from inside the portal, so the adapter that owns the host sets it. */
    setVisible(visible) {
      if (host) host.hidden = !visible;
    },
    /**
     * Take the fold back before the transcript is rebuilt: the process group it was borrowed into is about to be
     * replaced, and a node React still owns must not be unmounted through that group.
     */
    releaseThought() {
      const thought = document.getElementById('live-reasoning');
      if (host && thought) host.prepend(thought);
    },
    dispose,
  };
}
