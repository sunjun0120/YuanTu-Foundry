import type { ProviderState, ToolCall } from '../protocol/index.ts';
import { TOOL_ALIASES, resolveToolAlias } from '../protocol/tool-families.ts';

/**
 * History by the tool names this request declares.
 *
 * A session recorded before a tool family replaced some names (`../protocol/tool-families.ts`) holds calls by the
 * old names. The visible calls and the native output are rewritten here, item by item, by the protocol that owns
 * their shape. Reasoning items, thinking blocks and `reasoning_content` are left untouched: a tool loop resumed
 * mid-turn must hand them back exactly as they were produced. Whether native output is replayed at all is still
 * decided against the stored message (its hash covers the stored calls), so nothing here recomputes a hash.
 * History that holds no old name comes back as the same objects.
 */
export function currentToolCalls(calls: readonly ToolCall[]): readonly ToolCall[] {
  return calls.some((call) => TOOL_ALIASES.has(call.name))
    ? calls.map((call) => resolveToolAlias(call))
    : calls;
}

/** A JSON-encoded argument object with the action its old tool name became; anything unreadable stays as it was. */
function withAction(name: string, encoded: unknown): unknown {
  const alias = TOOL_ALIASES.get(name);
  if (!alias || typeof encoded !== 'string') return encoded;
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return encoded;
    return JSON.stringify({ action: alias.action, ...(parsed as Record<string, unknown>) });
  } catch {
    return encoded;
  }
}

const aliased = (name: unknown): name is string =>
  typeof name === 'string' && TOOL_ALIASES.has(name);

/** The native output of one assistant message, with each tool call under the name this request declares. */
export function currentNativeOutput(state: ProviderState): Record<string, unknown>[] {
  if (state.protocol === 'openai-responses')
    return state.output.map((item) =>
      item.type === 'function_call' && aliased(item.name)
        ? {
            ...item,
            name: TOOL_ALIASES.get(item.name)!.tool,
            arguments: withAction(item.name, item.arguments),
          }
        : item,
    );
  if (state.protocol === 'anthropic')
    return state.output.map((block) => {
      if (block.type !== 'tool_use' || !aliased(block.name)) return block;
      const alias = TOOL_ALIASES.get(block.name)!;
      const input =
        block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {};
      return { ...block, name: alias.tool, input: { action: alias.action, ...input } };
    });
  return state.output.map((message) => {
    const calls = message.tool_calls;
    if (!Array.isArray(calls)) return message;
    return {
      ...message,
      tool_calls: calls.map((call: { function?: { name?: unknown; arguments?: unknown } }) => {
        const name = call.function?.name;
        if (!aliased(name)) return call;
        return {
          ...call,
          function: {
            ...call.function,
            name: TOOL_ALIASES.get(name)!.tool,
            arguments: withAction(name, call.function?.arguments),
          },
        };
      }),
    };
  });
}
