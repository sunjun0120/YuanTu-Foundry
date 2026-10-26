// Mantine's static stylesheet: esbuild emits it beside the bundle as `renderer.css`, which the page links first.
import '@mantine/core/styles.css';
import { setupTasks } from './renderer-tasks.ts';
import { setupStatistics } from './renderer-statistics.ts';
import { setupWorkspace } from './renderer-workspace.ts';
import { setupSubAgents } from './renderer-subagents.ts';
import { setupMcpSettings } from './renderer-mcp.ts';
import { PRODUCT_SCOPE } from '../../packages/protocol/product-scope.ts';
import type { DesktopBridge, DesktopReply } from './contract.ts';
import { carrierErrorText } from './carrier-errors.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../packages/carrier/contract.ts';
import { createDesktopActions } from './ui/actions.ts';
import { mountDesktopApp } from './ui/App.tsx';
import { createDesktopRuntime } from './ui/runtime.ts';
import { createPendingOperations } from './ui/ui-state.ts';
import type { Message } from '../../packages/protocol/index.ts';
import { setupModelSettings } from './renderer-settings.ts';
import { diffView } from './diff-view.ts';
import { approvalSummary } from './approval-view.ts';
import { setupAttachments } from './renderer-attachments.ts';
import { setupBackgroundView } from './renderer-background.ts';
import { setupCommandPalette } from './renderer-commands.ts';
import { setupComposer } from './renderer-composer.ts';
import { setupLiveMessage } from './renderer-live.ts';
import { setupMessages } from './renderer-messages.ts';
import { setupPlanPanel } from './renderer-plan.ts';
import { setupQuestions } from './renderer-questions.ts';
import { setupSessionPanels } from './renderer-session-panels.ts';
import { setupSessionList, type SessionActivity } from './renderer-session-list.ts';
import { setupTranscript } from './renderer-transcript.ts';
import { setupTurnChanges } from './renderer-changes.ts';
import {
  RUN_CANCELLED,
  runStatusText,
  visibleRunError,
  providerDegradedText,
} from './renderer-status.ts';
import { setupSessionManagement } from './session-management.ts';
import { setupGeneralSettings } from './renderer-general-settings.ts';
import { setupSandboxInitialization } from './renderer-sandbox-setup.ts';
import { setupWorkspaceMaintenance } from './renderer-workspace-maintenance.ts';
import { setupArchivedSessions } from './renderer-archived-sessions.ts';
import { setupPermissionSettings } from './renderer-permissions.ts';
import { setupSelectMenus } from './renderer-select-menu.ts';
import { locale, t, format, onLocaleChange } from './i18n.ts';
import { environmentBlockedCode } from '../../packages/tools/environment-blocked.ts';
import { approvalKey as identicalApprovalKey } from '../../packages/client/approval-key.ts';
import { localizedRunError, runErrorWantsModelSettings } from './renderer-error-text.ts';
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
 * The string is the kernel's, so it is matched rather than re-worded: `agent.ts` uses it as the reason on the
 * run result, the CLI prints it, and a second spelling of "the user stopped this" is a second thing to keep in
 * step. Defined beside `visibleRunError`, which is the other reader of the same marker.
 */
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
 * The two command actions, declared before the panels that take them.
 *
 * They are thin forwarders on purpose: the implementations live in `ui/actions.ts` and are created below, but the
 * panels above this point are registered at module load and need the name now. The wrapper runs only after a click,
 * by which time `actions` exists.
 */
function invoke(command: CarrierCommand): Promise<CarrierSnapshot | null> {
  return actions.invoke(command);
}
function select(command: CarrierCommand): Promise<CarrierSnapshot | null> {
  return actions.select(command);
}
setupSelectMenus();
const statisticsView = setupStatistics();
const workspaceView = setupWorkspace();
const workspaceMaintenance = setupWorkspaceMaintenance();
const archivedSessions = setupArchivedSessions({ select });
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
  async openLocal(path: string) {
    const reply = await window.yuantu.openWorkspacePath?.(path, 'open');
    if (!reply?.ok) throw new Error(reply?.error ?? t('ui.openLinkFailed'));
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
/**
 * A settings form's own busy state, kept apart from the command counter: the settings pages already disable
 * themselves, and one boolean used to carry both meanings.
 */
let externalBusy = false;
const pendingOperations = createPendingOperations();
const runtime = createDesktopRuntime(window.yuantu);
const actions = createDesktopActions({
  bridge: window.yuantu,
  getState: () => state,
  setError: (error) => {
    localError = error;
  },
  requestRender: () => render(),
  // The composer and the attachment list are initialised below; these callbacks run only after the first command.
  isSending: () => composerView.isSending(),
  clearComposer: () => {
    prompt.value = '';
    attachmentsView.clear();
  },
  focusPrompt: () => prompt.focus(),
  pending: pendingOperations,
});
/** Whether the window should present itself as busy: a command in flight, or a settings form saving. */
const isOperating = (): boolean => pendingOperations.isOperating() || externalBusy;
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
  requestRender: render,
  requestComposerUpdate: renderComposerState,
  invoke,
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
  taskView(state, isOperating() || composerView.isSending());
}

/**
 * Which sessions are running and what each waits on, for the session list.
 *
 * Three witnesses, newest wins: the list's own `activeRun` (a run this window never saw start, such as a scheduled
 * task), the runs the controller is following in the background, and the session on screen.
 */
function sessionActivity(snapshot: CarrierSnapshot): Map<string, SessionActivity> {
  const activity = new Map<string, SessionActivity>();
  for (const item of snapshot.sessions)
    if (item.activeRun) activity.set(item.id, { running: true, waiting: 0 });
  for (const run of snapshot.session.otherRuns ?? [])
    activity.set(run.sessionId, {
      running: true,
      waiting: run.approvals.length + run.questions.length,
    });
  const current = snapshot.session;
  if (current.sessionId) {
    const waiting = current.approvals.length + current.questions.length;
    if (current.running || waiting)
      activity.set(current.sessionId, { running: current.running, waiting });
    else activity.delete(current.sessionId);
  }
  return activity;
}
/**
 * Carry on after 停止: one ordinary message, so the transcript shows exactly what the model was told.
 *
 * It is not a resume of the interrupted tool call - the kernel has no such notion, and pretending otherwise
 * would promise a continuation it cannot guarantee. What it removes is the retyping.
 */
function continuePausedRun(): void {
  if (!state || state.session.running || state.session.loading) return;
  void select({ type: 'send', prompt: t('ui.continuePrompt') });
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
  onContinue: () => continuePausedRun(),
  onRequestFullAccess: () => permissionSettings?.requestFullAccess(),
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
  waitingQuestion: () => (state?.session.running ? (state.session.questions[0]?.id ?? null) : null),
  showQuestion: (id) => {
    const card = Array.from(document.querySelectorAll<HTMLElement>('.question-card')).find(
      (card) => card.dataset.questionId === id,
    );
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card?.querySelector<HTMLElement>('button, input, textarea')?.focus({ preventScroll: true });
  },
  // The panel's key holds the window's own in-flight command (`pendingOperations`) and nothing wider: `isBusy` is the
  // separate question that gates the buttons, and it stays separate so the panel repaints exactly when it did.
  isOperating: () => isOperating(),
  isBusy: () => Boolean(state?.session.running || isOperating()),
  select,
  setError: (message) => {
    localError = message;
    render();
  },
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
    isOperating() ||
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
/**
 * Whether the error banner is talking about a dead Windows sandbox lease.
 *
 * That blocker is the one failure in this window whose fix belongs to the window: the kernel's sentence ends by
 * naming `yuantu-agent sandbox-recover`, a CLI the desktop installer does not contain, so without this the person
 * is told to run something they cannot run. The banner shows the actionable sentence and one button instead, and
 * keeps the kernel's own text as the tooltip for whoever wants the details.
 */
function sandboxLeaseBlocked(error: string): boolean {
  return (environmentBlockedCode(error) ?? '').startsWith('windows-sandbox-');
}
/** The status line, from the window's current state; also re-run on a timer while a model is silent. */
function renderRunStatus(): void {
  if (!state) return;
  const session = state.session;
  element('run-status').textContent =
    runStatusText({
      status: session.status,
      compacting: session.compacting,
      approvals: session.approvals.length,
      questions: session.questions.length,
      ready: state.ready,
      loading: session.loading,
      activity: session.statisticsActivity,
      tools: session.tools.length,
      preparation: session.sandboxPreparation[0] ?? null,
      now: Date.now(),
      ...(session.completion ? { completionReason: session.completion.summary.reason } : {}),
    }) + (session.providerDegraded ? ' · ' + providerDegradedText(session.providerDegraded) : '');
}
// Only the "waiting for the model" reading changes with time; the timer is cheap and skips every other state.
window.setInterval(() => {
  const activity = state?.session.statisticsActivity;
  if (state?.session.status === 'running' && activity?.kind === 'model' && !activity.phase)
    renderRunStatus();
}, 1_000);
let sandboxRecoveryNote = '';
let sandboxRecoveryBusy = false;
let sandboxRecovered = false;
let bannerError = '';
function renderErrorBanner(error: string): void {
  bannerError = error;
  const blocked = sandboxLeaseBlocked(error);
  // A failure with a known shape gets a sentence that says what to do; the kernel's own text becomes the
  // tooltip so the detail (a request id, the provider's wording) is still one hover away.
  const translated = error ? localizedRunError(error, locale() === 'en-US') : null;
  element('error').hidden = !error;
  element('error').title = blocked || translated ? error : '';
  element('error-text').textContent = blocked ? t('ui.sandboxBlocked') : (translated ?? error);
  const action = element<HTMLButtonElement>('error-action');
  const settings = !blocked && Boolean(error) && runErrorWantsModelSettings(error);
  action.hidden = settings ? false : !blocked || sandboxRecovered;
  action.disabled = !settings && sandboxRecoveryBusy;
  action.dataset.action = settings ? 'model-settings' : 'sandbox-recovery';
  if (settings) action.textContent = t('ui.openModelSettings');
  else if (blocked)
    action.textContent = sandboxRecoveryBusy
      ? t('ui.sandboxRecovering')
      : t('ui.sandboxRecoveryAction');
  element('error-note').textContent = blocked ? sandboxRecoveryNote : '';
}
/** Put back the workspace permissions a dead sandbox owner left, then say what happened. */
async function recoverSandboxWorkspace(): Promise<void> {
  if (sandboxRecoveryBusy) return;
  sandboxRecoveryBusy = true;
  sandboxRecoveryNote = t('ui.sandboxRecovering');
  renderCurrentError();
  try {
    const reply = await window.yuantu.sandboxRecovery?.({ type: 'recover' });
    if (!reply)
      sandboxRecoveryNote = format(t('ui.sandboxRecoveryFailed'), {
        message: t('ui.operationFailed'),
      });
    else if (!reply.ok)
      sandboxRecoveryNote = format(t('ui.sandboxRecoveryFailed'), {
        message: reply.detail ?? reply.error,
      });
    else if (reply.view.restored.length) {
      sandboxRecovered = true;
      sandboxRecoveryNote = format(t('ui.sandboxRecovered'), {
        count: String(reply.view.restored.length),
      });
    } else sandboxRecoveryNote = t('ui.sandboxRecoveryNothing');
  } catch (cause) {
    sandboxRecoveryNote = format(t('ui.sandboxRecoveryFailed'), {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    sandboxRecoveryBusy = false;
    renderCurrentError();
  }
}
/** Re-draw the banner from the error it already holds, without waiting for the next snapshot. */
function renderCurrentError(): void {
  renderErrorBanner(bannerError);
}
function render(): void {
  if (!state) return;
  // A full paint draws whatever pushes were waiting for the next frame.
  pendingPaint = undefined;
  const session = state.session;
  workspaceMaintenance.update(state);
  archivedSessions.update(state);
  // Every panel in a slot renders here, in the order the slot decides — the built-ins included. Nothing below
  // this line calls a panel directly; adding one is a `register`, not an edit to this function.
  const slotContext: PanelSlotContext = { session, workspace: state.workspace };
  for (const mount of slotMounts) mount.render(slotContext);
  const blocked =
    !state.ready || session.running || session.loading || isOperating() || composerView.isSending();
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
  // A cancelled run and every `needs_review` verdict are statuses, not failures: the conversation and the
  // completion block already say what happened, in the user's language. See `visibleRunError` for the rule and
  // why only the run's own error is suppressed.
  const error = visibleRunError({
    error: stopError,
    sessionError: session.error,
    completion: session.completion?.summary ?? null,
    runStatus: session.status,
  });
  renderErrorBanner(error);
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
  const switchBlocked = !state.ready || session.loading || isOperating();
  element<HTMLButtonElement>('new-session').disabled = switchBlocked;
  element<HTMLButtonElement>('choose-workspace').disabled =
    blocked ||
    (session.otherRuns?.length ?? 0) > 0 ||
    state.sessions.some((item) => item.activeRun);
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
  renderRunStatus();
  element('session-short').textContent = session.sessionId
    ? t('ui.sessionShort', { id: session.sessionId.slice(0, 8) })
    : '';
  element('welcome').hidden = Boolean(session.messages.length || session.running);
  /**
   * The rows are not disabled for a switch in progress: `select` already ignores a click while one runs, and the
   * row menu checks its own `blocked` when clicked. Disabling them rebuilt every row twice per switch and dimmed
   * the whole sidebar for the length of the read — the blink that made a switch look like a reload.
   */
  sessionListView.render(
    state.sessions,
    session.sessionId,
    !state.ready,
    state.sessionsHasMore === true,
    sessionActivity(state),
    Boolean(state.sessionQuery?.trim()),
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
  // An approval does not change once raised, so its id stands for it: the key no longer serializes every diff.
  const nextApprovalKey = JSON.stringify([
    session.approvals.map((item) => item.id),
    [...approvalBusy],
    locale(),
  ]);
  if (nextApprovalKey !== approvalKey) {
    approvalKey = nextApprovalKey;
    // Identical requests waiting together are one card: the controller answers every copy with one click.
    const copies = new Map<string, number>();
    for (const item of session.approvals) {
      const key = identicalApprovalKey(item.approval);
      copies.set(key, (copies.get(key) ?? 0) + 1);
    }
    const drawn = new Set<string>();
    const shown = session.approvals.filter((item) => {
      const key = identicalApprovalKey(item.approval);
      if (drawn.has(key)) return false;
      drawn.add(key);
      return true;
    });
    element('approvals').replaceChildren(
      ...shown.map((item) => {
        const panel = node('section', '', 'approval');
        const summary = approvalSummary(item.approval);
        const count = copies.get(identicalApprovalKey(item.approval)) ?? 1;
        panel.append(
          node('div', t('ui.approvalRequired'), 'approval-label'),
          node('h2', summary.title),
          node('p', summary.why, 'approval-why'),
        );
        if (count > 1)
          panel.append(
            node(
              'p',
              format(t('approval.identicalCount'), { count: String(count) }),
              'approval-meta',
            ),
          );
        if (summary.subject) panel.append(node('pre', summary.subject, 'approval-subject'));
        if (summary.directory)
          panel.append(
            node(
              'p',
              format(t('approval.directory'), { directory: summary.directory }),
              'approval-meta',
            ),
          );
        if (summary.boundary) panel.append(node('p', summary.boundary, 'approval-meta'));
        if (summary.projectConfig)
          panel.append(node('p', summary.projectConfig, 'approval-meta approval-config'));
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
        raw.open = !item.approval.change && !summary.subject;
        raw.append(
          node('summary', t('approval.raw')),
          node('p', item.approval.description),
          node('pre', JSON.stringify(item.approval.toolCall.arguments, null, 2)),
        );
        panel.append(raw);
        const actions = node('div', '', 'approval-actions');
        /*
         * A command approval offers a third answer: allow this exact call for the rest of the session.
         *
         * It is not offered for file changes (a diff is read once and approved once) or external services.
         * The command case is the one where the same call repeats — a test command retried five times used to
         * cost five identical clicks.
         */
        const decisions = [
          { allow: false, remember: false },
          { allow: true, remember: false },
          ...(item.approval.kind === 'command' ? [{ allow: true, remember: true }] : []),
        ];
        for (const decision of decisions) {
          const button = node(
            'button',
            t(
              decision.remember
                ? 'approval.allowSession'
                : decision.allow
                  ? 'approval.allow'
                  : 'approval.deny',
            ),
            decision.remember || !decision.allow ? 'secondary' : 'primary',
          );
          if (decision.remember) {
            button.title = t('approval.allowSessionNote');
            button.setAttribute('aria-label', t('approval.allowSessionNote'));
          }
          button.disabled = approvalBusy.has(item.id);
          button.addEventListener('click', () => {
            approvalBusy.add(item.id);
            localError = null;
            render();
            void invoke({
              type: 'approve',
              id: item.id,
              allow: decision.allow,
              ...(decision.remember ? { remember: true } : {}),
            }).finally(() => {
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
function openWorkspaceFile(path: string, action: 'open' | 'reveal'): void {
  const request = window.yuantu.openWorkspacePath?.(path, action);
  if (!request) return;
  void request
    .then((reply) => {
      if (!reply.ok) {
        localError = reply.error;
        render();
      }
    })
    .catch((error: unknown) => {
      localError = error instanceof Error ? error.message : String(error);
      render();
    });
}
const sessionPanels = setupSessionPanels(
  () => state,
  (path) => void workspaceView.open(path),
  window.yuantu.openWorkspacePath
    ? {
        open: (path) => openWorkspaceFile(path, 'open'),
        reveal: (path) => openWorkspaceFile(path, 'reveal'),
      }
    : undefined,
);

const questionsView = setupQuestions({
  markdownActions,
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
// The one failure in this window whose remedy belongs to the window: put back the workspace permissions a dead
// sandbox owner left, instead of telling the person to run a CLI the desktop does not ship.
element('error-action').addEventListener('click', () => {
  if (element('error-action').dataset.action === 'model-settings') {
    // The same two clicks the command palette's 模型设置 entry makes: open settings, then the model page.
    element('open-settings').dispatchEvent(new Event('click'));
    document.getElementById('model-settings')?.dispatchEvent(new Event('click'));
    return;
  }
  void recoverSandboxWorkspace();
});

element('load-older-history').addEventListener('click', () => {
  if (isOperating() || composerView.isSending() || state?.session.running || state?.session.loading)
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
/**
 * Sections pushed since the last paint, drawn once per frame: `'all'` when one of them needs the full `render()`.
 *
 * `state` follows every push as it arrives, so a click or a delta in between reads the newest one; only the
 * drawing waits. A burst of publishes — a tool finishing as the next starts — used to redraw the page per publish.
 * The timer backs the frame callback up, since a hidden window may not get frames.
 */
let pendingPaint: Set<keyof CarrierSnapshot> | 'all' | undefined;
function paintPending(): void {
  const pending = pendingPaint;
  pendingPaint = undefined;
  if (!pending || !state) return;
  if (pending === 'all') {
    render();
    return;
  }
  for (const view of new Set([...pending].map((key) => SECTION_VIEWS[key]!))) view();
}
// A clicked system notification names the session it was about; the window is already in front by then.
window.yuantu.subscribeOpenSession?.((sessionId) => {
  if (state?.session.sessionId !== sessionId) void select({ type: 'load', id: sessionId });
});
// The runtime owns the bridge subscription; this adapter keeps the old view's frame-coalesced repaint.
runtime.onSnapshot((next, changed) => {
  const first = !state;
  const wasRunning = state?.session.running === true;
  state = next;
  // The workspace tree is a snapshot from the Host, not a filesystem watcher. A run that just ended is exactly
  // when the files it wrote are most likely to be looked for, so re-read it once instead of making the person
  // notice the refresh button.
  if (!first && wasRunning && !next.session.running) workspaceView.refresh();
  // A recovery notice supersedes the error that caused it: both describe the same crash, and "the app came
  // back and rebuilt the session" is the more useful of the two to leave on screen. Without this the window
  // recovered silently and kept an error banner from the request that died with the Host.
  if (state.recovery) localError = null;
  // The first state paints at once: there is nothing on screen yet to keep.
  if (first) {
    render();
    return;
  }
  const scheduled = pendingPaint !== undefined;
  // A bridge that names no sections (a test double, an older preload) means "anything may have changed".
  if (pendingPaint === 'all' || !changed?.length || !changed.every((key) => SECTION_VIEWS[key]))
    pendingPaint = 'all';
  else {
    const sections: Set<keyof CarrierSnapshot> = pendingPaint ?? new Set();
    for (const key of changed) sections.add(key);
    pendingPaint = sections;
  }
  if (scheduled) return;
  requestAnimationFrame(paintPending);
  setTimeout(paintPending, 50);
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
  renderRunStatus();
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
const sandboxInitialization = setupSandboxInitialization();
modelSettings = setupModelSettings(
  () =>
    Boolean(
      isOperating() || composerView.isSending() || state?.session.running || state?.session.loading,
    ),
  (busy) => {
    externalBusy = busy;
    render();
  },
);
// MCP service management is temporarily hidden; keep its renderer for restoration.
if (PRODUCT_SCOPE.mcpManagement)
  mcpSettings = setupMcpSettings(
    () =>
      Boolean(
        isOperating() ||
        composerView.isSending() ||
        state?.session.running ||
        state?.session.loading,
      ),
    (busy) => {
      externalBusy = busy;
      render();
    },
    () => state?.workspace,
  );
permissionSettings = setupPermissionSettings(
  (busy) => {
    externalBusy = busy;
    render();
  },
  // The chip is drawn by the main process's own answer, which arrives before the Host can accept a change: the
  // rungs stay locked until the desktop says it is ready, instead of a click failing with a startup message.
  () => Boolean(state?.ready),
  (mode) => sandboxInitialization.setMode(mode),
);
// The React root is created once, after the legacy DOM exists, and owns only the containers regions hand it.
const disposeDesktopUi = mountDesktopApp({ runtime, actions });
window.addEventListener('pagehide', disposeDesktopUi, { once: true });
// The runtime subscribes first and then asks for the initial snapshot, so nothing published in between is lost.
void runtime
  .start()
  .then(render)
  .catch((error: unknown) => {
    // The initial request's failure is the one error with no push behind it: a refused reply is shown as it came,
    // a transport failure as the connection sentence the old invoke path used.
    localError =
      error && typeof error === 'object' && 'ok' in error && error.ok === false
        ? (error as Extract<DesktopReply, { ok: false }>)
        : error instanceof Error
          ? error.message
          : String(error);
    render();
  });
