/**
 * The summary popover's reading: which MCP calls the latest turn made, and how each one ended.
 *
 * A turn starts at the last message a person wrote; runtime snapshots and compaction summaries are bookkeeping, not
 * a new question, so they do not start one. Two kinds of tool reach an MCP server: the built-in analysis service's
 * `scan_<tool>` and a configured server's `mcp_<id>_<operation>` proxies. Every other tool is local and not listed.
 * Nothing here formats DOM, so the panel and the tests share one source.
 */
import type { CarrierSnapshot } from '../../../../packages/carrier/contract.ts';
import { BUILTIN_TOOL_PREFIX } from '../../../../packages/builtin-services/manifest.ts';
import { isMachineContext } from '../../../../packages/protocol/context.ts';
import type { Message, ToolCall } from '../../../../packages/protocol/index.ts';

const MCP_OPERATIONS = [
  'list_tools',
  'call_tool',
  'list_resources',
  'read_resource',
  'list_prompts',
  'get_prompt',
] as const;
const MCP_PROXY = new RegExp(`^mcp_([a-z][a-z0-9_]{0,31})_(${MCP_OPERATIONS.join('|')})$`);
const BUILTIN = `${BUILTIN_TOOL_PREFIX}_`;
const ARGS_CHARS = 120;

/** `running` while the run may still answer it; `interrupted` when the run ended without a result. */
export type SummaryCallStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface SummaryCall {
  id: string;
  /** `null` for the built-in analysis service, otherwise the configured server's id. */
  server: string | null;
  /** The tool's name on its server, or the proxy operation when it names no tool (`list_tools`, …). */
  tool: string;
  args: string;
  status: SummaryCallStatus;
}

export interface SummaryView {
  visible: boolean;
  calls: SummaryCall[];
  failed: number;
}

/** What a call reaches, or `null` for a local tool. */
export function mcpTarget(
  call: ToolCall,
): { server: string | null; tool: string; args: unknown } | null {
  if (call.name.startsWith(BUILTIN) && call.name.length > BUILTIN.length)
    return { server: null, tool: call.name.slice(BUILTIN.length), args: call.arguments };
  const match = MCP_PROXY.exec(call.name);
  if (!match) return null;
  const [, server, operation] = match as unknown as [string, string, string];
  const args = call.arguments ?? {};
  if (operation === 'call_tool' && typeof args.name === 'string')
    return { server, tool: args.name, args: args.arguments };
  if (operation === 'get_prompt' && typeof args.name === 'string')
    return { server, tool: `${operation} ${args.name}`, args: args.arguments };
  if (operation === 'read_resource' && typeof args.uri === 'string')
    return { server, tool: operation, args: { uri: args.uri } };
  return { server, tool: operation, args: {} };
}

/** `key=value` pairs on one line, so a row says what was asked without opening anything. */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const text = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return text.length > ARGS_CHARS ? `${text.slice(0, ARGS_CHARS - 1)}…` : text;
}

/** Index of the first message of the latest turn, or `-1` when no person has written yet. */
export function latestTurnStart(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user' && !isMachineContext(message.content)) return index;
  }
  return -1;
}

export function turnMcpCalls(messages: readonly Message[], running: boolean): SummaryCall[] {
  const start = latestTurnStart(messages);
  if (start < 0) return [];
  const results = new Map<string, boolean>();
  for (let index = start + 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === 'tool') results.set(message.toolCallId, message.isError);
  }
  const calls: SummaryCall[] = [];
  for (let index = start + 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      const target = mcpTarget(call);
      if (!target) continue;
      const isError = results.get(call.id);
      calls.push({
        id: call.id,
        server: target.server,
        tool: target.tool,
        args: summarizeArgs(target.args),
        status:
          isError === undefined
            ? running
              ? 'running'
              : 'interrupted'
            : isError
              ? 'failed'
              : 'succeeded',
      });
    }
  }
  return calls;
}

export function summaryView(snapshot: CarrierSnapshot | null): SummaryView {
  const session = snapshot?.session;
  if (!session?.sessionId) return { visible: false, calls: [], failed: 0 };
  const calls = turnMcpCalls(session.messages, session.running);
  // A call in flight may not be in the stored messages yet; the run's own list of executing tools has it.
  if (session.running) {
    // A stale live entry must not bring an earlier turn's call back into the current turn.
    const known = new Set(
      session.messages.flatMap((message) =>
        message.role === 'assistant' ? message.toolCalls.map((call) => call.id) : [],
      ),
    );
    for (const call of session.tools) {
      const target = known.has(call.id) ? null : mcpTarget(call);
      if (target)
        calls.push({
          id: call.id,
          server: target.server,
          tool: target.tool,
          args: summarizeArgs(target.args),
          status: 'running',
        });
    }
  }
  return {
    visible: true,
    calls,
    failed: calls.filter((call) => call.status === 'failed').length,
  };
}
