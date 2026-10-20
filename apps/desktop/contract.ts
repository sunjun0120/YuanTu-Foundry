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
import type { BackupCommand, BackupReply } from './backup-contract.ts';
import type { FilesCommand, FilesReply } from './files-contract.ts';
import type {
  WorkspaceMaintenanceCommand,
  WorkspaceMaintenanceReply,
} from './workspace-maintenance-contract.ts';
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
import type { SandboxSetupCommand, SandboxSetupReply } from './sandbox-setup.ts';
import type {
  PermissionPresetCommand,
  PermissionPresetReply,
  PermissionPresetView,
} from './permission-presets.ts';

export type { MessageDelta, SubAgentDelta, StatisticsDelta };
export type { CarrierCommand, CarrierSnapshot };
export type DesktopReply =
  | { ok: true; state: CarrierSnapshot }
  | {
      ok: false;
      error: string;
      errorDetail?: import('../../packages/carrier/errors.ts').CarrierIssue;
    };
/** `DesktopReply` as it crosses IPC: the snapshot travels as a patch the preload merges (`snapshot-patch.ts`). */
export type DesktopWireReply =
  | { ok: true; patch: import('./snapshot-patch.ts').SnapshotPatch }
  | Extract<DesktopReply, { ok: false }>;
/** The archived sessions of the open project, for their settings page. */
export type ArchivedSessionsReply =
  | {
      ok: true;
      workspace: string;
      sessions: import('../../packages/protocol/index.ts').SessionInfo[];
    }
  | Extract<DesktopReply, { ok: false }>;
/** What a person can do with a workspace file from a deliverable or a local Markdown link. */
export type WorkspaceFileAction = 'open' | 'reveal';
export type OpenWorkspacePathReply = { ok: true } | { ok: false; error: string };
export interface DesktopBridge {
  workspaceMaintenance(command: WorkspaceMaintenanceCommand): Promise<WorkspaceMaintenanceReply>;
  /** Read on demand by the settings page; unarchiving and deleting go through `invoke`. */
  archivedSessions?(): Promise<ArchivedSessionsReply>;
  backups?(command: BackupCommand): Promise<BackupReply>;
  readAttachment(input: { name: string; data: Uint8Array }): Promise<AttachmentReply>;
  /**
   * The workspace's files, for the read-only tree and preview.
   *
   * Its own channel rather than a carrier command, because the answer is a value the Host produced and not
   * new session state: routing it through `invoke` would return a whole `CarrierSnapshot` — every message and
   * attachment — for one directory listing.
   */
  files(command: FilesCommand): Promise<FilesReply>;
  /**
   * Open or reveal one workspace file with the operating system.
   *
   * The renderer may name a path from a deliverable or a Markdown link; the main process resolves it against the
   * active workspace, rejects links that escape it (including a symlink or junction), and only then asks the shell.
   */
  openWorkspacePath?(path: string, action: WorkspaceFileAction): Promise<OpenWorkspacePathReply>;
  mcp?(command: McpCommand): Promise<McpReply>;
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
  /** A system notification about a session was clicked: open that session (`main-notifications.ts`). */
  subscribeOpenSession?(listener: (sessionId: string) => void): () => void;
  uiSettings(command: UiSettingsCommand): Promise<UiSettingsReply>;
  /** Native Windows maintenance is absent in the browser bridge. */
  sandboxSetup?(command: SandboxSetupCommand): Promise<SandboxSetupReply>;
  settings(command: SettingsCommand): Promise<SettingsReply>;
  /**
   * The shell's carrier-command channel. The renderer sends the same validated vocabulary it always did; the
   * main process answers the shell-owned verbs (clipboard, external links, save dialog, folder picker) itself
   * and forwards everything else to the carrier service.
   */
  invoke(command: CarrierCommand): Promise<DesktopReply>;
  /**
   * Whole snapshots, plus which sections the main process actually changed since the last one — so the window can
   * leave the rest of the page alone (`renderer.ts`).
   */
  subscribe(
    listener: (state: CarrierSnapshot, changed: readonly (keyof CarrierSnapshot)[]) => void,
  ): () => void;
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
