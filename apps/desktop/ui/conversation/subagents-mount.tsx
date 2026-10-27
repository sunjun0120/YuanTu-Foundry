/**
 * Mount the sub-agent surfaces and answer the renderer's `update`/`delta` calls.
 *
 * The adapter keeps `setupSubAgents`'s two-call shape (`update`, `delta`) plus the teardown React needs, so
 * `renderer.ts` changes only the import and the dispose. State that belongs to the *interaction* rather than to the
 * snapshot — the open catalog, the page being read, the scroll position to return to — lives here; the views and the
 * live slices live in the store so the three React regions can draw them.
 *
 * The catalog and cards are React; the header's trigger/popover and the page container are still the product's own
 * elements, which is why opening and closing them stays here. Every word still goes through the dictionary.
 */
import type { ReactNode } from 'react';
import type {
  CarrierCommand,
  CarrierSnapshot,
  SubAgentTranscript,
} from '../../../../packages/carrier/contract.ts';
import type {
  SubAgentDelta,
  SubAgentView,
} from '../../../../packages/client/session-controller.ts';
import type { Message } from '../../../../packages/protocol/index.ts';
import { isRuntimeContext } from '../../../../packages/protocol/context.ts';
import { locale, onLocaleChange, translate } from '../../i18n.ts';
import { useReadable } from '../context.tsx';
import { useLocale } from '../i18n.ts';
import { registerView } from '../views.tsx';
import { createStore, type ReadableStore } from '../stores.ts';
import {
  SubagentCards,
  SubagentCatalog,
  SubagentPage,
  type SubagentPageState,
} from './Subagents.tsx';
import { subagentRunning } from './subagent-model.ts';

export interface SubagentsState {
  views: readonly SubAgentView[];
  live: Readonly<Record<string, string>>;
  /** The ticker's clock: every duration in the two surfaces is read against it. */
  now: number;
  page: SubagentPageState | null;
  transcript: SubAgentTranscript | null;
  busy: boolean;
}

export interface SubagentsHandle {
  update(subagents: readonly SubAgentView[]): void;
  delta(delta: SubAgentDelta): void;
  dispose(): void;
}

export interface SubagentsMountOptions {
  getState(): CarrierSnapshot | null;
  send(command: CarrierCommand): void | Promise<unknown>;
  renderMessage(message: Message): HTMLElement;
}

function CatalogHost({
  store,
  onOpen,
}: {
  store: ReadableStore<SubagentsState>;
  onOpen(view: SubAgentView): void;
}): ReactNode {
  const state = useReadable(store);
  const lang = useLocale();
  return <SubagentCatalog views={state.views} now={state.now} lang={lang} onOpen={onOpen} />;
}

function CardsHost({
  store,
  onOpen,
}: {
  store: ReadableStore<SubagentsState>;
  onOpen(view: SubAgentView): void;
}): ReactNode {
  const state = useReadable(store);
  const lang = useLocale();
  return (
    <SubagentCards
      views={state.views}
      live={state.live}
      now={state.now}
      lang={lang}
      busy={state.busy}
      onOpen={onOpen}
    />
  );
}

function PageHost({
  store,
  conversation,
  renderMessage,
  onWorkspaceAction,
}: {
  store: ReadableStore<SubagentsState>;
  conversation: HTMLElement;
  renderMessage(message: Message): HTMLElement;
  onWorkspaceAction(action: 'archive' | 'remove' | 'restore'): Promise<unknown>;
}): ReactNode {
  const state = useReadable(store);
  const lang = useLocale();
  const page = state.page;
  if (!page) return null;
  return (
    <SubagentPage
      key={`${page.id}:${page.nonce}`}
      page={page}
      views={state.views}
      transcript={state.transcript}
      live={state.live}
      busy={state.busy}
      lang={lang}
      conversation={conversation}
      renderMessage={renderMessage}
      onWorkspaceAction={onWorkspaceAction}
    />
  );
}

export function mountSubagents(deps: SubagentsMountOptions): SubagentsHandle {
  function required<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing element: ${id}`);
    return value as T;
  }
  const conversation = required('conversation');
  const viewer = required('subagent-transcript');
  const crumbChild = required('subagent-transcript-title');
  const crumbSep = required('chat-breadcrumb-sep');
  const chatTitle = required('chat-title');
  const trigger = required<HTMLButtonElement>('open-subagents');
  const triggerLabel = required('subagents-label');
  const triggerPulse = required('subagents-pulse');
  const popover = required('subagents-popover');
  const catalog = required('subagent-catalog');
  const anchor = document.querySelector<HTMLElement>('.subagent-anchor');
  if (!anchor) throw new Error('Missing element: .subagent-anchor');
  const store = createStore<SubagentsState>({
    views: [],
    live: {},
    now: Date.now(),
    page: null,
    transcript: null,
    busy: false,
  });
  /** The children the last snapshot carried, which the imperative chrome and the delta patches read. */
  let views: SubAgentView[] = [];
  /**
   * The child whose record is on screen, or `null` while the parent's conversation is. The record itself arrives on
   * the snapshot, read from the child's own session, so this holds only which child the page belongs to.
   */
  let page: SubagentPageState | null = null;
  /** The session the open page belongs to, so switching sessions cannot leave one behind. */
  let pageSessionId = '';
  /** Where the conversation was scrolled to before a child's page took the viewport. */
  let pageScroll = 0;
  let openNonce = 0;
  let storedAssistantCount = -1;
  let transcript: SubAgentTranscript | null = null;
  let key = '';
  let ticker: ReturnType<typeof setInterval> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** Live text per child, fed by the delta channel; one buffer per id, never shared between parent and child. */
  const live = new Map<string, string>();

  const liveTexts = (): Readonly<Record<string, string>> => Object.fromEntries(live);

  function closeCatalog(): void {
    clearTimeout(closeTimer);
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  function openCatalog(): void {
    if (!views.length) return;
    clearTimeout(closeTimer);
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }
  /**
   * The trigger's own copy and the catalog's accessible name.
   *
   * They are written here rather than in React because the trigger and popover are the product's elements: making
   * them React-owned would mean duplicating their ids in the page. Every string still comes from the dictionary.
   */
  function paintCatalogChrome(): void {
    trigger.hidden = views.length === 0;
    catalog.setAttribute('aria-label', translate('subagent.catalogLabel', locale()));
    if (!views.length) {
      closeCatalog();
      return;
    }
    const count = views.length;
    const running = views.filter(subagentRunning).length;
    const labelKey = count === 1 ? 'subagent.catalog.one' : 'subagent.catalog.other';
    const runningKey =
      running === 1 ? 'subagent.catalog.running.one' : 'subagent.catalog.running.other';
    triggerLabel.textContent = translate(labelKey, locale(), { count });
    trigger.setAttribute(
      'aria-label',
      running > 0
        ? translate(runningKey, locale(), { count: running })
        : translate(labelKey, locale(), { count }),
    );
    triggerPulse.hidden = running === 0;
  }
  /** The header's back control and the page container: the only parts of this view React does not own. */
  function syncPageChrome(): void {
    const open = page !== null;
    viewer.setAttribute('aria-label', translate('subagent.pageLabel', locale()));
    document.body.dataset.subagentPage = open ? 'open' : '';
    viewer.hidden = !open;
    crumbSep.hidden = !open;
    crumbChild.hidden = !open;
    if (!open) {
      chatTitle.classList.remove('chat-title-back');
      chatTitle.removeAttribute('role');
      chatTitle.removeAttribute('tabindex');
      chatTitle.removeAttribute('aria-label');
      return;
    }
    if (!page) return;
    crumbChild.textContent = page.objective;
    // The title keeps being the session's name; it becomes a control only while it has somewhere to go back to.
    chatTitle.classList.add('chat-title-back');
    chatTitle.setAttribute('role', 'button');
    chatTitle.tabIndex = 0;
    chatTitle.setAttribute(
      'aria-label',
      translate('subagent.back', locale(), { title: chatTitle.textContent ?? '' }),
    );
  }
  /**
   * A clock only runs while something is working. A finished child's time is frozen in its log, so a timer that kept
   * repainting would spend a wake-up a second to redraw the same digits.
   */
  function syncTicker(): void {
    const working = views.some(subagentRunning);
    if (working && ticker === undefined)
      ticker = setInterval(() => {
        if (disposed) return;
        store.set({ ...store.getSnapshot(), now: Date.now() });
      }, 1_000);
    else if (!working && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }
  /**
   * Open one child's own record as the page.
   *
   * The page is defined by which child it names, not by a stack of views: opening a second child while the first is
   * on screen is the same call. A new opening resets the record's folded process, which the page's key carries.
   */
  function openChild(view: SubAgentView): void {
    if (disposed || !view.childSessionId) return;
    if (page === null) pageScroll = conversation.scrollTop;
    page = {
      id: view.id,
      childSessionId: view.childSessionId,
      objective: view.objective,
      nonce: ++openNonce,
    };
    storedAssistantCount = -1;
    store.set({ ...store.getSnapshot(), page });
    void deps.send({
      type: 'subagentTranscript',
      subagentId: view.id,
      childSessionId: view.childSessionId,
    });
    closeCatalog();
    syncPageChrome();
    // A record is read from its beginning, and the conversation underneath keeps its own place for the return.
    conversation.scrollTop = 0;
  }
  /** Back to the conversation that delegated the work, at the position it was left at. */
  function leaveChild(): void {
    if (!page) return;
    page = null;
    storedAssistantCount = -1;
    store.set({ ...store.getSnapshot(), page });
    void deps.send({ type: 'closeSubagentTranscript' });
    syncPageChrome();
    conversation.scrollTop = pageScroll;
  }
  function workspaceAction(action: 'archive' | 'remove' | 'restore'): Promise<unknown> {
    const target = page;
    if (!target) return Promise.resolve();
    return Promise.resolve(
      deps.send({
        type: 'subagentWorkspace',
        subagentId: target.id,
        childSessionId: target.childSessionId,
        action,
      }),
    );
  }

  const onCancelClose = (): void => clearTimeout(closeTimer);
  const onScheduleClose = (): void => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeCatalog, 180);
  };
  const onDocumentClick = (event: MouseEvent): void => {
    if (popover.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (trigger.contains(target) || popover.contains(target)) return;
    closeCatalog();
  };
  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || popover.hidden) return;
    closeCatalog();
    trigger.focus();
    event.stopPropagation();
  };
  const onTitleClick = (): void => {
    if (page) leaveChild();
  };
  const onTitleKeydown = (event: KeyboardEvent): void => {
    if (!page) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    leaveChild();
  };
  anchor.addEventListener('pointerenter', openCatalog);
  anchor.addEventListener('pointerleave', onScheduleClose);
  popover.addEventListener('pointerenter', onCancelClose);
  trigger.addEventListener('click', openCatalog);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
  chatTitle.addEventListener('click', onTitleClick);
  chatTitle.addEventListener('keydown', onTitleKeydown);
  const stopLocale = onLocaleChange(() => {
    if (disposed) return;
    paintCatalogChrome();
    syncPageChrome();
  });

  const disposeRegions = [
    registerView('subagents-catalog', <CatalogHost store={store} onOpen={openChild} />),
    registerView('subagents-list', <CardsHost store={store} onOpen={openChild} />),
    registerView(
      'subagents-page',
      <PageHost
        store={store}
        conversation={conversation}
        renderMessage={deps.renderMessage}
        onWorkspaceAction={workspaceAction}
      />,
    ),
  ];

  paintCatalogChrome();
  syncPageChrome();

  return {
    update(subagents) {
      if (disposed) return;
      views = [...subagents];
      const session = deps.getState()?.session;
      const busy = Boolean(session?.running || session?.loading);
      const sessionId = session?.sessionId ?? '';
      if (pageSessionId !== sessionId) {
        pageSessionId = sessionId;
        page = null;
        storedAssistantCount = -1;
      }
      const nextTranscript = deps.getState()?.subagentTranscript ?? null;
      let liveChanged = false;
      if (!views.length) {
        if (live.size) {
          live.clear();
          liveChanged = true;
        }
      } else {
        for (const id of [...live.keys()])
          if (!views.some((view) => view.id === id)) {
            live.delete(id);
            liveChanged = true;
          }
      }
      // A new assistant message means the live slice is now part of the stored record; keeping it would print the
      // final answer twice. Only the page's own buffer is cleared, because only its record has a transcript here.
      if (page && nextTranscript && nextTranscript.childSessionId === page.childSessionId) {
        const assistantCount = nextTranscript.messages.filter(
          (message) =>
            !(message.role === 'user' && isRuntimeContext(message.content)) &&
            message.role === 'assistant',
        ).length;
        if (storedAssistantCount >= 0 && assistantCount > storedAssistantCount) {
          live.set(page.id, '');
          liveChanged = true;
        }
        storedAssistantCount = assistantCount;
      }
      const nextKey = JSON.stringify([
        views.map((view) => [
          view.id,
          view.role,
          view.objective,
          view.status,
          view.childSessionId,
          view.tool ?? '',
          view.toolArgs ?? '',
          view.rounds,
          view.toolCalls,
          view.error ?? '',
          view.durationMs ?? null,
          view.runningSince ?? null,
          view.usage ?? null,
          view.workspaceProgress
            ? `${String(view.workspaceProgress.processed)}/${String(view.workspaceProgress.total)}`
            : '',
          view.report ?? null,
          view.workspace ?? null,
          // The full text only enters the key when it is the stored report rather than a live stream: keying on
          // streamed text would rebuild the list on every token.
          view.status === 'running' ? '' : view.text,
        ]),
        busy,
        page ? [page.id, page.childSessionId, page.objective, page.nonce] : null,
      ]);
      const transcriptChanged = nextTranscript !== transcript;
      transcript = nextTranscript;
      if (nextKey !== key || transcriptChanged || liveChanged) {
        key = nextKey;
        store.set({
          views,
          live: liveTexts(),
          now: Date.now(),
          page,
          transcript: nextTranscript,
          busy,
        });
      }
      paintCatalogChrome();
      syncPageChrome();
      syncTicker();
    },
    delta(delta) {
      if (disposed) return;
      const state = store.getSnapshot();
      let changed = false;
      if (delta.text !== undefined) {
        live.set(delta.id, (live.get(delta.id) ?? '') + delta.text);
        changed = true;
      }
      if (delta.workspaceProgress) {
        const view = views.find((entry) => entry.id === delta.id);
        if (view) {
          view.workspaceProgress = delta.workspaceProgress;
          changed = true;
        }
      }
      if (delta.durationMs === undefined && delta.runningSince === undefined && !delta.usage) {
        if (changed) store.set({ ...state, views, live: liveTexts(), now: Date.now() });
        return;
      }
      const view = views.find((entry) => entry.id === delta.id);
      if (view) {
        // The view is patched in place so the reading on screen is right now; the next snapshot carries the same
        // numbers from the controller, which is what keeps this a repaint rather than a second tally.
        if (delta.durationMs !== undefined) view.durationMs = delta.durationMs;
        if (delta.runningSince !== undefined) view.runningSince = delta.runningSince;
        if (delta.usage) view.usage = delta.usage;
        changed = true;
      }
      if (changed) store.set({ ...state, views, live: liveTexts(), now: Date.now() });
      syncTicker();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopLocale();
      clearInterval(ticker);
      clearTimeout(closeTimer);
      anchor.removeEventListener('pointerenter', openCatalog);
      anchor.removeEventListener('pointerleave', onScheduleClose);
      popover.removeEventListener('pointerenter', onCancelClose);
      trigger.removeEventListener('click', openCatalog);
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onDocumentKeydown);
      chatTitle.removeEventListener('click', onTitleClick);
      chatTitle.removeEventListener('keydown', onTitleKeydown);
      for (const dispose of disposeRegions) dispose();
      page = null;
      syncPageChrome();
    },
  };
}
