import { setupTasks } from './renderer-tasks.ts';
import { setupStatistics } from './renderer-statistics.ts';
import { setupWorkspace } from './renderer-workspace.ts';
import { setupSubAgents } from './renderer-subagents.ts';
import { setupMcpSettings } from './renderer-mcp.ts';
import { PRODUCT_SCOPE } from '../../packages/protocol/product-scope.ts';
import type { DesktopBridge, DesktopReply } from './contract.ts';
import { carrierErrorText } from './carrier-errors.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import type { Message } from '../../packages/protocol/index.ts';
import { setupModelSettings } from './renderer-settings.ts';
import { diffView } from './diff-view.ts';
import { setupAttachments } from './renderer-attachments.ts';
import { setupBackgroundView } from './renderer-background.ts';
import { setupCommandPalette } from './renderer-commands.ts';
import { setupComposer } from './renderer-composer.ts';
import { setupLiveMessage } from './renderer-live.ts';
import { setupMessages } from './renderer-messages.ts';
import { setupPlanPanel } from './renderer-plan.ts';
import { setupQuestions } from './renderer-questions.ts';
import { setupSessionPanels } from './renderer-session-panels.ts';
import { setupSessionList } from './renderer-session-list.ts';
import { setupTranscript } from './renderer-transcript.ts';
import { setupTurnChanges } from './renderer-changes.ts';
import { runStatusText } from './renderer-status.ts';
import { setupSessionManagement } from './session-management.ts';
import { setupGeneralSettings } from './renderer-general-settings.ts';
import { setupWorkspaceMaintenance } from './renderer-workspace-maintenance.ts';
import { setupSandboxInitialization } from './renderer-sandbox-setup.ts';
import { setupPermissionSettings } from './renderer-permissions.ts';
import { locale, t, format, onLocaleChange } from './i18n.ts';
import { SlotRegistry, mountSlot, type SlotMount } from './slots.ts';
declare global {
  interface Window {
    yuantu: DesktopBridge;
  }
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
/**
 * What the kernel writes into `error` when the signal it was given aborted.
 *
 * The string is the kernel's, so it is matched here rather than re-worded there: `agent.ts` uses it as the
 * reason on the run result, the CLI prints it, and a second spelling of "the user stopped this" is a second
 * thing to keep in step.
 */
const RUN_CANCELLED = 'Run cancelled';
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
const statisticsView = setupStatistics();
const workspaceView = setupWorkspace();
const workspaceMaintenance = setupWorkspaceMaintenance();
/** What a panel-level slot is given: the carrier snapshot a panel draws from, and nothing else. */
interface PanelSlotContext {
  readonly session: CarrierSnapshot['session'];
  readonly workspace: string;
}
/** What a slot inside one message is given: the message it sits on. */
interface MessageSlotContext {
  readonly message: Message;
}
/**
 * Every slot this window renders, and what each hands a contribution.
 *
 * Declared as one map so the registry can check a registration against the slot it names: a contribution to
 * `sidebar.right` that expects a message is a type error here rather than a panel that receives something it
 * cannot read. A slot missing from this map is a type error too.
 */
interface DesktopSlotContexts {
  'composer.above': PanelSlotContext;
  'message.actions': MessageSlotContext;
  'message.footer': MessageSlotContext;
  'sidebar.right': PanelSlotContext;
  'tool.result.extra': MessageSlotContext;
}

/**
 * What markdown is allowed to ask the window to do: copy text, or open a link.
 *
 * It lives in the hub rather than in a panel because two of them need it — the message view renders markdown,
 * and the live bubble repaints it on every coalesced tick — and both must reach the bridge the same way.
 */
const markdownActions = {
  async copy(text: string) {
    if (!(await invoke({ type: 'copyText', text }))) throw new Error('Copy failed');
  },
  async open(url: string) {
    if (!(await invoke({ type: 'openLink', url }))) throw new Error('Open failed');
  },
};
const messagesView = setupMessages({ markdownActions, mountMessageSlot });
/**
 * The window's combination point.
 *
 * The panels used to be called by name from `render()`, in the order the calls happened to be written, which
 * left exactly one way to add a view: edit this file. They now register into a named slot, through the same call
 * a contributed view would use — a built-in that bypassed its own slot would be a second path that drifts from
 * the first. Which slot exists, what order it renders in and how a contribution leaves are pinned by
 * `tests/slots.test.ts`; the composition itself is exercised by the desktop smoke.
 *
 * The frames the mount creates are nesting, not ownership: each panel still builds its own subtree by id, so
 * moving one into the slot changed where it sits and who decides the order, not what it renders.
 */
const slots = new SlotRegistry<DesktopSlotContexts>();
slots.register('composer.above', {
  order: 10,
  render: (_frame, context) => statisticsView.update(context.session),
});
slots.register('sidebar.right', {
  order: 10,
  render: (_frame, context) => workspaceView.update(context.workspace),
});
// Extra material beside a tool result: the pictures it produced and the change it made to a file. A contributed
// view can add more here — a chart, a rendered document — without this file learning about it.
slots.register('tool.result.extra', {
  order: 10,
  render: (frame, context) => {
    const message = context.message;
    if (message.role !== 'tool') return;
    frame.replaceChildren(
      ...(message.images?.length ? [messagesView.imageGallery(message.images)] : []),
      ...(message.change && !message.isError ? [diffView(message.change)] : []),
    );
  },
});
// The two halves of a user message's meta row: when it was sent, and what can be done with it. They are two
// slots because they are two questions — a contributed view that wants to act on a message registers next to the
// copy button, and one that wants to annotate it registers beside the timestamp.
slots.register('message.footer', {
  order: 10,
  render: (frame, context) => frame.replaceChildren(messagesView.messageTimeView(context.message)),
});
slots.register('message.actions', {
  order: 20,
  render: (frame, context) => frame.replaceChildren(messagesView.messageCopyView(context.message)),
});
const subagentView = setupSubAgents(
  () => state,
  (command) => invoke(command),
  messagesView.messageView,
);
const prompt = element<HTMLTextAreaElement>('prompt');
const sendButton = element<HTMLButtonElement>('send');
const conversation = element('conversation');
/** Mounted once: a slot's frames are stable across renders, so re-rendering cannot stack a panel twice. */
const slotMounts: SlotMount<PanelSlotContext>[] = [
  mountSlot(document, element('composer-statistics'), slots, 'composer.above'),
  mountSlot(document, element('workspace-panel'), slots, 'sidebar.right'),
];
/**
 * Mount a message-level slot into a container this view just built.
 *
 * Called from `messageView`, which runs once per message per transcript rebuild (`render()` replaces the whole
 * list when the revision or the language changes), so each message element gets its own frames and nothing has
 * to be disposed: they are removed with the element they live in.
 */
function mountMessageSlot(
  container: HTMLElement,
  slot: 'message.actions' | 'message.footer' | 'tool.result.extra',
  message: Message,
): void {
  mountSlot(document, container, slots, slot).render({ message });
}
let state: CarrierSnapshot | null = null;

let mcpSettings: ReturnType<typeof setupMcpSettings> | undefined;
let permissionSettings: ReturnType<typeof setupPermissionSettings> | undefined;
let modelSettings: ReturnType<typeof setupModelSettings> | undefined;
let localError: string | Extract<DesktopReply, { ok: false }> | null = null;
let operation = false;
let approvalBusy = new Set<string>();
let transcriptKey = '';
/**
 * Where the shown window of history began at the last paint, for the session it belonged to.
 *
 * Following the newest message is for growth at the *end*. Older history arriving at the top also changes the
 * transcript, and a short conversation counts as "near the bottom" even when scrolled to its top — so the
 * snapshot pushed after a load-older reply used to jump the reader to the end, past the step they were on.
 */
let paintedWindow: { sessionId: string | null; historyStart: number; end: number } | null = null;
/** Set once older history was prepended; cleared by a new message at the end or by another session. */
let holdReadingPosition = false;
let approvalKey = '';
const commandsView = setupCommandPalette({
  getState: () => state,
  select,
  invoke,
  requestRender: render,
  requestComposerUpdate: renderComposerState,
  onStop: () => sendButton.click(),
});
const backgroundView = setupBackgroundView({ getState: () => state, invoke });
const attachmentsView = setupAttachments({
  getState: () => state,
  requestRender: render,
  setError: (message) => {
    localError = message;
  },
});
const composerView = setupComposer({
  getState: () => state,
  invoke,
  requestRender: render,
  setError: (message) => {
    localError = message;
  },
  attachments: attachmentsView,
  commands: commandsView,
});
const taskView = setupTasks(select);
function renderTasks(): void {
  taskView(state, operation || composerView.isSending());
}

async function invoke(command: CarrierCommand): Promise<CarrierSnapshot | null> {
  try {
    const reply = await window.yuantu.invoke(command);
    if (!reply.ok) {
      localError = reply;
      render();
      return null;
    }
    if (command.type === 'snapshot') state = reply.state;
    return reply.state;
  } catch {
    localError = '桌面连接中断，请重新启动后检查会话记录。';
    render();
    return null;
  }
}
async function select(command: CarrierCommand): Promise<CarrierSnapshot | null> {
  if (operation || composerView.isSending() || state?.session.running || state?.session.loading)
    return null;
  if (command.type === 'searchSessions') {
    localError = null;
    return invoke(command);
  }
  operation = true;
  localError = null;
  const previousWorkspace = state?.workspace;
  const previousSession = state?.session.sessionId;
  render();
  try {
    const next = await invoke(command);
    if (
      next &&
      (next.workspace !== previousWorkspace || next.session.sessionId !== previousSession)
    ) {
      prompt.value = '';
      attachmentsView.clear();
    }
    return next;
  } finally {
    operation = false;
    render();
    if (command.type !== 'loadOlder') prompt.focus();
  }
}
let loadingOlderHistory = false;

const turnChangesView = setupTurnChanges({
  getState: () => state,
  select,
  preview: (path, content, key) => workspaceView.previewChanges(path, content, key),
  refreshPreview: (key, content) => workspaceView.refreshChangePreview(key, content),
  clearPreviews: () => workspaceView.clearChangePreviews(),
});
const transcriptView = setupTranscript({
  getState: () => state,
  messageView: messagesView.messageView,
  turnChanges: () => turnChangesView.cards(),
});

const liveView = setupLiveMessage({
  getState: () => state,
  markdownActions,
  reasoningView: messagesView.reasoningView,
  placeLiveThought: transcriptView.placeLiveThought,
  updateJumpButton,
  isChildPageOpen: childPageOpen,
  isLoadingOlder: () => loadingOlderHistory,
});

const planView = setupPlanPanel({
  // The panel's key holds the window's own in-flight command (`operation`) and nothing wider: `isBusy` is the
  // separate question that gates the buttons, and it stays separate so the panel repaints exactly when it did.
  isOperating: () => operation,
  isBusy: () => Boolean(state?.session.running || operation),
  select,
});
/**
 * The composer's own controls: whether it accepts input, and what the send button does and says.
 *
 * Split out of `render` because typing changes exactly this — an empty prompt disables Send — and nothing else
 * in the window. A keystroke used to repaint every panel, the session list and the transcript key check to flip
 * one button; it now repaints the button.
 */
function renderComposerState(): void {
  if (!state) return;
  const session = state.session;
  const composerBlocked =
    !state.ready ||
    !state.configured ||
    session.loading ||
    operation ||
    composerView.isStopping() ||
    composerView.isQueueBusy() ||
    attachmentsView.isBusy() ||
    (composerView.isSending() && !session.running);
  prompt.disabled = composerBlocked;
  for (const button of element('attachments').querySelectorAll<HTMLButtonElement>('button'))
    button.disabled = attachmentsView.isBusy();
  sendButton.disabled = session.running
    ? composerView.isStopping()
    : composerBlocked || (!prompt.value.trim() && !attachmentsView.hasAny());
  sendButton.dataset.mode = session.running ? 'stop' : 'send';
  const sendLabel = session.running
    ? composerView.isStopping()
      ? t('ui.stopping')
      : t('ui.stop')
    : t('ui.send');
  sendButton.setAttribute('aria-label', sendLabel);
  sendButton.title = sendLabel;
  element<HTMLButtonElement>('attach-image').disabled = composerBlocked;
  element('attach-image').title = t('ui.addAttachment');
  element('attach-image').setAttribute('aria-label', t('ui.addAttachment'));
}
function render(): void {
  if (!state) return;
  const session = state.session;
  workspaceMaintenance.update(state);
  // Every panel in a slot renders here, in the order the slot decides — the built-ins included. Nothing below
  // this line calls a panel directly; adding one is a `register`, not an edit to this function.
  const slotContext: PanelSlotContext = { session, workspace: state.workspace };
  for (const mount of slotMounts) mount.render(slotContext);
  const blocked =
    !state.ready || session.running || session.loading || operation || composerView.isSending();
  const older = element<HTMLButtonElement>('load-older-history');
  older.hidden = !(session.historyStart && !childPageOpen());
  older.disabled = blocked;
  older.textContent = t('ui.loadOlderHistory', { count: session.historyStart ?? 0 });
  const nearBottom =
    conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
  element('workspace').textContent = state.workspace;
  element('workspace').title = state.workspace;
  const title =
    state.sessions.find((item) => item.id === session.sessionId)?.title || t('ui.newSession');
  element('chat-title').textContent = title;
  element('chat-title').title = title;
  element<HTMLTextAreaElement>('prompt').placeholder = t('ui.promptPlaceholder');
  element('background-label').textContent = t('background.title');
  element('background-popover').setAttribute('aria-label', t('background.title'));
  backgroundView.render();

  renderTasks();
  modelSettings?.updateBusy();
  mcpSettings?.updateBusy();
  permissionSettings?.updateBusy();
  element('configuration').hidden = !state.ready || state.configured;
  const stopError =
    (typeof localError === 'string'
      ? localError
      : localError && carrierErrorText(localError, locale())) ||
    carrierErrorText(state, locale()) ||
    session.error;
  /**
   * A run the user stopped is not an error, and the kernel's marker for it is not shown as one.
   *
   * `agent.ts` sets `error = 'Run cancelled'` when the signal aborted, which the banner drew as a failure in
   * English across the top of a Chinese interface. What happened is that somebody pressed 停止: the conversation
   * says so at its end (`renderPaused`), and a red band is the wrong shape for a thing the user did on purpose.
   */
  const error = stopError === RUN_CANCELLED ? '' : stopError;
  element('error').hidden = !error;
  element('error').textContent = error || '';
  // A recovery is reported, not hidden: the window came back by itself, and the reason the reply the user was
  // waiting for never arrived is exactly what they need to be told.
  const notice = state.recovery
    ? format(t('ui.hostRecovered'), {
        attempts: state.recovery.attempts,
        // A pid that could not be read is shown as a dash rather than as 0, which is a real process id.
        pid: state.recovery.pid ?? '—',
      })
    : '';
  element('notice').hidden = !notice;
  element('notice').textContent = notice;
  sessionManagement.render(state, blocked);
  element<HTMLButtonElement>('new-session').disabled = blocked;
  element<HTMLButtonElement>('choose-workspace').disabled = blocked;
  commandsView.render();
  renderComposerState();
  /**
   * There is no enqueue-mode control any more: a message typed while the run is live is queued for after the
   * turn, always. The select that chose between that and steering the live run was one more thing in the
   * composer during exactly the moments the composer is not what you are looking at (a question is up, an
   * approval is waiting), and the queue below still says what will happen.
   */
  element('queue').textContent = session.queue
    .map((item) =>
      format(t('ui.queueItem'), {
        mode: item.mode === 'steer' ? t('ui.steerTask') : t('ui.followUp'),
        prompt: item.prompt.slice(0, 100),
      }),
    )
    .join('\n');
  element('clear-queue').hidden = !session.queue.length;
  element<HTMLButtonElement>('clear-queue').disabled = composerView.isQueueBusy();
  element('run-status').textContent = runStatusText({
    status: session.status,
    compacting: session.compacting,
    approvals: session.approvals.length,
    ready: state.ready,
    loading: session.loading,
    activity: session.statisticsActivity,
    tools: session.tools.length,
  });
  element('session-short').textContent = session.sessionId
    ? t('ui.sessionShort', { id: session.sessionId.slice(0, 8) })
    : '';
  element('welcome').hidden = Boolean(session.messages.length || session.running);
  sessionListView.render(
    state.sessions,
    session.sessionId,
    blocked,
    state.sessionsHasMore === true,
  );
  // Message timestamps are locale-formatted, so they follow the language too.
  const paused = session.error === RUN_CANCELLED;
  const changesIdentity = turnChangesView.update(blocked);
  const nextTranscriptKey = `${session.sessionId}:${session.messageRevision}:${locale()}:${paused}:${changesIdentity}`;
  const transcriptChanged = nextTranscriptKey !== transcriptKey;
  if (transcriptChanged) {
    transcriptKey = nextTranscriptKey;
    liveView.schedule();
    /**
     * The transcript is the conversation, and a runtime snapshot is not part of it: it is bookkeeping the *model*
     * needs (a memory or workspace outline it must be told about when it changes), wrapped in a tag that says so.
     * Drawn as an ordinary user message it reads as though somebody said it, and it buries the two things a
     * person scrolls for. The message stays in the session — the model still receives it, the log still holds it,
     * and `export` still writes it — the window simply does not draw it.
     */
    element('live').prepend(element('live-reasoning'));
    transcriptView.render(session.messages, session.historyStart ?? 0, paused);
  }
  liveView.sync();
  planView.render(session.plan);
  subagentView.update(session.subagents);
  transcriptView.updateRunning();
  element('tools').hidden = true;
  const nextApprovalKey = JSON.stringify([session.approvals, [...approvalBusy], locale()]);
  if (nextApprovalKey !== approvalKey) {
    approvalKey = nextApprovalKey;
    element('approvals').replaceChildren(
      ...session.approvals.map((item) => {
        const panel = node('section', '', 'approval');
        panel.append(
          node('div', '需要你的确认', 'approval-label'),
          node(
            'h2',
            item.approval.kind === 'external'
              ? '访问外部服务'
              : item.approval.kind === 'command'
                ? '执行命令'
                : '修改文件',
          ),
        );
        if (item.approval.subagent)
          panel.append(
            node(
              'p',
              format(t('subagent.attribution'), {
                objective: item.approval.subagent.objective.slice(0, 120),
              }),
              'subagent-badge',
            ),
          );
        if (item.approval.change) panel.append(diffView(item.approval.change, true));
        const raw = node('details', '', 'approval-raw');
        raw.open = !item.approval.change;
        raw.append(
          node('summary', '完整操作参数'),
          node('p', item.approval.description),
          node('pre', JSON.stringify(item.approval.toolCall.arguments, null, 2)),
        );
        panel.append(raw);
        const actions = node('div', '', 'approval-actions');
        for (const allow of [false, true]) {
          const button = node(
            'button',
            allow ? '允许一次' : '拒绝',
            allow ? 'primary' : 'secondary',
          );
          button.disabled = approvalBusy.has(item.id);
          button.addEventListener('click', () => {
            approvalBusy.add(item.id);
            localError = null;
            render();
            void invoke({ type: 'approve', id: item.id, allow }).finally(() => {
              approvalBusy.delete(item.id);
              render();
            });
          });
          actions.append(button);
        }
        panel.append(actions);
        return panel;
      }),
    );
  }
  questionsView.render(session.questions);
  sessionPanels.todos(session.todos);
  sessionPanels.goal(session.goal);
  sessionPanels.deliverables(session.deliverables);
  const historyStart = session.historyStart ?? 0;
  const end = historyStart + session.messages.length;
  if (paintedWindow?.sessionId !== session.sessionId) holdReadingPosition = false;
  else {
    if (historyStart < paintedWindow.historyStart) holdReadingPosition = true;
    if (end > paintedWindow.end || session.running) holdReadingPosition = false;
  }
  paintedWindow = { sessionId: session.sessionId, historyStart, end };
  if (
    nearBottom &&
    transcriptChanged &&
    !childPageOpen() &&
    !loadingOlderHistory &&
    !holdReadingPosition
  )
    conversation.scrollTop = conversation.scrollHeight;
  updateJumpButton();
}
function updateJumpButton(): void {
  const button = element<HTMLButtonElement>('jump-to-latest');
  button.hidden =
    conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120;
  button.title = t('ui.jumpToLatest');
  button.setAttribute('aria-label', t('ui.jumpToLatest'));
}
/**
 * Whether a sub-agent's record has taken the viewport.
 *
 * The conversation keeps being rendered while a child's page is on screen — the snapshot arrives either way —
 * and its auto-scroll is the one thing that must not run then: following the parent's tail would drag the
 * record the reader is looking at down to the bottom of a conversation they cannot even see.
 */
function childPageOpen(): boolean {
  return document.body.dataset.subagentPage === 'open';
}
const sessionPanels = setupSessionPanels(() => state);

const questionsView = setupQuestions({
  invoke,
  setError: (message) => {
    localError = message;
  },
  requestRender: render,
});

const sessionManagement = setupSessionManagement({ select });
const sessionListView = setupSessionList({
  select,
  createMenuButton: sessionManagement.createMenuButton,
});
prompt.addEventListener('input', () => {
  commandsView.onInput();
});
prompt.addEventListener('keydown', (event) => {
  if (commandsView.onKeydown(event)) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    element<HTMLFormElement>('composer').requestSubmit();
  }
});
window.addEventListener('yuantu-settings-open', () => {
  backgroundView.close();
  transcriptView.saveScroll();
});
window.addEventListener('yuantu-settings-close', () => {
  backgroundView.close();
  transcriptView.restoreScroll();
});

element('load-older-history').addEventListener('click', () => {
  if (operation || composerView.isSending() || state?.session.running || state?.session.loading)
    return;
  let anchor = element('messages').firstElementChild;
  if (anchor instanceof HTMLDetailsElement && anchor.open) {
    const steps = anchor.querySelector<HTMLElement>('.process-steps');
    if (steps)
      anchor =
        Array.from(steps.children).find(
          (step) => step.getBoundingClientRect().bottom > steps.getBoundingClientRect().top,
        ) ?? anchor;
  }
  const top = anchor?.getBoundingClientRect().top;
  loadingOlderHistory = true;
  void select({ type: 'loadOlder' }).finally(() => {
    if (anchor?.isConnected && top !== undefined)
      conversation.scrollTop += anchor.getBoundingClientRect().top - top;
    loadingOlderHistory = false;
  });
});
/**
 * Sections whose change is drawn by one view and by nothing else on the page.
 *
 * A publish names the sections it changed (`snapshot-patch.ts`). Most publishes outside a run are one of these —
 * a background command's output, a task's progress — and redrawing the whole page for them read the
 * conversation's layout and re-keyed every panel for a change one popover shows. A publish that touches any
 * other section takes the full `render()`, exactly as before. `audit` and `backgroundState` are carried for
 * other consumers and drawn by no view here.
 */
const SECTION_VIEWS: Partial<Record<keyof CarrierSnapshot, () => void>> = {
  background: () => backgroundView.render(),
  backgroundState: () => {},
  audit: () => {},
  tasks: renderTasks,
  taskAttempts: renderTasks,
  taskSteps: renderTasks,
};
window.yuantu.subscribe((next, changed) => {
  const first = !state;
  state = next;
  // A recovery notice supersedes the error that caused it: both describe the same crash, and "the app came
  // back and rebuilt the session" is the more useful of the two to leave on screen. Without this the window
  // recovered silently and kept an error banner from the request that died with the Host.
  if (state.recovery) localError = null;
  // A bridge that names no sections (a test double, an older preload) means "anything may have changed".
  if (first || !changed?.length || !changed.every((key) => SECTION_VIEWS[key])) {
    render();
    return;
  }
  for (const view of new Set(changed.map((key) => SECTION_VIEWS[key]!))) view();
});
window.yuantu.subscribeDelta((delta) => {
  liveView.delta(delta);
});
// Sub-agent text takes the same cheap path: one child can stream for minutes while the parent idles,
// and repainting a single card is what keeps that free.
window.yuantu.subscribeSubAgentDelta((delta) => {
  subagentView.delta(delta);
});
// Patch progress into the statistics panel and status line without rebuilding the transcript per token.
window.yuantu.subscribeStatisticsDelta((delta) => {
  statisticsView.delta(delta);
  if (!state || state.session.sessionId !== delta.sessionId) return;
  state = {
    ...state,
    session: { ...state.session, statistics: delta.statistics, statisticsActivity: delta.activity },
  };
  const session = state.session;
  element('run-status').textContent = runStatusText({
    status: session.status,
    compacting: session.compacting,
    approvals: session.approvals.length,
    ready: state.ready,
    loading: session.loading,
    activity: delta.activity,
    tools: session.tools.length,
  });
});
// Every other renderer re-renders on a language change; without this the chat
// surface kept its old locale-formatted timestamps and labels.
onLocaleChange(render);
conversation.addEventListener('scroll', updateJumpButton, { passive: true });
element<HTMLButtonElement>('jump-to-latest').addEventListener('click', () => {
  conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
});
new ResizeObserver(() => {
  element('chat-page').style.setProperty(
    '--composer-height',
    `${element('chat-page').querySelector('.composer-area')!.getBoundingClientRect().height}px`,
  );
  updateJumpButton();
}).observe(element('chat-page').querySelector('.composer-area')!);
setupGeneralSettings();
setupSandboxInitialization();
modelSettings = setupModelSettings(
  () =>
    Boolean(
      operation || composerView.isSending() || state?.session.running || state?.session.loading,
    ),
  (busy) => {
    operation = busy;
    render();
  },
);
// MCP service management is temporarily hidden; keep its renderer for restoration.
if (PRODUCT_SCOPE.mcpManagement)
  mcpSettings = setupMcpSettings(
    () =>
      Boolean(
        operation || composerView.isSending() || state?.session.running || state?.session.loading,
      ),
    (busy) => {
      operation = busy;
      render();
    },
    () => state?.workspace,
  );
permissionSettings = setupPermissionSettings(
  (busy) => {
    operation = busy;
    render();
  },
  // The chip is drawn by the main process's own answer, which arrives before the Host can accept a change: the
  // rungs stay locked until the desktop says it is ready, instead of a click failing with a startup message.
  () => Boolean(state?.ready),
);
void invoke({ type: 'snapshot' }).then(render);
