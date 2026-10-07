import type { SubAgentDelta, SubAgentView } from '../../packages/client/session-controller.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { Message, SubAgentSummaryReport } from '../../packages/protocol/index.ts';
import { isRuntimeContext } from '../../packages/protocol/context.ts';
import { locale, t, format } from './i18n.ts';
import { formatTokens } from './token-format.ts';

/**
 * The sub-agents a session delegated to, in the two readings a person uses them for.
 *
 * A parent run can delegate several tasks at once, and each child then works for minutes with no visible
 * trace in the parent transcript — the only durable record is the report that lands in the `delegate_task`
 * tool result. Two surfaces cover that, and they answer different questions on purpose:
 *
 * - the **catalog** in the header (DSH's): one line per direct child, with its state, what it has spent and
 *   how long it has worked. This is the glance — "are they still going, and is the expensive one the one I
 *   think it is" — and it is also how a child's own record is opened.
 * - the **panel** over the transcript: the detail a line cannot hold, which is the child's live text, the
 *   tool it is running, and the findings with their evidence.
 *
 * Both are painted from one `SubAgentView` list, so a number cannot differ between them: the tokens and the
 * work time come from the child's own session, arrive on the delta channel while it runs, and are formatted
 * by one pair of functions here.
 */
export function setupSubAgents(
  getState: () => CarrierSnapshot | null,
  send: (command: CarrierCommand) => void,
  renderMessage: (message: Message) => HTMLElement,
) {
  function required<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing element: ${id}`);
    return value as T;
  }
  const panel = required('subagents-panel');
  const list = required('subagent-list');
  const viewer = required('subagent-transcript');
  const conversation = required('conversation');
  const crumbChild = required('subagent-transcript-title');
  const crumbSep = required('chat-breadcrumb-sep');
  const chatTitle = required('chat-title');
  const note = required('subagent-transcript-note');
  const body = required('subagent-transcript-messages');
  const liveMessage = document.createElement('div');
  liveMessage.className = 'message assistant subagent-live';
  const liveContent = document.createElement('div');
  liveContent.className = 'message-content';
  liveMessage.append(liveContent);
  const liveTool = document.createElement('details');
  liveTool.className = 'tool-call subagent-live-tool';
  const liveToolSummary = document.createElement('summary');
  liveToolSummary.className = 'process-summary process-tool';
  const liveToolArgs = document.createElement('pre');
  liveTool.append(liveToolSummary, liveToolArgs);
  const trigger = required<HTMLButtonElement>('open-subagents');
  const anchor = document.querySelector<HTMLElement>('.subagent-anchor')!;
  const triggerLabel = required('subagents-label');
  const triggerPulse = required('subagents-pulse');
  const popover = required('subagents-popover');
  const catalog = required('subagent-catalog');
  let key = '';
  let viewerKey = '';
  let catalogKey = '';
  /**
   * The child whose record is on screen, or `null` while the parent's conversation is.
   *
   * The record itself is not kept here — it arrives on the snapshot, read from the child's own session — so
   * what this holds is only *which* child the page belongs to and the name to show beside the title.
   */
  let page: { id: string; childSessionId: string; objective: string } | null = null;
  /** The session the open page belongs to, so switching sessions cannot leave one behind. */
  let pageSessionId = '';
  /** Where the conversation was scrolled to before a child's page took the viewport. */
  let pageScroll = 0;
  let storedAssistantCount = 0;
  /** The children the last snapshot carried, which every painter here reads. */
  let views: readonly SubAgentView[] = [];
  /** The token and duration cells of each catalog row, so a tick repaints text and not the list. */
  const rowCells = new Map<
    string,
    { row: HTMLElement; tokens: HTMLElement; duration: HTMLElement }
  >();
  /** The same two cells on each detail card, which tick with the catalog so the two never disagree. */
  const cardCells = new Map<string, { tokens: HTMLElement; duration: HTMLElement }>();
  let ticker: ReturnType<typeof setInterval> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Live text per card, fed by the delta channel. The snapshot also accumulates it, but a delta must
   * not force a re-render: one child can stream for as long as it runs.
   */
  const live = new Map<string, string>();
  const texts = new Map<string, HTMLElement>();

  function paint(id: string): void {
    const target = texts.get(id);
    if (target) target.textContent = live.get(id) ?? '';
  }
  function label(view: SubAgentView): string {
    const key = `subagent.status.${view.status}`;
    const text = t(key);
    // A missing key renders as the raw key, which is how a UI regression reaches the user unseen;
    // an unknown Host status falls back to the status string instead.
    return text === key ? view.status : text;
  }
  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = '',
    className = '',
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  }
  /** Whether a child is working right now, which is what makes its own clock tick. */
  function running(view: SubAgentView): boolean {
    return view.runningSince !== undefined && view.runningSince !== null;
  }
  /**
   * A child's work time: the turns it has finished, plus the one it is in the middle of.
   *
   * The second half is computed here rather than sent, because it changes every second and the alternative
   * is a frame a second per child just to say "add one second". A child that is not running is frozen at
   * exactly what its log says it spent, so a reload and a live window show the same number.
   */
  function workMs(view: SubAgentView, now: number): number {
    const settled = view.durationMs ?? 0;
    return running(view) ? settled + Math.max(0, now - (view.runningSince as number)) : settled;
  }
  /**
   * Work time in DSH's subagent shape: seconds, then minutes with two-digit seconds, then hours, then days.
   *
   * Months and years are absent on purpose — this measures how long a child *worked*, and a child that has
   * been working for a month is a broken run rather than a reading anybody formats.
   */
  function workDuration(view: SubAgentView, now: number): string {
    const totalSeconds = Math.floor(workMs(view, now) / 1_000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3_600) % 24;
    const days = Math.floor(totalSeconds / 86_400);
    const pad = (value: number) => String(value).padStart(2, '0');
    if (days > 0)
      return hours === 0
        ? t('subagent.duration.days', { days })
        : t('subagent.duration.daysHours', { days, hours });
    if (totalSeconds >= 3_600)
      return t('subagent.duration.hours', { hours, minutes: pad(minutes), seconds: pad(seconds) });
    if (totalSeconds >= 60)
      return t('subagent.duration.minutes', { minutes, seconds: pad(seconds) });
    return t('subagent.duration.seconds', { seconds });
  }
  /**
   * What a child has spent, or `undefined` when it has reported nothing yet.
   *
   * `inputTokens` is the billed prompt total with the cache buckets already inside it, so the total is that
   * plus the output — adding the cache reads again would count the same tokens twice.
   */
  function tokenTotal(view: SubAgentView): number | undefined {
    return view.usage ? view.usage.inputTokens + view.usage.outputTokens : undefined;
  }
  const tokenText = (tokens: number | undefined) =>
    tokens === undefined ? '' : t('subagent.tokens', { value: formatTokens(tokens) });
  /** Which of DSH's three dots a child gets: working, finished cleanly, or anything else. */
  function dotState(view: SubAgentView): string {
    if (view.status === 'running') return 'ongoing';
    return view.status === 'completed' ? 'done' : 'idle';
  }
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
    paintNumbers();
  }
  /** Findings, always paired with the evidence the child gave for them. */
  function findings(report: SubAgentSummaryReport): HTMLElement {
    const block = element('div', '', 'subagent-report');
    block.append(element('p', report.summary, 'subagent-report-summary'));
    const heading = element('div', t('subagent.findings'), 'subagent-report-heading');
    block.append(heading);
    const items = element('ul', '', 'subagent-findings');
    for (const finding of report.findings) {
      const item = element('li');
      item.append(element('span', finding.statement));
      item.append(
        element(
          'span',
          `${t('subagent.evidence')}: ${finding.evidence}${finding.paths?.length ? ` [${finding.paths.join(', ')}]` : ''}`,
          'subagent-evidence',
        ),
      );
      items.append(item);
    }
    block.append(items);
    if (report.unverified?.length)
      block.append(
        element(
          'p',
          `${t('subagent.unverified')}: ${report.unverified.join('; ')}`,
          'subagent-unverified',
        ),
      );
    if (report.blockers?.length)
      block.append(
        element(
          'p',
          `${t('subagent.blockers')}: ${report.blockers.join('; ')}`,
          'subagent-blockers',
        ),
      );
    return block;
  }
  /**
   * Open one child's own record as the page.
   *
   * The record is read from the child's own session, so this asks for it and shows the page immediately: the
   * round trip fills the body. Opening a second child while the first is on screen is the same call — the page
   * is defined by which child it names, not by a stack of views.
   */
  function openChild(view: SubAgentView): void {
    if (!view.childSessionId) return;
    if (page === null) pageScroll = conversation.scrollTop;
    page = { id: view.id, childSessionId: view.childSessionId, objective: view.objective };
    viewerKey = '';
    storedAssistantCount = -1;
    send({
      type: 'subagentTranscript',
      subagentId: view.id,
      childSessionId: view.childSessionId,
    });
    closeCatalog();
    paintPage();
    // A record is read from its beginning, and the conversation underneath keeps its own place for the return.
    conversation.scrollTop = 0;
  }
  /**
   * The catalog: one row per direct child, DSH's shape — a state dot, the task, what the child is doing, and
   * the two numbers beside it.
   *
   * Rows are rebuilt only when the *set* of children or one of their labels changes; the numbers are painted
   * into cells that outlive the rebuild, because a working child moves them once a second and rebuilding a
   * list at that rate would throw away the focus and the open transcript of whoever is reading it.
   */
  function paintCatalog(): void {
    trigger.hidden = views.length === 0;
    if (!views.length) {
      closeCatalog();
      rowCells.clear();
      catalog.replaceChildren();
      catalogKey = '';
      return;
    }
    const runningCount = views.filter(running).length;
    const count = views.length;
    const labelKey = count === 1 ? 'subagent.catalog.one' : 'subagent.catalog.other';
    const runningKey =
      runningCount === 1 ? 'subagent.catalog.running.one' : 'subagent.catalog.running.other';
    triggerLabel.textContent = t(labelKey, { count });
    trigger.setAttribute(
      'aria-label',
      runningCount > 0 ? t(runningKey, { count: runningCount }) : t(labelKey, { count }),
    );
    triggerPulse.hidden = runningCount === 0;
    const next = JSON.stringify([
      views.map((view) => [view.id, view.role, view.objective, view.status, view.childSessionId]),
      locale(),
    ]);
    if (next === catalogKey) return;
    catalogKey = next;
    rowCells.clear();
    catalog.replaceChildren(
      ...views.map((view) => {
        const row = element('div', '', 'subagent-row');
        row.dataset.status = view.status;
        row.setAttribute('role', 'treeitem');
        row.tabIndex = 0;
        const dot = element('span', '', 'subagent-row-dot');
        dot.dataset.state = dotState(view);
        dot.setAttribute('aria-hidden', 'true');
        const content = element('span', '', 'subagent-row-content');
        content.append(
          element('span', view.objective, 'subagent-row-label'),
          element(
            'span',
            `${t(`subagent.role.${view.role}`)} · ${label(view)}`,
            'subagent-row-meta',
          ),
        );
        const metrics = element('span', '', 'subagent-row-metrics');
        const tokens = element('span', '', 'subagent-row-tokens');
        const duration = element('span', '', 'subagent-row-duration');
        metrics.append(tokens, duration);
        row.append(dot, content, metrics);
        rowCells.set(view.id, { row, tokens, duration });
        row.addEventListener('click', () => openChild(view));
        row.addEventListener('keydown', (event) => {
          const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openChild(view);
            return;
          }
          if (!keys.includes(event.key)) return;
          // Focus walks the rows, which is what makes the catalog usable without a pointer; there is no
          // nesting to expand here, so the arrow keys are a list and not a tree.
          event.preventDefault();
          const rows = [...catalog.querySelectorAll<HTMLElement>('.subagent-row')];
          const at = rows.indexOf(row);
          const target =
            event.key === 'Home'
              ? rows[0]
              : event.key === 'End'
                ? rows[rows.length - 1]
                : rows[event.key === 'ArrowDown' ? at + 1 : at - 1];
          target?.focus();
        });
        return row;
      }),
    );
  }
  /** The four numbers on screen, repainted without touching the rows that hold them. */
  function paintNumbers(): void {
    const now = Date.now();
    for (const view of views) {
      const tokens = tokenTotal(view);
      const duration = workDuration(view, now);
      const row = rowCells.get(view.id);
      if (row) {
        row.tokens.textContent = tokenText(tokens);
        row.tokens.hidden = tokens === undefined;
        row.duration.textContent = duration;
        row.duration.title = t('subagent.duration.exact', { duration });
        // DSH names a row by everything it shows, so a screen reader reads the same three facts a sighted
        // reader does rather than a bare task title.
        row.row.setAttribute(
          'aria-label',
          [
            view.objective,
            `${t(`subagent.role.${view.role}`)} · ${label(view)}`,
            tokenText(tokens),
            duration,
          ]
            .filter((value) => value !== '')
            .join(' '),
        );
      }
      const card = cardCells.get(view.id);
      if (card) {
        // The separators live in the text rather than in the flex gap: the three readings are one line to a
        // reader — sighted or not — and a cell that is missing must not leave a dangling dot behind.
        card.tokens.textContent = tokens === undefined ? '' : ` · ${tokenText(tokens)}`;
        card.tokens.hidden = tokens === undefined;
        card.duration.textContent = ` · ${duration}`;
      }
    }
  }
  /**
   * A clock only runs while something is working.
   *
   * A finished child's time is frozen in its log, so a timer that kept repainting would spend a wake-up a
   * second to redraw the same digits — and it would be a timer nobody could see was pointless.
   */
  function syncTicker(): void {
    const working = views.some(running);
    if (working && ticker === undefined) ticker = setInterval(paintNumbers, 1_000);
    else if (!working && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }
  anchor.addEventListener('pointerenter', openCatalog);
  popover.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  anchor.addEventListener('pointerleave', () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => closeCatalog(), 180);
  });
  trigger.addEventListener('click', openCatalog);
  document.addEventListener('click', (event) => {
    if (popover.hidden) return;
    const target = event.target as Node;
    if (trigger.contains(target) || popover.contains(target)) return;
    closeCatalog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || popover.hidden) return;
    closeCatalog();
    trigger.focus();
    event.stopPropagation();
  });
  function paintLive(): void {
    const nearBottom =
      conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
    const selected = page;
    const text = selected
      ? (live.get(selected.id) ?? views.find((entry) => entry.id === selected.id)?.text ?? '')
      : '';
    liveContent.textContent = text;
    liveMessage.hidden = !text;
    if (page && text && liveMessage.parentElement !== body) body.append(liveMessage);
    if (nearBottom && page) conversation.scrollTop = conversation.scrollHeight;
  }
  function paintLiveTool(): void {
    const view = page ? views.find((entry) => entry.id === page?.id) : undefined;
    if (!view?.tool) {
      liveTool.remove();
      return;
    }
    liveToolSummary.replaceChildren(
      element('span', '✧', 'process-icon'),
      element('span', t('ui.toolCall'), 'process-label'),
      element('span', `· ${view.tool}`, 'process-preview'),
    );
    liveToolArgs.textContent = view.toolArgs ?? view.tool;
    if (liveTool.parentElement !== body) body.append(liveTool);
  }
  function renderViewer(): void {
    const transcript = getState()?.subagentTranscript ?? null;
    viewer.hidden = page === null;
    if (page === null) {
      viewerKey = '';
      body.replaceChildren();
      liveMessage.hidden = true;
      liveTool.remove();
      return;
    }
    const next = JSON.stringify([transcript, locale(), page.childSessionId]);
    if (next === viewerKey) return;
    const nearBottom =
      body.querySelector('.message') !== null &&
      conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
    viewerKey = next;
    // The record arrives on a round trip: the page is already on screen when the command is sent, and a blank
    // body would read as "this child recorded nothing" rather than "the answer is still coming".
    if (!transcript || transcript.childSessionId !== page.childSessionId) {
      note.textContent = t('subagent.transcriptLoading');
      body.replaceChildren();
      paintLive();
      paintLiveTool();
      return;
    }
    note.textContent = transcript.truncated
      ? t('subagent.transcriptTruncated')
      : t('subagent.transcriptNote');
    // Match the parent transcript: snapshots stay in the session, but are not conversation bubbles.
    const messages = transcript.messages.filter(
      (message) => !(message.role === 'user' && isRuntimeContext(message.content)),
    );
    const assistantCount = messages.filter((message) => message.role === 'assistant').length;
    if (storedAssistantCount >= 0 && assistantCount > storedAssistantCount) live.set(page.id, '');
    storedAssistantCount = assistantCount;
    body.replaceChildren(...messages.map(renderMessage));
    paintLive();
    paintLiveTool();
    if (!messages.length && liveMessage.hidden)
      body.append(element('p', t('subagent.transcriptEmpty'), 'subagent-transcript-empty'));
    if (nearBottom) conversation.scrollTop = conversation.scrollHeight;
  }
  /**
   * Open one child's record as a page, and go back by the header's own title.
   *
   * The record used to open as a panel folded into the card list, which put a child's whole transcript inside
   * the box that lists it. It is a page instead: the header's title becomes the way back to the conversation
   * that delegated the work, the crumb beside it names the child, and the parent's own surfaces — transcript,
   * plan, checklist, composer — step aside while the record is what is on screen. That is the navigation DSH
   * uses for the same view, and it is the same two facts a reader needs: which child am I in, and how do I
   * get out.
   */
  function paintPage(): void {
    const open = page !== null;
    document.body.dataset.subagentPage = open ? 'open' : '';
    viewer.hidden = !open;
    crumbSep.hidden = !open;
    crumbChild.hidden = !open;
    if (!open) {
      chatTitle.classList.remove('chat-title-back');
      chatTitle.removeAttribute('role');
      chatTitle.removeAttribute('tabindex');
      chatTitle.removeAttribute('aria-label');
      viewerKey = '';
      return;
    }
    crumbChild.textContent = page!.objective;
    // The title keeps being the session's name; it becomes a control only while it has somewhere to go back to.
    chatTitle.classList.add('chat-title-back');
    chatTitle.setAttribute('role', 'button');
    chatTitle.tabIndex = 0;
    chatTitle.setAttribute(
      'aria-label',
      t('subagent.back', { title: chatTitle.textContent ?? '' }),
    );
    renderViewer();
  }
  function leaveChild(): void {
    if (page === null) return;
    page = null;
    send({ type: 'closeSubagentTranscript' });
    paintPage();
    // Back where the reader was: the page scrolled to its own top on the way in, and the conversation they
    // left is not the same place.
    conversation.scrollTop = pageScroll;
  }
  chatTitle.addEventListener('click', () => leaveChild());
  chatTitle.addEventListener('keydown', (event) => {
    if (page === null) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    leaveChild();
  });

  return {
    /** Streamed text, or the child's numbers: repaint exactly what moved and nothing else. */
    delta(delta: SubAgentDelta): void {
      if (delta.text !== undefined) {
        live.set(delta.id, (live.get(delta.id) ?? '') + delta.text);
        paint(delta.id);
        if (page?.id === delta.id) paintLive();
      }
      if (delta.durationMs === undefined && delta.runningSince === undefined && !delta.usage)
        return;
      const view = views.find((entry) => entry.id === delta.id);
      if (!view) return;
      // The view is patched in place so the reading on screen is right now; the next snapshot carries the
      // same numbers from the controller, which is what keeps this a repaint rather than a second tally.
      if (delta.durationMs !== undefined) view.durationMs = delta.durationMs;
      if (delta.runningSince !== undefined) view.runningSince = delta.runningSince;
      if (delta.usage) view.usage = delta.usage;
      paintNumbers();
      syncTicker();
    },
    update(subagents: readonly SubAgentView[]): void {
      views = subagents;
      // A page belongs to the session that opened it: switching sessions leaves the child's record behind
      // rather than showing one session's child on top of another's conversation.
      const sessionId = getState()?.session.sessionId ?? '';
      if (pageSessionId !== sessionId) {
        pageSessionId = sessionId;
        page = null;
      }
      // Child conversations have their own page, reached through the header entry.
      panel.hidden = true;
      if (!subagents.length) {
        key = '';
        live.clear();
        texts.clear();
        cardCells.clear();
        list.replaceChildren();
      } else {
        // Drop buffered text for tasks this session no longer shows, so the buffer cannot grow across
        // sessions and a reused id can never inherit another session's words.
        for (const id of [...live.keys()])
          if (!subagents.some((view) => view.id === id)) live.delete(id);
        // The busy flag is part of the key: without it a card rebuilt while a run was in flight kept its
        // disabled button after the run ended, because nothing else about it had changed.
        const busy = Boolean(getState()?.session.running || getState()?.session.loading);
        const next = JSON.stringify([
          subagents.map((view) => [
            view.id,
            view.role,
            view.objective,
            view.status,
            view.tool ?? '',
            view.toolArgs ?? '',
            view.rounds,
            view.toolCalls,
            view.error ?? '',
            view.report ?? null,
            // The full text only enters the key when it is the stored report rather than a live stream:
            // keying on streamed text would rebuild the card on every token.
            view.status === 'running' ? '' : view.text,
          ]),
          locale(),
          busy,
        ]);
        if (next !== key) {
          key = next;
          texts.clear();
          cardCells.clear();
          list.replaceChildren(
            ...subagents.map((view) => {
              const card = element('article', '', 'subagent-card');
              card.dataset.status = view.status;
              const header = element('header', '', 'subagent-card-header');
              header.append(
                element(
                  'h3',
                  format(t('subagent.cardTitle'), {
                    index: view.index + 1,
                    total: view.total,
                    role: t(`subagent.role.${view.role}`),
                  }),
                ),
                element('span', label(view), 'subagent-status'),
              );
              card.append(header, element('p', view.objective, 'subagent-objective'));
              if (view.report) card.append(findings(view.report));
              else {
                const text = element('div', live.get(view.id) ?? view.text, 'subagent-text');
                texts.set(view.id, text);
                card.append(text);
              }
              if (view.tool) {
                card.append(
                  element(
                    'div',
                    view.toolArgs
                      ? format(t('subagent.runningToolWithArgs'), {
                          tool: view.tool,
                          args: view.toolArgs,
                        })
                      : format(t('subagent.runningTool'), { tool: view.tool }),
                    'subagent-tool',
                  ),
                );
              }
              if (view.error) card.append(element('div', view.error, 'subagent-error'));
              // Tokens and time matter to the person paying for them: the parent run is charged for every
              // child, and a card that showed only rounds and tool calls hid the expensive ones.
              const meta = element('div', '', 'subagent-meta');
              const tokens = element('span', '', 'subagent-meta-tokens');
              const duration = element('span', '', 'subagent-meta-duration');
              cardCells.set(view.id, { tokens, duration });
              meta.append(
                element(
                  'span',
                  format(t('subagent.meta'), { rounds: view.rounds, tools: view.toolCalls }),
                  'subagent-meta-counts',
                ),
                tokens,
                duration,
              );
              card.append(meta);
              if (view.childSessionId) {
                const open = element('button', t('subagent.viewTranscript'), 'subagent-view');
                open.disabled = busy;
                open.addEventListener('click', () => openChild(view));
                card.append(open);
              }
              return card;
            }),
          );
        }
      }
      renderViewer();
      paintLiveTool();
      paintPage();
      paintCatalog();
      paintNumbers();
      syncTicker();
    },
  };
}
