/**
 * The Electron IPC bridge: what the renderer is allowed to ask the main process.
 *
 * The carrier's own vocabulary and state (`CarrierCommand`, `CarrierSnapshot`) live in
 * `packages/carrier/contract.ts` now — they are not Electron's, and a second carrier must not have to copy
 * them. What is left here is the part that only makes sense inside this shell: the extra channels the desktop
 * exposes (attachments, sandbox mode, MCP, permissions, settings) next to the carrier command channel, and the
 * reply envelope the IPC handlers answer with.
 */
import type { AttachmentReply } from './attachment-contract.ts';
import type { FilesCommand, FilesReply } from './files-contract.ts';
import type { McpCommand, McpReply } from './mcp-contract.ts';
import type {
  CarrierCommand,
  CarrierSnapshot,
  MessageDelta,
  SubAgentDelta,
  StatisticsDelta,
} from '../../packages/carrier/contract.ts';
import type { SettingsCommand, SettingsReply } from './settings-contract.ts';
import type { UiSettingsCommand, UiSettingsReply } from './ui-settings.ts';
import type {
  PermissionPresetCommand,
  PermissionPresetReply,
  PermissionPresetView,
} from './permission-presets.ts';

export type { MessageDelta, SubAgentDelta, StatisticsDelta };
export type { CarrierCommand, CarrierSnapshot };
export type DesktopReply = { ok: true; state: CarrierSnapshot } | { ok: false; error: string };
export interface DesktopBridge {
  readAttachment(input: { name: string; data: Uint8Array }): Promise<AttachmentReply>;
  /**
   * The workspace's files, for the read-only tree and preview.
   *
   * Its own channel rather than a carrier command, because the answer is a value the Host produced and not
   * new session state: routing it through `invoke` would return a whole `CarrierSnapshot` — every message and
   * attachment — for one directory listing.
   */
  files(command: FilesCommand): Promise<FilesReply>;
  mcp(command: McpCommand): Promise<McpReply>;
  /**
   * The two security knobs as one choice, which is now the only way either of them moves.
   *
   * It was three channels: `sandbox` and `permissions` set one knob each (the settings page had a row for each)
   * and this one wrote both. The page is gone — the composer's chip is the preset picker — so the two
   * single-knob channels went with it, and what is left is the pairing rule itself: the sandbox half restarts
   * the carrier service, the approval half is a hot update, and only this channel can put the first back when
   * the second fails.
   */
  presets(command: PermissionPresetCommand): Promise<PermissionPresetReply>;
  /**
   * The pair the window's session is in, pushed when the desktop moves it.
   *
   * The chip cannot poll its way out of a race: the choice follows the session, so the desktop applies it while
   * the session is changing — and a read taken at that moment answers with the pair *before* the move, which is
   * what the window then drew and kept. The desktop is the only party that knows when the pair is in place, so
   * it says so.
   */
  subscribePresets(listener: (view: PermissionPresetView) => void): () => void;
  uiSettings(command: UiSettingsCommand): Promise<UiSettingsReply>;
  settings(command: SettingsCommand): Promise<SettingsReply>;
  /**
   * The shell's carrier-command channel. The renderer sends the same validated vocabulary it always did; the
   * main process answers the shell-owned verbs (clipboard, external links, save dialog, folder picker) itself
   * and forwards everything else to the carrier service.
   */
  invoke(command: CarrierCommand): Promise<DesktopReply>;
  subscribe(listener: (state: CarrierSnapshot) => void): () => void;
  /**
   * Streamed assistant text. Separate from `subscribe` on purpose: delivering each token as a whole
   * CarrierSnapshot copied the entire session — attachments included — across IPC per token.
   */
  subscribeDelta(listener: (delta: MessageDelta) => void): () => void;
  /** Streamed sub-agent text, on its own channel for the same reason as assistant text. */
  subscribeSubAgentDelta(listener: (delta: SubAgentDelta) => void): () => void;
  /**
   * Usage and activity, on their own channel: they change once a second while a model call runs, and a
   * snapshot per update copies the whole session (attachments included) for a panel of numbers.
   */
  subscribeStatisticsDelta(listener: (delta: StatisticsDelta) => void): () => void;
}
