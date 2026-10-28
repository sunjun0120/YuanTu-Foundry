import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopBridge, DesktopWireReply, CarrierCommand, DesktopReply } from './contract.ts';
import {
  WorkspaceMirrors,
  sameTarget,
  type WorkspaceEvent,
  type WorkspaceTarget,
} from './workspace-routing.ts';
import type { SnapshotSection } from './snapshot-patch.ts';
import type { PermissionPresetView } from './permission-presets.ts';
import type { CarrierSnapshot, MessageDelta, SubAgentDelta, StatisticsDelta } from './contract.ts';

const mirrors = new WorkspaceMirrors();
const states = new Set<(state: CarrierSnapshot, changed: readonly SnapshotSection[]) => void>();
const deltas = new Set<(delta: MessageDelta) => void>();
const subagents = new Set<(delta: SubAgentDelta) => void>();
const statistics = new Set<(delta: StatisticsDelta) => void>();
const workspaces = new Set<(event: WorkspaceEvent) => void>();
const workspaceStates = new Set<(view: WorkspaceTarget & { state: CarrierSnapshot }) => void>();
const presets = new Set<(view: PermissionPresetView) => void>();
const presetViews = new Map<string, WorkspaceTarget & { view: PermissionPresetView }>();
ipcRenderer.on(
  'yuantu:workspace-presets',
  (_event, reading: WorkspaceTarget & { view: PermissionPresetView }) => {
    const held = presetViews.get(reading.workspaceId);
    if (held && held.hostEpoch > reading.hostEpoch) return;
    presetViews.set(reading.workspaceId, reading);
    if (sameTarget(mirrors.target, reading)) for (const listener of presets) listener(reading.view);
  },
);
function receive(event: WorkspaceEvent): void {
  if (event.type === 'state') {
    const projected = mirrors.apply(event);
    if (projected) for (const listener of states) listener(projected.state, projected.changed);
    const reading = presetViews.get(event.workspaceId);
    if (event.active && reading && sameTarget(mirrors.target, reading))
      for (const listener of presets) listener(reading.view);
  } else if (sameTarget(mirrors.target, event)) {
    if (event.type === 'delta') for (const listener of deltas) listener(event.delta);
    if (event.type === 'subagent') for (const listener of subagents) listener(event.delta);
    if (event.type === 'statistics') for (const listener of statistics) listener(event.delta);
  }
  const held = mirrors.get(event);
  if (held) {
    for (const listener of workspaces) listener(event);
    if (event.type === 'state')
      for (const listener of workspaceStates)
        listener({ workspaceId: event.workspaceId, hostEpoch: event.hostEpoch, state: held });
  }
}
ipcRenderer.on('yuantu:workspace-event', (_event, event: WorkspaceEvent) => receive(event));
function subscribe<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function on<T>(channel: string, listener: (value: T) => void): () => void {
  const receive = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}
async function invoke(
  target: WorkspaceTarget | null,
  command: CarrierCommand,
): Promise<DesktopReply> {
  const reply = (await ipcRenderer.invoke('yuantu:command', {
    target,
    command,
  })) as DesktopWireReply;
  if (!reply.ok) return reply;
  if (!reply.target) return { ok: false, error: 'Workspace reply has no target' };
  receive({
    ...reply.target,
    type: 'state',
    patch: reply.patch,
    active: reply.active,
    selection: reply.selection,
  });
  const state = mirrors.get(reply.target);
  return state ? { ok: true, state } : { ok: false, error: 'Workspace Host has changed' };
}
const scoped = (channel: string, command?: unknown) =>
  ipcRenderer.invoke(channel, { target: mirrors.target, command });
const bridge: DesktopBridge = {
  workspaceMaintenance: (command) => scoped('yuantu:workspace-maintenance', command),
  browser: (command) => ipcRenderer.invoke('yuantu:browser', command),
  async projects(command) {
    const reply = await ipcRenderer.invoke('yuantu:projects', command);
    if (reply.ok && reply.activation) receive(reply.activation);
    return reply;
  },
  subscribeBrowser: (listener) => on('yuantu:browser-event', listener),
  archivedSessions: () => scoped('yuantu:archived-sessions'),
  readAttachment: (input) => ipcRenderer.invoke('yuantu:attachment', input),
  sourceArchivePath: (file) => webUtils.getPathForFile(file),
  stageSourceArchive: (input) => ipcRenderer.invoke('yuantu:analysis-source', input),
  files: (command) => scoped('yuantu:files', command),
  openWorkspacePath: (path, action) => scoped('yuantu:open-workspace-path', { path, action }),
  presets: (command) => scoped('yuantu:presets', command),
  subscribePresets(listener) {
    const target = mirrors.target;
    const view = target ? presetViews.get(target.workspaceId) : undefined;
    if (view && target && sameTarget(target, view)) listener(view.view);
    return subscribe(presets, listener);
  },
  subscribeOpenSession: (listener) => on('yuantu:open-session', listener),
  subscribeWorkspaceSession: (listener) => on('yuantu:open-workspace-session', listener),
  uiSettings: (command) => ipcRenderer.invoke('yuantu:ui-settings', command),
  sandboxSetup: (command) => ipcRenderer.invoke('yuantu:sandbox-setup', command),
  sandboxRecovery: (command) => ipcRenderer.invoke('yuantu:sandbox-recovery', command),
  settings: (command) => scoped('yuantu:settings', command),
  invoke: (command) => invoke(mirrors.target, command),
  workspaceInvoke: (target, command) => invoke(target, command),
  subscribe: (listener) => subscribe(states, listener),
  subscribeDelta: (listener) => subscribe(deltas, listener),
  subscribeSubAgentDelta: (listener) => subscribe(subagents, listener),
  subscribeStatisticsDelta: (listener) => subscribe(statistics, listener),
  subscribeWorkspaces: (listener) => subscribe(workspaces, listener),
  subscribeWorkspaceStates(listener) {
    for (const view of mirrors.snapshots()) listener(view);
    return subscribe(workspaceStates, listener);
  },
};
contextBridge.exposeInMainWorld('yuantu', bridge);
