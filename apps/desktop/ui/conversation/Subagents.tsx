/**
 * The sub-agent surfaces, as projections of `subagent-model.ts`.
 *
 * The catalog in the header answers a glance — one line per direct child, its state, what it spent and how long it
 * worked — and the page over the transcript holds what a line cannot: the child's live text, the tool it is running,
 * and the findings it reported with their evidence. The numbers in both places come from the same model functions so
 * the two readings of one child cannot disagree.
 *
 * The page is the child's *own* record, opened by asking the Host for it: the parent's transcript, cards and composer
 * step aside while the header's title becomes the way back. A child that is still running streams into the page's
 * own live line, never into the parent's buffer.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { SubAgentTranscript } from '../../../../packages/carrier/contract.ts';
import type { SubAgentView } from '../../../../packages/client/session-controller.ts';
import type { Message, SubAgentSummaryReport } from '../../../../packages/protocol/index.ts';
import { isRuntimeContext } from '../../../../packages/protocol/context.ts';
import { format, translate } from '../../i18n.ts';
import type { UiLanguage } from '../../ui-settings.ts';
import {
  subagentDotState,
  subagentFindings,
  subagentRunning,
  subagentStatusLabel,
  subagentTokenText,
  subagentWorkDuration,
} from './subagent-model.ts';

export interface SubagentPageState {
  id: string;
  childSessionId: string;
  objective: string;
  /** Which opening of this page it is; a second open of the same child starts a fresh record view. */
  nonce: number;
}

type LiveTexts = Readonly<Record<string, string>>;

function roleText(view: SubAgentView, lang: UiLanguage): string {
  const key = `subagent.role.${view.role}`;
  const text = translate(key, lang);
  return text === key ? view.role : text;
}

/** Findings, always paired with the evidence the child gave for them. */
function Findings({
  report,
  lang,
}: {
  report: SubAgentSummaryReport;
  lang: UiLanguage;
}): ReactNode {
  const reading = subagentFindings(report, lang);
  return (
    <div className="subagent-report">
      <p className="subagent-report-summary">{reading.summary}</p>
      <div className="subagent-report-heading">{reading.heading}</div>
      <ul className="subagent-findings">
        {reading.findings.map((finding, index) => (
          <li key={index}>
            <span>{finding.statement}</span>
            <span className="subagent-evidence">{finding.evidence}</span>
          </li>
        ))}
      </ul>
      {reading.unverified === null ? null : (
        <p className="subagent-unverified">{reading.unverified}</p>
      )}
      {reading.blockers === null ? null : <p className="subagent-blockers">{reading.blockers}</p>}
    </div>
  );
}

/**
 * The catalog: one row per direct child, DSH's shape — a state dot, the task, what the child is doing, and the two
 * numbers beside it.
 *
 * The numbers are computed from the model with the same `now` the ticker publishes, so a row and a card update in
 * step. Focus walks the rows with the arrow keys, which is what makes the catalog usable without a pointer.
 */
export function SubagentCatalog({
  views,
  now,
  lang,
  onOpen,
}: {
  views: readonly SubAgentView[];
  now: number;
  lang: UiLanguage;
  onOpen(view: SubAgentView): void;
}): ReactNode {
  return (
    <>
      {views.map((view) => {
        const status = subagentStatusLabel(view, lang);
        const tokens = subagentTokenText(view, lang);
        const duration = subagentWorkDuration(view, now, lang);
        const meta = `${roleText(view, lang)} · ${status}`;
        const move = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(view);
            return;
          }
          const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
          if (!keys.includes(event.key)) return;
          event.preventDefault();
          const catalog = event.currentTarget.closest('.subagent-catalog');
          if (!catalog) return;
          const rows = [...catalog.querySelectorAll<HTMLElement>('.subagent-row')];
          const at = rows.indexOf(event.currentTarget);
          const target =
            event.key === 'Home'
              ? rows[0]
              : event.key === 'End'
                ? rows[rows.length - 1]
                : rows[event.key === 'ArrowDown' ? at + 1 : at - 1];
          target?.focus();
        };
        return (
          <div
            key={view.id}
            className="subagent-row"
            data-status={view.status}
            role="treeitem"
            tabIndex={0}
            aria-label={[view.objective, meta, tokens, duration]
              .filter((value) => value !== '')
              .join(' ')}
            onClick={() => onOpen(view)}
            onKeyDown={move}
          >
            <span
              className="subagent-row-dot"
              data-state={subagentDotState(view)}
              aria-hidden="true"
            />
            <span className="subagent-row-content">
              <span className="subagent-row-label">{view.objective}</span>
              <span className="subagent-row-meta">{meta}</span>
            </span>
            <span className="subagent-row-metrics">
              <span className="subagent-row-tokens" hidden={tokens === ''}>
                {tokens}
              </span>
              <span
                className="subagent-row-duration"
                title={translate('subagent.duration.exact', lang, { duration })}
              >
                {duration}
              </span>
            </span>
          </div>
        );
      })}
    </>
  );
}

/**
 * The cards: one per child, with its findings or its text, where it worked, what it spent, and the way into its
 * record. The panel they live in is hidden in the product — the catalog and the page are the two readings a person
 * uses — but the cards are still the durable summary a restored session shows.
 */
export function SubagentCards({
  views,
  live,
  now,
  lang,
  busy,
  onOpen,
}: {
  views: readonly SubAgentView[];
  live: LiveTexts;
  now: number;
  lang: UiLanguage;
  busy: boolean;
  onOpen(view: SubAgentView): void;
}): ReactNode {
  return (
    <>
      {views.map((view) => {
        const tokenText = subagentTokenText(view, lang);
        const duration = subagentWorkDuration(view, now, lang);
        const text = Object.hasOwn(live, view.id) ? live[view.id]! : view.text;
        return (
          <article key={view.id} className="subagent-card" data-status={view.status}>
            <header className="subagent-card-header">
              <h3>
                {format(translate('subagent.cardTitle', lang), {
                  index: view.index + 1,
                  total: view.total,
                  role: roleText(view, lang),
                })}
              </h3>
              <span className="subagent-status">{subagentStatusLabel(view, lang)}</span>
            </header>
            <p className="subagent-objective">{view.objective}</p>
            {view.report ? (
              <Findings report={view.report} lang={lang} />
            ) : (
              <div className="subagent-text">{text}</div>
            )}
            {view.tool ? (
              <div className="subagent-tool">
                {view.toolArgs
                  ? format(translate('subagent.runningToolWithArgs', lang), {
                      tool: view.tool,
                      args: view.toolArgs,
                    })
                  : format(translate('subagent.runningTool', lang), { tool: view.tool })}
              </div>
            ) : null}
            {view.error ? <div className="subagent-error">{view.error}</div> : null}
            {view.workspace ? (
              <div
                className="subagent-workspace"
                data-kind={view.workspace.kind}
                data-state={view.workspace.state}
              >
                {view.workspace.kind === 'worktree'
                  ? format(translate('subagent.workspace.isolated', lang), {
                      path: view.workspace.executionRoot,
                    })
                  : translate('subagent.workspace.shared', lang)}
                {view.workspace.problem ? (
                  <span className="subagent-workspace-problem">
                    {format(translate('subagent.workspace.problem', lang), {
                      reason: view.workspace.problem,
                    })}
                  </span>
                ) : null}
                {view.workspace.dependencyWarning ? (
                  <span className="subagent-workspace-problem">
                    {translate('subagent.workspace.dependenciesMissing', lang)}
                  </span>
                ) : null}
                {view.workspace.result ? (
                  <span className="subagent-workspace-result">
                    {format(
                      translate(`subagent.workspace.result.${view.workspace.result.status}`, lang),
                      { count: view.workspace.result.paths.length },
                    )}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="subagent-meta">
              <span className="subagent-meta-counts">
                {format(translate('subagent.meta', lang), {
                  rounds: view.rounds,
                  tools: view.toolCalls,
                })}
              </span>
              <span className="subagent-meta-tokens" hidden={tokenText === ''}>
                {tokenText === '' ? '' : ` · ${tokenText}`}
              </span>
              <span className="subagent-meta-duration">{` · ${duration}`}</span>
            </div>
            <div className="subagent-export-progress" hidden={!view.workspaceProgress}>
              {view.workspaceProgress
                ? format(translate('subagent.workspace.exporting', lang), {
                    processed: view.workspaceProgress.processed,
                    total: view.workspaceProgress.total,
                  })
                : ''}
            </div>
            {view.childSessionId ? (
              <button
                type="button"
                className="subagent-view"
                disabled={busy}
                onClick={() => onOpen(view)}
              >
                {translate('subagent.viewTranscript', lang)}
              </button>
            ) : null}
          </article>
        );
      })}
    </>
  );
}

/** One legacy message node, kept as a DOM island so the shared renderer stays the one account of a message. */
function MessageIsland({
  content,
  renderMessage,
}: {
  content: string;
  renderMessage(message: Message): HTMLElement;
}): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    container.replaceChildren(renderMessage({ role: 'assistant', content, toolCalls: [] }));
    return () => container.replaceChildren();
  }, [content, renderMessage]);
  return <div ref={host} />;
}

/**
 * The process half of a child's record.
 *
 * The messages are the shared renderer's nodes, so they stay a DOM island the way a plan does. The live tool is its
 * own node appended after them: it changes while the child works, and rebuilding the history for it would close the
 * tool results a reader had opened.
 */
function ProcessBody({
  loaded,
  open,
  processMessages,
  emptyText,
  tool,
  toolArgs,
  lang,
  renderMessage,
}: {
  loaded: boolean;
  open: boolean;
  processMessages: readonly Message[];
  emptyText: string;
  tool: string | undefined;
  toolArgs: string | undefined;
  lang: UiLanguage;
  renderMessage(message: Message): HTMLElement;
}): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const toolNode = useRef<HTMLDetailsElement | null>(null);
  const toolLabel = translate('ui.toolCall', lang);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    const nodes = open && loaded ? processMessages.map(renderMessage) : [];
    if (toolNode.current) nodes.push(toolNode.current);
    if (open && loaded && processMessages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'subagent-transcript-empty';
      empty.textContent = emptyText;
      nodes.push(empty);
    }
    container.replaceChildren(...nodes);
    return () => container.replaceChildren();
  }, [loaded, open, processMessages, emptyText, renderMessage]);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    if (!tool) {
      toolNode.current?.remove();
      toolNode.current = null;
      return;
    }
    let node = toolNode.current;
    if (!node) {
      node = document.createElement('details');
      node.className = 'tool-call subagent-live-tool';
      toolNode.current = node;
    }
    const summary = document.createElement('summary');
    summary.className = 'process-summary process-tool';
    const icon = document.createElement('span');
    icon.className = 'process-icon';
    icon.textContent = '✧';
    const label = document.createElement('span');
    label.className = 'process-label';
    label.textContent = toolLabel;
    const preview = document.createElement('span');
    preview.className = 'process-preview';
    preview.textContent = `· ${tool}`;
    summary.replaceChildren(icon, label, preview);
    const args = document.createElement('pre');
    args.textContent = toolArgs ?? tool;
    node.replaceChildren(summary, args);
    if (node.parentElement !== container) container.append(node);
  }, [tool, toolArgs, toolLabel]);
  return (
    <div ref={host} id="subagent-transcript-messages" className="subagent-transcript-messages" />
  );
}

/**
 * Keep following the newest line while the reader is at the bottom of the record.
 *
 * The follow flag is updated by scroll events rather than measured after a commit: by then the new text is already in
 * the layout, and the distance to the bottom would have grown by exactly the amount that should still count as
 * "following".
 */
function ScrollKeeper({
  conversation,
  signal,
}: {
  conversation: HTMLElement | null;
  signal: string;
}): ReactNode {
  const follow = useRef(false);
  useEffect(() => {
    const element = conversation;
    if (!element) return;
    const update = (): void => {
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    return () => element.removeEventListener('scroll', update);
  }, [conversation]);
  useLayoutEffect(() => {
    const element = conversation;
    if (!element || signal === '') return;
    if (follow.current) element.scrollTop = element.scrollHeight;
  }, [conversation, signal]);
  return null;
}

/**
 * One child's record as a page, with the process folded and the final result read from the stored tail.
 *
 * The page is keyed by the opening, not only by the child: opening a second child — or the same one again — starts a
 * fresh record view with its process folded, while a polling snapshot leaves the reader's expansion state alone.
 */
export function SubagentPage({
  page,
  views,
  transcript,
  live,
  busy,
  lang,
  conversation,
  renderMessage,
  onWorkspaceAction,
}: {
  page: SubagentPageState;
  views: readonly SubAgentView[];
  transcript: SubAgentTranscript | null;
  live: LiveTexts;
  busy: boolean;
  lang: UiLanguage;
  conversation: HTMLElement | null;
  renderMessage(message: Message): HTMLElement;
  onWorkspaceAction(action: 'archive' | 'remove' | 'restore'): Promise<unknown>;
}): ReactNode {
  const [processOpen, setProcessOpen] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set<string>());
  const view = views.find((entry) => entry.id === page.id);
  const current =
    transcript !== null && transcript.childSessionId === page.childSessionId ? transcript : null;
  const loaded = current !== null;
  const status = view?.status ?? current?.status;
  const messages = useMemo(() => {
    if (!current) return [];
    // Match the parent transcript: snapshots stay in the session, but are not conversation bubbles.
    return current.messages.filter(
      (message) => !(message.role === 'user' && isRuntimeContext(message.content)),
    );
  }, [current]);
  const report = view?.report ?? current?.report;
  // A tool request, reasoning-only message or interrupted answer is a process record, not a final reply. Read the
  // final prose from the stored tail so a bounded live preview cannot clip it.
  const finalMessage = useMemo(
    () =>
      loaded && status === 'completed' && !report
        ? [...messages]
            .reverse()
            .find(
              (message) =>
                message.role === 'assistant' &&
                message.content.trim() &&
                !message.toolCalls?.length &&
                !message.interrupted,
            )
        : undefined,
    [loaded, messages, status, report],
  );
  const processMessages = useMemo(
    () =>
      messages.flatMap((message): Message[] => {
        if (message !== finalMessage) return [message];
        // Only the answer moves to the result section; its reasoning still belongs to the process.
        return message.role === 'assistant' && message.reasoning
          ? [{ ...message, content: '' }]
          : [];
      }),
    [messages, finalMessage],
  );
  const truncated = current?.truncated === true;
  const noteText = loaded
    ? translate(truncated ? 'subagent.transcriptTruncated' : 'subagent.transcriptNote', lang)
    : translate('subagent.transcriptLoading', lang);
  const processTitle = loaded
    ? translate(truncated ? 'subagent.processRecentCount' : 'subagent.processCount', lang, {
        count: processMessages.length,
      })
    : translate('subagent.process', lang);
  const resultTitle = translate(
    status === 'running' ? 'subagent.liveProgress' : 'subagent.finalResult',
    lang,
  );
  const liveText =
    status === 'running' || (view !== undefined && subagentRunning(view))
      ? (live[page.id] ?? view?.text ?? '')
      : '';
  // Opening a record must not scroll it: the page starts at its beginning. Following the newest line is for content
  // that arrives while it is already on screen — the live answer, or the process history the reader expanded.
  const signal = `${liveText.length}:${processOpen ? processMessages.length : 0}`;
  const workspace = view?.workspace;
  const workspaceActions =
    view !== undefined && workspace?.kind === 'worktree' && view.status !== 'running'
      ? workspace.state === 'ready'
        ? (['archive'] as const)
        : workspace.state === 'archived'
          ? (['remove', 'restore'] as const)
          : ['removed', 'blocked'].includes(workspace.state)
            ? (['restore'] as const)
            : ([] as const)
      : ([] as const);
  const runWorkspace = (action: 'archive' | 'remove' | 'restore'): void => {
    if (pending.has(action)) return;
    if (action === 'remove' && !window.confirm(translate('subagent.workspace.removeConfirm', lang)))
      return;
    setPending(new Set(pending).add(action));
    void (async () => {
      try {
        await onWorkspaceAction(action);
      } catch {
        // The invoker owns error presentation, including a rejected IPC call.
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(action);
          return next;
        });
      }
    })();
  };
  return (
    <>
      <details
        id="subagent-transcript-process"
        className="subagent-process"
        open={processOpen}
        onToggle={(event) => setProcessOpen(event.currentTarget.open)}
      >
        <summary id="subagent-transcript-process-title">{processTitle}</summary>
        <p id="subagent-transcript-note" className="subagent-transcript-note">
          {noteText}
        </p>
        <ProcessBody
          key={lang}
          loaded={loaded}
          open={processOpen}
          processMessages={processMessages}
          emptyText={translate('subagent.transcriptEmpty', lang)}
          tool={view?.tool}
          toolArgs={view?.toolArgs}
          lang={lang}
          renderMessage={renderMessage}
        />
      </details>
      <section id="subagent-transcript-result" className="subagent-result">
        <h2 id="subagent-transcript-result-title">{resultTitle}</h2>
        <div id="subagent-transcript-result-body">
          {loaded ? (
            report && status !== 'running' ? (
              <Findings report={report} lang={lang} />
            ) : finalMessage ? (
              <MessageIsland
                key={lang}
                content={finalMessage.content}
                renderMessage={renderMessage}
              />
            ) : (
              <p className="subagent-result-empty">
                {view?.error ??
                  current?.error ??
                  translate(
                    status === 'running' ? 'subagent.finalPending' : 'subagent.finalEmpty',
                    lang,
                  )}
              </p>
            )
          ) : (
            <p className="subagent-result-empty">{translate('subagent.transcriptLoading', lang)}</p>
          )}
          {view !== undefined && workspace?.kind === 'worktree' && view.status !== 'running' ? (
            <div className="subagent-workspace-actions">
              {workspaceActions.map((action) => (
                <button
                  key={action}
                  type="button"
                  className="secondary"
                  data-workspace-action={action}
                  disabled={busy || pending.has(action)}
                  onClick={() => runWorkspace(action)}
                >
                  {translate(`subagent.workspace.action.${action}`, lang)}
                </button>
              ))}
            </div>
          ) : null}
          {liveText === '' ? null : (
            <div className="message assistant subagent-live">
              <div className="message-content">{liveText}</div>
            </div>
          )}
        </div>
      </section>
      <ScrollKeeper conversation={conversation} signal={signal} />
    </>
  );
}
