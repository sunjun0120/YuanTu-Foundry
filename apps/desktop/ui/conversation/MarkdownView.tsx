/**
 * A markdown body rendered incrementally from its block list.
 *
 * Only the last block of a streaming answer is still changing, so the blocks before it keep their nodes and only the
 * tail is parsed again (`markdownBlocks`). The rendered nodes are produced by the existing `renderMarkdown`, never by
 * handing model-authored HTML to the DOM.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { renderMarkdown, type MarkdownActions } from '../../markdown.ts';
import { markdownBlocks } from '../../markdown-blocks.ts';

export function MarkdownView({
  text,
  actions,
  className = 'message-content markdown',
}: {
  text: string;
  actions: MarkdownActions;
  className?: string;
}): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const blocks = useRef<{ source: string; nodes: ChildNode[] }[]>([]);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    const sources = markdownBlocks(text);
    let keep = 0;
    while (
      keep < blocks.current.length &&
      keep < sources.length &&
      blocks.current[keep]!.source === sources[keep]
    )
      keep += 1;
    for (const block of blocks.current.slice(keep)) for (const child of block.nodes) child.remove();
    blocks.current.length = keep;
    for (const source of sources.slice(keep)) {
      const nodes = Array.from(renderMarkdown(source, actions).childNodes);
      container.append(...nodes);
      blocks.current.push({ source, nodes });
    }
  }, [text, actions]);
  return <div ref={host} className={className} />;
}
