/**
 * The React host for the live answer body.
 *
 * The reasoning fold and the stream buffers stay where they are for now; this replaces only the repeatedly repainted
 * `.message-content` node, so `#live .message-content` remains the same shape for the rest of the window.
 */
import { useReadable } from '../context.tsx';
import { createStore } from '../stores.ts';
import { mountRegion } from '../legacy/mount-region.tsx';
import type { MarkdownActions } from '../../markdown.ts';
import { MarkdownView } from './MarkdownView.tsx';

export function mountLiveContent(actions: MarkdownActions): {
  update(text: string): void;
  dispose(): void;
} {
  const store = createStore<string>('');
  const host = document.getElementById('live-content-root');
  const dispose = host
    ? mountRegion('live-content', host, <LiveContentHost store={store} actions={actions} />)
    : () => {};
  return {
    update(text) {
      if (store.getSnapshot() !== text) store.set(text);
    },
    dispose,
  };
}

function LiveContentHost({
  store,
  actions,
}: {
  store: ReturnType<typeof createStore<string>>;
  actions: MarkdownActions;
}) {
  const text = useReadable(store);
  return <MarkdownView text={text} actions={actions} />;
}
