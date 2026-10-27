/**
 * The composer's permission chip and the full-access confirmation, as data.
 *
 * One choice moves **both** security knobs: `PERMISSION_PRESETS` decides the sandbox and the approval policy
 * together, so the chip can only offer rungs that exist. `custom` is a *reading*, not a target: a pair no preset
 * declares is shown and cannot be selected. `unconfined` goes through the confirmation dialog, and the main process
 * re-checks the same rule.
 *
 * The three states the legacy module had to keep in closures are explicit here: `unreadable` (the pair could not be
 * read, so the chip must not guess), `confirming` (the dialog's subject), and `pending` (a switch in flight). The
 * component draws them; this file decides them.
 */
import { t } from '../../i18n.ts';
import {
  CUSTOM_PRESET,
  PERMISSION_PRESETS,
  type PermissionPresetCommand,
  type PermissionPresetId,
  type PermissionPresetReply,
  type PermissionPresetView,
} from '../../permission-presets.ts';
import type { SandboxMode } from '../../sandbox-settings.ts';
import { createStore, type ReadableStore } from '../stores.ts';

export type PermissionReading = PermissionPresetId | typeof CUSTOM_PRESET;

export function permissionIds(): PermissionPresetId[] {
  return PERMISSION_PRESETS.map((preset) => preset.id);
}

export function permissionLabel(id: PermissionReading): string {
  return t(`permission.label.${id}`);
}

export function permissionSummary(id: PermissionPresetId): string {
  return t(`permission.summary.${id}`);
}

/**
 * What the rung's sandbox does and does not stop.
 */
export function sandboxNote(_mode: SandboxMode | undefined, windowsHost: boolean): string {
  if (!windowsHost) return t('permission.sandbox.seatbelt');
  return t('permission.sandbox.account');
}

export function permissionBoundary(
  id: PermissionReading,
  mode: SandboxMode | undefined,
  windowsHost: boolean,
): string {
  if (id === 'observe') return t('permission.boundary.observe');
  if (id === 'unconfined') return t('permission.boundary.unconfined');
  if (id === CUSTOM_PRESET) return '';
  return t(`permission.boundary.${id}`) + sandboxNote(mode, windowsHost);
}

export interface PermissionState {
  view: PermissionPresetView | undefined;
  pending: boolean;
  ready: boolean;
  unreadable: boolean;
  confirming: PermissionPresetId | undefined;
  menuOpen: boolean;
}

export function permissionReading(state: PermissionState): PermissionReading {
  return state.view?.current ?? CUSTOM_PRESET;
}

export function permissionLocked(state: PermissionState): boolean {
  return state.pending || !state.ready || state.unreadable;
}

/** The label inside the chip; an unreadable pair says so instead of falling through to `custom`. */
export function chipLabel(state: PermissionState): string {
  if (state.unreadable) return t('permission.chip.unknown');
  return permissionLabel(permissionReading(state));
}

export function chipTitle(state: PermissionState, windowsHost: boolean): string {
  if (state.unreadable) return t('permission.unknownTitle');
  const reading = permissionReading(state);
  return reading === CUSTOM_PRESET
    ? ''
    : permissionBoundary(reading, state.view?.sandbox.mode, windowsHost);
}

export function customReading(state: PermissionState): {
  hidden: boolean;
  text: string;
  title: string;
} {
  const reading = permissionReading(state);
  return {
    hidden: reading !== CUSTOM_PRESET,
    title: '',
    text: permissionLabel(CUSTOM_PRESET),
  };
}

export interface PermissionController {
  readonly store: ReadableStore<PermissionState>;
  /** Called after a window render: the ready flag is not the chip's own state. */
  updateBusy(): void;
  refresh(): void;
  requestFullAccess(): void;
  toggleMenu(): void;
  closeMenu(): void;
  choose(id: PermissionReading): void;
  confirm(): void;
  cancel(): void;
  setView(view: PermissionPresetView): void;
  dispose(): void;
}

export function createPermissionController(deps: {
  presets(command: PermissionPresetCommand): Promise<PermissionPresetReply>;
  subscribePresets(listener: (view: PermissionPresetView) => void): () => void;
  isReady(): boolean;
  onBusy(busy: boolean): void;
  onSandboxMode(mode: SandboxMode | undefined): void;
  notify?(message: string): void;
}): PermissionController {
  const store = createStore<PermissionState>({
    view: undefined,
    // Until the first read answers, nothing may move: the chip does not know what is enforced.
    pending: true,
    ready: deps.isReady(),
    unreadable: false,
    confirming: undefined,
    menuOpen: false,
  });
  let disposed = false;
  const update = (patch: Partial<PermissionState>): void => {
    if (!disposed) store.set({ ...store.getSnapshot(), ...patch });
  };
  const notify = (message: string): void => {
    if (deps.notify) deps.notify(message);
    else window.alert(message);
  };
  const messageOf = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : t('permission.failure');
  const adopt = (view: PermissionPresetView): void => {
    update({ view, unreadable: false });
    deps.onSandboxMode(view.sandbox.mode);
  };

  const controller: PermissionController = {
    store,
    updateBusy() {
      update({ ready: deps.isReady() });
    },
    refresh() {
      update({ confirming: undefined, menuOpen: false });
      void read();
    },
    requestFullAccess() {
      controller.choose('unconfined');
    },
    toggleMenu() {
      const state = store.getSnapshot();
      if (state.unreadable) {
        void read();
        return;
      }
      update({ menuOpen: !state.menuOpen });
    },
    closeMenu() {
      update({ menuOpen: false });
    },
    choose(id) {
      const state = store.getSnapshot();
      if (state.pending || id === permissionReading(state)) return;
      if (id === CUSTOM_PRESET) return;
      if (id === 'unconfined') {
        update({ confirming: id, menuOpen: false });
        return;
      }
      void apply(id, false);
    },
    confirm() {
      const preset = store.getSnapshot().confirming;
      if (!preset || store.getSnapshot().pending) return;
      update({ confirming: undefined });
      void apply(preset, true);
    },
    cancel() {
      update({ confirming: undefined });
    },
    setView(view) {
      adopt(view);
    },
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };

  async function apply(preset: PermissionPresetId, acknowledgeHost: boolean): Promise<void> {
    if (store.getSnapshot().pending) return;
    update({ pending: true });
    deps.onBusy(true);
    let failed = false;
    try {
      const reply = await deps.presets({
        type: 'set',
        preset,
        ...(acknowledgeHost ? { acknowledgeHost: true } : {}),
      });
      if (!reply.ok) throw new Error(reply.error);
      adopt(reply.view);
    } catch (error) {
      failed = true;
      notify(messageOf(error));
    } finally {
      update({ pending: false });
      deps.onBusy(false);
    }
    // A switch is two writes; one that failed between them leaves a pair that is neither rung. Read it back rather
    // than drawing the old one.
    if (failed) void read();
  }

  async function read(): Promise<void> {
    update({ pending: true, ready: deps.isReady() });
    try {
      const reply = await deps.presets({ type: 'get' });
      if (!reply.ok) throw new Error(reply.error);
      adopt(reply.view);
    } catch (error) {
      // The previous view may be another session's: it is dropped rather than shown as this one's.
      update({ view: undefined, unreadable: true });
      deps.onSandboxMode(undefined);
      notify(messageOf(error));
    } finally {
      update({ pending: false });
    }
  }

  const unsubscribe = deps.subscribePresets((next) => adopt(next));
  void read();
  return controller;
}
