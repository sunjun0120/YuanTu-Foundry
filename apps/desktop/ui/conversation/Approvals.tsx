/**
 * The approval cards under the transcript, as a projection of `approval-model.ts`.
 *
 * A card leads with what the call will do, to what, and why it needs a yes; the Host's own description and the raw
 * arguments stay folded underneath. A command offers "allow for this session" because the same call repeats; a diff
 * does not.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Approval } from '../../../../packages/protocol/index.ts';
import { approvalSummary } from '../../approval-view.ts';
import { diffView } from '../../diff-view.ts';
import { format, t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import { approvalDecisions, type ApprovalEntry } from './approval-model.ts';

function DiffHost({ approval }: { approval: Approval }): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container || !approval.change) return;
    const view = diffView(approval.change, true);
    container.replaceChildren(view);
    return () => view.remove();
  }, [approval.change]);
  return <div ref={host} />;
}

export function ApprovalCard({
  entry,
  busy,
  onDecision,
}: {
  entry: ApprovalEntry;
  busy: boolean;
  onDecision(id: string, allow: boolean, remember: boolean): void;
}): ReactNode {
  useLocale();
  const { approval } = entry;
  const summary = approvalSummary(approval);
  const decisions = approvalDecisions(approval.kind);
  return (
    <section className="approval">
      <div className="approval-label">{t('ui.approvalRequired')}</div>
      <h2>{summary.title}</h2>
      <p className="approval-why">{summary.why}</p>
      {entry.count > 1 ? (
        <p className="approval-meta">
          {format(t('approval.identicalCount'), { count: String(entry.count) })}
        </p>
      ) : null}
      {summary.subject ? <pre className="approval-subject">{summary.subject}</pre> : null}
      {summary.directory ? (
        <p className="approval-meta">
          {format(t('approval.directory'), { directory: summary.directory })}
        </p>
      ) : null}
      {summary.boundary ? <p className="approval-meta">{summary.boundary}</p> : null}
      {summary.projectConfig ? (
        <p className="approval-meta approval-config">{summary.projectConfig}</p>
      ) : null}
      {approval.subagent ? (
        <p className="subagent-badge">
          {format(t('subagent.attribution'), {
            objective: approval.subagent.objective.slice(0, 120),
          })}
        </p>
      ) : null}
      {approval.change ? <DiffHost approval={approval} /> : null}
      <details className="approval-raw" open={!approval.change && !summary.subject}>
        <summary>{t('approval.raw')}</summary>
        <p>{approval.description}</p>
        <pre>{JSON.stringify(approval.toolCall.arguments, null, 2)}</pre>
      </details>
      <div className="approval-actions">
        {decisions.map((decision) => {
          const label = t(
            decision.remember
              ? 'approval.allowSession'
              : decision.allow
                ? 'approval.allow'
                : 'approval.deny',
          );
          return (
            <button
              key={`${decision.allow}:${decision.remember}`}
              type="button"
              className={decision.remember || !decision.allow ? 'secondary' : 'primary'}
              disabled={busy}
              title={decision.remember ? t('approval.allowSessionNote') : undefined}
              aria-label={decision.remember ? t('approval.allowSessionNote') : undefined}
              onClick={() => onDecision(entry.id, decision.allow, decision.remember)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
