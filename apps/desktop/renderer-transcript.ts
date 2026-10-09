/**
 * The transcript: the conversation's messages folded into one `process-group` per interval of work, and the
 * three pieces of scroll/fold state that outlive a rebuild.
 *
 * A run writes a tool call at a time, and drawing each one as its own row is how a transcript becomes
 * unreadable; consecutive operations therefore share one fold while actual replies keep their own place. The
 * fold state (`processOpen`, `processScroll`, `processTail`) lives here rather than in the DOM because the
 * transcript is *rebuilt* on a revision change: what the reader had open and where they had scrolled is read
 * back off the previous DOM (or remembered here) and reapplied to the new one, and a fold still on screen is
 * reused rather than recreated so an expanded group does not snap shut under the pointer.
 *
 * The live thought is the one thing that crosses into the fold without a rebuild: `placeLiveThought` moves it
 * in and out of the last interval, which is why the tail is kept. The two scroll helpers exist for the settings
 * page, which hides the transcript without destroying it — the folds come back where they were, not at 0.
 */
import type { CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { Message } from '../../packages/protocol/index.ts';
import { isRuntimeContext } from '../../packages/protocol/context.ts';
import { TranscriptCache, reconcileChildren } from './transcript-cache.ts';
import { locale, t } from './i18n.ts';

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
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

export function setupTranscript(options: {
  getState(): CarrierSnapshot | null;
  /** The hub's message renderer: one message, once per transcript rebuild. */
  messageView(message: Message): HTMLElement;
}): {
  render(messages: Message[], startIndex: number, runPaused: boolean): void;
  updateRunning(): void;
  placeLiveThought(thought: HTMLElement, visible: boolean): void;
  saveScroll(): void;
  restoreScroll(): void;
} {
  const { messageView } = options;
  let processSession: string | null = null;
  let processMessageCount = 0;
  let processTail: HTMLDetailsElement | undefined;
  let processOpen = new Map<string, boolean>();
  let processScroll = new Map<string, number>();
  let runningProcessCalls = new Set<string>();
  let transcriptIdentity = '';
  const transcriptCache = new TranscriptCache<{
    view: HTMLElement;
    thought: HTMLElement | null;
    calls: HTMLElement[];
  }>();

  function updateProcessSummary(
    group: HTMLDetailsElement,
    source = group
      .querySelector('.process-steps')
      ?.lastElementChild?.querySelector(':scope > summary'),
  ): void {
    const summary = group.querySelector(':scope > summary')!;
    if (!source) return;
    summary.className = `${source.className} process-group-summary`;
    summary.replaceChildren(...Array.from(source.childNodes, (child) => child.cloneNode(true)));
    summary.append(node('span', '', 'process-chevron'));
  }

  function processGroup(key: string): HTMLDetailsElement {
    const group = node('details', '', 'process-group');
    group.dataset.processKey = key;
    group.open = processOpen.get(key) ?? false;
    group.append(node('summary'), node('div', '', 'process-steps'));
    return group;
  }

  /** Consecutive operations share one fold; actual replies keep their own place in the transcript. */
  function transcriptViews(messages: Message[], startIndex = 0): HTMLElement[] {
    const visible = !required('chat-page').hidden;
    const identity = `${options.getState()?.session.sessionId}:${locale()}`;
    const reusableGroups =
      identity === transcriptIdentity
        ? new Map(
            Array.from(
              document.querySelectorAll<HTMLDetailsElement>('#messages > .process-group'),
              (group) => [group.dataset.processKey!, group],
            ),
          )
        : new Map<string, HTMLDetailsElement>();
    transcriptIdentity = identity;
    const internalAnchors = new Map<HTMLElement, { node: HTMLElement; top: number }>();
    for (const previous of reusableGroups.values()) {
      if (!previous.open || !visible) continue;
      const steps = previous.querySelector<HTMLElement>('.process-steps')!;
      const boundary = steps.getBoundingClientRect().top;
      const anchor = Array.from(steps.children).find(
        (step) => step.getBoundingClientRect().bottom > boundary,
      ) as HTMLElement | undefined;
      if (anchor)
        internalAnchors.set(steps, { node: anchor, top: anchor.getBoundingClientRect().top });
    }
    const sameSession = processSession === options.getState()?.session.sessionId;
    processSession = options.getState()?.session.sessionId ?? null;
    const previousScroll = processScroll;
    processOpen = new Map();
    processScroll = new Map();
    if (!sameSession) runningProcessCalls.clear();
    if (sameSession) {
      for (const previous of document.querySelectorAll<HTMLDetailsElement>('[data-process-key]')) {
        processOpen.set(previous.dataset.processKey!, previous.open);
        const steps = previous.querySelector<HTMLElement>(':scope > .process-steps');
        if (steps)
          processScroll.set(
            previous.dataset.processKey!,
            visible ? steps.scrollTop : (previousScroll.get(previous.dataset.processKey!) ?? 0),
          );
      }
    }
    processMessageCount = startIndex + messages.length;
    const rows = messages
      .map((message, index) => ({ index: startIndex + index, message }))
      .filter(({ message }) => !(message.role === 'user' && isRuntimeContext(message.content)));
    const fragments = transcriptCache.views(identity, rows, (message) => {
      const view = messageView(message);
      const thought = view.querySelector<HTMLElement>(':scope > .message-reasoning');
      const calls = Array.from(view.querySelectorAll<HTMLElement>(':scope > .tool-call'));
      thought?.remove();
      for (const call of calls) call.remove();
      return { view, thought, calls };
    });
    const views: HTMLElement[] = [];
    const groupSteps = new Map<HTMLDetailsElement, HTMLElement[]>();
    const retainedGroups = new Set<HTMLDetailsElement>();
    let group: HTMLDetailsElement | undefined;
    const add = (step: HTMLElement, key: string) => {
      step.dataset.processKey = key;
      (step as HTMLDetailsElement).open = processOpen.get(key) ?? false;
      if (!group) {
        group = reusableGroups.get(`group:${key}`) ?? processGroup(`group:${key}`);
        if (reusableGroups.get(`group:${key}`) === group) retainedGroups.add(group);
        views.push(group);
        groupSteps.set(group, []);
      }
      const previousGroup = step.closest<HTMLDetailsElement>('.process-group');
      if (
        previousGroup &&
        !retainedGroups.has(group) &&
        !retainedGroups.has(previousGroup) &&
        [...reusableGroups.values()].includes(previousGroup)
      ) {
        const newKey = group.dataset.processKey!;
        const planned = groupSteps.get(group)!;
        views[views.indexOf(group)] = previousGroup;
        groupSteps.delete(group);
        group = previousGroup;
        const oldKey = group.dataset.processKey!;
        group.dataset.processKey = newKey;
        processScroll.set(
          newKey,
          visible
            ? group.querySelector<HTMLElement>('.process-steps')!.scrollTop
            : (processScroll.get(oldKey) ?? 0),
        );
        groupSteps.set(group, planned);
        retainedGroups.add(group);
      }
      groupSteps.get(group)!.push(step);
    };
    for (const [position, { index, message }] of rows.entries()) {
      const { view, thought, calls } = fragments[position]!;
      if (message.role === 'tool') add(view, `${index}:result`);
      else if (message.role === 'assistant') {
        if (thought) add(thought, `${index}:reasoning`);
        if (message.content.trim() || message.interrupted) {
          group = undefined;
          views.push(view);
        }
        for (const [callIndex, call] of calls.entries()) add(call, `${index}:call:${callIndex}`);
      } else {
        group = undefined;
        views.push(view);
      }
    }
    for (const [group, steps] of groupSteps) {
      const container = group.querySelector<HTMLElement>('.process-steps')!;
      reconcileChildren(container, steps);
      updateProcessSummary(group);
      const anchor = internalAnchors.get(container);
      if (anchor?.node.isConnected)
        container.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top;
      if (visible && retainedGroups.has(group))
        processScroll.set(group.dataset.processKey!, container.scrollTop);
    }
    processTail = group;
    return views;
  }

  function updateRunning(): void {
    const calls = options.getState()?.session.tools ?? [];
    const started = calls.filter((call) => !runningProcessCalls.has(call.id));
    runningProcessCalls = new Set(calls.map((call) => call.id));
    for (const call of started) {
      const step = Array.from(document.querySelectorAll<HTMLElement>('#messages .tool-call')).find(
        (item) => item.dataset.callId === call.id,
      );
      const group = step?.closest<HTMLDetailsElement>('.process-group');
      if (group) updateProcessSummary(group, step!.querySelector(':scope > summary'));
    }
  }

  /** The live thought joins the last interval, without rebuilding or closing a reader's open fold. */
  function placeLiveThought(thought: HTMLElement, visible: boolean): void {
    if (!visible) {
      if (thought.parentElement?.classList.contains('process-steps')) {
        const group = thought.closest<HTMLDetailsElement>('.process-group')!;
        required('live').prepend(thought);
        if (!group.querySelector('.process-steps')!.children.length) {
          group.remove();
          if (processTail === group) processTail = undefined;
        } else updateProcessSummary(group);
      }
      return;
    }
    thought.dataset.processKey = `${processMessageCount}:reasoning`;
    if (!processTail) {
      processTail = processGroup(`group:${thought.dataset.processKey}`);
      required('messages').append(processTail);
    }
    processTail.querySelector('.process-steps')!.append(thought);
    updateProcessSummary(processTail);
  }

  /** Remember where every fold was scrolled to, before something hides the transcript. */
  function saveScroll(): void {
    for (const group of document.querySelectorAll<HTMLElement>('#messages > .process-group')) {
      const steps = group.querySelector<HTMLElement>('.process-steps');
      if (steps) processScroll.set(group.dataset.processKey!, steps.scrollTop);
    }
  }
  /** Put every fold back where it was; a rebuilt transcript runs this right after its own rebuild. */
  function restoreScroll(): void {
    for (const group of document.querySelectorAll<HTMLElement>('#messages > .process-group')) {
      const steps = group.querySelector<HTMLElement>('.process-steps');
      if (steps) steps.scrollTop = processScroll.get(group.dataset.processKey!) ?? 0;
    }
  }
  function render(messages: Message[], startIndex: number, runPaused: boolean): void {
    reconcileChildren(required('messages'), [
      ...transcriptViews(messages, startIndex),
      /**
       * Where the run stopped, not at the top of the window: a stop is the end of what happened, so it belongs
       * after the last thing that happened. `renderPaused` is the only place this sentence is written.
       */
      ...(runPaused ? [node('p', t('ui.runPaused'), 'run-paused')] : []),
    ]);
    restoreScroll();
  }
  return { render, updateRunning, placeLiveThought, saveScroll, restoreScroll };
}
