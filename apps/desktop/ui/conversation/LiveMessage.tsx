/**
 * The live bubble's content: the folded thinking and the answer being written.
 *
 * The fold is rendered here rather than rebuilt per paint, which is what keeps a reader's expansion: React keeps the
 * same `<details>` node and updates its summary and text in place, so a repaint cannot close it. The answer body is
 * the incremental `MarkdownView`.
 *
 * `#live` itself stays the static host because the transcript moves the fold into the last process group while the run
 * is live, and back again when it ends. A node React replaced would lose that identity — and the fold's open state with
 * it — so this component always renders the fold and hides it instead of dropping it.
 */
import type { ReactNode } from 'react';
import { t } from '../../i18n.ts';
import type { MarkdownActions } from '../../markdown.ts';
import { useLocale } from '../i18n.ts';
import { MarkdownView } from './MarkdownView.tsx';
import { liveBodyText, liveReasoningPreview, type LiveMessageView } from './live-model.ts';

/**
 * The fold. React owns it, so the transcript can move the same node into the last process group while the run is
 * live; a rebuilt node would lose the reader's open state with it.
 */
function ReasoningFold({ reasoning }: { reasoning: string }): ReactNode {
  return (
    <details id="live-reasoning" className="message-reasoning" hidden={reasoning === ''}>
      <summary className="process-summary process-reasoning">
        <span className="process-icon" data-kind="reasoning" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z" />
          </svg>
        </span>
        <span className="process-label">{t('ui.reasoning')}</span>
        <span className="process-preview">{liveReasoningPreview(reasoning)}</span>
      </summary>
      <pre className="reasoning-content">{reasoning}</pre>
    </details>
  );
}

export function LiveMessage({
  view,
  actions,
}: {
  view: LiveMessageView;
  actions: MarkdownActions;
}): ReactNode {
  // Every string below comes through `t`, which reads the language at render time; this subscription re-renders it.
  useLocale();
  return (
    <>
      <ReasoningFold reasoning={view.reasoning} />
      <MarkdownView text={liveBodyText(view)} actions={actions} />
    </>
  );
}
