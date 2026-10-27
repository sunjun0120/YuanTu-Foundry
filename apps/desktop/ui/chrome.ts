import { createStore } from './stores.ts';

export const chrome = createStore({
  workspace: '',
  title: '',
  configVisible: false,
  errorVisible: false,
  errorTitle: '',
  errorText: '',
  errorAction: null as 'model-settings' | 'sandbox-recovery' | null,
  errorActionDisabled: false,
  errorActionText: '',
  errorNote: '',
  notice: '',
  canCreate: false,
  canChangeWorkspace: false,
  promptDisabled: true,
  sendDisabled: true,
  sendMode: 'send' as 'send' | 'stop',
  sendLabel: '',
  attachDisabled: true,
  queueText: '',
  queueVisible: false,
  queueDisabled: false,
  runStatus: '',
  sessionShort: '',
  welcomeVisible: true,
  olderVisible: false,
  olderDisabled: true,
  olderText: '',
  jumpVisible: false,
});

export type ChromeState = ReturnType<typeof chrome.getSnapshot>;

/** Projection is cheap: a repeated status/snapshot does not redraw unchanged chrome. */
export function updateChrome(patch: Partial<ChromeState>): void {
  const previous = chrome.getSnapshot();
  if (
    Object.entries(patch).every(([key, value]) =>
      Object.is(previous[key as keyof ChromeState], value),
    )
  )
    return;
  chrome.set({ ...previous, ...patch });
}
