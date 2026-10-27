import { chrome, updateChrome } from './chrome.ts';
import { mountTasks } from './panels/tasks-mount.tsx';
import { mountStatistics } from './panels/statistics-mount.tsx';
import { mountWorkspace } from './workspace/workspace-mount.tsx';
import { mountSubagents } from './conversation/subagents-mount.tsx';
import { mountTranscript } from './conversation/transcript-mount.tsx';
import { captureHistoryAnchor, restoreAnchor } from './conversation/scroll-anchor.ts';
import { setupMcpSettings } from '../renderer-mcp.ts';
import { PRODUCT_SCOPE } from '../../../packages/protocol/product-scope.ts';
import type { DesktopReply } from '../contract.ts';
import { carrierErrorText } from '../carrier-errors.ts';
import type { CarrierCommand, CarrierSnapshot } from '../../../packages/carrier/contract.ts';
import { createDesktopActions } from './actions.ts';
import { mountGeneralSettings } from './settings/mount.tsx';
import type { DesktopRuntime } from './runtime.ts';
import { createPendingOperations } from './ui-state.ts';
import type { Message } from '../../../packages/protocol/index.ts';
import { connectModelSelection } from './settings/model-selection.ts';
import { mountModelSettings } from './settings/model-mount.tsx';
import { diffView } from '../diff-view.ts';
import { mountAttachments } from './composer/attachment-mount.tsx';
import { mountBackground } from './panels/background-mount.tsx';
import { mountCommandPalette } from './composer/command-mount.tsx';
import { connectComposer } from './composer/bindings.ts';
import { mountLiveMessage } from './conversation/live-message-mount.tsx';
import { createLiveScheduler } from './conversation/live-scheduler.ts';
import { setupMessages } from '../renderer-messages.ts';
import { mountPlanPanel } from './panels/plan-mount.tsx';
import { mountQuestions } from './conversation/questions-mount.tsx';
import { mountApprovals } from './conversation/approvals-mount.tsx';
import { mountSessionPanels } from './panels/session-panels-mount.tsx';
import { mountSessionSidebar } from './sessions/session-mount.tsx';
import type { SessionActivity } from './sessions/session-model.ts';
import { mountTurnChanges } from './conversation/turn-changes-mount.tsx';
import {
  RUN_CANCELLED,
  runStatusText,
  visibleRunError,
  providerDegradedText,
} from '../renderer-status.ts';
import { mountSandboxSetup } from './sandbox/mount.tsx';
import { mountWorkspaceSettings } from './settings/workspace-mount.tsx';
import { mountPermissions } from './permissions/mount.tsx';
import { locale, t, format, onLocaleChange } from '../i18n.ts';
import { environmentBlockedCode } from '../../../packages/tools/environment-blocked.ts';
import { localizedRunError, runErrorWantsModelSettings } from '../renderer-error-text.ts';
import type { ReactNode } from 'react';
import {
  SlotRegistry,
  desktopSlots,
  type DesktopSlotContexts,
  type PanelSlotContext,
} from './slots.tsx';
import { ViewSlot } from './views.tsx';
import { MessageTime, MessageCopy, MessageExtras } from './conversation/MessageContributions.tsx';
import { modelLock } from './settings/model-lock.ts';

/** Window controllers project independent stores; React owns all page and chrome rendering. */
export function connectDesktop(runtime: DesktopRuntime) {
  modelLock.set({ form: false, entry: false, busy: false });
  const lifecycle = new AbortController();
  const disposers: ((() => void) | undefined)[] = [];
  let disposed = false;
  let started = false;
  let paintFrame: number | undefined;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    lifecycle.abort();
    if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
    if (paintTimer !== undefined) clearTimeout(paintTimer);
    for (const release of disposers.reverse()) release?.();
  }
  try {
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

    // Create the product hosts before the controllers bind. Runtime/actions are stable instances shared by every view.
    const pendingOperations = createPendingOperations();

    const actions = createDesktopActions({
      bridge: window.yuantu,
      getState: () => state,
      setError: (error) => {
        localError = error;
      },
      requestRender: () => projectSession(),
      isSending: () => composerView.isSending(),
      clearComposer: () => {
        prompt.value = '';
        attachmentsView.clear();
      },
      focusPrompt: () => prompt.focus(),
      pending: pendingOperations,
    });

    const statisticsView = mountStatistics();

    disposers.push(() => statisticsView.dispose());

    const workspaceView = mountWorkspace({ files: (command) => window.yuantu.files(command) });

    disposers.push(() => workspaceView.dispose());

    const workspaceSettings = mountWorkspaceSettings(window.yuantu, { select });

    disposers.push(() => workspaceSettings.dispose());

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

    const messagesView = setupMessages({ markdownActions });

    const slots = new SlotRegistry<DesktopSlotContexts, ReactNode>();
    desktopSlots.set({ registry: slots, context: null });
    disposers.push(() => {
      if (desktopSlots.getSnapshot()?.registry === slots) desktopSlots.set(null);
    });
    slots.register('sidebar.right', {
      id: 'workspace',
      order: 10,
      render: () => <ViewSlot name="workspace" />,
    });
    const renderExtras = (message: Message): HTMLElement[] =>
      message.role !== 'tool'
        ? []
        : [
            ...(message.images?.length ? [messagesView.imageGallery(message.images)] : []),
            ...(message.change && !message.isError ? [diffView(message.change)] : []),
          ];
    slots.register('tool.result.extra', {
      id: 'tool-extras',
      order: 10,
      render: ({ message }) => <MessageExtras message={message} render={renderExtras} />,
    });
    slots.register('message.footer', {
      id: 'sent-time',
      order: 10,
      render: ({ message }) => <MessageTime message={message} />,
    });
    slots.register('message.actions', {
      id: 'copy-message',
      order: 20,
      render: ({ message }) => <MessageCopy message={message} copy={markdownActions.copy} />,
    });

    const subagentView = mountSubagents({
      getState: () => state,
      send: (command) => invoke(command),
      renderMessage: messagesView.messageView,
    });

    disposers.push(() => subagentView.dispose());

    const prompt = element<HTMLTextAreaElement>('prompt');

    const conversation = element('conversation');

    let state: CarrierSnapshot | null = runtime.getSnapshot();

    let mcpSettings: ReturnType<typeof setupMcpSettings> | undefined;

    let permissionSettings: ReturnType<typeof mountPermissions> | undefined;

    let modelSettings: ReturnType<typeof connectModelSelection> | undefined;

    let localError: string | Extract<DesktopReply, { ok: false }> | null = null;

    /**
     * A settings form's own busy state, kept apart from the command counter: the settings pages already disable
     * themselves, and one boolean used to carry both meanings.
     */
    let externalBusy = false;

    /** Whether the window should present itself as busy: a command in flight, or a settings form saving. */
    const isOperating = (): boolean => pendingOperations.isOperating() || externalBusy;

    let transcriptKey = '';

    /**
     * Where the shown window of history began at the last paint, for the session it belonged to.
     *
     * Following the newest message is for growth at the *end*. Older history arriving at the top also changes the
     * transcript, and a short conversation counts as "near the bottom" even when scrolled to its top — so the
     * snapshot pushed after a load-older reply used to jump the reader to the end, past the step they were on.
     */
    let paintedWindow: { sessionId: string | null; historyStart: number; end: number } | null =
      null;

    /** Set once older history was prepended; cleared by a new message at the end or by another session. */
    let holdReadingPosition = false;

    const commandsView = mountCommandPalette({
      getState: () => state,
      requestRender: projectSession,
      requestComposerUpdate: renderComposerState,
      invoke,
    });

    disposers.push(() => commandsView.dispose());

    const backgroundView = mountBackground({ getState: () => state, invoke });

    disposers.push(() => backgroundView.dispose());

    const attachmentsView = mountAttachments({
      getState: () => state,
      requestRender: projectSession,
      setError: (message) => {
        localError = message;
      },
    });

    disposers.push(() => attachmentsView.dispose());

    const composerView = connectComposer({
      getState: () => state,
      invoke,
      requestRender: projectSession,
      setError: (message) => {
        localError = message;
      },
      attachments: attachmentsView,
      commands: commandsView,
    });

    disposers.push(() => composerView.dispose());

    const taskView = mountTasks(select);

    disposers.push(() => taskView.dispose());

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

    const turnChangesView = mountTurnChanges({
      getState: () => state,
      select,
      preview: (path, content, key) => workspaceView.previewChanges(path, content, key),
      refreshPreview: (key, content) => workspaceView.refreshChangePreview(key, content),
      clearPreviews: () => workspaceView.clearChangePreviews(),
    });

    disposers.push(() => turnChangesView.dispose());

    const transcriptView = mountTranscript({
      getState: () => state,
      messageView: messagesView.messageView,
      turnChanges: () => turnChangesView.cards(),
      onContinue: () => continuePausedRun(),
      onRequestFullAccess: () => permissionSettings?.requestFullAccess(),
    });

    disposers.push(() => transcriptView.dispose());

    const liveMessage = mountLiveMessage({
      actions: markdownActions,
      placeLiveThought: transcriptView.placeLiveThought,
    });

    disposers.push(() => liveMessage.dispose());

    const liveView = createLiveScheduler({
      getState: () => state,
      live: liveMessage,
      updateJumpButton,
      isChildPageOpen: childPageOpen,
      isLoadingOlder: () => loadingOlderHistory,
    });

    disposers.push(() => liveView.dispose());

    const planView = mountPlanPanel({
      waitingQuestion: () =>
        state?.session.running ? (state.session.questions[0]?.id ?? null) : null,
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
        projectSession();
      },
    });

    disposers.push(() => planView.dispose());

    /**
     * The composer's own controls: whether it accepts input, and what the send button does and says.
     *
     * Split out of `render` because typing changes exactly this — an empty prompt disables Send — and nothing else
     * in the window. A keystroke used to repaint every panel, the session list and the transcript key check to flip
     * one button; it now repaints the button.
     */
    function renderComposerState(): void {
      if (disposed) return;
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
      const sendLabel = session.running
        ? composerView.isStopping()
          ? t('ui.stopping')
          : t('ui.stop')
        : t('ui.send');
      updateChrome({
        promptDisabled: composerBlocked,
        sendDisabled: session.running
          ? composerView.isStopping()
          : composerBlocked || (!prompt.value.trim() && !attachmentsView.hasAny()),
        sendMode: session.running ? 'stop' : 'send',
        sendLabel,
        attachDisabled: composerBlocked,
      });
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
      updateChrome({
        runStatus:
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
          }) +
          (session.providerDegraded ? ' · ' + providerDegradedText(session.providerDegraded) : ''),
      });
    }

    // Only the "waiting for the model" reading changes with time; the timer is cheap and skips every other state.
    {
      const ticker = window.setInterval(() => {
        const activity = state?.session.statisticsActivity;
        if (state?.session.status === 'running' && activity?.kind === 'model' && !activity.phase)
          renderRunStatus();
      }, 1_000);
      disposers.push(() => clearInterval(ticker));
    }

    let sandboxRecoveryNote = '';

    let sandboxRecoveryBusy = false;

    let sandboxRecovered = false;

    let bannerError = '';

    function renderErrorBanner(error: string): void {
      bannerError = error;
      const blocked = sandboxLeaseBlocked(error);
      const translated = error ? localizedRunError(error, locale() === 'en-US') : null;
      const settings = !blocked && Boolean(error) && runErrorWantsModelSettings(error);
      const action = settings
        ? 'model-settings'
        : !blocked || sandboxRecovered
          ? null
          : 'sandbox-recovery';
      updateChrome({
        errorVisible: Boolean(error),
        errorTitle: blocked || translated ? error : '',
        errorText: blocked ? t('ui.sandboxBlocked') : (translated ?? error),
        errorAction: action,
        errorActionDisabled: !settings && sandboxRecoveryBusy,
        errorActionText: settings
          ? t('ui.openModelSettings')
          : sandboxRecoveryBusy
            ? t('ui.sandboxRecovering')
            : t('ui.sandboxRecoveryAction'),
        errorNote: blocked ? sandboxRecoveryNote : '',
      });
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

    function projectSession(): void {
      if (!state) return;
      // A full paint draws whatever pushes were waiting for the next frame.
      pendingPaint = undefined;
      const session = state.session;
      workspaceSettings.update(state);
      // Every panel in a slot renders here, in the order the slot decides — the built-ins included. Nothing below
      // this line calls a panel directly; adding one is a `register`, not an edit to this function.
      const slotContext: PanelSlotContext = { session, workspace: state.workspace };
      workspaceView.update(state.workspace);
      desktopSlots.set({ registry: slots, context: slotContext });
      statisticsView.update(state.session);
      const blocked =
        !state.ready ||
        session.running ||
        session.loading ||
        isOperating() ||
        composerView.isSending();
      updateChrome({
        olderVisible: Boolean(session.historyStart && !childPageOpen()),
        olderDisabled: blocked,
        olderText: t('ui.loadOlderHistory', { count: session.historyStart ?? 0 }),
      });
      const nearBottom =
        conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
      const title =
        state.sessions.find((item) => item.id === session.sessionId)?.title || t('ui.newSession');
      updateChrome({ workspace: state.workspace, title });
      backgroundView.render();

      renderTasks();
      modelSettings?.updateBusy();
      mcpSettings?.updateBusy();
      permissionSettings?.updateBusy();
      updateChrome({ configVisible: state.ready && !state.configured });
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
      updateChrome({ notice });
      const switchBlocked = !state.ready || session.loading || isOperating();
      updateChrome({
        canCreate: !switchBlocked,
        canChangeWorkspace: !(
          blocked ||
          (session.otherRuns?.length ?? 0) > 0 ||
          state.sessions.some((item) => item.activeRun)
        ),
      });
      renderComposerState();
      commandsView.update({
        skills: state.resources.skills ?? [],
        disabled: chrome.getSnapshot().promptDisabled,
      });
      /**
       * There is no enqueue-mode control any more: a message typed while the run is live is queued for after the
       * turn, always. The select that chose between that and steering the live run was one more thing in the
       * composer during exactly the moments the composer is not what you are looking at (a question is up, an
       * approval is waiting), and the queue below still says what will happen.
       */
      updateChrome({
        queueText: session.queue
          .map((item) =>
            format(t('ui.queueItem'), {
              mode: item.mode === 'steer' ? t('ui.steerTask') : t('ui.followUp'),
              prompt: item.prompt.slice(0, 100),
            }),
          )
          .join('\n'),
        queueVisible: session.queue.length > 0,
        queueDisabled: composerView.isQueueBusy(),
      });
      renderRunStatus();
      updateChrome({
        sessionShort: session.sessionId
          ? t('ui.sessionShort', { id: session.sessionId.slice(0, 8) })
          : '',
        welcomeVisible: !Boolean(session.messages.length || session.running),
      });
      /**
       * The rows are not disabled for a switch in progress: `select` already ignores a click while one runs, and the
       * row menu checks its own `blocked` when clicked. Disabling them rebuilt every row twice per switch and dimmed
       * the whole sidebar for the length of the read — the blink that made a switch look like a reload.
       */
      sessionSidebar.update({
        sessions: state.sessions,
        currentId: session.sessionId,
        blocked: !state.ready,
        hasMore: state.sessionsHasMore === true,
        searching: Boolean(state.sessionQuery?.trim()),
        activity: sessionActivity(state),
        sessionQuery: state.sessionQuery,
      });
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
        // The rebuild replaces the group that borrowed the live fold; take it back before React unmounts that group.
        liveMessage.releaseThought();
        transcriptView.render(session.messages, session.historyStart ?? 0, paused);
      }
      liveView.sync();
      planView.render(session.plan);
      subagentView.update(session.subagents);
      transcriptView.updateRunning();
      approvalsView.render(session.approvals);
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
      updateChrome({
        jumpVisible:
          conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight >= 120,
      });
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
            projectSession();
          }
        })
        .catch((error: unknown) => {
          localError = error instanceof Error ? error.message : String(error);
          projectSession();
        });
    }

    const sessionPanels = mountSessionPanels(
      () => state,
      (path) => void workspaceView.open(path),
      window.yuantu.openWorkspacePath
        ? {
            open: (path) => openWorkspaceFile(path, 'open'),
            reveal: (path) => openWorkspaceFile(path, 'reveal'),
          }
        : undefined,
    );

    disposers.push(() => sessionPanels.dispose());

    const approvalsView = mountApprovals({
      invoke,
      setError: (message) => {
        localError = message;
      },
    });

    disposers.push(() => approvalsView.dispose());

    const questionsView = mountQuestions({
      markdownActions,
      invoke,
      setError: (message) => {
        localError = message;
      },
      requestRender: projectSession,
    });

    disposers.push(() => questionsView.dispose());

    const sessionSidebar = mountSessionSidebar({ select });

    disposers.push(() => sessionSidebar.dispose());

    prompt.addEventListener(
      'input',
      () => {
        commandsView.onInput();
      },
      { signal: lifecycle.signal },
    );

    prompt.addEventListener(
      'keydown',
      (event) => {
        if (commandsView.onKeydown(event)) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          element<HTMLFormElement>('composer').requestSubmit();
        }
      },
      { signal: lifecycle.signal },
    );

    window.addEventListener(
      'yuantu-settings-open',
      () => {
        backgroundView.close();
        transcriptView.saveScroll();
      },
      { signal: lifecycle.signal },
    );

    window.addEventListener(
      'yuantu-settings-close',
      () => {
        backgroundView.close();
        transcriptView.restoreScroll();
      },
      { signal: lifecycle.signal },
    );

    // The one failure in this window whose remedy belongs to the window: put back the workspace permissions a dead
    // sandbox owner left, instead of telling the person to run a CLI the desktop does not ship.
    element('error-action').addEventListener(
      'click',
      () => {
        if (element('error-action').dataset.action === 'model-settings') {
          // The same two clicks the command palette's 模型设置 entry makes: open settings, then the model page.
          element('open-settings').dispatchEvent(new Event('click'));
          document.getElementById('model-settings')?.dispatchEvent(new Event('click'));
          return;
        }
        void recoverSandboxWorkspace();
      },
      { signal: lifecycle.signal },
    );

    element('load-older-history').addEventListener(
      'click',
      () => {
        if (
          isOperating() ||
          composerView.isSending() ||
          state?.session.running ||
          state?.session.loading
        )
          return;
        // The anchor is the first visible row, or the visible step when that row is an open process group: older steps are
        // inserted above the step being read, not above the fold's own boundary.
        const anchor = captureHistoryAnchor(conversation, element('messages'));
        loadingOlderHistory = true;
        void select({ type: 'loadOlder' }).finally(() => {
          restoreAnchor(conversation, anchor);
          loadingOlderHistory = false;
        });
      },
      { signal: lifecycle.signal },
    );

    /**
     * Sections whose change is drawn by one view and by nothing else on the page.
     *
     * A publish names the sections it changed (`snapshot-patch.ts`). Most publishes outside a run are one of these —
     * a background command's output, a task's progress — and redrawing the whole page for them read the
     * conversation's layout and re-keyed every panel for a change one popover shows. A publish that touches any
     * other section takes the full `projectSession()`, exactly as before. `audit` and `backgroundState` are carried for
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
     * Sections pushed since the last paint, drawn once per frame: `'all'` when one of them needs the full `projectSession()`.
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
        projectSession();
        return;
      }
      for (const view of new Set([...pending].map((key) => SECTION_VIEWS[key]!))) view();
    }

    // A clicked system notification names the session it was about; the window is already in front by then.
    disposers.push(
      window.yuantu.subscribeOpenSession?.((sessionId) => {
        if (state?.session.sessionId !== sessionId) void select({ type: 'load', id: sessionId });
      }),
    );

    // The runtime owns the bridge subscription; this adapter keeps the old view's frame-coalesced repaint.
    disposers.push(
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
          projectSession();
          return;
        }
        const scheduled = pendingPaint !== undefined;
        // A bridge that names no sections (a test double, an older preload) means "anything may have changed".
        if (
          pendingPaint === 'all' ||
          !changed?.length ||
          !changed.every((key) => SECTION_VIEWS[key])
        )
          pendingPaint = 'all';
        else {
          const sections: Set<keyof CarrierSnapshot> = pendingPaint ?? new Set();
          for (const key of changed) sections.add(key);
          pendingPaint = sections;
        }
        if (scheduled) return;
        paintFrame = requestAnimationFrame(paintPending);
        paintTimer = setTimeout(paintPending, 50);
      }),
    );

    disposers.push(
      window.yuantu.subscribeDelta((delta) => {
        liveView.delta(delta);
      }),
    );

    // Sub-agent text takes the same cheap path: one child can stream for minutes while the parent idles,
    // and repainting a single card is what keeps that free.
    disposers.push(
      window.yuantu.subscribeSubAgentDelta((delta) => {
        subagentView.delta(delta);
      }),
    );

    // Patch progress into the statistics panel and status line without rebuilding the transcript per token.
    disposers.push(
      window.yuantu.subscribeStatisticsDelta((delta) => {
        statisticsView.delta(delta);
        if (!state || state.session.sessionId !== delta.sessionId) return;
        state = {
          ...state,
          session: {
            ...state.session,
            statistics: delta.statistics,
            statisticsActivity: delta.activity,
          },
        };
        renderRunStatus();
      }),
    );

    // Every other renderer re-renders on a language change; without this the chat
    // surface kept its old locale-formatted timestamps and labels.
    disposers.push(onLocaleChange(projectSession));

    conversation.addEventListener('scroll', updateJumpButton, {
      ...{ passive: true },
      signal: lifecycle.signal,
    });

    element<HTMLButtonElement>('jump-to-latest').addEventListener(
      'click',
      () => {
        conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
      },
      { signal: lifecycle.signal },
    );

    {
      const observer = new ResizeObserver(() => {
        element('chat-page').style.setProperty(
          '--composer-height',
          `${element('chat-page').querySelector('.composer-area')!.getBoundingClientRect().height}px`,
        );
        updateJumpButton();
      });
      observer.observe(element('chat-page').querySelector('.composer-area')!);
      disposers.push(() => observer.disconnect());
    }

    const sandboxInitialization = mountSandboxSetup(window.yuantu);

    disposers.push(() => sandboxInitialization.dispose());

    modelSettings = connectModelSelection(
      () =>
        Boolean(
          isOperating() ||
          composerView.isSending() ||
          state?.session.running ||
          state?.session.loading,
        ),
      (busy) => {
        externalBusy = busy;
        projectSession();
      },
    );

    disposers.push(() => modelSettings?.dispose());

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
          projectSession();
        },
        () => state?.workspace,
      );

    permissionSettings = mountPermissions(window.yuantu, {
      onBusy: (busy) => {
        externalBusy = busy;
        projectSession();
      },
      // The chip is drawn by the main process's own answer, which arrives before the Host can accept a change: the
      // rungs stay locked until the desktop says it is ready, instead of a click failing with a startup message.
      isReady: () => Boolean(state?.ready),
      onSandboxMode: (mode) => sandboxInitialization.setMode(mode),
    });

    disposers.push(() => permissionSettings?.dispose());

    // Controllers publish ordinary children under the already committed application hosts.
    const disposeGeneralSettings = mountGeneralSettings(window.yuantu);

    disposers.push(disposeGeneralSettings);

    const disposeModelSettings = mountModelSettings(window.yuantu);

    disposers.push(disposeModelSettings);

    return {
      actions,
      dispose,
      start(): void {
        if (started || disposed) return;
        started = true;
        queueMicrotask(() => {
          if (disposed) return;
          void runtime
            .start()
            .then(() => {
              if (!disposed) projectSession();
            })
            .catch((error: unknown) => {
              if (disposed) return;
              // The initial request's failure is the one error with no push behind it: a refused reply is shown as it came,
              // a transport failure as the connection sentence the old invoke path used.
              localError =
                error && typeof error === 'object' && 'ok' in error && error.ok === false
                  ? (error as Extract<DesktopReply, { ok: false }>)
                  : error instanceof Error
                    ? error.message
                    : String(error);
              projectSession();
            });
        });
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
