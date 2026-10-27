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
import { existsSync, realpathSync } from 'node:fs';
import { CarrierService, parseCarrierCommand } from '../../packages/carrier/index.ts';
import type { CarrierSnapshot } from '../../packages/carrier/index.ts';
import type {
  ArchivedSessionsReply,
  DesktopWireReply,
  OpenWorkspacePathReply,
} from './contract.ts';
import { workspaceFilePath } from './workspace-file-path.ts';
import { BrowserViews } from './browser-views.ts';
import { parseBrowserCommand, type BrowserReply } from './browser-contract.ts';
import { ProjectWorkspacesStore } from './project-workspaces-store.ts';
import {
  parseProjectWorkspaceCommand,
  type ProjectRuntimeView,
  type ProjectWorkspaceReply,
} from './project-workspaces-contract.ts';
import { ProjectWorkspaces, resolveStartupWorkspace, samePath } from './main-project-workspaces.ts';
import { WorkspaceHostManager } from './workspace-host-manager.ts';
import { workspaceTarget, type WorkspaceTarget, type WorkspaceEvent } from './workspace-routing.ts';
import { SnapshotSender } from './snapshot-patch.ts';
import { createRunNotifier } from './main-notifications.ts';
import { withinQuitDeadline } from './quit-deadline.ts';
import { redactSecrets } from '../../packages/platform/redact.ts';
import { startupEnvironmentCheck, startupEnvironmentProblems } from './startup-environment.ts';
import { ModelSettingsStore, testModelConnection } from './model-settings.ts';
import { parseSettingsCommand, type SettingsReply } from './settings-contract.ts';
import type { ProviderConfig } from '../../packages/providers/config.ts';
import type { ModelCatalogConfiguration } from '../../packages/protocol/model-configuration.ts';
import { discoverModels } from '../../packages/providers/discovery.ts';
import { parseUiSettingsCommand, type UiSettingsReply } from './ui-settings.ts';
import { mainText, setMainLocale } from './i18n.ts';
import { conversationMarkdown } from './renderer-export.ts';
import { carrierErrorReply } from './carrier-errors.ts';
import { UiSettingsStore } from './ui-settings-store.ts';
import { PermissionSettingsStore } from './permission-settings-store.ts';
import {
  parsePermissionPresetCommand,
  permissionPreset,
  type PermissionPresetReply,
} from './permission-presets.ts';
import { runtimePaths, safeError, type MainContext } from './main-context.ts';
import { MissingDevelopmentNode } from './install-paths.ts';
import { SessionChoices, choiceForPreset, type SessionChoice } from './session-choices.ts';
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
 * (`main-upgrade.ts`, `main-attachment.ts`, `main-hook-trust.ts`,
 * `session-choices.ts`) and see this state through `ctx` — live getters, never copies.
 */
let window: BrowserWindow | null = null;
let browserViews: BrowserViews | null = null;
let projectWorkspaces: ProjectWorkspaces | null = null;
let workspaceHosts: WorkspaceHostManager<CarrierService> | null = null;
/** Background workspace state for the left sidebar: running and waiting counts, not a second renderer snapshot. */
const workspaceRuntime = new Map<string, ProjectRuntimeView>();
const workspaceWatchers = new Map<string, () => void>();
const workspaceRoutes = new Map<
  string,
  {
    host: CarrierService;
    target: WorkspaceTarget;
    sender: SnapshotSender;
    choices: SessionChoices;
    empty?: boolean;
  }
>();
let nextHostEpoch = 0;
let selectionVersion = 0;
function sendWorkspace(event: WorkspaceEvent): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send('yuantu:workspace-event', event);
}
function routeFor(host: CarrierService) {
  const route = [...workspaceRoutes.values()].find((entry) => entry.host === host);
  if (!route) throw new Error('Workspace Host is no longer registered');
  return route;
}
function routedService(target: unknown, allowEmpty = false): CarrierService {
  const scope = workspaceTarget(target);
  const route = workspaceRoutes.get(scope.workspaceId);
  if (!route || route.target.hostEpoch !== scope.hostEpoch)
    throw new Error('Workspace Host has changed; retry the operation');
  if (route.empty && !allowEmpty) throw new Error('Add a workspace before using project commands');
  return route.host;
}
function workspaceSnapshot(host: CarrierService): CarrierSnapshot {
  const route = routeFor(host);
  return route.empty ? { ...host.snapshot, workspace: '' } : host.snapshot;
}
function watchHost(workspaceId: string, host: CarrierService, empty = false): void {
  workspaceWatchers.get(workspaceId)?.();
  const target = { workspaceId, hostEpoch: ++nextHostEpoch };
  const sender = new SnapshotSender();
  const notifier = createRunNotifier(
    () => window,
    () => uiSettingsStore?.view.notifications !== false,
    (sessionId) => {
      if (window && !window.isDestroyed())
        window.webContents.send('yuantu:open-workspace-session', { ...target, sessionId });
    },
  );
  const hostChoices = new SessionChoices({
    service: () => host,
    window: () => (service === host ? window : null),
    sandbox: () => sandboxEnvironment,
    publish: (view) => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send('yuantu:workspace-presets', { ...target, view });
    },
  });
  workspaceRoutes.set(workspaceId, { host, target, sender, choices: hostChoices, empty });
  let pending: CarrierSnapshot | undefined;
  let timer: ReturnType<typeof setImmediate> | undefined;
  let lastPid: number | null = null;
  let recovered = false;
  const flush = () => {
    if (timer) clearImmediate(timer);
    timer = undefined;
    if (!pending) return;
    const patch = sender.diff(workspaceSnapshot(host));
    pending = undefined;
    if (Object.keys(patch.sections).length)
      sendWorkspace({
        ...target,
        type: 'state',
        patch,
        ...(recovered && service === host ? { active: true, selection: selectionVersion } : {}),
      });
    recovered = false;
  };
  const stops = [
    host.subscribeDelta((delta) => {
      flush();
      sendWorkspace({ ...target, type: 'delta', delta });
    }),
    host.subscribeSubAgentDelta((delta) => {
      flush();
      sendWorkspace({ ...target, type: 'subagent', delta });
    }),
    host.subscribeStatisticsDelta((delta) => {
      flush();
      sendWorkspace({ ...target, type: 'statistics', delta });
    }),
  ];
  workspaceWatchers.set(
    workspaceId,
    (() => {
      const stop = host.subscribe((state) => {
        if (state.hostPid && lastPid && state.hostPid !== lastPid) {
          target.hostEpoch = ++nextHostEpoch;
          sender.reset();
          recovered = true;
        }
        if (state.hostPid) lastPid = state.hostPid;
        pending = state;
        timer ??= setImmediate(flush);
        if (state.ready && state.session.sessionId) hostChoices.follow(state.session.sessionId);
        const other = state.session.otherRuns ?? [];
        workspaceRuntime.set(workspaceId, {
          ready: state.ready,
          running: state.session.running || other.length > 0,
          waiting:
            state.session.approvals.length +
            state.session.questions.length +
            other.reduce((count, run) => count + run.approvals.length + run.questions.length, 0),
          sessions: state.sessions
            .filter((session) => !session.parentSessionId)
            .slice(0, 20)
            .map((session) => {
              const otherRun = other.find((run) => run.sessionId === session.id);
              const waiting =
                (session.id === state.session.sessionId
                  ? state.session.approvals.length + state.session.questions.length
                  : 0) + (otherRun ? otherRun.approvals.length + otherRun.questions.length : 0);
              return {
                id: session.id,
                title: session.title ?? '',
                running: Boolean(session.activeRun),
                waiting,
              };
            }),
        });
        notifier.update(state);
      });
      return () => {
        stop();
        stops.forEach((dispose) => dispose());
        if (timer) clearImmediate(timer);
      };
    })(),
  );
}
/** The last workspace/session pair written to the registry; a snapshot burst must not rewrite the file. */
let recordedLastSession = '';
async function noteLastSession(state: CarrierSnapshot): Promise<void> {
  const workspaces = projectWorkspaces;
  const sessionId = state.session.sessionId;
  if (!workspaces || !state.ready || !sessionId) return;
  const key = `${state.workspace}\n${sessionId}`;
  if (key === recordedLastSession) return;
  recordedLastSession = key;
  try {
    const registry = await workspaces.list();
    const entry = registry.workspaces.find(
      (workspace) => !workspace.removed && samePath(workspace.canonicalPath, state.workspace),
    );
    if (entry && entry.lastSessionId !== sessionId)
      await workspaces.setLastSession(entry.id, sessionId);
  } catch {
    /* The session is still usable when the registry is momentarily unreadable or unwritable. */
  }
}
let service: CarrierService | null = null;
let openingService: CarrierService | null = null;
let unsubscribe: (() => void) | undefined;
/** What the window's mirror already holds; publishes and replies send only what differs from it. */
const snapshotSender = new SnapshotSender();
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
  get services() {
    return [
      ...new Set(
        [...workspaceRoutes.values()].filter((route) => !route.empty).map((route) => route.host),
      ),
    ];
  },
  async stopServices() {
    if (workspaceHosts) await workspaceHosts.stopAll();
    else await service?.stop();
    await openingService?.stop();
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
let choices = new SessionChoices({
  service: () => service,
  window: () => window,
  sandbox: () => sandboxEnvironment,
});
const reviewWorkspaceHooks = workspaceHookReviewer(() => window);

function hostEnvironment(config?: ProviderConfig): NodeJS.ProcessEnv {
  return {
    ...settingsStore.environment(config),
    ...sandboxEnvironment.environment(),
    YUANTU_PERMISSION_POLICY: permissionSettingsStore.file,
    YUANTU_MCP_OAUTH_DIR: path.join(app.getPath('userData'), 'mcp-oauth'),
    // The Host runs on its own Node; this is how its Windows sandbox learns which Electron must stay out of a grant.
    YUANTU_DESKTOP_EXECUTABLE: process.execPath,
  };
}
function modelSettingsView() {
  const view = settingsStore.view;
  const selection = service?.selectedModel;
  const selected = selection?.connectionId
    ? view.connections.find((row) => row.connectionId === selection.connectionId)
    : undefined;
  return {
    ...view,
    ...(selected ??
      (selection?.connectionId
        ? {
            connectionId: selection.connectionId,
            model: '',
            source: 'empty' as const,
            error: mainText('settings.connectionMissing'),
          }
        : {})),
    environmentProblems: startupEnvironmentProblems(process.env, hostEnvironment()),
  };
}
function createService(workspace: string, config?: ProviderConfig): CarrierService {
  const runtime = runtimePaths();
  const env = hostEnvironment(config);
  /**
   * The environment this Host will actually receive, checked before a process exists.
   *
   * `process.env` first, then the desktop's own keys, which is the order the carrier spawns with
   * (`{ ...process.env, ...this.env }`): checking only `process.env` would miss every variable the settings store
   * injects, and checking only `env` would misreport one the desktop overrides. The Host refuses an unknown or
   * invalid `YUANTU_*` name by exiting, and what the window can say about an exit is "restart" — which is wrong
   * advice for a name that has to be corrected first. So the list is produced here, before the spawn, and carried
   * as the start failure itself.
   */
  const startupCheck = startupEnvironmentCheck(startupEnvironmentProblems(process.env, env));
  return new CarrierService({
    nodePath: runtime.nodePath,
    hostPath: runtime.hostPath,
    workspace,
    env,
    modelCatalog: settingsStore.runtimeCatalog,
    ...(startupCheck ? { startupCheck } : {}),
    // The window has no process-record panel, so the carrier does not read one for it. The desktop smoke
    // suites still assert the record (approval decisions, restart persistence); they opt back in explicitly.
    audit: process.env.FOUNDRY_TEST_DESKTOP_AUDIT === '1',
  });
}
async function configureModelCatalog(catalog: ModelCatalogConfiguration): Promise<void> {
  const hosts = new Set(
    [...workspaceRoutes.values()].map((route) => route.host).filter((host) => host.snapshot.ready),
  );
  const results = await Promise.allSettled([...hosts].map((host) => host.configureModels(catalog)));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
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
  const route = [...workspaceRoutes.values()].find((entry) => entry.host === next);
  if (route) choices = route.choices;
  service = next;
  if (route) choices.push();
  if (route) {
    route.sender.reset();
    sendWorkspace({
      ...route.target,
      type: 'state',
      active: true,
      selection: selectionVersion,
      patch: route.sender.diff(workspaceSnapshot(next)),
    });
  }
  unsubscribe = next.subscribe((state) => {
    const recording = noteLastSession(state);
    profileWrites.add(recording);
    void recording.finally(() => profileWrites.delete(recording));
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
  // that from serialising the session (images included) across IPC every time the numbers move. A state still
  // waiting to go out is sent first, as for the other channels: the window replaces its whole state with each
  // push, so a batched push taken before this delta and sent after it would put the old activity back — a run
  // whose request was already out then read "preparing the request" until the model's first token arrived.
  unsubscribeStatisticsDelta = next.subscribeStatisticsDelta((delta) => {
    flushState();
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
      const results = workspaceHosts
        ? await Promise.allSettled([
            withinQuitDeadline(workspaceHosts.stopAll(), 'Host shutdown'),
            withinQuitDeadline(Promise.all([...profileWrites]), 'Profile writes'),
          ])
        : await Promise.allSettled([
            withinQuitDeadline(service?.stop(), 'Host shutdown'),
            withinQuitDeadline(openingService?.stop(), 'Host shutdown'),
            withinQuitDeadline(Promise.all([...profileWrites]), 'Profile writes'),
          ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (!setupSettled) throw new Error(mainText('sandboxSetup.exitUnconfirmed'));
      if (failure?.status === 'rejected') throw failure.reason;
    } catch (error) {
      dialog.showErrorBox(mainText('desktop.exitFailureTitle'), safeError(error));
    } finally {
      browserViews?.destroyAll();
      browserViews = null;
      quitAllowed = true;
      app.quit();
    }
  })();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (window && !window.isDestroyed()) window.show();
});

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
                  void manualUpgrade(ctx);
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
    const sandboxHelper = path.resolve(
      __dirname,
      '../packages/tools/windows-sandbox/yuantu-sandbox.exe',
    );
    // A missing helper is a broken installation, not a setting: the window stays silent about it, the log says
    // so once, and a sandboxed command that is refused names the reinstall.
    if (process.platform === 'win32' && !existsSync(sandboxHelper))
      console.error(
        'desktop: the Windows sandbox helper is missing; reinstall YuanTu',
        sandboxHelper,
      );
    const sandboxSetup = new WindowsAccountSandboxSetup({
      platform: process.platform,
      helperPath: sandboxHelper,
      // A read root is chosen in the native picker and never typed into the page: the journal, not the renderer, is
      // the list of what may be removed.
      chooseDirectory: async () => {
        if (!window) return undefined;
        const picked = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
        return picked.canceled ? undefined : picked.filePaths[0];
      },
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
    const projectStore = new ProjectWorkspacesStore(
      path.join(app.getPath('userData'), 'project-workspaces.json'),
    );
    const explicitWorkspace =
      process.argv.find((arg) => arg.startsWith('--workspace='))?.slice('--workspace='.length) ||
      process.env.YUANTU_WORKSPACE;
    const installDirectory = app.isPackaged ? path.dirname(app.getPath('exe')) : undefined;
    const started = await resolveStartupWorkspace(projectStore, {
      explicitPath: explicitWorkspace,
      fallbackPath: path.join(app.getPath('userData'), 'workspace'),
      installDirectory,
    });
    projectWorkspaces = new ProjectWorkspaces(projectStore, installDirectory);
    const workspace = started.workspace;
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
      // macOS keeps an app alive with its window closed: the red button hides the window and running work goes
      // on, the Dock icon brings it back, and Cmd+Q is the quit (its `before-quit` has already set `quitting`).
      if (process.platform === 'darwin' && !quitting && !quitAllowed) {
        event.preventDefault();
        window?.hide();
        return;
      }
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
    browserViews = new BrowserViews(window, (event) => {
      if (window && !window.isDestroyed()) window.webContents.send('yuantu:browser-event', event);
    });
    // The guest is a child view, not part of the page: hiding or minimising the window must hide it too, and a
    // restored window asks the renderer to re-measure rather than trusting the bounds it sent before the hide.
    window.on('hide', () => browserViews?.hideAll());
    window.on('minimize', () => browserViews?.hideAll());
    window.on('show', () => browserViews?.requestLayout());
    window.on('restore', () => browserViews?.requestLayout());
    window.on('closed', () => {
      browserViews?.destroyAll();
      browserViews = null;
    });
    workspaceHosts = new WorkspaceHostManager(
      (id, hostPath) => {
        const host = createService(hostPath);
        watchHost(id, host);
        return host;
      },
      {
        isBusy: (host) =>
          host.busy ||
          host.snapshot.session.running ||
          host.snapshot.session.queue.length > 0 ||
          host.snapshot.session.approvals.length > 0 ||
          host.snapshot.session.questions.length > 0 ||
          (host.snapshot.session.otherRuns?.length ?? 0) > 0 ||
          host.snapshot.sessions.some((session) => Boolean(session.activeRun)),
      },
    );
    const idleTimer = setInterval(() => {
      if (quitting || switching) return;
      const retiring = new Map(workspaceRoutes);
      void workspaceHosts
        ?.releaseIdle()
        .then((released) => {
          for (const id of released) {
            if (workspaceRoutes.get(id) !== retiring.get(id)) continue;
            workspaceWatchers.get(id)?.();
            workspaceWatchers.delete(id);
            workspaceRoutes.delete(id);
            workspaceRuntime.delete(id);
          }
        })
        .catch((error: unknown) =>
          console.error('[desktop] Idle Host cleanup failed:', safeError(error)),
        );
    }, 60_000);
    idleTimer.unref();
    const initial = attach(createService(workspace));
    let resolveInitial!: () => void;
    let rejectInitial!: (error: unknown) => void;
    const initialReady = new Promise<void>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    void initialReady.catch(() => {});
    workspaceHosts.adopt(started.registry.activeWorkspaceId ?? 'default', workspace, initial);
    watchHost(
      started.registry.activeWorkspaceId ?? 'default',
      initial,
      !started.registry.activeWorkspaceId,
    );
    attach(initial);
    /**
     * Switch the visible Host to another workspace's.
     *
     * The new Host starts before it becomes visible; the previous Host is kept in the manager so its run can finish
     * in the background. The caller owns `switching` and has checked that no approval still waits on the old view.
     */
    const replaceHost = async (
      selected: string,
      version = ++selectionVersion,
      selectId?: string,
    ): Promise<void> => {
      const registry = projectWorkspaces ? await projectWorkspaces.list() : null;
      const entry = registry?.workspaces.find(
        (workspaceEntry) =>
          !workspaceEntry.removed && samePath(workspaceEntry.canonicalPath, selected),
      );
      // Before the Host exists: its first run is when an untrusted hook would otherwise execute.
      await reviewWorkspaceHooks(selected);
      const created = !workspaceHosts!.get(entry?.id ?? '');
      const runtime = await workspaceHosts!.ensure(
        entry?.id ?? `unregistered:${selected}`,
        selected,
        false,
      );
      if (runtime.host === initial && !initial.snapshot.ready) await initialReady;
      await runtime.host.configureModels(settingsStore.runtimeCatalog);
      if (
        created &&
        entry?.lastSessionId &&
        runtime.host.snapshot.sessions.some((session) => session.id === entry.lastSessionId)
      ) {
        await runtime.host.dispatch({ type: 'load', id: entry.lastSessionId });
      }
      if (!quitting && version === selectionVersion && selectId)
        await projectWorkspaces!.select(selectId);
      if (!quitting && version === selectionVersion) {
        workspaceHosts!.activate(runtime.workspaceId);
        attach(runtime.host);
      }
    };
    registerAttachmentIpc(ctx, () => uiSettingsStore.view.language);
    ipcMain.handle('yuantu:browser', async (event, input: unknown): Promise<BrowserReply> => {
      try {
        assertSender(event);
        if (!browserViews || quitting || !window) throw new Error(mainText('desktop.quitting'));
        return browserViews.handle(parseBrowserCommand(input));
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
    ipcMain.handle(
      'yuantu:projects',
      async (event, input: unknown): Promise<ProjectWorkspaceReply> => {
        try {
          assertSender(event);
          if (!projectWorkspaces || quitting) throw new Error(mainText('desktop.quitting'));
          const command = parseProjectWorkspaceCommand(input);
          if (command.type === 'add') {
            const register = async (folder: string): Promise<ProjectWorkspaceReply> => {
              const registry = await projectWorkspaces!.add(folder, undefined, false);
              const addedId = registry.workspaces.find(
                (entry) => !entry.removed && samePath(entry.canonicalPath, realpathSync(folder)),
              )?.id;
              return { ok: true, registry, addedId };
            };
            if (command.path) return register(command.path);
            if (!window) throw new Error(mainText('desktop.quitting'));
            const picked = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
            if (picked.canceled || !picked.filePaths[0])
              return { ok: true, registry: await projectWorkspaces.list(), cancelled: true };
            return register(picked.filePaths[0]);
          }
          switch (command.type) {
            case 'groupCollapse':
              return {
                ok: true,
                registry: await projectWorkspaces.setProjectsCollapsed(command.collapsed),
              };
            case 'prepare': {
              if (switching) throw new Error('Workspace operation is in progress');
              const registry = await projectWorkspaces.list();
              const entry = registry.workspaces.find(
                (entry) => entry.id === command.id && !entry.removed,
              );
              if (!entry) throw new Error('Workspace is not in the list');
              if (!workspaceHosts?.get(entry.id)) {
                await reviewWorkspaceHooks(entry.canonicalPath);
                await workspaceHosts!.ensure(entry.id, entry.canonicalPath, false);
                await workspaceHosts!
                  .get(entry.id)!
                  .host.configureModels(settingsStore.runtimeCatalog);
              }
              return {
                ok: true,
                registry: await projectWorkspaces.list(),
                runtime: Object.fromEntries(workspaceRuntime),
              };
            }
            case 'list':
              return {
                ok: true,
                registry: await projectWorkspaces.list(),
                runtime: Object.fromEntries(workspaceRuntime),
              };
            case 'select': {
              if (switching) throw new Error('Workspace operation is in progress');
              const version = ++selectionVersion;
              const registry = await projectWorkspaces.list();
              const entry = registry.workspaces.find(
                (workspace) => workspace.id === command.id && !workspace.removed,
              );
              if (!entry) throw new Error('Workspace is not in the list');
              if (
                service &&
                (routeFor(service).empty ||
                  !samePath(service.snapshot.workspace, entry.canonicalPath))
              ) {
                if (service.sessionOperation)
                  throw new Error('Wait for the current operation to finish');
                await replaceHost(entry.canonicalPath, version, entry.id);
              } else {
                await projectWorkspaces.select(command.id);
              }
              if (version !== selectionVersion)
                throw new Error('Workspace selection was superseded');
              const selectedRoute = routeFor(service!);
              selectedRoute.sender.reset();
              const activation = {
                ...selectedRoute.target,
                type: 'state' as const,
                active: true,
                selection: version,
                patch: selectedRoute.sender.diff(service!.snapshot),
              };
              const selectedRegistry = await projectWorkspaces.list();
              if (version !== selectionVersion)
                throw new Error('Workspace selection was superseded');
              return {
                ok: true,
                registry: selectedRegistry,
                target: selectedRoute.target,
                activation,
              };
            }
            case 'rename':
              return {
                ok: true,
                registry: await projectWorkspaces.rename(command.id, command.displayName),
              };
            case 'remove': {
              if (switching) throw new Error('Workspace operation is in progress');
              if (workspaceHosts?.isStarting(command.id))
                throw new Error('Workspace Host is still starting');
              const targetHost = workspaceHosts?.get(command.id)?.host;
              if (targetHost) {
                const state = targetHost.snapshot;
                if (
                  targetHost.busy ||
                  !state.ready ||
                  state.session.running ||
                  state.session.loading ||
                  (state.session.otherRuns?.length ?? 0) > 0 ||
                  state.sessions.some((item) => item.activeRun)
                )
                  throw new Error('Wait for the current operation to finish');
              }
              switching = true;
              ++selectionVersion;
              try {
                const registry = await projectWorkspaces.remove(command.id);
                await workspaceHosts?.stop(command.id);
                workspaceWatchers.get(command.id)?.();
                workspaceWatchers.delete(command.id);
                workspaceRoutes.delete(command.id);
                workspaceRuntime.delete(command.id);
                const next = registry.workspaces.find(
                  (entry) => entry.id === registry.activeWorkspaceId,
                );
                if (targetHost === service) {
                  if (next) await replaceHost(next.canonicalPath);
                  else {
                    const empty = createService(workspace);
                    watchHost('empty', empty, true);
                    attach(empty);
                  }
                }
                return { ok: true, registry };
              } finally {
                switching = false;
              }
            }
            case 'collapse':
              return {
                ok: true,
                registry: await projectWorkspaces.setCollapsed(command.id, command.collapsed),
              };
            case 'lastSession':
              return {
                ok: true,
                registry: await projectWorkspaces.setLastSession(command.id, command.sessionId),
              };
          }
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      },
    );
    ipcMain.handle(
      'yuantu:workspace-maintenance',
      async (event, input: unknown): Promise<WorkspaceMaintenanceReply> => {
        try {
          assertSender(event);
          const envelope = input as { target?: unknown; command?: unknown };
          const command = parseWorkspaceMaintenanceCommand(envelope?.command);
          const service = envelope.target ? routedService(envelope.target) : null;
          const choices = service ? routeFor(service).choices : undefined;
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
              policyReady: choices?.following,
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
    ipcMain.handle(
      'yuantu:archived-sessions',
      async (event, input: unknown): Promise<ArchivedSessionsReply> => {
        try {
          assertSender(event);
          const service = routedService((input as { target?: unknown })?.target);
          if (!service || quitting) throw new Error(mainText('desktop.quitting'));
          const current = service;
          const workspace = current.snapshot.workspace;
          return { ok: true, workspace, sessions: await current.archivedSessions() };
        } catch (error) {
          return carrierErrorReply(error);
        }
      },
    );
    ipcMain.handle('yuantu:files', async (event, input: unknown): Promise<FilesReply> => {
      try {
        assertSender(event);
        const envelope = input as { target?: unknown; command?: unknown };
        const command = parseFilesCommand(envelope?.command);
        const service = envelope.target ? routedService(envelope.target) : null;
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
          const envelope = input as { target?: unknown; command?: unknown };
          const service = routedService(envelope?.target);
          input = envelope.command;
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
          const envelope = input as { target?: unknown; command?: unknown };
          const command = parsePermissionPresetCommand(envelope?.command);
          const service = envelope.target
            ? routedService(envelope.target, command.type === 'get')
            : ctx.service;
          if (!service) throw new Error('Workspace is not ready');
          const choices = routeFor(service).choices;
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
            const sandbox = choiceForPreset(preset).sandbox;
            const choice: SessionChoice = {
              sandbox,
              permission: preset.permission,
            };
            const sessionId = service?.snapshot.session.sessionId ?? undefined;
            await choices.apply(choice, sessionId);
            if (sessionId) choices.remember(sessionId, choice);
            // Choosing a preset is choosing the account sandbox again, for the sessions that follow too.

            return {
              ok: true,
              view: choices.view(),
              message: `Preset applied: ${sandbox} + ${preset.permission}.`,
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
          if (command.type === 'verify') return { ok: true, view: await sandboxSetup.verify() };
          if (
            switching ||
            !service ||
            ctx.services?.some((host) => host.busy || !host.snapshot.ready)
          )
            throw new Error(mainText('settingsMain.busy'));
          switching = true;
          try {
            sandboxInitializing =
              command.type === 'initialize'
                ? sandboxSetup.initialize()
                : command.type === 'uninstall'
                  ? sandboxSetup.uninstall()
                  : command.type === 'read-add'
                    ? sandboxSetup.addRead()
                    : sandboxSetup.removeRead(command.path);
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
        const envelope = input as { target?: unknown; command?: unknown };
        const command = parseSettingsCommand(envelope?.command);
        const service = envelope.target
          ? routedService(envelope.target, command.type === 'get')
          : ctx.service;
        if (quitting) throw new Error(mainText('desktop.quitting'));
        if (command.type === 'get') return { ok: true, settings: modelSettingsView() };
        submittedKey = 'values' in command ? command.values.apiKey : '';
        if (!service || switching || service.busy) throw new Error(mainText('settingsMain.busy'));
        if (command.type === 'select') {
          settingsStore.configFor(command.connectionId);
          switching = true;
          try {
            await service.selectModel(command.connectionId);
            return { ok: true, settings: modelSettingsView() };
          } finally {
            switching = false;
          }
        }
        if (command.type === 'delete') {
          switching = true;
          try {
            await settingsStore.withRuntime(
              () => settingsStore.delete(command.connectionId),
              configureModelCatalog,
            );
            return {
              ok: true,
              settings: modelSettingsView(),
              message: mainText('settingsMain.connectionDeleted'),
            };
          } finally {
            switching = false;
          }
        }
        const preparedGroup =
          command.type === 'save-group' ? settingsStore.prepareGroup(command.values) : null;
        const config =
          command.type === 'save-group'
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
              settings: modelSettingsView(),
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
              settings: modelSettingsView(),
              message: mainText('settingsMain.testSucceeded'),
            };
          }
          await settingsStore.withRuntime(
            () =>
              preparedGroup
                ? settingsStore.savePreparedGroup(preparedGroup)
                : settingsStore.save(config),
            configureModelCatalog,
          );
          return {
            ok: true,
            settings: modelSettingsView(),
            message: mainText('settingsMain.saved'),
          };
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
        const envelope = input as { target?: unknown; command?: unknown };
        const command = parseCarrierCommand(envelope?.command);
        const current = envelope.target
          ? routedService(envelope.target, command.type === 'snapshot')
          : command.type === 'snapshot'
            ? service
            : null;
        if (!current || quitting) throw new Error('Workspace target is required');
        const route = routeFor(current);
        const capturedTarget = { ...route.target };
        const choices = route.choices;
        const reply = (): DesktopWireReply => {
          if (route.target.hostEpoch !== capturedTarget.hostEpoch)
            throw new Error('Workspace Host has changed');
          return {
            ok: true,
            target: capturedTarget,
            patch: route.sender.diff(workspaceSnapshot(current)),
            ...(!envelope.target ? { active: true, selection: selectionVersion } : {}),
          };
        };
        // The window asks for a snapshot when it starts; whatever it held before, it gets every section.
        if (command.type === 'snapshot') route.sender.reset();
        if (command.type === 'snapshot' && !envelope.target) {
          for (const other of workspaceRoutes.values()) {
            if (other === route) continue;
            other.sender.reset();
            sendWorkspace({
              ...other.target,
              type: 'state',
              patch: other.sender.diff(workspaceSnapshot(other.host)),
            });
          }
        }
        if (command.type === 'sandbox')
          throw new Error('Change the sandbox through a confirmed permission preset.');
        if (!service || quitting) throw new Error('Desktop is shutting down');
        if (command.type === 'copyText') {
          clipboard.writeText(command.text);
          return reply();
        }
        if (command.type === 'openLink') {
          await shell.openExternal(command.url);
          return reply();
        }
        if (command.type === 'export') {
          const language = uiSettingsStore.view.language;
          const content =
            'sessionId' in command
              ? conversationMarkdown({
                  ...(await current.exportTranscript(command.sessionId)),
                  language,
                })
              : command.content;
          const result = await dialog.showSaveDialog(window!, {
            title: mainText('desktop.exportTitle'),
            defaultPath: path.join(
              current.snapshot.workspace,
              safeExportName(command.suggestedName),
            ),
            filters: [
              { name: 'Markdown', extensions: ['md'] },
              { name: mainText('desktop.textFilter'), extensions: ['txt'] },
            ],
          });
          if (!result.canceled && result.filePath)
            await writeFile(result.filePath, content, 'utf8');
          return reply();
        }
        if (switching && command.type !== 'snapshot') throw new Error('Workspace is changing');
        if (command.type === 'chooseWorkspace') {
          const state = current.snapshot;
          // Changing the workspace replaces the Host, so a run of any session — not only the visible one — holds it.
          if (!state.ready || state.session.loading || current.sessionOperation)
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
              // The picker is also the "add workspace" flow: register it before starting the Host.
              await projectWorkspaces?.add(selected);
              if (selected !== state.workspace || routeFor(current).empty)
                await replaceHost(selected);
            }
            const activeRoute = routeFor(service!);
            return {
              ok: true,
              target: activeRoute.target,
              active: true,
              selection: selectionVersion,
              patch: activeRoute.sender.diff(service!.snapshot),
            };
          } finally {
            switching = false;
          }
        }
        if (command.type !== 'snapshot') await choices.following;
        if (switching && command.type !== 'snapshot') throw new Error('Workspace is changing');
        if (routedService(capturedTarget, command.type === 'snapshot') !== current)
          throw new Error('Workspace Host has changed');
        await current.dispatch(command);
        if (command.type !== 'snapshot') await choices.following;
        return reply();
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
    if (!quitting && started.registry.activeWorkspaceId)
      await initial
        .start()
        .then(async () => {
          resolveInitial();
          await confirmUpgradeStartup();
          console.info('[desktop] host.ready');
        })
        .catch((error) => {
          rejectInitial(error);
          if (app.commandLine.hasSwitch('upgrade-journal'))
            dialog.showErrorBox(
              mainText('upgrade.failed'),
              `${safeError(error)}\n${mainText('upgrade.recovery')}`,
            );
        });
  })
  .catch((error) => {
    console.error('[desktop] Startup failed:', safeError(error));
    dialog.showErrorBox(
      mainText('desktop.startFailureTitle'),
      // A launch that skipped the script has one recovery, and the dictionary already owns its sentence; the
      // English detail behind it would name a variable the person who double-clicked never set.
      error instanceof MissingDevelopmentNode
        ? mainText('desktop.startWithNode')
        : safeError(error),
    );
    app.quit();
  });
