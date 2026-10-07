import type { PermissionMode } from './permission-settings.ts';
import {
  parseSandboxSettingsCommand,
  type SandboxMode,
  type SandboxSettingsView,
} from './sandbox-settings.ts';
/**
 * A named pair: where commands run, and how much the run may do without asking.
 *
 * The two knobs are one decision in practice — "how much can this run do on my machine before I am asked" —
 * but they were configured by two independent controls, so the desktop could be left in combinations nobody
 * intended (`host` + `ask` reads as "no isolation, but ask me", which is a coherent-sounding sentence that
 * means the run's commands touch the real machine while the approval floor still looks guarded). A preset is
 * the honest unit: one choice that writes both, so a combination that is not one of these is visibly
 * *custom* rather than silently normal.
 *
 * **Three, not four.** The chip dresses the same three rungs the DSH interface offers — look only, write in the
 * workspace, full access — because a fourth rung nobody can describe in one sentence is a fourth state to be
 * understood rather than a choice to be made. The rung that went is `workspace` (`sbx` + `approve`, writes
 * auto-approved): it sat between "asks before writing" and "no isolation at all" without saying anything the
 * other two do not, and dropping it keeps the default (`guarded`) the one that still asks.
 *
 * The pairing rule is one sentence: **anything that stops asking must be isolated, and the only preset that
 * gives up isolation is the one whose entire point is that it stops asking.** Everything else runs in the
 * sandbox. Two consequences worth stating: `observe` is the pair for a run that may not write at all, and
 * `docker` is never a preset's sandbox — it is the compatibility backend an operator names in the launch
 * environment, and a preset that silently chose it would be making that choice on their behalf.
 */
export type PermissionPresetId = 'observe' | 'guarded' | 'unconfined';
export interface PermissionPreset {
  id: PermissionPresetId;
  sandbox: SandboxMode;
  permission: PermissionMode;
}
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  { id: 'observe', sandbox: 'sbx', permission: 'read-only' },
  { id: 'guarded', sandbox: 'sbx', permission: 'ask' },
  { id: 'unconfined', sandbox: 'host', permission: 'full-access' },
];
/** What a new session starts in. Kept here rather than in the desktop so the default and the table agree. */
export const DEFAULT_PRESET: PermissionPresetId = 'guarded';
/** What the desktop shows for a pair no preset declares. Not an id: it cannot be applied. */
export const CUSTOM_PRESET = 'custom';
export function isPermissionPresetId(value: unknown): value is PermissionPresetId {
  return PERMISSION_PRESETS.some((preset) => preset.id === value);
}
export function permissionPreset(id: PermissionPresetId): PermissionPreset {
  const preset = PERMISSION_PRESETS.find((candidate) => candidate.id === id);
  if (!preset)
    throw new Error(
      `Unknown permission preset: ${String(id)}; use ${PERMISSION_PRESETS.map((entry) => entry.id).join(', ')}`,
    );
  return preset;
}
/**
 * Which preset a pair *is*, or `null` when it is one no preset declares.
 *
 * This is the reader the selector needs: the current state is shown as the preset it matches, and an
 * unlisted pair shows as custom — the difference between "you are in the guarded preset" and "you are
 * somewhere we do not have a name for" is exactly what makes the control honest.
 */
export function presetIdFor(
  sandbox: SandboxMode,
  permission: PermissionMode,
): PermissionPresetId | null {
  return (
    PERMISSION_PRESETS.find(
      (preset) => preset.sandbox === sandbox && preset.permission === permission,
    )?.id ?? null
  );
}
/** Both knobs as the desktop shows them, plus which preset (if any) they currently are. */
export interface PermissionPresetView {
  current: PermissionPresetId | null;
  sandbox: SandboxSettingsView;
  permission: PermissionMode;
}
export type PermissionPresetCommand =
  { type: 'get' } | { type: 'set'; preset: PermissionPresetId; acknowledgeHost?: boolean };
export type PermissionPresetReply =
  { ok: true; view: PermissionPresetView; message?: string } | { ok: false; error: string };
export function parsePermissionPresetCommand(input: unknown): PermissionPresetCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid permission preset request');
  const value = input as Record<string, unknown>;
  if (value.type === 'get' && Object.keys(value).length === 1) return { type: 'get' };
  if (
    value.type !== 'set' ||
    !isPermissionPresetId(value.preset) ||
    Object.keys(value).some((key) => !['type', 'preset', 'acknowledgeHost'].includes(key)) ||
    (value.acknowledgeHost !== undefined && typeof value.acknowledgeHost !== 'boolean')
  )
    throw new Error('Invalid permission preset request');
  const preset = permissionPreset(value.preset);
  /**
   * The host acknowledgement is checked by the sandbox command's own parser, not by a second copy of the rule.
   *
   * A preset must not be a way around a confirmation that the plain mode selector still asks for: routing the
   * check through `parseSandboxSettingsCommand` means the two paths cannot drift, and the message the user
   * sees is the one that rule already produces.
   */
  parseSandboxSettingsCommand({
    type: 'set',
    mode: preset.sandbox,
    ...(value.acknowledgeHost === undefined ? {} : { acknowledgeHost: value.acknowledgeHost }),
  });
  return {
    type: 'set',
    preset: preset.id,
    ...(value.acknowledgeHost === undefined
      ? {}
      : { acknowledgeHost: value.acknowledgeHost as boolean }),
  };
}
