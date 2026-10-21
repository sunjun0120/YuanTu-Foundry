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
  const uninstall = document.getElementById('sandbox-setup-uninstall') as HTMLButtonElement | null;
  const readPath = document.getElementById('sandbox-read-path') as HTMLInputElement | null;
  const readAdd = document.getElementById('sandbox-read-add') as HTMLButtonElement | null;
  const readRemove = document.getElementById('sandbox-read-remove') as HTMLButtonElement | null;
  if (!section || !title || !note || !feedback || !initialize || !refresh) return;
  let view: SandboxSetupView | undefined;
  let pending = false;
  let error = '';
  let operation: SandboxSetupCommand['type'] = 'status';
  const draw = () => {
    title.textContent = t('sandboxSetup.title');
    note.textContent = t('sandboxSetup.note');
    initialize.textContent = t(
      view?.state === 'damaged' ? 'sandboxSetup.repair' : 'sandboxSetup.initialize',
    );
    refresh.textContent = t('sandboxSetup.refresh');
    for (const part of ['title', 'note', 'add', 'remove']) {
      const element = document.getElementById(`sandbox-read-${part}`);
      if (element) element.textContent = t(`sandboxSetup.read.${part}`);
    }
    if (readPath) readPath.disabled = pending || !view?.ready;
    if (readAdd)
      readAdd.disabled =
        pending || !view?.ready || view.state === 'uninitialized' || !readPath?.value.trim();
    if (readRemove) readRemove.disabled = pending || !view?.ready || !readPath?.value.trim();
    if (uninstall) {
      uninstall.textContent = t('sandboxSetup.uninstall');
      uninstall.disabled = pending || !view?.ready || view.state === 'uninitialized';
    }
    initialize.disabled = pending || !view?.ready || view.installed;
    refresh.disabled = pending;
    feedback.classList.toggle('error', Boolean(error));
    feedback.textContent = pending
      ? t(operation !== 'status' ? 'sandboxSetup.pending' : 'sandboxSetup.checking')
      : error ||
        (view?.state === 'damaged'
          ? `${t('sandboxSetup.damaged')} ${(view.problems ?? []).map((problem) => t(`sandboxSetup.problem.${problem}`)).join('；')}`
          : view?.installed
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
  uninstall?.addEventListener('click', () => request({ type: 'uninstall', acknowledge: true }));
  readPath?.addEventListener('input', draw);
  readAdd?.addEventListener('click', () =>
    request({ type: 'read-add', path: readPath!.value, acknowledge: true }),
  );
  readRemove?.addEventListener('click', () =>
    request({ type: 'read-remove', path: readPath!.value, acknowledge: true }),
  );
  onLocaleChange(draw);
  void request({ type: 'status' });
}
