import type { PermissionPolicySource } from '../../packages/core/permissions.ts';

/**
 * The four approval floors, and the policy each one is.
 *
 * There is no `set` command here any more: the desktop has no control that moves the approval floor alone (the
 * composer's chip writes presets, and a preset writes both knobs or neither). What remains is the mapping the
 * store persists and the preset path applies — RFC-style: the mode *is* the file, so writing one and reading it
 * back can never disagree.
 */
export type PermissionMode = 'read-only' | 'ask' | 'approve' | 'full-access';

export function permissionPolicyForMode(mode: PermissionMode): PermissionPolicySource {
  if (mode === 'read-only') {
    return {
      version: 1,
      rules: [
        { effect: 'deny', kind: 'write' },
        { effect: 'deny', kind: 'command' },
        { effect: 'deny', kind: 'external' },
      ],
    };
  }
  if (mode === 'ask') return { version: 1, rules: [] };
  if (mode === 'approve') {
    return {
      version: 1,
      rules: [
        { effect: 'allow', kind: 'write' },
        { effect: 'ask', kind: 'command' },
        { effect: 'ask', kind: 'external' },
      ],
    };
  }
  return {
    version: 1,
    rules: [
      { effect: 'allow', kind: 'write' },
      { effect: 'allow', kind: 'command' },
      { effect: 'allow', kind: 'external' },
    ],
  };
}
