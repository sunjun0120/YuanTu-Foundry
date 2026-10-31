/**
 * Tool families: tools offered as one, told apart by an `action` argument.
 *
 * Only the language server tools are merged: a dozen near-identical position queries were the one place where
 * separate names cost the model more than they told it. A family joins only tools with the same permission
 * (`Tool.permission` is per tool), which is why `lsp_start` stays apart. The table sits below every layer that
 * reads an old name — the registry, permission rules, hooks, provider history — so they cannot disagree.
 */
export interface ToolFamily {
  name: string;
  /** Action → the tool that used to answer it. */
  actions: Readonly<Record<string, string>>;
}

export const TOOL_FAMILIES: readonly ToolFamily[] = [
  {
    name: 'lsp',
    actions: {
      diagnostics: 'lsp_diagnostics',
      definition: 'lsp_definition',
      references: 'lsp_references',
      hover: 'lsp_hover',
      symbols: 'lsp_symbols',
      workspace_symbols: 'lsp_workspace_symbols',
      code_actions: 'lsp_code_action',
      servers: 'lsp_servers',
      stop: 'lsp_stop',
    },
  },
  {
    name: 'lsp_edit',
    actions: { rename: 'lsp_rename', apply_code_action: 'lsp_apply_code_action' },
  },
];

/** Old member names, with what they mean now. Kept for one release. */
export const TOOL_ALIASES: ReadonlyMap<string, { tool: string; action: string }> = new Map(
  TOOL_FAMILIES.flatMap((family) =>
    Object.entries(family.actions).map(
      ([action, member]) => [member, { tool: family.name, action }] as const,
    ),
  ),
);

const FAMILIES_BY_NAME = new Map(TOOL_FAMILIES.map((family) => [family.name, family]));

/** The call as the current catalog names it; the same object when its name is current. */
export function resolveToolAlias<T extends { name: string; arguments: Record<string, unknown> }>(
  call: T,
): T {
  const alias = TOOL_ALIASES.get(call.name);
  if (!alias) return call;
  return { ...call, name: alias.tool, arguments: { action: alias.action, ...call.arguments } };
}

/** The names a hook matcher written before the merge may use for this call: the old member, then the family. */
export function hookSubjects(tool: string, action: string | undefined): string[] {
  const member = action === undefined ? undefined : FAMILIES_BY_NAME.get(tool)?.actions[action];
  return member ? [member, tool] : [tool];
}

/**
 * An allowlist in the merged catalog's terms: the tools to allow, and the actions allowed of each family that is
 * not allowed whole. An entry is a tool name, a family name (every action), `family.action`, or an old member
 * name, which allows only the action it used to be: allowing `lsp_hover` must not allow `stop`.
 */
export function scopeAllowlist(names: readonly string[]): {
  tools: string[];
  actions: Map<string, Set<string>>;
} {
  const tools = new Set<string>();
  const actions = new Map<string, Set<string>>();
  const whole = new Set<string>();
  const allowAction = (tool: string, action: string) => {
    tools.add(tool);
    actions.set(tool, (actions.get(tool) ?? new Set<string>()).add(action));
  };
  for (const entry of names) {
    const [name = '', action] = entry.split('.', 2);
    const family = FAMILIES_BY_NAME.get(name);
    if (family && action !== undefined) {
      if (family.actions[action]) allowAction(name, action);
      continue;
    }
    const alias = TOOL_ALIASES.get(name);
    if (alias) {
      allowAction(alias.tool, alias.action);
      continue;
    }
    tools.add(name);
    if (family) whole.add(name);
  }
  for (const name of whole) actions.delete(name);
  return { tools: [...tools], actions };
}
