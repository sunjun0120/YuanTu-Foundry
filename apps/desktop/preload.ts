import { contextBridge, ipcRenderer } from 'electron';
import { PRODUCT_SCOPE } from '../../packages/protocol/product-scope.ts';
import type { DesktopBridge, DesktopWireReply } from './contract.ts';
import { SnapshotMirror, type SnapshotPatch } from './snapshot-patch.ts';
import type { PermissionPresetView } from './permission-presets.ts';
import type {
  MessageDelta,
  StatisticsDelta,
  SubAgentDelta,
} from '../../packages/carrier/contract.ts';

/** The snapshot the main process has sent, section by section; see `snapshot-patch.ts`. */
const mirror = new SnapshotMirror();
const bridge: DesktopBridge = {
  workspaceMaintenance: (command) => ipcRenderer.invoke('yuantu:workspace-maintenance', command),
  archivedSessions: () => ipcRenderer.invoke('yuantu:archived-sessions'),
  ...(PRODUCT_SCOPE.backups
    ? { backups: (command) => ipcRenderer.invoke('yuantu:backups', command) }
    : {}),
  readAttachment: (input) => ipcRenderer.invoke('yuantu:attachment', input),
  files: (command) => ipcRenderer.invoke('yuantu:files', command),
  ...(PRODUCT_SCOPE.mcpManagement
    ? { mcp: (command) => ipcRenderer.invoke('yuantu:mcp', command) }
    : {}),
  presets: (command) => ipcRenderer.invoke('yuantu:presets', command),
  subscribePresets(listener) {
    const receive = (_event: Electron.IpcRendererEvent, view: PermissionPresetView) =>
      listener(view);
    ipcRenderer.on('yuantu:presets-view', receive);
    return () => ipcRenderer.removeListener('yuantu:presets-view', receive);
  },
  subscribeOpenSession(listener) {
    const receive = (_event: Electron.IpcRendererEvent, sessionId: string) => listener(sessionId);
    ipcRenderer.on('yuantu:open-session', receive);
    return () => ipcRenderer.removeListener('yuantu:open-session', receive);
  },
  uiSettings: (command) => ipcRenderer.invoke('yuantu:ui-settings', command),
  sandboxSetup: (command) => ipcRenderer.invoke('yuantu:sandbox-setup', command),
  settings: (command) => ipcRenderer.invoke('yuantu:settings', command),
  async invoke(command) {
    const reply = (await ipcRenderer.invoke('yuantu:command', command)) as DesktopWireReply;
    if (!reply.ok) return reply;
    return { ok: true, state: mirror.apply(reply.patch).state };
  },
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, patch: SnapshotPatch) => {
      const { state, changed } = mirror.apply(patch);
      // A patch every section of which was older than what a reply already delivered changes nothing.
      if (changed.length) listener(state, changed);
    };
    ipcRenderer.on('yuantu:state', receive);
    return () => ipcRenderer.removeListener('yuantu:state', receive);
  },
  subscribeDelta(listener) {
    const receive = (_event: Electron.IpcRendererEvent, delta: MessageDelta) => listener(delta);
    ipcRenderer.on('yuantu:delta', receive);
    return () => ipcRenderer.removeListener('yuantu:delta', receive);
  },
  subscribeSubAgentDelta(listener) {
    const receive = (_event: Electron.IpcRendererEvent, delta: SubAgentDelta) => listener(delta);
    ipcRenderer.on('yuantu:subagent-delta', receive);
    return () => ipcRenderer.removeListener('yuantu:subagent-delta', receive);
  },
  subscribeStatisticsDelta(listener) {
    const receive = (_event: Electron.IpcRendererEvent, delta: StatisticsDelta) => listener(delta);
    ipcRenderer.on('yuantu:statistics-delta', receive);
    return () => ipcRenderer.removeListener('yuantu:statistics-delta', receive);
  },
};
contextBridge.exposeInMainWorld('yuantu', bridge);
