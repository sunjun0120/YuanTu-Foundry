import { t, onLocaleChange } from './i18n.ts';
import type { SandboxSetupCommand, SandboxSetupView } from './sandbox-setup.ts';
import type { SandboxMode } from './sandbox-settings.ts';

/**
 * The Windows sandbox accounts, drawn only while they need something from the person.
 *
 * Accounts that still need setting up (or repairing) are one prompt above the composer, offered once per launch:
 * dismissing it leaves the backend as it is, and switching the session back onto the sandbox offers it again.
 * Ready accounts are not drawn anywhere: there is nothing to manage, and the uninstaller removes them. A helper that
 * cannot answer is an installation problem, not a choice the person can make, so the prompt says nothing about it;
 * the main process logs it and a sandboxed command names it when it is refused.
 *
 * Read-only checks on opening; only a deliberate button click requests UAC.
 */
export function setupSandboxInitialization(): { setMode(mode: SandboxMode | undefined): void } {
  const quiet = { setMode() {} };
  const api = window.yuantu.sandboxSetup;
  if (!api) return quiet;
  const prompt = document.getElementById('sandbox-prompt');
  const promptTitle = document.getElementById('sandbox-prompt-title');
  const promptNote = document.getElementById('sandbox-prompt-note');
  const promptFeedback = document.getElementById('sandbox-prompt-feedback');
  const initialize = document.getElementById(
    'sandbox-prompt-initialize',
  ) as HTMLButtonElement | null;
  const dismiss = document.getElementById('sandbox-prompt-dismiss') as HTMLButtonElement | null;
  const weaker = document.getElementById('sandbox-prompt-weak') as HTMLButtonElement | null;
  if (!prompt || !promptTitle || !promptNote || !initialize) return quiet;
  let view: SandboxSetupView | undefined;
  let pending = false;
  let error = '';
  let diagnosed = false;
  let dismissed = false;
  /** Whether the session on screen runs commands through the account backend; unknown counts as yes. */
  let needed = true;
  let operation: SandboxSetupCommand['type'] = 'status';

  const draw = () => {
    const state = view?.state;
    const missing = state === 'uninitialized' || state === 'damaged';
    // Composer: setup or repair, while the session needs it and the person has not set it aside.
    prompt.hidden = !(missing && needed && !dismissed) && !(pending && operation === 'initialize');
    promptTitle.textContent = t(
      state === 'damaged' ? 'sandboxSetup.prompt.repairTitle' : 'sandboxSetup.prompt.title',
    );
    promptNote.textContent =
      state === 'damaged'
        ? `${t('sandboxSetup.damaged')} ${(view?.problems ?? []).map((problem) => t(`sandboxSetup.problem.${problem}`)).join('；')}`
        : t('sandboxSetup.note');
    promptNote.title = state === 'damaged' ? (view?.details ?? []).join('; ') : '';
    if (promptFeedback) {
      const text =
        pending && operation === 'initialize' ? t('sandboxSetup.pending') : missing ? error : '';
      promptFeedback.hidden = !text;
      promptFeedback.textContent = text;
    }
    initialize.textContent = t(
      state === 'damaged' ? 'sandboxSetup.repair' : 'sandboxSetup.initialize',
    );
    initialize.disabled = pending;
    if (dismiss) {
      dismiss.textContent = t('sandboxSetup.prompt.dismiss');
      dismiss.disabled = pending;
    }
    if (weaker) {
      weaker.textContent = t('sandboxSetup.prompt.weak');
      weaker.title = t('sandboxSetup.prompt.weakNote');
      weaker.disabled = pending;
    }
  };

  const request = async (command: SandboxSetupCommand) => {
    if (pending) return;
    pending = true;
    error = '';
    operation = command.type;
    draw();
    try {
      const reply = await api(command);
      if (!reply.ok) throw new Error(reply.error);
      view = reply.view;
    } catch (failure) {
      // A dropped IPC/UAC failure releases controls for retry. A failed initial
      // status cannot accidentally enable the initialization button.
      error = failure instanceof Error ? failure.message : t('sandboxSetup.failed');
    } finally {
      pending = false;
      draw();
    }
    // A damaged backend only says which problems it has: ask the live check once so the list is specific.
    if (view?.state === 'damaged' && !diagnosed) {
      diagnosed = true;
      await request({ type: 'verify' });
    }
  };

  initialize.addEventListener(
    'click',
    () => void request({ type: 'initialize', acknowledge: true }),
  );
  /**
   * The restricted-token backend, for a machine where administrator approval is not available. It is the person's
   * choice, made after reading what it does not confine; the main process switches the session and the permission
   * chip then names it (which also hides this prompt: that session no longer needs the accounts).
   */
  weaker?.addEventListener('click', () => {
    if (pending || !window.confirm(t('sandboxSetup.prompt.weakConfirm'))) return;
    pending = true;
    error = '';
    operation = 'status';
    draw();
    void window.yuantu
      .presets({ type: 'weak-sandbox', acknowledgeWeak: true })
      .then((reply) => {
        if (!reply.ok) throw new Error(reply.error);
      })
      .catch((failure: unknown) => {
        error = failure instanceof Error ? failure.message : t('sandboxSetup.failed');
      })
      .finally(() => {
        pending = false;
        draw();
      });
  });
  dismiss?.addEventListener('click', () => {
    dismissed = true;
    error = '';
    draw();
  });
  onLocaleChange(draw);
  void request({ type: 'status' });
  return {
    setMode(mode) {
      const next = mode === undefined || mode === 'native' || mode === 'windows-account';
      // Moving back onto the sandbox is the moment it is needed again.
      if (next && !needed) dismissed = false;
      needed = next;
      draw();
    },
  };
}
