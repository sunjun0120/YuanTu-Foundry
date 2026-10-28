import type { PermissionPolicySource } from '../../packages/protocol/permission-policy.ts';

/**
 * The four approval floors, and the policy each one is.
 *
 * There is no `set` command here any more: the desktop has no control that moves the approval floor alone (the
 * composer's chip writes presets, and a preset writes both knobs or neither). What remains is the mapping the
 * store persists and the preset path applies — RFC-style: the mode *is* the file, so writing one and reading it
 * back can never disagree.
 */
export type PermissionMode = 'read-only' | 'ask' | 'approve' | 'auto' | 'full-access';

/**
 * Commands `auto` still stops for: the ones that destroy data, leave the workspace, publish, or raise privileges.
 *
 * Matched case-insensitively against the whole command line (`ask`/`deny` patterns fold case and normalise
 * paths), and `ask` outranks `allow`, so one hit here is enough to bring the approval card back. The list is the
 * risk a person would want to see before it happens, not a sandbox: the sandbox still applies underneath.
 */
export const RISKY_COMMAND_PATTERNS: readonly string[] = [
  // Deleting files and directories.
  '*rm -r*',
  '*rm -f*',
  '*rm -*r*',
  '*rmdir*',
  '*remove-item*',
  '*del /*',
  '*erase *',
  '*rd /s*',
  '*mkfs*',
  '*diskpart*',
  '*format-volume*',
  '*dd if=*',
  // Rewriting or publishing history.
  '*git push*',
  '*git reset --hard*',
  '*git clean*',
  '*git checkout -- *',
  '*git restore*',
  '*git rebase*',
  '*git branch -d*',
  '*git stash drop*',
  '*git stash clear*',
  '*git filter-branch*',
  '*--force*',
  '*npm publish*',
  '*pnpm publish*',
  '*yarn publish*',
  '*docker push*',
  // Privileges, system state and processes.
  '*sudo *',
  '*runas *',
  '*start-process*-verb*',
  '*chmod *',
  '*chown *',
  '*icacls *',
  '*takeown*',
  '*reg add*',
  '*reg delete*',
  '*set-executionpolicy*',
  '*schtasks*',
  '*netsh*',
  '*setx *',
  '*shutdown*',
  '*reboot*',
  '*taskkill*',
  '*stop-process*',
  '*kill -*',
  '*npm install -g*',
  '*npm i -g*',
  // Downloading and running code.
  '*curl *',
  '*wget *',
  '*invoke-webrequest*',
  '*invoke-restmethod*',
  '*iwr *',
  '*irm *',
  '*invoke-expression*',
  '*| iex*',
  '*|iex*',
  '*| sh*',
  '*|sh*',
  '*| bash*',
  '*|bash*',
];

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
  if (mode === 'auto') {
    return {
      version: 1,
      rules: [
        { effect: 'allow', kind: 'write' },
        { effect: 'allow', kind: 'command' },
        { effect: 'ask', kind: 'external' },
        // Raw keystrokes into an open terminal cannot be read as one command line, so they always ask.
        { effect: 'ask', tool: 'terminal_send' },
        // A command that can reach the network can also send away whatever it can read, so it is never routine.
        { effect: 'ask', kind: 'command', network: 'unrestricted' },
        ...RISKY_COMMAND_PATTERNS.map((pattern) => ({
          effect: 'ask' as const,
          kind: 'command' as const,
          match: { command: pattern },
        })),
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
