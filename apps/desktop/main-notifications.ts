/**
 * Shows the notices `RunWatch` finds as system notifications, and brings the session back when one is clicked.
 *
 * A notice is shown only while the window is not in front: a person looking at the window sees the run end and
 * the panel appear, and the session list marks the others. Clicking it raises the window and opens the session
 * the notice is about.
 */
import { app, Notification, type BrowserWindow } from 'electron';
import type { CarrierSnapshot } from '../../packages/carrier/index.ts';
import { mainText } from './i18n.ts';
import { RunWatch, type RunNotice } from './run-notifications.ts';

/** The id electron-builder installs the Start-menu shortcut under; Windows files toasts by it. */
const APP_USER_MODEL_ID = 'com.yuantu.agent';

export function createRunNotifier(
  getWindow: () => BrowserWindow | null | undefined,
  /** The general-settings switch, read at each notice so a change applies at once. */
  enabled: () => boolean,
  openSession?: (sessionId: string) => void,
): {
  reset(): void;
  update(state: CarrierSnapshot): void;
} {
  // A development run has no shortcut under that id, and Windows drops toasts for an id it does not know.
  if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId(APP_USER_MODEL_ID);
  const watch = new RunWatch();
  // Held until dismissed: a notification the garbage collector takes loses its click handler on Windows.
  const shown = new Set<Notification>();

  function text(notice: RunNotice): { title: string; body: string } {
    if (notice.kind === 'done') return { title: mainText('notify.done'), body: notice.title };
    if (notice.kind === 'failed')
      return { title: mainText('notify.failed'), body: `${notice.title}：${notice.error}` };
    return {
      title: mainText(notice.kind === 'question' ? 'notify.question' : 'notify.approval'),
      body: mainText('notify.waitingBody', { title: notice.title, count: notice.count }),
    };
  }

  function show(notice: RunNotice): void {
    // A Windows notification does not always report `close` when it is dismissed from Action Center; a bounded
    // set keeps a long-running Host from retaining every toast it ever showed.
    if (shown.size >= 64) {
      const oldest = shown.values().next().value;
      if (oldest) {
        shown.delete(oldest);
        oldest.close();
      }
    }
    const notification = new Notification(text(notice));
    shown.add(notification);
    const forget = () => shown.delete(notification);
    notification.on('close', forget);
    notification.on('failed', forget);
    notification.on('click', () => {
      forget();
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (openSession) openSession(notice.sessionId);
      else if (!window.webContents.isDestroyed())
        window.webContents.send('yuantu:open-session', notice.sessionId);
    });
    notification.show();
  }

  return {
    reset: () => watch.reset(),
    update(state) {
      // The comparison runs with the switch off too, so turning it on does not report what changed meanwhile.
      const notices = watch.update(state);
      if (!notices.length || !enabled() || !Notification.isSupported()) return;
      const window = getWindow();
      if (window && !window.isDestroyed() && window.isFocused()) return;
      for (const notice of notices) show(notice);
    },
  };
}
