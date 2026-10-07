/**
 * The page's side of the bridge: the desktop's bridge shape, over one WebSocket.
 *
 * `apps/desktop/renderer.ts` and its sibling modules ask for `window.yuantu: DesktopBridge` and nothing else, so
 * the way to give a page the same interface is to implement that interface — not to write a second renderer. The
 * shell-only channels (attachments through a native reader, MCP drafts, sandbox switches, the encrypted model
 * store) are answered with a refusal that says where they live, because a page that silently did nothing would
 * look like a broken desktop.
 *
 * Two things are deliberately local to the page:
 *
 * - **Language, appearance and font size** are per-browser preferences, so they are kept in `localStorage`
 *   rather than sent to a Host that has no opinion about them.
 * - **Nothing else**: commands, workspace files and every event come from the bridge, which is what makes the
 *   page a carrier instead of a mock.
 */
import type { DesktopBridge, DesktopReply } from '../desktop/contract.ts';
import type { AttachmentReply } from '../desktop/attachment-contract.ts';
import type { FilesCommand, FilesReply } from '../desktop/files-contract.ts';
import type { McpCommand, McpReply } from '../desktop/mcp-contract.ts';
import type {
  PermissionPresetCommand,
  PermissionPresetReply,
} from '../desktop/permission-presets.ts';
import type { SettingsCommand, SettingsReply } from '../desktop/settings-contract.ts';
import {
  defaultUiSettings,
  parseUiSettings,
  type UiSettings,
  type UiSettingsCommand,
  type UiSettingsReply,
} from '../desktop/ui-settings.ts';
import type {
  CarrierCommand,
  CarrierSnapshot,
  MessageDelta,
  StatisticsDelta,
  SubAgentDelta,
} from '../../packages/carrier/contract.ts';
import type { BridgeFrame, BridgeRequest } from './protocol.ts';

/** Everything a page needs to reach its bridge. */
export interface BrowserBridgeOptions {
  /** The `ws://127.0.0.1:<port>/ws?token=…` URL the bridge printed. */
  readonly url: string;
  /** Where page-local preferences live. Defaults to `localStorage`; a test passes its own store. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
}
/** The channels that only exist where there is a shell, and what to tell a page that asks for one. */
const SHELL_ONLY: Record<string, string> = {
  attachment: '附件在桌面版中通过原生读取器解析；网页版请把文件内容直接粘进对话。',
  mcp: 'MCP 服务器由桥的配置决定，网页版不提供编辑。',
  presets: '安全预设由桥的配置决定，网页版不提供编辑。',
  settings: '模型与密钥由桥持有（环境变量或 --settings 文件），网页版不提供模型设置页。',
};
const UI_SETTINGS_KEY = 'yuantu.ui-settings';
export function createBrowserBridge(options: BrowserBridgeOptions): DesktopBridge {
  const storage = options.storage ?? localStorage;
  const states = new Set<(state: CarrierSnapshot) => void>();
  const deltas = new Set<(delta: MessageDelta) => void>();
  const subAgentDeltas = new Set<(delta: SubAgentDelta) => void>();
  const statisticsDeltas = new Set<(delta: StatisticsDelta) => void>();
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let socket: WebSocket | undefined;
  let connecting: Promise<WebSocket> | undefined;
  let refused: string | undefined;
  /**
   * One socket for every request, opened lazily and kept.
   *
   * `send` queues until the socket is open: the page builds its bridge before the module that renders it asks
   * for anything, and a request that arrived during the handshake must not be dropped.
   */
  const connect = (): Promise<WebSocket> => {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (connecting) return connecting;
    if (socket) {
      for (const entry of pending.values()) entry.reject(new Error('与本机桥的连接已断开'));
      pending.clear();
    }
    const created = new WebSocket(options.url);
    connecting = new Promise((resolve, reject) => {
      socket = created;
      created.addEventListener(
        'open',
        () => {
          connecting = undefined;
          resolve(created);
        },
        { once: true },
      );
      created.addEventListener(
        'error',
        () => reject(new Error('无法连接本机桥（apps/web/main.ts 是否在运行？）')),
        { once: true },
      );
      created.addEventListener('message', (event: MessageEvent) => {
        if (socket !== created) return;
        const frame = JSON.parse(String(event.data)) as BridgeFrame;
        if (frame.kind === 'reply') {
          const entry = pending.get(frame.id);
          pending.delete(frame.id);
          if (!entry) return;
          if (frame.ok) entry.resolve(frame.value);
          else entry.reject(new Error(frame.error));
          return;
        }
        if (frame.kind === 'refused') {
          refused = frame.reason;
          for (const entry of pending.values()) entry.reject(new Error(frame.reason));
          pending.clear();
          return;
        }
        if (frame.kind === 'state') for (const listener of states) listener(frame.state);
        else if (frame.kind === 'delta') for (const listener of deltas) listener(frame.delta);
        else if (frame.kind === 'subagent-delta')
          for (const listener of subAgentDeltas) listener(frame.delta);
        else for (const listener of statisticsDeltas) listener(frame.delta);
      });
      created.addEventListener('close', () => {
        const reason = refused ?? '与本机桥的连接已断开';
        reject(new Error(reason));
        if (socket !== created) return;
        for (const entry of pending.values()) entry.reject(new Error(reason));
        pending.clear();
        socket = undefined;
        connecting = undefined;
      });
    });
    return connecting;
  };
  const request = async (body: Omit<BridgeRequest, 'id'>): Promise<unknown> => {
    if (refused) throw new Error(refused);
    const live = await connect();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      live.send(JSON.stringify({ ...body, id }));
    });
  };
  const localUiSettings = (): UiSettings => {
    try {
      const stored = storage.getItem(UI_SETTINGS_KEY);
      return stored ? parseUiSettings(JSON.parse(stored)) : defaultUiSettings();
    } catch {
      return defaultUiSettings();
    }
  };
  /**
   * The refusal one of the shell-only channels answers with.
   *
   * The cast is the honest shape of it: every reply union has an `{ok:false,error}` variant, and this builds
   * exactly that variant — the caller names the union it belongs to.
   */
  const refusal = <T>(channel: keyof typeof SHELL_ONLY): T =>
    ({ ok: false, error: SHELL_ONLY[channel] }) as T;
  return {
    async readAttachment(): Promise<AttachmentReply> {
      return refusal<AttachmentReply>('attachment');
    },
    async files(command: FilesCommand): Promise<FilesReply> {
      try {
        return (await request({ kind: 'files', command })) as FilesReply;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '读取工作区失败' };
      }
    },
    async mcp(_command: McpCommand): Promise<McpReply> {
      return refusal<McpReply>('mcp');
    },
    async presets(_command: PermissionPresetCommand): Promise<PermissionPresetReply> {
      return refusal<PermissionPresetReply>('presets');
    },
    /**
     * The desktop's push, which this carrier has nothing to push: the bridge's sandbox comes from how it was
     * started, and `presets` above already refuses to change it. A no-op unsubscribe rather than a refusal,
     * because subscribing is not an ask — there is simply never an answer.
     */
    subscribePresets() {
      return () => {};
    },
    async uiSettings(command: UiSettingsCommand): Promise<UiSettingsReply> {
      if (command.type === 'save') {
        storage.setItem(UI_SETTINGS_KEY, JSON.stringify(command.settings));
        return { ok: true, kind: 'settings', settings: command.settings };
      }
      return { ok: true, kind: 'settings', settings: localUiSettings() };
    },
    async settings(_command: SettingsCommand): Promise<SettingsReply> {
      return refusal<SettingsReply>('settings');
    },
    async invoke(command: CarrierCommand): Promise<DesktopReply> {
      try {
        return {
          ok: true,
          state: (await request({ kind: 'command', command })) as CarrierSnapshot,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '命令失败' };
      }
    },
    subscribe(listener: (state: CarrierSnapshot) => void): () => void {
      states.add(listener);
      return () => states.delete(listener);
    },
    subscribeDelta(listener: (delta: MessageDelta) => void): () => void {
      deltas.add(listener);
      return () => deltas.delete(listener);
    },
    subscribeSubAgentDelta(listener: (delta: SubAgentDelta) => void): () => void {
      subAgentDeltas.add(listener);
      return () => subAgentDeltas.delete(listener);
    },
    subscribeStatisticsDelta(listener: (delta: StatisticsDelta) => void): () => void {
      statisticsDeltas.add(listener);
      return () => statisticsDeltas.delete(listener);
    },
  };
}
