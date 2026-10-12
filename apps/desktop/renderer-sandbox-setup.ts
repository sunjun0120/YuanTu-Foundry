import { t, onLocaleChange } from './i18n.ts';
import type { SandboxSetupCommand, SandboxSetupView } from './sandbox-setup.ts';

/** Read-only checks on opening; only a deliberate button click requests UAC. */
export function setupSandboxInitialization(): void {
  const api = window.yuantu.sandboxSetup;
  if (!api) return;
  const section = document.getElementById('sandbox-setup-section');
  const title = document.getElementById('sandbox-setup-title');
  const note = document.getElementById('sandbox-setup-note');
  const feedback = document.getElementById('sandbox-setup-feedback');
  const initialize = document.getElementById(
    'sandbox-setup-initialize',
  ) as HTMLButtonElement | null;
  const refresh = document.getElementById('sandbox-setup-refresh') as HTMLButtonElement | null;
  if (!section || !title || !note || !feedback || !initialize || !refresh) return;
  let view: SandboxSetupView | undefined;
  let pending = false;
  let error = '';
  let operation: SandboxSetupCommand['type'] = 'status';
  const draw = () => {
    title.textContent = t('sandboxSetup.title');
    note.textContent = t('sandboxSetup.note');
    initialize.textContent = t('sandboxSetup.initialize');
    refresh.textContent = t('sandboxSetup.refresh');
    initialize.disabled = pending || !view?.ready || view.installed;
    refresh.disabled = pending;
    feedback.classList.toggle('error', Boolean(error));
    feedback.textContent = pending
      ? t(operation === 'initialize' ? 'sandboxSetup.pending' : 'sandboxSetup.checking')
      : error ||
        (view?.installed
          ? t('sandboxSetup.installed')
          : view?.ready
            ? t('sandboxSetup.ready')
            : view?.reason && view.reason !== 'platform'
              ? t(`sandboxSetup.${view.reason}`)
              : '');
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
      section.hidden = !view.supported;
    } catch (failure) {
      // A dropped IPC/UAC failure releases controls for retry. A failed initial
      // status cannot accidentally enable the initialization button.
      error = failure instanceof Error ? failure.message : t('sandboxSetup.failed');
    } finally {
      pending = false;
      draw();
    }
  };
  initialize.addEventListener('click', () => request({ type: 'initialize', acknowledge: true }));
  refresh.addEventListener('click', () => request({ type: 'status' }));
  onLocaleChange(draw);
  void request({ type: 'status' });
}
