/**
 * The Windows sandbox-account prompt above the composer, as data.
 *
 * The prompt is small but its state machine has four independent facts: what the backend says, whether this session's
 * commands even use the account backend, whether the person dismissed the prompt, and whether a request is in flight.
 * The legacy module kept them in one closure and was tested through a hand-written fake document. The controller
 * keeps them apart, so the test can ask "does moving back onto the sandbox offer it again?" without a DOM.
 *
 * Two rules survive verbatim:
 *
 * - `undefined` mode counts as needing accounts (that is the native default), while `windows` and `host` do not;
 * - a damaged backend is diagnosed once with a live `verify`, because the status call only names the problem ids.
 */
import { t } from '../../i18n.ts';
import type { SandboxSetupCommand, SandboxSetupView } from '../../sandbox-setup.ts';
import type { SandboxMode } from '../../sandbox-settings.ts';
import type { PermissionPresetCommand } from '../../permission-presets.ts';
import { createStore, type ReadableStore } from '../stores.ts';

/** Whether this session's commands need the account backend before they can run at all. */
export function commandsNeedSandboxAccounts(input: {
  mode: SandboxMode | undefined;
  state: SandboxSetupView['state'];
}): boolean {
  const accounts =
    input.mode === undefined || input.mode === 'native' || input.mode === 'windows-account';
  return accounts && (input.state === 'uninitialized' || input.state === 'damaged');
}

export function sandboxStateNeedsSetup(state: SandboxSetupView['state']): boolean {
  return state === 'uninitialized' || state === 'damaged';
}

export interface SandboxSetupState {
  view: SandboxSetupView | null;
  pending: boolean;
  error: string;
  dismissed: boolean;
  /** Whether the session on screen uses the account backend; unknown counts as yes. */
  needed: boolean;
  mode: SandboxMode | undefined;
  operation: SandboxSetupCommand['type'];
  started: boolean;
}

export interface SandboxSetupController {
  readonly store: ReadableStore<SandboxSetupState>;
  start(): Promise<void>;
  request(command: SandboxSetupCommand): Promise<void>;
  dismiss(): void;
  chooseWeak(): Promise<void>;
  setMode(mode: SandboxMode | undefined): void;
  dispose(): void;
}

export function sandboxPromptVisible(state: SandboxSetupState): boolean {
  const missing = sandboxStateNeedsSetup(state.view?.state);
  return (
    (missing && state.needed && !state.dismissed) ||
    (state.pending && state.operation === 'initialize')
  );
}

export function sandboxPromptTitleKey(
  state: SandboxSetupView['state'],
): 'sandboxSetup.prompt.repairTitle' | 'sandboxSetup.prompt.title' {
  return state === 'damaged' ? 'sandboxSetup.prompt.repairTitle' : 'sandboxSetup.prompt.title';
}

/**
 * The sentence under the title.
 *
 * "Ready" in the status line means the Host and session are usable and stays true while commands are refused, so a
 * refused command is explained here — the one place a person looks after a command did nothing.
 */
export function sandboxPromptNote(state: SandboxSetupState): string {
  const view = state.view;
  const problems = (view?.problems ?? [])
    .map((problem) => t(`sandboxSetup.problem.${problem}`))
    .join('；');
  const base =
    view?.state === 'damaged' ? `${t('sandboxSetup.damaged')} ${problems}` : t('sandboxSetup.note');
  const unavailable =
    !state.dismissed && commandsNeedSandboxAccounts({ mode: state.mode, state: view?.state });
  return unavailable ? `${t('sandboxSetup.commandsUnavailable')} ${base}` : base;
}

export function sandboxPromptFeedback(state: SandboxSetupState): string {
  if (sandboxStateNeedsSetup(state.view?.state) && state.error) return state.error;
  if (state.pending && state.operation === 'initialize') return t('sandboxSetup.pending');
  return '';
}

export function createSandboxSetupController(deps: {
  api?: (
    command: SandboxSetupCommand,
  ) => Promise<import('../../sandbox-setup.ts').SandboxSetupReply>;
  presets?: (command: PermissionPresetCommand) => Promise<unknown>;
  confirm?(message: string): boolean;
}): SandboxSetupController {
  const store = createStore<SandboxSetupState>({
    view: null,
    pending: false,
    error: '',
    dismissed: false,
    needed: true,
    mode: undefined,
    operation: 'status',
    started: false,
  });
  let disposed = false;
  let diagnosed = false;

  const update = (patch: Partial<SandboxSetupState>): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), ...patch });
  };
  const messageOf = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : t('sandboxSetup.failed');

  const controller: SandboxSetupController = {
    store,
    async start() {
      if (store.getSnapshot().started || !deps.api) return;
      update({ started: true });
      await controller.request({ type: 'status' });
    },
    async request(command) {
      if (disposed || store.getSnapshot().pending || !deps.api) return;
      update({ pending: true, error: '', operation: command.type });
      try {
        const reply = await deps.api(command);
        if (disposed) return;
        if (!reply.ok) throw new Error(reply.error);
        update({ view: reply.view });
      } catch (error) {
        if (!disposed) update({ error: messageOf(error) });
      } finally {
        if (!disposed) update({ pending: false });
      }
      // A damaged backend only names its problem ids; ask the live check once so the list is specific.
      if (!disposed && store.getSnapshot().view?.state === 'damaged' && !diagnosed) {
        diagnosed = true;
        await controller.request({ type: 'verify' });
      }
    },
    dismiss() {
      update({ dismissed: true, error: '' });
    },
    async chooseWeak() {
      const state = store.getSnapshot();
      if (disposed || state.pending || !deps.presets) return;
      const confirm = deps.confirm ?? ((message: string) => window.confirm(message));
      if (!confirm(t('sandboxSetup.prompt.weakConfirm'))) return;
      update({ pending: true, error: '', operation: 'status' });
      try {
        const reply = (await deps.presets({
          type: 'weak-sandbox',
          acknowledgeWeak: true,
        })) as { ok: boolean; error?: string };
        if (!reply.ok) throw new Error(reply.error ?? t('sandboxSetup.failed'));
      } catch (error) {
        update({ error: messageOf(error) });
      } finally {
        update({ pending: false });
      }
    },
    setMode(mode) {
      const needed = mode === undefined || mode === 'native' || mode === 'windows-account';
      const state = store.getSnapshot();
      // Moving back onto the sandbox is the moment it is needed again.
      update({ needed, mode, dismissed: needed && !state.needed ? false : state.dismissed });
    },
    dispose() {
      disposed = true;
    },
  };
  return controller;
}
