import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './contract.ts';
import type { PermissionPresetView } from './permission-presets.ts';
import type {
  CarrierSnapshot,
  MessageDelta,
  StatisticsDelta,
  SubAgentDelta,
} from '../../packages/carrier/contract.ts';

const bridge: DesktopBridge = {
  readAttachment: (input) => ipcRenderer.invoke('yuantu:attachment', input),
  files: (command) => ipcRenderer.invoke('yuantu:files', command),
  mcp: (command) => ipcRenderer.invoke('yuantu:mcp', command),
  presets: (command) => ipcRenderer.invoke('yuantu:presets', command),
  subscribePresets(listener) {
    const receive = (_event: Electron.IpcRendererEvent, view: PermissionPresetView) =>
      listener(view);
    ipcRenderer.on('yuantu:presets-view', receive);
    return () => ipcRenderer.removeListener('yuantu:presets-view', receive);
  },
  uiSettings: (command) => ipcRenderer.invoke('yuantu:ui-settings', command),
  settings: (command) => ipcRenderer.invoke('yuantu:settings', command),
  invoke: (command) => ipcRenderer.invoke('yuantu:command', command),
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: CarrierSnapshot) => listener(state);
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
