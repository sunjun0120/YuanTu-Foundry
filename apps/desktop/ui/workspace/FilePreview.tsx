/**
 * The one file on screen, drawn as the Host answered: text, an image, a sandboxed generated page, or the reason it
 * cannot be shown. A reply with no preview is a failure, not an empty file.
 *
 * Content that is already a DOM tree — a diff built by the transcript, a markdown document — is hosted in a node
 * this component appends to, because those renderers own their own markup.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { t } from '../../i18n.ts';
import { highlightCode, languageForPath, MAX_HIGHLIGHT_LENGTH } from '../../highlight.ts';
import { renderMarkdown, type MarkdownActions } from '../../markdown.ts';
import { FILE_PREVIEW_BYTES } from '../../../../packages/protocol/rpc.ts';
import { MAX_IMAGE_BYTES } from '../../../../packages/protocol/images.ts';
import { formatBytes, fileName, type WorkspaceTab } from './workspace-model.ts';

function Host({ element }: { element: Element }): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  // Layout, not passive: the panel restores the tab's scroll in its own layout effect, which runs after this one.
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    container.replaceChildren(element);
    return () => element.remove();
  }, [element]);
  return <div ref={host} />;
}

function MarkdownHost({ text, actions }: { text: string; actions: MarkdownActions }): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, '');
    const document = renderMarkdown(body, actions);
    document.classList.add('workspace-preview-markdown');
    container.replaceChildren(document);
    return () => document.remove();
  }, [text, actions]);
  return <div ref={host} />;
}

/**
 * A highlighted source file.
 *
 * `useMemo` keys the highlighted element on the file's own text and language: snapshot or theme updates redraw the
 * panel without re-tokenizing the file. The element is a `<code>` built by the shared highlighter, never HTML.
 */
function CodeHost({ text, language }: { text: string; language: string }): ReactNode {
  const host = useRef<HTMLPreElement>(null);
  const code = useMemo(() => highlightCode(text, language), [text, language]);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    container.replaceChildren(code);
    return () => code.remove();
  }, [code]);
  return <pre ref={host} className="workspace-preview-text workspace-preview-code" />;
}

function OfficeFrame({ html, title }: { html: string; title: string }): ReactNode {
  const url = useRef<string | null>(null);
  if (url.current === null)
    url.current = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  useEffect(
    () => () => {
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
    },
    [],
  );
  return (
    <iframe
      className="workspace-preview-document"
      sandbox=""
      referrerPolicy="no-referrer"
      title={title}
      src={url.current}
    />
  );
}

function unsupported(reason: string | undefined): string {
  if (reason === 'too-large')
    return t('workspace.unsupported.too-large', { limit: formatBytes(MAX_IMAGE_BYTES) });
  if (reason === 'not-a-file') return t('workspace.unsupported.not-a-file');
  if (reason === 'binary') return t('workspace.unsupported.binary');
  return t('workspace.unsupported.other');
}

export function FilePreview({
  path,
  tab,
  actions,
}: {
  path: string;
  tab: WorkspaceTab;
  actions: MarkdownActions;
}): ReactNode {
  if (tab.changePreview) return <Host element={tab.changePreview} />;
  if (tab.reading && tab.shown === null)
    return (
      <p className="workspace-note" role="status">
        {t('workspace.previewing')}
      </p>
    );
  if (tab.error !== null || tab.shown === null)
    return (
      <p className="workspace-note">
        {t('workspace.error', { message: tab.error ?? t('workspace.unsupported.other') })}
      </p>
    );
  const file = tab.shown;
  const truncated =
    file.truncated && file.kind === 'text' ? (
      <p className="workspace-note">
        {t('workspace.shownOfTotal', {
          shown: formatBytes(FILE_PREVIEW_BYTES),
          total: formatBytes(file.bytes ?? 0),
        })}
      </p>
    ) : null;
  const content = (() => {
    if (file.kind === 'image' && file.data && file.mimeType)
      return (
        <img
          className="workspace-preview-image"
          src={`data:${file.mimeType};base64,${file.data}`}
          alt={t('workspace.imageAlt')}
        />
      );
    if (file.kind === 'html' && file.html)
      return <OfficeFrame html={file.html} title={fileName(path)} />;
    if (file.kind === 'text') {
      const text = file.text ?? '';
      if (/\.(?:md|markdown|mdown)$/i.test(path) && text)
        return <MarkdownHost text={text} actions={actions} />;
      const language = text ? languageForPath(path) : null;
      // Past the highlight budget the file stays plain text rather than guessing a language on the main thread.
      if (language && file.bytes <= MAX_HIGHLIGHT_LENGTH)
        return <CodeHost text={text} language={language} />;
      return text ? (
        <pre className="workspace-preview-text">{text}</pre>
      ) : (
        <p className="workspace-note">{t('workspace.emptyFile')}</p>
      );
    }
    return (
      <p className="workspace-note workspace-preview-unsupported">{unsupported(file.reason)}</p>
    );
  })();
  return (
    <>
      {truncated}
      {content}
    </>
  );
}
