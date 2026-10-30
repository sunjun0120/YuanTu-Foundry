import type { ReactNode } from 'react';
import { hasTranslation, t } from '../../i18n.ts';
import { summarizeArgs } from '../panels/summary-model.ts';
import { BuiltToolResultBody } from './BuiltMessage.tsx';
import type { GroupRegistry, MessageFragment } from './Conversation.tsx';
import { Fold } from './Fold.tsx';
import type { TranscriptMcpCall } from './transcript-model.ts';

function CapabilityIcon(): ReactNode {
  return (
    <svg
      className="mcp-capability-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 13 6 6m-8 0 4-4m3-8 7 7m-5-9 2-2m3 5 2-2M7 11l4-4 6 6-4 4a4.2 4.2 0 0 1-6-6Z" />
    </svg>
  );
}

function CallStatus({ status }: { status: TranscriptMcpCall['status'] }): ReactNode {
  return (
    <span className="mcp-call-status" role="status" title={t(`mcp.status.${status}`)}>
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {status === 'succeeded' ? (
          <>
            <rect x="2" y="2" width="16" height="16" rx="4" />
            <path d="m5.5 10 3 3 6-6" />
          </>
        ) : status === 'failed' ? (
          <>
            <rect x="2" y="2" width="16" height="16" rx="4" />
            <path d="m7 7 6 6m0-6-6 6" />
          </>
        ) : (
          <>
            <circle cx="10" cy="10" r="8" />
            <path d={status === 'running' ? 'M10 5v5l3 2' : 'M6 10h8'} />
          </>
        )}
      </svg>
      <span className="mcp-status-label">{t(`mcp.status.${status}`)}</span>
    </span>
  );
}

function callDescription(item: TranscriptMcpCall): string {
  // Tool descriptions are not carried by the transcript. Known capabilities have localized readings;
  // other servers show their identity and the actual argument summary rather than guessed prose.
  const key = `mcp.description.${item.target.tool}`;
  if (item.target.server === null && hasTranslation(key)) return t(key);
  const server = item.target.server ?? t('summary.builtinServer');
  const args = summarizeArgs(item.target.args);
  return args ? `${server} · ${args}` : server;
}

function McpCallRow({
  item,
  result,
}: {
  item: TranscriptMcpCall;
  result?: MessageFragment;
}): ReactNode {
  const description = callDescription(item);
  return (
    <details
      className="mcp-call"
      data-call-id={item.call.id}
      data-status={item.status}
      data-process-key={item.key}
    >
      <summary className="mcp-call-summary">
        <CallStatus status={item.status} />
        <span className="mcp-call-name">
          <code translate="no" title={item.target.tool}>
            {item.target.tool}
          </code>
        </span>
        <span className="mcp-call-description" title={description}>
          {description}
        </span>
        <span className="mcp-chevron" aria-hidden="true" />
      </summary>
      <div className="mcp-call-details">
        {result ? (
          <BuiltToolResultBody view={result.view} message={result.message} />
        ) : (
          <p className="mcp-call-pending">{t(`mcp.status.${item.status}`)}</p>
        )}
        <details className="mcp-call-arguments">
          <summary>{t('mcp.arguments')}</summary>
          <pre translate="no">{JSON.stringify(item.target.args ?? {}, null, 2)}</pre>
        </details>
      </div>
    </details>
  );
}

/** MCP calls have their own surface; local process rows continue through ProcessGroup unchanged. */
export function McpCalls({
  groupKey,
  calls,
  fragments,
  registry,
}: {
  groupKey: string;
  calls: readonly TranscriptMcpCall[];
  fragments: ReadonlyMap<number, MessageFragment>;
  registry: GroupRegistry;
}): ReactNode {
  const builtin = calls.every((item) => item.target.server === null);
  const completed = calls.filter((item) => item.status === 'succeeded').length;
  const failed = calls.filter((item) => item.status === 'failed').length;
  const running = calls.some((item) => item.status === 'running');
  const interrupted = calls.some((item) => item.status === 'interrupted');
  return (
    <Fold
      className="mcp-group"
      processKey={groupKey}
      initiallyOpen={registry.wasOpen(groupKey) ?? false}
      onOpenChange={(open) => registry.rememberOpen(groupKey, open)}
      summaryClassName="mcp-group-summary"
      summary={
        <>
          <CapabilityIcon />
          <span className="mcp-group-title">{t(builtin ? 'mcp.builtinTitle' : 'mcp.title')}</span>
          <span className="mcp-group-progress" role="status">
            {t('mcp.completedCount', { completed, total: calls.length })}
            {failed
              ? ` · ${t('mcp.failedCount', { count: failed })}`
              : running
                ? ` · ${t('mcp.status.running')}`
                : interrupted
                  ? ` · ${t('mcp.status.interrupted')}`
                  : ''}
          </span>
          <span className="mcp-chevron" aria-hidden="true" />
        </>
      }
    >
      <div className="mcp-call-list">
        {calls.map((item) => (
          <McpCallRow
            key={item.key}
            item={item}
            result={item.resultIndex === null ? undefined : fragments.get(item.resultIndex)}
          />
        ))}
      </div>
    </Fold>
  );
}
