import { isDeepStrictEqual } from 'node:util';
import type { PreparedTool, Tool, ToolContext, ToolFamily } from '../protocol/index.ts';
import { TOOL_FAMILIES } from '../protocol/tool-families.ts';
import { invalidArgumentsMessage } from './call-result.ts';
import { compileToolSchema, toolSchemaErrorsText, type ToolRegistry } from './registry.ts';

type Properties = Record<string, Record<string, unknown>>;

const sentences = (text: string): string[] =>
  text
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

/**
 * The summary, the sentences several members share (said once), then one line per action with what is its own.
 *
 * The members were written to stand alone, so each repeats what they have in common — how a position is counted,
 * how an edit is journalled. Joined as they were, the shared sentences were most of the family's description.
 */
function familyDescription(summary: string, members: ReadonlyMap<string, Tool>): string {
  const counts = new Map<string, number>();
  for (const member of members.values())
    for (const sentence of new Set(sentences(member.description)))
      counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  const shared = [...counts].filter(([, count]) => count > 1).map(([sentence]) => sentence);
  const lines = [...members].map(([action, member]) => {
    const own = sentences(member.description).filter((sentence) => !shared.includes(sentence));
    return `- ${action}: ${own.join(' ')}`;
  });
  return [[summary, ...shared].join(' '), ...lines].join('\n');
}

/**
 * One tool for a family of tools, told apart by `action`.
 *
 * The members keep their implementations and schemas: the flat schema the model sees is the union of their
 * arguments, loose where they disagree, and each call is checked against the chosen member's schema before it
 * runs. Validation sits in `prepare` because the registry turns what `prepare` throws into the call's error result.
 */
export function composeFamily(
  family: ToolFamily,
  members: ReadonlyMap<string, Tool>,
  summary: string,
): Tool {
  const actions = [...members.keys()];
  if (!actions.length) throw new Error(`Tool family ${family.name} has no members`);
  const permissions = new Set([...members.values()].map((member) => member.permission));
  if (permissions.size > 1)
    throw new Error(`Tool family ${family.name}: members declare different permissions`);
  const permission = [...permissions][0];
  const properties: Properties = {};
  for (const member of members.values())
    for (const [key, value] of Object.entries(
      (member.inputSchema as { properties?: Properties }).properties ?? {},
    )) {
      const seen = properties[key];
      if (!seen) properties[key] = value;
      else if (!isDeepStrictEqual(seen, value)) {
        if (seen.type !== value.type)
          throw new Error(`Tool family ${family.name}: argument ${key} has different types`);
        properties[key] = {
          type: seen.type,
          ...(typeof seen.description === 'string' ? { description: seen.description } : {}),
        };
      }
    }
  const dispatch = (args: Record<string, unknown>) => {
    const action = typeof args.action === 'string' ? args.action : undefined;
    const member = action === undefined ? undefined : members.get(action);
    if (!member) throw new Error(`${family.name} needs "action", one of: ${actions.join(', ')}`);
    const { action: _omitted, ...rest } = args;
    const validate = compileToolSchema(member.inputSchema);
    return {
      action: action!,
      member,
      rest,
      valid: validate(rest) === true,
      errors: validate.errors,
    };
  };
  const checked = (args: Record<string, unknown>) => {
    const call = dispatch(args);
    if (!call.valid)
      throw new Error(
        `Invalid arguments for ${family.name} action "${call.action}": ` +
          invalidArgumentsMessage(
            toolSchemaErrorsText(call.errors),
            call.errors,
            call.member.inputSchema,
          ),
      );
    return call;
  };
  const classifies = [...members.values()].some((member) => member.isConcurrencySafe);
  const effects = new Set([...members.values()].map((member) => member.effect));
  const graces = [...members.values()].flatMap((member) =>
    member.cancellationGraceMs === undefined ? [] : [member.cancellationGraceMs],
  );
  const effect = effects.size === 1 ? [...effects][0] : undefined;
  return {
    name: family.name,
    description: familyDescription(summary, members),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: 'Which operation to run; see the description for each.',
        },
        ...properties,
      },
      required: ['action'],
    },
    ...(permission ? { permission } : {}),
    ...(effect ? { effect } : {}),
    ...(graces.length ? { cancellationGraceMs: Math.max(...graces) } : {}),
    // Attached only when a member has one, so "declared nothing" keeps the registry's default reading.
    ...(classifies
      ? {
          isConcurrencySafe(args: Record<string, unknown>) {
            try {
              const call = dispatch(args);
              return call.valid && call.member.isConcurrencySafe?.(call.rest) === true;
            } catch {
              return false;
            }
          },
        }
      : {}),
    async prepare(args: Record<string, unknown>, context: ToolContext): Promise<PreparedTool> {
      const { member, rest } = checked(args);
      if (member.prepare) {
        const prepared = await member.prepare(rest, context);
        return prepared.approvalDescription || !member.approvalDescription
          ? prepared
          : { ...prepared, approvalDescription: member.approvalDescription };
      }
      return {
        ...(member.approvalDescription ? { approvalDescription: member.approvalDescription } : {}),
        execute: (scope) => member.execute(rest, scope),
      };
    },
    async execute(args, context) {
      const { member, rest } = checked(args);
      return member.execute(rest, context);
    },
  };
}

/** One line per family, in front of the per-action lines `composeFamily` adds. */
export const FAMILY_SUMMARIES: Readonly<Record<string, string>> = {
  lsp: 'Language server queries and server management. Start a server with lsp_start first.',
  lsp_edit:
    'Apply a language server edit: rename a symbol, or apply a code action listed by lsp (action "code_actions").',
};

/**
 * Replace each family's registered members with the family tool. Runs after every tool is registered, so a family
 * offers exactly the members this host has, and one with none is not registered.
 */
export function mergeToolFamilies(registry: ToolRegistry): void {
  for (const family of TOOL_FAMILIES) {
    const members = new Map<string, Tool>();
    for (const [action, name] of Object.entries(family.actions)) {
      const tool = registry.tool(name);
      if (tool) members.set(action, tool);
    }
    if (!members.size) continue;
    for (const name of Object.values(family.actions)) registry.remove(name);
    registry.register(composeFamily(family, members, FAMILY_SUMMARIES[family.name] ?? family.name));
  }
}
