/**
 * Leaves one tool call hanging under an hour-long budget, on purpose, and then does nothing.
 *
 * Run by `tool-timeout.test.ts`. The process must end by itself: the only thing still pending is a deadline
 * timer, and a timer that keeps a process alive would keep the user's agent alive too. No `process.exit` here —
 * calling one would hide exactly the failure this exists to catch.
 */
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { ToolResult } from '../packages/protocol/index.ts';

const registry = new ToolRegistry();
registry.register({
  name: 'hang',
  description: 'never answers',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: () => new Promise<ToolResult>(() => {}),
});
registry.deadlines = { defaultMs: 3_600_000 };
void registry
  .execute(
    { id: 'call-hang', name: 'hang', arguments: {} },
    {
      signal: new AbortController().signal,
      approve: async () => true,
    },
  )
  .catch(() => undefined);
console.log('hanging call launched');
