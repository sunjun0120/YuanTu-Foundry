import { SandboxEnvironment } from './sandbox-environment.ts';
import {
  inspectSandboxRecovery,
  parseSandboxRecoveryCommand,
  recoverSandboxLease,
  type SandboxRecoveryReply,
} from './sandbox-recovery.ts';
import {
  WindowsAccountSandboxSetup,
  parseSandboxSetupCommand,
  waitForSandboxInitialization,
  type SandboxSetupReply,
  type SandboxSetupView,
} from './sandbox-setup.ts';
import { refreshAccountBackend } from '../../packages/tools/sandbox-account.ts';
import { parseFilesCommand, type FilesReply } from './files-contract.ts';
import { maintainWorkspace } from './workspace-maintenance.ts';
import {
  parseWorkspaceMaintenanceCommand,
  type WorkspaceMaintenanceReply,
} from './workspace-maintenance-contract.ts';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  screen,
  shell,
  clipboard,
  Menu,
  nativeTheme,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { CarrierService, parseCarrierCommand } from '../../packages/carrier/index.ts';
import type { CarrierSnapshot } from '../../packages/carrier/index.ts';
import type {
  ArchivedSessionsReply,
  DesktopWireReply,
  OpenWorkspacePathReply,
} from './contract.ts';
import { workspaceFilePath } from './workspace-file-path.ts';
import { SnapshotSender } from './snapshot-patch.ts';
import { createRunNotifier } from './main-notifications.ts';
import { withinQuitDeadline } from './quit-deadline.ts';
import { redactSecrets } from '../../packages/platform/redact.ts';
import { ModelSettingsStore, testModelConnection } from './model-settings.ts';
import { parseSettingsCommand, type SettingsReply } from './settings-contract.ts';
import type { ProviderConfig } from '../../packages/providers/config.ts';
import { discoverModels } from '../../packages/providers/discovery.ts';
import { parseUiSettingsCommand, type UiSettingsReply } from './ui-settings.ts';
import { mainText, setMainLocale } from './i18n.ts';
import { carrierErrorReply } from './carrier-errors.ts';
import { UiSettingsStore } from './ui-settings-store.ts';
import { PermissionSettingsStore } from './permission-settings-store.ts';
import {
  parsePermissionPresetCommand,
  permissionPreset,
  type PermissionPresetReply,
} from './permission-presets.ts';
import { runtimePaths, safeError, type MainContext } from './main-context.ts';
import { SessionChoices, type SessionChoice } from './session-choices.ts';
import { DesktopBackups } from './main-backups.ts';
import { mcpOAuthDirectory, registerMcpIpc } from './main-mcp.ts';
import { confirmUpgradeStartup, desktopRelease, manualUpgrade } from './main-upgrade.ts';
import { workspaceHookReviewer } from './main-hook-trust.ts';
import { registerAttachmentIpc } from './main-attachment.ts';
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  restorableWindowState,
  safeExportName,
  WindowStateStore,
  type WindowState,
} from './window-state.ts';

/**
 * The Electron main process: the window, the settings stores, the IPC channels and the Host child's lifecycle.
 *
 * The bindings below are the process's whole mutable state. Self-contained surfaces live in their own modules
 * (`main-upgrade.ts`, `main-backups.ts`, `main-mcp.ts`, `main-attachment.ts`, `main-hook-trust.ts`,
 * `session-choices.ts`) and see this state through `ctx` — live getters, never copies.
 */
let window: BrowserWindow | null = null;
let service: CarrierService | null = null;
let openingService: CarrierService | null = null;
let unsubscribe: (() => void) | undefined;
/** What the window's mirror already holds; publishes and replies send only what differs from it. */
const snapshotSender = new SnapshotSender();
const runNotifier = createRunNotifier(
  () => window,
  () => uiSettingsStore?.view.notifications !== false,
);
let unsubscribeDelta: (() => void) | undefined;
let unsubscribeSubAgentDelta: (() => void) | undefined;
let unsubscribeStatisticsDelta: (() => void) | undefined;
let switching = false;
let quitting = false;
let quitAllowed = false;
const profileWrites = new Set<Promise<void>>();
let windowStateStore: WindowStateStore | undefined;
let settingsStore: ModelSettingsStore;
let uiSettingsStore: UiSettingsStore;
let permissionSettingsStore: PermissionSettingsStore;
let sandboxEnvironment: SandboxEnvironment;
let sandboxInitializing: Promise<SandboxSetupView> | undefined;
// Replaced, not reused, after an upgrade that aborted it and then failed before quitting: an aborted controller
// stays aborted, and every later connection test or model discovery would fail at once until a restart.
let settingsAbort = new AbortController();
const pagePath = path.join(__dirname, 'index.html');
const trustedUrl = pathToFileURL(pagePath).href;

/** The window's normal (unmaximised) bounds and whether it is maximised, as the next launch should restore them. */
function currentWindowState(): WindowState | null {
  if (!window || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return null;
  return { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
}
/** Saved when the window closes; a failure only costs the next launch its position, so it is not reported. */
function saveWindowState(): void {
  const state = currentWindowState();
  if (state && windowStateStore) void windowStateStore.save(state).catch(() => {});
}

function assertSender(event: Electron.IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== trustedUrl
  )
    throw new Error('Untrusted desktop sender');
}
const ctx: MainContext = {
  get window() {
    return window;
  },
  get service() {
    return service;
  },
  get openingService() {
    return openingService;
  },
  set openingService(next) {
    openingService = next;
  },
  get switching() {
    return switching;
  },
  set switching(next) {
    switching = next;
  },
  get quitting() {
    return quitting;
  },
  set quitting(next) {
    quitting = next;
  },
  get quitAllowed() {
    return quitAllowed;
  },
  set quitAllowed(next) {
    quitAllowed = next;
  },
  get following() {
    return choices.following;
  },
  get settingsAbort() {
    return settingsAbort;
  },
  renewSettingsAbort() {
    if (settingsAbort.signal.aborted) settingsAbort = new AbortController();
  },
  get sandboxEnvironment() {
    return sandboxEnvironment;
  },
  profileWrites,
  createService,
  attach,
  assertSender,
};
const choices = new SessionChoices({
  service: () => service,
  window: () => window,
  sandbox: () => sandboxEnvironment,
});
const backups = new DesktopBackups(ctx);
const reviewWorkspaceHooks = workspaceHookReviewer(() => window);

function createService(workspace: string, config?: ProviderConfig): CarrierService {
  const runtime = runtimePaths();
  return new CarrierService({
    nodePath: runtime.nodePath,
    hostPath: runtime.hostPath,
    workspace,
    env: {
      ...settingsStore.environment(config),
      ...sandboxEnvironment.environment(),
      YUANTU_PERMISSION_POLICY: permissionSettingsStore.file,
      YUANTU_MCP_OAUTH_DIR: mcpOAuthDirectory(),
    },
    // The window has no process-record panel, so the carrier does not read one for it. The desktop smoke
    // suites still assert the record (approval decisions, restart persistence); they opt back in explicitly.
    audit: process.env.FOUNDRY_TEST_DESKTOP_AUDIT === '1',
  });
}
/**
 * The newest published state not yet sent to the window.
 *
 * Host events arrive in bursts — one read of its pipe can carry a tool's finish, a message and the next tool's
 * start — and each one publishes. Sending each publish diffed, serialized and redrew the window once per event;
 * the burst now goes out as one patch at the end of the turn of the event loop that carried it.
 */
let pendingState: CarrierSnapshot | undefined;
let pendingFlush: ReturnType<typeof setImmediate> | undefined;
function flushState(): void {
  if (pendingFlush) clearImmediate(pendingFlush);
  pendingFlush = undefined;
  const state = pendingState;
  pendingState = undefined;
  if (!state || !window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  const patch = snapshotSender.diff(state);
  if (Object.keys(patch.sections).length) window.webContents.send('yuantu:state', patch);
}
/**
 * A command's reply: the snapshot as it is now. A state still waiting to be pushed goes out first, as it did
 * before pushes were batched: the window's listeners are told about a change only by a push, so a reply that
 * absorbed it would leave the page undrawn, and sent after the reply it would carry older values.
 */
function replyPatch(state: CarrierSnapshot) {
  flushState();
  return snapshotSender.diff(state);
}
function attach(next: CarrierService): CarrierService {
  // What the previous service published is no longer the state to show.
  if (pendingFlush) clearImmediate(pendingFlush);
  pendingFlush = undefined;
  pendingState = undefined;
  unsubscribe?.();
  unsubscribeDelta?.();
  unsubscribeSubAgentDelta?.();
  unsubscribeStatisticsDelta?.();
  // A replacement Host starts with launch defaults, even when it loads the same session.
  choices.reset();
  runNotifier.reset();
  service = next;
  unsubscribe = next.subscribe((state) => {
    runNotifier.update(state);
    if (state.ready && state.session.sessionId) choices.follow(state.session.sessionId);
    pendingState = state;
    pendingFlush ??= setImmediate(flushState);
  });
  // Streamed text travels on its own channel so a token never serialises the whole snapshot. A state still
  // waiting to go out is sent first: it may be the one that announces the message this slice belongs to.
  unsubscribeDelta = next.subscribeDelta((delta) => {
    flushState();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:delta', delta);
  });
  unsubscribeSubAgentDelta = next.subscribeSubAgentDelta((delta) => {
    flushState();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:subagent-delta', delta);
  });
  // Usage and activity change once a second during a model call; sending them on their own channel keeps
  // that from serialising the session (images included) across IPC every time the numbers move.
  unsubscribeStatisticsDelta = next.subscribeStatisticsDelta((delta) => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('yuantu:statistics-delta', delta);
  });
  return next;
}

app.setName('YuanTu Agent');
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'YuanTu Agent'));
}
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  console.info('[desktop] Existing window activated.');
  app.quit();
}
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
app.on('before-quit', (event) => {
  if (quitAllowed) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  settingsAbort.abort();
  void (async () => {
    try {
      /**
       * Every step is bounded.
       *
       * The window's close has already been turned into this quit, so a step that never settles leaves a process
       * with no window that cannot be closed again. Each wait reports which step missed its deadline; the quit then
       * continues instead of hanging. The bound is above the Host client's own ten-second kill, so an ordinary slow
       * shutdown still finishes on its own terms.
       */
      const setupSettled = await withinQuitDeadline(
        waitForSandboxInitialization(sandboxInitializing),
        'sandbox setup confirmation',
      );
      await withinQuitDeadline(backups.quiesce(), 'backup quiesce');
      const results = await Promise.allSettled([
        withinQuitDeadline(service?.stop(), 'Host shutdown'),
        withinQuitDeadline(openingService?.stop(), 'Host shutdown'),
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (!setupSettled) throw new Error(mainText('sandboxSetup.exitUnconfirmed'));
      if (failure?.status === 'rejected') throw failure.reason;
    } catch (error) {
      dialog.showErrorBox(mainText('desktop.exitFailureTitle'), safeError(error));
    } finally {
      quitAllowed = true;
      app.quit();
    }
  })();
});
app.on('window-all-closed', () => app.quit());

void app
  .whenReady()
  .then(async () => {
    if (!ownsInstance) return;
    settingsStore = new ModelSettingsStore(
      path.join(app.getPath('userData'), 'model-settings.json'),
      {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      },
    );
    await settingsStore.load();
    backups.start();
    uiSettingsStore = new UiSettingsStore(path.join(app.getPath('userData'), 'ui-settings.json'));
    await uiSettingsStore.load();
    /**
     * The language this process writes its own text in, taken from the settings file rather than from the window.
     *
     * A failure dialog can be raised before the renderer has loaded, so the main process cannot wait to be told:
     * the text it produces is read by a person either way, and the same dictionary answers both sides.
     */
    setMainLocale(uiSettingsStore.view.language);
    /**
     * Native widgets — a `<select>`'s popup above all — are painted by Chromium in the process's theme, not the
     * page's: with the default `system` theme a dark page on a light OS opened every dropdown as a white box
     * before its options drew. Following the saved appearance keeps those widgets on the page's side.
     */
    nativeTheme.themeSource = uiSettingsStore.view.appearance;
    if (app.isPackaged && process.platform === 'win32') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: mainText('upgrade.menu'),
            submenu: [
              {
                label: mainText('upgrade.check'),
                click: () => {
                  void manualUpgrade(ctx, () => backups.quiesce());
                },
              },
              {
                label: mainText('upgrade.about'),
                click: () => {
                  // A damaged install can have a missing or unparseable release file, and an unhandled rejection
                  // here would be an uncaught exception in the main process with no dialog at all.
                  void desktopRelease()
                    .then((release) =>
                      dialog.showMessageBox({
                        message: `YuanTu Agent ${release.version}`,
                        detail: `Channel: ${release.channel}`,
                      }),
                    )
                    .catch((error: unknown) =>
                      dialog.showErrorBox(mainText('upgrade.failed'), safeError(error)),
                    );
                },
              },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
        ]),
      );
    }
    permissionSettingsStore = new PermissionSettingsStore(
      path.join(app.getPath('userData'), 'permission-policy.json'),
    );
    await permissionSettingsStore.load();
    const runtime = runtimePaths();
    sandboxEnvironment = new SandboxEnvironment(process.env, {
      nodePath: runtime.nodePath,
      workerPath: path.join(__dirname, 'sandbox-probe-worker.cjs'),
    });
    const sandboxSetup = new WindowsAccountSandboxSetup({
      platform: process.platform,
      helperPath: path.resolve(__dirname, '../packages/tools/windows-sandbox/yuantu-sandbox.exe'),
      changing: async () => {
        await refreshAccountBackend();
        await service?.refreshSandboxAccounts();
      },
      changed: async () => {
        await refreshAccountBackend();
        await service?.refreshSandboxAccounts();
        await sandboxEnvironment.probe(sandboxEnvironment.defaultMode);
        choices.push();
      },
    });
    // Probe with standalone Node, not Electron's executable; remember each mode's answer.
    void sandboxEnvironment.probe(sandboxEnvironment.defaultMode);
    if (app.isPackaged && runtime.workspace === path.join(app.getPath('userData'), 'workspace'))
      mkdirSync(runtime.workspace, { recursive: true });
    const workspace = realpathSync(runtime.workspace);
    if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
    windowStateStore = new WindowStateStore(
      path.join(app.getPath('userData'), 'window-state.json'),
    );
    const restored = restorableWindowState(
      windowStateStore.load(),
      screen.getAllDisplays().map((display) => display.workArea),
    );
    window = new BrowserWindow({
      ...(restored ? restored.bounds : DEFAULT_WINDOW_SIZE),
      minWidth: MIN_WINDOW_SIZE.width,
      minHeight: MIN_WINDOW_SIZE.height,
      title: 'YuanTu Agent',
      // The colour shown before the page paints, in the same theme it is about to paint.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#f8f9fb',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.removeMenu();
    if (restored?.maximized) window.maximize();
    window.on('close', (event) => {
      saveWindowState();
      if (!quitAllowed) {
        event.preventDefault();
        app.quit();
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    // A (re)loading page starts with an empty mirror, so the next patch has to carry every section.
    window.webContents.on('did-start-loading', () => snapshotSender.reset());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    const initial = attach(createService(workspace));
    backups.register();
    registerAttachmentIpc(ctx, () => uiSettingsStore.view.language);
    ipcMain.handle(
      'yuantu:workspace-maintenance',
      async (event, input: unknown): Promise<WorkspaceMaintenanceReply> => {
        try {
          assertSender(event);
          const command = parseWorkspaceMaintenanceCommand(input);
          if (!service || quitting || switching) throw new Error(mainText('desktop.quitting'));
          const current = service;
          const workspace = current.snapshot.workspace;
          if (command.type === 'list')
            return { ok: true, workspace, items: await current.orphanWorkspaces() };
          switching = true;
          try {
            const sessionId = current.snapshot.session.sessionId;
            return await maintainWorkspace({
              service: current,
              command,
              workspace,
              policyReady: choices.following,
              isCurrent: () =>
                !quitting &&
                current === service &&
                current.snapshot.workspace === workspace &&
                current.snapshot.session.sessionId === sessionId,
            });
          } finally {
            switching = false;
          }
        } catch (error) {
          return carrierErrorReply(error);
        }
      },
    );
    ipcMain.handle('yuantu:archived-sessions', async (event): Promise<ArchivedSessionsReply> => {
      try {
        assertSender(event);
        if (!service || quitting) throw new Error(mainText('desktop.quitting'));
        const current = service;
        const workspace = current.snapshot.workspace;
        return { ok: true, workspace, sessions: await current.archivedSessions() };
      } catch (error) {
        return carrierErrorReply(error);
      }
    });
    ipcMain.handle('yuantu:files', async (event, input: unknown): Promise<FilesReply> => {
      try {
        assertSender(event);
        const command = parseFilesCommand(input);
        if (!service || quitting) throw new Error(mainText('desktop.quitting'));
        /**
         * A round trip to the Host, and nothing else.
         *
         * This handler deliberately does not touch the filesystem: the workspace's containment rule and its
         * ignore list belong to the process that owns the workspace, and a reader here would be a second copy
         * of them — the copy that quietly lists what the file tools refuse.
         */
        return command.type === 'list'
          ? {
              ok: true,
              listing: await service.listWorkspaceFiles(
                command.path === undefined || !command.path ? {} : { path: command.path },
              ),
            }
          : {
              ok: true,
              preview: await service.readWorkspaceFile({
                path: command.path,
                ...(command.locale ? { locale: command.locale } : {}),
              }),
            };
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
    ipcMain.handle(
      'yuantu:open-workspace-path',
      async (event, input: unknown): Promise<OpenWorkspacePathReply> => {
        try {
          assertSender(event);
          if (!service || quitting) throw new Error(mainText('desktop.quitting'));
          if (!input || typeof input !== 'object') throw new Error('Invalid path request');
          const { path: requested, action } = input as {
            path?: unknown;
            action?: unknown;
          };
          if (typeof requested !== 'string' || !requested || requested.length > 4096)
            throw new Error('Invalid workspace path');
          if (requested.includes('\0')) throw new Error('Invalid workspace path');
          if (action !== 'open' && action !== 'reveal') throw new Error('Invalid file action');
          /**
           * Resolve twice: the first check keeps `..` inside the workspace, and the real path check refuses a
           * symlink or junction that points out of it. The runtime directory is never a user-facing file.
           */
          const root = realpathSync.native(service.snapshot.workspace);
          const target = workspaceFilePath(root, requested);
          if (action === 'reveal') shell.showItemInFolder(target);
          else {
            const failure = await shell.openPath(target);
            if (failure) throw new Error(failure);
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      },
    );
    registerMcpIpc(ctx);
    /** Hold the shell operation guard across both halves of a preset update. */
    const assertPresetChangeAllowed = (): void => {
      if (!service || quitting || switching)
        throw new Error('Wait for the current desktop operation before changing the sandbox.');
    };
    ipcMain.handle(
      'yuantu:presets',
      async (event, input: unknown): Promise<PermissionPresetReply> => {
        try {
          assertSender(event);
          const command = parsePermissionPresetCommand(input);
          if (command.type === 'get') {
            // After a switch that failed half way and could not be undone, a read is the retry: the pair in force
            // is unknown until one known pair has been written again.
            if (choices.unknown) {
              assertPresetChangeAllowed();
              switching = true;
              try {
                await choices.recover(service?.snapshot.session.sessionId ?? undefined);
              } finally {
                switching = false;
              }
            }
            return { ok: true, view: choices.view() };
          }
          const preset = permissionPreset(command.preset);
          assertPresetChangeAllowed();
          switching = true;
          try {
            await choices.following;
            const choice: SessionChoice = {
              sandbox: preset.sandbox,
              permission: preset.permission,
            };
            const sessionId = service?.snapshot.session.sessionId ?? undefined;
            await choices.apply(choice, sessionId);
            if (sessionId) choices.remember(sessionId, choice);
            return {
              ok: true,
              view: choices.view(),
              message: `Preset applied: ${preset.sandbox} + ${preset.permission}.`,
            };
          } finally {
            switching = false;
          }
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      },
    );
    ipcMain.handle(
      'yuantu:ui-settings',
      async (event, input: unknown): Promise<UiSettingsReply> => {
        try {
          assertSender(event);
          const command = parseUiSettingsCommand(input);
          if (command.type === 'get')
            return { ok: true, kind: 'settings', settings: uiSettingsStore.view };
          if (quitting || switching) throw new Error(mainText('desktop.quitting'));
          const saving = uiSettingsStore.save(command.settings);
          profileWrites.add(saving);
          try {
            await saving;
          } finally {
            profileWrites.delete(saving);
          }
          // The renderer draws the interface in this language, so the messages this process produces for it have
          // to be in the same one -- otherwise the settings page is English and its validation errors are not.
          setMainLocale(uiSettingsStore.view.language);
          nativeTheme.themeSource = uiSettingsStore.view.appearance;
          return { ok: true, kind: 'settings', settings: uiSettingsStore.view };
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      },
    );
    ipcMain.handle(
      'yuantu:sandbox-setup',
      async (event, input: unknown): Promise<SandboxSetupReply> => {
        try {
          assertSender(event);
          const command = parseSandboxSetupCommand(input);
          if (quitting) throw new Error(mainText('desktop.quitting'));
          if (command.type === 'status') return { ok: true, view: await sandboxSetup.status() };
          if (switching || !service || service.busy) throw new Error(mainText('settingsMain.busy'));
          switching = true;
          try {
            sandboxInitializing =
              command.type === 'initialize'
                ? sandboxSetup.initialize()
                : command.type === 'uninstall'
                  ? sandboxSetup.uninstall()
                  : sandboxSetup.allowRead(command.path, command.type === 'read-remove');
            return { ok: true, view: await sandboxInitializing };
          } finally {
            sandboxInitializing = undefined;
            switching = false;
          }
        } catch (error) {
          console.error('desktop: sandbox initialization request failed', safeError(error));
          return { ok: false, error: mainText('sandboxSetup.failed') };
        }
      },
    );
    ipcMain.handle(
      'yuantu:sandbox-recovery',
      async (event, input: unknown): Promise<SandboxRecoveryReply> => {
        try {
          assertSender(event);
          const command = parseSandboxRecoveryCommand(input);
          if (quitting) throw new Error(mainText('desktop.quitting'));
          return {
            ok: true,
            view:
              command.type === 'status'
                ? await inspectSandboxRecovery()
                : await recoverSandboxLease(),
          };
        } catch (error) {
          // The refusal (a live owner, an unreadable lock) is the reason the person needs; the generic sentence
          // alone would leave them pressing a button that keeps failing.
          console.error('desktop: sandbox recovery request failed', safeError(error));
          return {
            ok: false,
            error: mainText('sandboxSetup.recoveryFailed'),
            detail: safeError(error),
          };
        }
      },
    );
    ipcMain.handle('yuantu:settings', async (event, input: unknown): Promise<SettingsReply> => {
      let submittedKey = '';
      try {
        assertSender(event);
        const command = parseSettingsCommand(input);
        if (quitting) throw new Error(mainText('desktop.quitting'));
        if (command.type === 'get') return { ok: true, settings: settingsStore.view };
        submittedKey = 'values' in command ? command.values.apiKey : '';
        if (!service || switching || service.busy) throw new Error(mainText('settingsMain.busy'));
        if (command.type === 'delete') {
          switching = true;
          try {
            await settingsStore.delete(command.connectionId);
            return {
              ok: true,
              settings: settingsStore.view,
              message: mainText('settingsMain.connectionDeleted'),
            };
          } finally {
            switching = false;
          }
        }
        const preparedGroup =
          command.type === 'save-group' ? settingsStore.prepareGroup(command.values) : null;
        const config =
          command.type === 'select'
            ? settingsStore.configFor(command.connectionId)
            : command.type === 'save-group'
              ? preparedGroup!.activeConfig
              : settingsStore.prepare(command.values);
        switching = true;
        try {
          if (command.type === 'discover') {
            /**
             * The endpoint's own catalogue, read with the credential in the form.
             *
             * This is the desktop half of "capacity comes from the provider": the two numbers a run needs are
             * the ones this runtime refuses to invent, and the endpoint usually publishes them. Nothing is
             * saved and nothing is applied — the renderer fills fields the operator can still edit.
             */
            const discovered = await discoverModels(config, {
              signal: AbortSignal.any([settingsAbort.signal, AbortSignal.timeout(15_000)]),
            });
            return {
              ok: true,
              settings: settingsStore.view,
              discovered,
              message: mainText('settingsMain.modelsRead', { count: discovered.models.length }),
            };
          }
          if (command.type === 'test') {
            await testModelConnection(
              config,
              AbortSignal.any([settingsAbort.signal, AbortSignal.timeout(15_000)]),
            );
            return {
              ok: true,
              settings: settingsStore.view,
              message: mainText('settingsMain.testSucceeded'),
            };
          }
          const previous = service.snapshot;
          const next = createService(previous.workspace, config);
          openingService = next;
          try {
            await next.start(previous.session.sessionId || undefined);
            if (quitting) throw new Error(mainText('desktop.quitting'));
            if (command.type === 'select') await settingsStore.select(command.connectionId);
            else if (preparedGroup) await settingsStore.savePreparedGroup(preparedGroup);
            else await settingsStore.save(config);
            if (quitting) throw new Error(mainText('desktop.quitting'));
            let cleanupWarning = false;
            try {
              await service.stop();
            } catch {
              cleanupWarning = true;
            }
            if (quitting) throw new Error(mainText('desktop.quitting'));
            attach(next);
            await choices.following;
            return {
              ok: true,
              settings: settingsStore.view,
              message: cleanupWarning
                ? mainText('settingsMain.savedCleanupWarning')
                : mainText('settingsMain.saved'),
            };
          } finally {
            try {
              if (service !== next) await next.stop();
            } finally {
              openingService = null;
            }
          }
        } finally {
          switching = false;
        }
      } catch (error) {
        return {
          ok: false,
          error: redactSecrets(safeError(error), { YUANTU_API_KEY: submittedKey }),
        };
      }
    });
    ipcMain.handle('yuantu:command', async (event, input: unknown): Promise<DesktopWireReply> => {
      try {
        assertSender(event);
        const command = parseCarrierCommand(input);
        // The window asks for a snapshot when it starts; whatever it held before, it gets every section.
        if (command.type === 'snapshot') snapshotSender.reset();
        if (command.type === 'sandbox')
          throw new Error('Change the sandbox through a confirmed permission preset.');
        if (!service || quitting) throw new Error('Desktop is shutting down');
        if (command.type === 'copyText') {
          clipboard.writeText(command.text);
          return { ok: true, patch: replyPatch(service.snapshot) };
        }
        if (command.type === 'openLink') {
          await shell.openExternal(command.url);
          return { ok: true, patch: replyPatch(service.snapshot) };
        }
        if (command.type === 'export') {
          const result = await dialog.showSaveDialog(window!, {
            title: mainText('desktop.exportTitle'),
            defaultPath: path.join(
              service.snapshot.workspace,
              safeExportName(command.suggestedName),
            ),
            filters: [
              { name: 'Markdown', extensions: ['md'] },
              { name: mainText('desktop.textFilter'), extensions: ['txt'] },
            ],
          });
          if (!result.canceled && result.filePath)
            await writeFile(result.filePath, command.content, 'utf8');
          return { ok: true, patch: replyPatch(service.snapshot) };
        }
        if (switching && command.type !== 'snapshot') throw new Error('Workspace is changing');
        if (command.type === 'chooseWorkspace') {
          const state = service.snapshot;
          // Changing the workspace replaces the Host, so a run of any session — not only the visible one — holds it.
          if (
            !state.ready ||
            state.session.running ||
            state.session.loading ||
            (state.session.otherRuns?.length ?? 0) > 0 ||
            state.sessions.some((item) => item.activeRun)
          )
            throw new Error('Wait for the current operation to finish');
          switching = true;
          try {
            const result = await dialog.showOpenDialog(window!, {
              title: mainText('desktop.chooseWorkspaceTitle'),
              defaultPath: state.workspace,
              properties: ['openDirectory'],
            });
            if (!result.canceled && result.filePaths[0] && !quitting) {
              const selected = realpathSync(result.filePaths[0]);
              if (selected !== state.workspace) {
                // Before the Host exists: its first run is when an untrusted hook would otherwise execute.
                await reviewWorkspaceHooks(selected);
                const next = createService(selected);
                openingService = next;
                try {
                  await next.start();
                  if (!quitting) {
                    await service.stop();
                    if (!quitting) attach(next);
                  }
                } finally {
                  if (service !== next) await next.stop();
                  openingService = null;
                }
              }
            }
            return { ok: true, patch: replyPatch(service.snapshot) };
          } finally {
            switching = false;
          }
        }
        if (command.type !== 'snapshot') await choices.following;
        const state = await service.dispatch(command);
        if (command.type !== 'snapshot') await choices.following;
        return { ok: true, patch: replyPatch(state) };
      } catch (error) {
        return carrierErrorReply(error);
      }
    });
    await window.loadFile(pagePath);
    window.show();
    // Startup failures remain visible in the chat window; no silent retries of runs.
    // Asked once the window is visible and before the Host starts, so the prompt has a parent and an
    // untrusted SessionStart hook has not had a chance to run.
    if (!quitting) await reviewWorkspaceHooks(workspace);
    if (!quitting)
      await initial
        .start()
        .then(async () => {
          await confirmUpgradeStartup();
          console.info('[desktop] host.ready');
        })
        .catch((error) => {
          if (app.commandLine.hasSwitch('upgrade-journal'))
            dialog.showErrorBox(
              mainText('upgrade.failed'),
              `${safeError(error)}\n${mainText('upgrade.recovery')}`,
            );
        });
  })
  .catch((error) => {
    dialog.showErrorBox(mainText('desktop.startFailureTitle'), safeError(error));
    app.quit();
  });
