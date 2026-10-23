import { t, onLocaleChange } from './i18n.ts';
import type { SandboxSetupCommand, SandboxSetupView } from './sandbox-setup.ts';
import type { SandboxMode } from './sandbox-settings.ts';

/**
 * The Windows sandbox accounts, drawn where they matter and nowhere else.
 *
 * Accounts that still need setting up (or repairing) are one prompt above the composer, offered once per launch:
 * dismissing it leaves the backend as it is, and switching the session back onto the sandbox offers it again.
 * Ready accounts are a settings section (read roots, uninstall). A helper that cannot answer is an installation
 * problem, not a choice the person can make, so neither surface says anything about it; the main process logs it
 * and a sandboxed command names it when it is refused.
 *
 * Read-only checks on opening; only a deliberate button click requests UAC.
 */
export function setupSandboxInitialization(): { setMode(mode: SandboxMode | undefined): void } {
  const quiet = { setMode() {} };
  const api = window.yuantu.sandboxSetup;
  if (!api) return quiet;
  const section = document.getElementById('sandbox-setup-section');
  const title = document.getElementById('sandbox-setup-title');
  const feedback = document.getElementById('sandbox-setup-feedback');
  const uninstall = document.getElementById('sandbox-setup-uninstall') as HTMLButtonElement | null;
  const advanced = document.getElementById('sandbox-read-advanced') as HTMLDetailsElement | null;
  const advancedTitle = document.getElementById('sandbox-read-advanced-title');
  const roots = document.getElementById('sandbox-read-roots');
  const add = document.getElementById('sandbox-read-add') as HTMLButtonElement | null;
  const prompt = document.getElementById('sandbox-prompt');
  const promptTitle = document.getElementById('sandbox-prompt-title');
  const promptNote = document.getElementById('sandbox-prompt-note');
  const promptFeedback = document.getElementById('sandbox-prompt-feedback');
  const initialize = document.getElementById(
    'sandbox-prompt-initialize',
  ) as HTMLButtonElement | null;
  const dismiss = document.getElementById('sandbox-prompt-dismiss') as HTMLButtonElement | null;
  if (!section || !title || !feedback || !prompt || !promptTitle || !promptNote || !initialize)
    return quiet;
  let view: SandboxSetupView | undefined;
  let pending = false;
  let error = '';
  let diagnosed = false;
  let dismissed = false;
  /** Whether the session on screen runs commands through the account backend; unknown counts as yes. */
  let needed = true;
  let operation: SandboxSetupCommand['type'] = 'status';

  /** The advanced list: automatic roots are read-only, the user's own each get a remove button. */
  const drawRoots = () => {
    if (!advanced) return;
    if (advancedTitle) advancedTitle.textContent = t('sandboxSetup.read.advanced');
    if (add) {
      add.textContent = t('sandboxSetup.read.choose');
      add.disabled = pending;
    }
    if (!roots) return;
    const items = (view?.readRoots ?? []).map((root) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = root.path;
      item.append(label);
      if (root.source === 'auto') {
        const badge = document.createElement('small');
        badge.textContent = t('sandboxSetup.read.auto');
        item.append(badge);
      } else {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = t('sandboxSetup.read.removeItem');
        remove.disabled = pending;
        remove.addEventListener('click', () => {
          void request({ type: 'read-remove', path: root.path, acknowledge: true });
        });
        item.append(remove);
      }
      return item;
    });
    roots.replaceChildren(...items);
  };

  const pendingText = () =>
    t(
      operation === 'status' || operation === 'verify'
        ? 'sandboxSetup.checking'
        : 'sandboxSetup.pending',
    );

  const draw = () => {
    const state = view?.state;
    const ready = state === 'ready';
    const missing = state === 'uninitialized' || state === 'damaged';
    // Settings: only accounts that exist have anything to manage.
    section.hidden = !ready;
    title.textContent = t('sandboxSetup.title');
    feedback.classList.toggle('error', Boolean(error) && ready);
    feedback.textContent =
      pending && ready ? pendingText() : (ready && error) || t('sandboxSetup.readyLine');
    if (uninstall) {
      uninstall.textContent = t('sandboxSetup.uninstall');
      uninstall.disabled = pending;
    }
    drawRoots();
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
      const text = pending && operation === 'initialize' ? pendingText() : missing ? error : '';
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
      const before = view?.state;
      view = reply.view;
      // Uninstalling from settings is a fresh need for setup, not one the person already declined.
      if (before === 'ready' && view.state !== 'ready') dismissed = false;
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
  dismiss?.addEventListener('click', () => {
    dismissed = true;
    error = '';
    draw();
  });
  uninstall?.addEventListener(
    'click',
    () => void request({ type: 'uninstall', acknowledge: true }),
  );
  add?.addEventListener('click', () => void request({ type: 'read-add', acknowledge: true }));
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
