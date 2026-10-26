/**
 * The command actions both renderers send through, extracted from the renderer without changing their meaning.
 *
 * `select` is not "invoke with a busy flag": it is the gate that decides whether a command may be sent at all. A run
 * in progress refuses everything except opening or creating a session — the Host is still working in the background
 * and the window should stay usable. Each accepted command owns a pending id, so a fast reply cannot unlock the UI
 * while a second command is still in flight.
 *
 * Two details are preserved on purpose. `searchSessions` clears the previous error and answers without the busy
 * dance: a search is a query, and the reply is not session state. After every other command the prompt is focused
 * again *except* after `loadOlder`, because that one is a scroll gesture and stealing focus back to the composer
 * moves the reader away from the history they just asked for.
 */
import type { CarrierCommand, CarrierSnapshot } from '../../../packages/carrier/contract.ts';
import type { DesktopBridge, DesktopReply } from '../contract.ts';
import { t } from '../i18n.ts';
import type { PendingOperations } from './ui-state.ts';

export type DesktopActionError = string | Extract<DesktopReply, { ok: false }>;

export interface DesktopActionDeps {
  bridge: DesktopBridge;
  getState(): CarrierSnapshot | null;
  /** `null` clears whatever banner is showing. */
  setError(error: DesktopActionError | null): void;
  requestRender(): void;
  /** The composer's own sending state, which outlives a command (a queued follow-up keeps it set). */
  isSending(): boolean;
  /** A session or workspace switch discards the draft and attachments they belonged to. */
  clearComposer(): void;
  focusPrompt(): void;
  pending: PendingOperations;
}

export interface DesktopActions {
  invoke(command: CarrierCommand): Promise<CarrierSnapshot | null>;
  select(command: CarrierCommand): Promise<CarrierSnapshot | null>;
}

export function createDesktopActions(deps: DesktopActionDeps): DesktopActions {
  async function invoke(command: CarrierCommand): Promise<CarrierSnapshot | null> {
    try {
      const reply = await deps.bridge.invoke(command);
      if (!reply.ok) {
        deps.setError(reply);
        deps.requestRender();
        return null;
      }
      return reply.state;
    } catch {
      deps.setError(t('ui.connectionInterrupted'));
      deps.requestRender();
      return null;
    }
  }

  async function select(command: CarrierCommand): Promise<CarrierSnapshot | null> {
    const state = deps.getState();
    // Opening or creating a session leaves a running one going in the Host; anything else waits for it.
    const switching = command.type === 'load' || command.type === 'create';
    if (
      deps.pending.isOperating() ||
      state?.session.loading ||
      (!switching && (deps.isSending() || state?.session.running))
    )
      return null;
    if (command.type === 'searchSessions') {
      deps.setError(null);
      return invoke(command);
    }
    const pendingId = deps.pending.begin();
    deps.setError(null);
    const previousWorkspace = state?.workspace;
    const previousSession = state?.session.sessionId;
    deps.requestRender();
    try {
      const next = await invoke(command);
      if (
        next &&
        (next.workspace !== previousWorkspace || next.session.sessionId !== previousSession)
      )
        deps.clearComposer();
      return next;
    } finally {
      deps.pending.end(pendingId);
      deps.requestRender();
      if (command.type !== 'loadOlder') deps.focusPrompt();
    }
  }

  return { invoke, select };
}
