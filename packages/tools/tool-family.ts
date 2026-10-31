import { isDeepStrictEqual } from 'node:util';
import type { PreparedTool, Tool, ToolContext, ToolFamily } from '../protocol/index.ts';
import { invalidArgumentsMessage } from './call-result.ts';
import { compileToolSchema, toolSchemaErrorsText } from './registry.ts';

type Properties = Record<string, Record<string, unknown>>;

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
    description:
      summary +
      '\n' +
      actions.map((action) => `- ${action}: ${members.get(action)!.description}`).join('\n'),
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
