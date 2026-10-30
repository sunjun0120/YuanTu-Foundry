import type { Message, ToolCategory } from '../protocol/index.ts';
import { classifyTool } from '../tools/tool-categories.ts';
import { shellRead } from './tool-advice.ts';

/**
 * How often calls went wrong in ways the model could have avoided, counted from transcripts.
 *
 * The evidence for changing a tool's description, the prompt's tool rules or the refusal messages: a rate that
 * drops after a change is the change working, and one that does not is a change to take back. Kinds are read from
 * the refusal texts the registry writes (`registry.ts`), so they are counted the same way the model read them.
 */
export interface ToolMisuse {
  sessions: number;
  calls: number;
  /** A name nothing in the run answered to. */
  unknownTool: number;
  /** Arguments that failed the tool's schema. */
  invalidArguments: number;
  /** Refused by a restriction, a policy, a person or an extension hook. */
  denied: number;
  /** The same call (name and arguments) sent again right after it failed. */
  repeatedAfterError: number;
  /** `run_command` calls that only read, listed or searched files. */
  shellReads: number;
  /** Per tool name, the calls and the avoidable failures among them, most failures first. */
  tools: { name: string; calls: number; failures: number }[];
  /**
   * The same per subsystem (`tools/tool-categories.ts`), so a change to one family's descriptions can be read as
   * one number. A name nothing classifies — a misspelt one included — is `other`.
   */
  categories: { category: ToolCategory; calls: number; failures: number }[];
}

const DENIED =
  /^(?:Permission denied by user|Permission was not granted|Blocked by the session's permission policy|Operation denied|Tool "[^"]+" is not available in this)/;

const signature = (name: string, args: unknown) => JSON.stringify([name, args]);

export function toolMisuse(
  transcripts: Iterable<readonly Message[]>,
  categoryOf: (name: string) => ToolCategory = (name) => classifyTool({ name }).category,
): ToolMisuse {
  const report: ToolMisuse = {
    sessions: 0,
    calls: 0,
    unknownTool: 0,
    invalidArguments: 0,
    denied: 0,
    repeatedAfterError: 0,
    shellReads: 0,
    tools: [],
    categories: [],
  };
  const tools = new Map<string, { name: string; calls: number; failures: number }>();
  const tool = (name: string) => {
    let found = tools.get(name);
    if (!found) tools.set(name, (found = { name, calls: 0, failures: 0 }));
    return found;
  };
  for (const messages of transcripts) {
    report.sessions++;
    const calls = new Map<string, { name: string; key: string }>();
    // Calls whose last attempt failed, by signature: sending one again unchanged is the repeat being counted.
    let failed = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const call of message.toolCalls) {
          const key = signature(call.name, call.arguments);
          calls.set(call.id, { name: call.name, key });
          report.calls++;
          tool(call.name).calls++;
          if (failed.has(key)) report.repeatedAfterError++;
          if (
            call.name === 'run_command' &&
            typeof call.arguments.command === 'string' &&
            shellRead(call.arguments.command)
          )
            report.shellReads++;
        }
        // Only the round right after a failure counts: the same call much later may follow a real change.
        failed = new Set();
        continue;
      }
      if (message.role !== 'tool' || !message.isError) continue;
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      failed.add(call.key);
      let avoidable = true;
      if (message.content.startsWith('Unknown tool:')) report.unknownTool++;
      else if (message.content.startsWith('Invalid arguments:')) report.invalidArguments++;
      else if (DENIED.test(message.content)) report.denied++;
      else avoidable = false;
      if (avoidable) tool(call.name).failures++;
    }
  }
  report.tools = [...tools.values()].sort(
    (a, b) => b.failures - a.failures || b.calls - a.calls || a.name.localeCompare(b.name),
  );
  const categories = new Map<
    ToolCategory,
    { category: ToolCategory; calls: number; failures: number }
  >();
  for (const { name, calls, failures } of report.tools) {
    const category = categoryOf(name);
    const found = categories.get(category) ?? { category, calls: 0, failures: 0 };
    found.calls += calls;
    found.failures += failures;
    categories.set(category, found);
  }
  report.categories = [...categories.values()].sort(
    (a, b) => b.failures - a.failures || b.calls - a.calls || a.category.localeCompare(b.category),
  );
  return report;
}
