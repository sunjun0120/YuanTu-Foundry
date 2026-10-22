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
  const uninstall = document.getElementById('sandbox-setup-uninstall') as HTMLButtonElement | null;
  const advanced = document.getElementById('sandbox-read-advanced') as HTMLDetailsElement | null;
  const advancedTitle = document.getElementById('sandbox-read-advanced-title');
  const roots = document.getElementById('sandbox-read-roots');
  const add = document.getElementById('sandbox-read-add') as HTMLButtonElement | null;
  if (!section || !title || !note || !feedback || !initialize) return;
  let view: SandboxSetupView | undefined;
  let pending = false;
  let error = '';
  let diagnosed = false;
  let operation: SandboxSetupCommand['type'] = 'status';

  /** The advanced list: automatic roots are read-only, the user's own each get a remove button. */
  const drawRoots = () => {
    if (!advanced) return;
    // There is nothing to manage before the accounts exist, and a damaged backend cannot answer for the journal.
    advanced.hidden = view?.state !== 'ready';
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

  const draw = () => {
    const state = view?.state;
    title.textContent = t('sandboxSetup.title');
    note.textContent = t('sandboxSetup.note');
    // The long explanation belongs to the uninitialized state; elsewhere the status line says it in one row.
    note.hidden = !view?.ready || state !== 'uninitialized';
    feedback.classList.toggle('error', Boolean(error));
    feedback.textContent = pending
      ? t(
          operation === 'status' || operation === 'verify'
            ? 'sandboxSetup.checking'
            : 'sandboxSetup.pending',
        )
      : error ||
        (state === 'damaged'
          ? `${t('sandboxSetup.damaged')} ${(view?.problems ?? []).map((problem) => t(`sandboxSetup.problem.${problem}`)).join('；')}${view?.details?.length ? ` (${view.details.join('; ')})` : ''}`
          : state === 'ready'
            ? t('sandboxSetup.readyLine')
            : view?.ready
              ? t('sandboxSetup.ready')
              : view?.reason && view.reason !== 'platform'
                ? t(`sandboxSetup.${view.reason}`)
                : '');
    initialize.textContent = t(
      state === 'damaged' ? 'sandboxSetup.repair' : 'sandboxSetup.initialize',
    );
    initialize.hidden = state === 'ready';
    initialize.disabled = pending || !view?.ready || state === 'ready';
    if (uninstall) {
      uninstall.textContent = t('sandboxSetup.uninstall');
      uninstall.hidden = state !== 'ready' && state !== 'damaged';
      uninstall.disabled = pending || !view?.ready || state === 'uninitialized';
    }
    drawRoots();
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
  uninstall?.addEventListener(
    'click',
    () => void request({ type: 'uninstall', acknowledge: true }),
  );
  add?.addEventListener('click', () => void request({ type: 'read-add', acknowledge: true }));
  onLocaleChange(draw);
  void request({ type: 'status' });
}
