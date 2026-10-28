/**
 * Sandbox preparation as a run announces it.
 *
 * The Windows account backend's first workspace authorization can walk a large tree for minutes, and the command
 * has not started while it does. The tool is the only layer that knows when that wait begins and ends, the run is
 * the only layer that can publish it, and the two are joined by the ambient preparation context: this test pins
 * that a tool sees the context and that the run turns its pair of reports into two live frames keyed by call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/catalog/index.ts';
import { currentSandboxPreparation } from '../packages/sandbox/sandbox-provider.ts';
import { storeFixture } from './temp-fixture.ts';
import type {
  AgentEvent,
  ModelResponse,
  Provider,
  Tool,
  ToolContext,
  ToolResult,
} from '../packages/protocol/index.ts';

const answer: ModelResponse = {
  text: 'Finished',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
};
const ask: ModelResponse = {
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id: 'prepare-1', name: 'prepare', arguments: {} }],
  usage: { inputTokens: 10, outputTokens: 5 },
};

test('a preparation reported inside a tool becomes a pair of live frames for that call', async (t) => {
  const reports = [
    { stage: 'workspace-authorization' as const, root: 'E:\\work', active: true },
    { stage: 'workspace-authorization' as const, root: 'E:\\work', active: false },
  ];
  const preparation: Tool = {
    name: 'prepare',
    description:
      'Reports the sandbox preparation it is waiting for, as the Windows account backend does.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, context: ToolContext): Promise<ToolResult> {
      const ambient = currentSandboxPreparation();
      assert.ok(
        ambient?.onPreparation,
        'the registry must make the observer ambient around the body',
      );
      // Authorization remains cancellable while its wait is excluded from the execution budget.
      assert.ok(ambient.signal, 'the wait must be cancellable');
      assert.equal(ambient.onPreparation, context.onPreparation);
      for (const report of reports) ambient.onPreparation!(report);
      return { isError: false, content: 'prepared' };
    },
  };
  let round = 0;
  const provider: Provider = {
    async complete() {
      return round++ === 0 ? ask : answer;
    },
  };
  const { root, store, session } = await storeFixture(t, 'yuantu-preparation-');
  const tools = createTools(root);
  tools.register(preparation);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'Prepare the workspace' })).status,
    'completed',
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'tool.preparation').map((event) => event.data),
    reports.map((report) => ({ callId: 'prepare-1', name: 'prepare', ...report })),
  );
  // Live only: the pair describes a wait that is over by the time the call answers, so it is not a durable fact.
  assert.equal(
    store.events(session.id).some((event) => event.type === 'tool.preparation'),
    false,
  );
});
