/**
 * The transcript's rows, as React.
 *
 * React owns what the reader navigates: which messages exist, where consecutive operations fold, where a run ended,
 * where a turn's file card sits, and which of those nodes survives a repaint. The *inside* of a message stays the
 * shared DOM builder's (`renderer-messages.ts`), rehosted under the row element React creates — a tool card, Markdown
 * and a diff preview are a large, security-sensitive surface and are not rewritten here.
 *
 * Two identities are load-bearing:
 *
 * - A row is keyed by its absolute source index, so appending a reply or prepending older history keeps every node
 *   that did not change — text selection and focus included.
 * - A process group inherits the key of any step it already had (`transcript-model.ts`), so loading older steps into
 *   the interval above an open fold reuses that fold: it stays open, at the same scroll position.
 *
 * Process summaries are not React children. They are a row of the same shape process rows use, copied from the last
 * step's own summary, and are repainted imperatively when a running call starts or the live thought joins the tail.
 * That is deliberate: a running call's line must change without rebuilding the fold that contains it.
 */
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { RunEnding } from '../../../../packages/protocol/run-cancellation.ts';
import { t } from '../../i18n.ts';
import { runEndingText } from '../../renderer-messages.ts';
import { useLocale } from '../i18n.ts';
import type { Message } from '../../../../packages/protocol/index.ts';
import { BuiltArticle, BuiltDetails } from './BuiltMessage.tsx';
import { Fold } from './Fold.tsx';
import type { TranscriptModel, TranscriptSegment, TranscriptStep } from './transcript-model.ts';
import { DeliverablesPanel, type DeliverableActions } from '../panels/SessionPanels.tsx';

/** One message's built view, with the pieces the transcript lifts out into process groups. */
export interface MessageFragment {
  message: Message;
  view: HTMLElement;
  thought: HTMLElement | null;
  calls: HTMLElement[];
}

type CardSegment = Extract<TranscriptSegment, { kind: 'card' }>;

/** Everything the rows draw, published by the mount adapter on each transcript rebuild. */
export interface TranscriptState {
  sessionId: string | null;
  /** Increases on every rebuild; a summary is repainted when it does, exactly as a rebuild used to replace it. */
  revision: number;
  model: TranscriptModel;
  fragments: ReadonlyMap<number, MessageFragment>;
  /** Turn-change cards for this rebuild, by the message index they follow. */
  cards: ReadonlyMap<number, HTMLElement>;
  /** The last card, drawn after the completion verdict rather than between an answer and its evidence. */
  footer: CardSegment | null;
  runPaused: boolean;
  /** The completion verdict's built block, or `null` when there is nothing to say. */
  completion: HTMLElement | null;
  /** The process key of the last group, where the live thought joins. */
  tailKey: string | null;
  /** The process key of the group React is drawing only for the live thought, when no stored group is open. */
  liveGroupKey: string | null;
}

/** The one mutable seam between the adapter's imperative helpers and the folds React owns. */
export interface GroupRegistry {
  register(key: string, group: HTMLDetailsElement | null): void;
  /** Whether the reader left this fold open: the value a fold React had to recreate starts from. */
  wasOpen(key: string): boolean | undefined;
  /** Record a decision the reader just made, so a repaint cannot lose it. */
  rememberOpen(key: string, open: boolean): void;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

/**
 * Copy the process-summary line from `source` (the last step, or a running call) onto a group's own summary.
 *
 * The group summary is the one line a folded interval shows, so it always speaks with the same icon, label and
 * preview as the row it came from. Cloning rather than moving is what lets the source stay a readable step.
 */
export function updateProcessSummary(group: Element, source?: Element | null): void {
  const summary = group.querySelector<HTMLElement>(':scope > summary');
  if (!summary) return;
  const from =
    source ??
    group.querySelector('.process-steps')?.lastElementChild?.querySelector(':scope > summary');
  if (!from) return;
  summary.className = `${from.className} process-group-summary`;
  summary.replaceChildren(...Array.from(from.childNodes, (child) => child.cloneNode(true)));
  summary.append(node('span', '', 'process-chevron'));
}

/**
 * Move the built view's children under a React-owned root and put them back when the root goes away.
 *
 * The built node is cached by message and reused, so its children must return to it on unmount: a cached view that
 * was left empty would repaint as an empty row the next time it is used.
 */
function useLegacyChildren<T extends HTMLElement = HTMLElement>(
  view: HTMLElement | null,
): RefObject<T | null> {
  const host = useRef<T>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !view) return;
    element.replaceChildren(...Array.from(view.childNodes));
    return () => {
      view.replaceChildren(...Array.from(element.childNodes));
      element.replaceChildren();
    };
  }, [view]);
  return host;
}

/** One message row: the element React owns is the row the rest of the window styles and measures. */
function MessageRow({ fragment }: { fragment: MessageFragment }): ReactNode {
  return <BuiltArticle view={fragment.view} message={fragment.message} />;
}

function stepView(step: TranscriptStep, fragment: MessageFragment): HTMLElement | null {
  if (step.kind === 'result') return fragment.view;
  if (step.kind === 'reasoning') return fragment.thought;
  return fragment.calls[step.callIndex] ?? null;
}

/** One row inside a fold: the built details element's contents, under the shell React keys for list identity. */
function TranscriptStepRow({
  step,
  fragment,
}: {
  step: TranscriptStep;
  fragment: MessageFragment;
}): ReactNode {
  const view = stepView(step, fragment);
  if (!view) return null;
  return (
    <BuiltDetails
      view={view}
      message={step.kind === 'result' ? fragment.message : undefined}
      processKey={step.key}
      callId={step.kind === 'call' ? view.dataset.callId : undefined}
    />
  );
}

/**
 * One fold. Steps are React children (so their identity survives a repaint); the summary is imperatively painted
 * from the last step, and the fold's open state is React's, keyed by the group key. `Fold` animates the height and
 * asks the adapter's registry for the reader's last decision, so a recreated fold opens where the reader left it.
 */
function ProcessGroup({
  groupKey,
  steps,
  fragments,
  revision,
  registry,
  live = false,
}: {
  groupKey: string;
  steps: readonly TranscriptStep[];
  fragments: ReadonlyMap<number, MessageFragment>;
  revision: number;
  registry: GroupRegistry;
  live?: boolean;
}): ReactNode {
  const host = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    registry.register(groupKey, host.current);
    return () => registry.register(groupKey, null);
  }, [groupKey, registry]);
  useLayoutEffect(() => {
    if (live || !host.current) return;
    // The built source summary has already handed its children to the React step row by the time this runs (child
    // layout effects commit first), so the summary is read back from the row the fold actually renders.
    updateProcessSummary(host.current);
  }, [live, revision]);
  // The live group's summary comes from the borrowed thought the adapter appends imperatively. Re-offering it on every
  // render heals the one ordering the adapter cannot cover: a group that committed before its thought was ready.
  useLayoutEffect(() => {
    if (live && host.current) updateProcessSummary(host.current);
  });
  return (
    <Fold
      detailsRef={host}
      className="process-group"
      processKey={groupKey}
      initiallyOpen={registry.wasOpen(groupKey) ?? false}
      onOpenChange={(open) => registry.rememberOpen(groupKey, open)}
      summary={null}
    >
      <div className="process-steps">
        {live
          ? null
          : steps.map((step) => {
              const fragment = fragments.get(step.index);
              return fragment ? (
                <TranscriptStepRow key={step.key} step={step} fragment={fragment} />
              ) : null;
            })}
      </div>
    </Fold>
  );
}

/**
 * A turn's file card. The card is React now (`TurnChanges.tsx`), so the adapter hands the transcript an element per
 * position whose content lives in a holder inside it; moving that holder under the React row is what leaves the
 * stylesheet, the cached card and the open previews untouched. The grouped shape keeps its built child cards whole,
 * because those are cached and reused between turns.
 */
function TurnChangeCard({ view }: { view: HTMLElement }): ReactNode {
  const host = useLegacyChildren<HTMLElement>(view);
  return <section ref={host} className={view.className} data-turn-key={view.dataset.turnKey} />;
}

function TurnChangeGroup({ view }: { view: HTMLElement }): ReactNode {
  const host = useLegacyChildren<HTMLDivElement>(view);
  return <div ref={host} className="turn-changes-group" />;
}

function TurnChangeRow({ view }: { view: HTMLElement }): ReactNode {
  return view.classList.contains('turn-changes-group') ? (
    <TurnChangeGroup view={view} />
  ) : (
    <TurnChangeCard view={view} />
  );
}

/** The completion block: a fold for the automatic verdict, a plain notice otherwise. */
function CompletionDetails({ view }: { view: HTMLElement }): ReactNode {
  return <BuiltDetails view={view} completionKey={view.dataset.completionKey} />;
}

function CompletionNotice({ view }: { view: HTMLElement }): ReactNode {
  const host = useLegacyChildren<HTMLDivElement>(view);
  return <div ref={host} className={view.className} />;
}

function CompletionRow({ view }: { view: HTMLElement }): ReactNode {
  return view.tagName === 'DETAILS' ? (
    <CompletionDetails view={view} />
  ) : (
    <CompletionNotice view={view} />
  );
}

function cardKey(segment: CardSegment, view: HTMLElement | undefined): string {
  const shape = view?.classList.contains('turn-changes-group') ? 'group' : 'single';
  return `${segment.key}:${shape}`;
}

function completionKey(view: HTMLElement): string {
  return `completion:${view.tagName}:${view.className}:${view.dataset.completionKey ?? ''}`;
}

/** The "stopped here" line, with the one action that carries on from it. */
function PausedNotice({ onContinue }: { onContinue?: () => void }): ReactNode {
  return (
    <p className="run-paused" role="status">
      {t('ui.runPaused')}
      {onContinue ? (
        <>
          {' '}
          <button type="button" className="secondary" onClick={() => onContinue()}>
            {t('ui.continueRun')}
          </button>
        </>
      ) : null}
    </p>
  );
}

function RunEndingRow({ ending }: { ending: RunEnding }): ReactNode {
  return (
    <p className="run-paused" role="status">
      {runEndingText(ending)}
    </p>
  );
}

export function Conversation({
  state,
  registry,
  onContinue,
  deliverableActions,
}: {
  state: TranscriptState;
  registry: GroupRegistry;
  onContinue?: () => void;
  deliverableActions?: DeliverableActions;
}): ReactNode {
  // Every string below comes through `t`/`runEndingText`, and both read the language at call time.
  useLocale();
  const { model, fragments, cards } = state;
  return (
    <>
      {model.segments.map((segment) => {
        if (segment.kind === 'message') {
          const fragment = fragments.get(segment.index);
          return fragment ? <MessageRow key={segment.key} fragment={fragment} /> : null;
        }
        if (segment.kind === 'group')
          return (
            <ProcessGroup
              key={segment.key}
              groupKey={segment.key}
              steps={segment.steps}
              fragments={fragments}
              revision={state.revision}
              registry={registry}
            />
          );
        if (segment.kind === 'ending')
          return <RunEndingRow key={segment.key} ending={segment.ending} />;
        if (segment.kind === 'deliverables')
          return (
            <DeliverablesPanel
              key={segment.key}
              turnKey={segment.key}
              files={segment.files}
              {...deliverableActions}
            />
          );
        const view = cards.get(segment.afterIndex);
        return view ? <TurnChangeRow key={cardKey(segment, view)} view={view} /> : null;
      })}
      {state.runPaused ? <PausedNotice onContinue={onContinue} /> : null}
      {state.completion ? (
        <CompletionRow key={completionKey(state.completion)} view={state.completion} />
      ) : null}
      {state.footer
        ? (() => {
            const view = cards.get(state.footer.afterIndex);
            return view ? <TurnChangeRow key={cardKey(state.footer, view)} view={view} /> : null;
          })()
        : null}
      {state.liveGroupKey ? (
        <ProcessGroup
          key={state.liveGroupKey}
          groupKey={state.liveGroupKey}
          steps={[]}
          fragments={fragments}
          revision={state.revision}
          registry={registry}
          live
        />
      ) : null}
    </>
  );
}
