import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Message } from '../../../../packages/protocol/index.ts';
import { MessageSlot } from '../slots.tsx';

/** Security-sensitive Markdown, tool cards and diff nodes remain isolated inside an empty ref host. */
function useBuiltParts(view: HTMLElement, details = false) {
  const body = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const content = body.current;
    const summaryHost = summary.current;
    if (!content) return;
    const heading = details ? view.querySelector<HTMLElement>(':scope > summary') : null;
    heading?.remove();
    if (heading && summaryHost) {
      summaryHost.className = heading.className;
      summaryHost.replaceChildren(...Array.from(heading.childNodes));
    }
    content.replaceChildren(...Array.from(view.childNodes));
    return () => {
      if (heading && summaryHost) heading.replaceChildren(...Array.from(summaryHost.childNodes));
      view.replaceChildren(...(heading ? [heading] : []), ...Array.from(content.childNodes));
      content.replaceChildren();
    };
  }, [view, details]);
  return { body, summary };
}

export function BuiltDetails({
  view,
  message,
  processKey,
  callId,
  completionKey,
}: {
  view: HTMLElement;
  message?: Message;
  processKey?: string;
  callId?: string;
  completionKey?: string;
}): ReactNode {
  const { body, summary } = useBuiltParts(view, true);
  return (
    <details
      className={view.className}
      data-process-key={processKey}
      data-call-id={callId}
      data-completion-key={completionKey}
    >
      <summary ref={summary} />
      <div ref={body} className="message-built-body" />
      {message?.role === 'tool' ? <MessageSlot name="tool.result.extra" message={message} /> : null}
    </details>
  );
}

export function BuiltArticle({
  view,
  message,
}: {
  view: HTMLElement;
  message: Message;
}): ReactNode {
  const { body } = useBuiltParts(view);
  return (
    <article className={view.className}>
      <div ref={body} className="message-built-body" />
      {message.role === 'user' ? (
        <div className="user-message-meta">
          <MessageSlot name="message.footer" message={message} />
          <MessageSlot name="message.actions" message={message} />
        </div>
      ) : null}
    </article>
  );
}

export function BuiltMessage({
  message,
  renderMessage,
}: {
  message: Message;
  renderMessage(message: Message): HTMLElement;
}): ReactNode {
  const view = useMemo(() => renderMessage(message), [message, renderMessage]);
  return view.tagName === 'DETAILS' ? (
    <BuiltDetails view={view} message={message} />
  ) : (
    <BuiltArticle view={view} message={message} />
  );
}

/** MCP rows own their disclosure and heading, but keep the exact safe result body and extension slots. */
export function BuiltToolResultBody({
  view,
  message,
}: {
  view: HTMLElement;
  message: Message;
}): ReactNode {
  const { body } = useBuiltParts(view, true);
  return (
    <div className="mcp-call-result">
      <div ref={body} className="message-built-body" />
      <MessageSlot name="tool.result.extra" message={message} />
    </div>
  );
}
