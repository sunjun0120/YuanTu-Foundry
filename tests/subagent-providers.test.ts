/**
 * Sub-agent providers as a pluggable seam.
 *
 * Delegation used to be one closure with no name: a second implementation could not exist, and a caller could not
 * learn what the implementation *cannot* do — a request for an unsupported model, tool filter or depth cap was
 * ignored, which is the worst answer available, because the caller believes it asked for something else. The seam
 * that replaced it has three load-bearing properties, and each one is a way for a second provider to be less real
 * than it looks:
 *
 * 1. **A task can choose its provider**, so "the cheap one for exploration, the careful one for edits" is
 *    expressible at all.
 * 2. **The choice is validated before any child exists**, so a refusal leaves no orphan session behind — and a
 *    refusal at that point produces *no summary at all*, which is why these tests read the tool result rather
 *    than `RunResult.subagents` for the refusal cases.
 * 3. **The child really runs somewhere else.** A "second provider" that ended up delegating into the built-in path
 *    would satisfy the first two and prove nothing, so the provider in this suite answers without a model and
 *    reports a session id no real child could have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import type { AgentEvent, Provider, RunResult } from '../packages/protocol/index.ts';
import type { SubAgentProvider } from '../packages/core/subagent-providers.ts';

async function fixture(
  t: test.TestContext,
  provider: Provider,
  subagentProviders: readonly SubAgentProvider[],
  extra: { deploymentPersona?: string } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-providers-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = createTools(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (event) => events.push(event),
    subagents: { enabled: true },
    subagentProviders,
    ...extra,
  });
  return { root, store, session, agent, events, tools };
}

/** A provider that answers without a model, so a task it runs cannot have gone through the built-in path. */
function stubProvider(
  name: string,
  capabilities: SubAgentProvider['capabilities'],
  onStart?: (task: { objective: string }) => void,
): SubAgentProvider {
  return {
    name,
    description: `${name} for tests`,
    capabilities,
    async start(request) {
      onStart?.(request.task);
      return {
        sessionId: `${name}-child`,
        status: 'completed' as const,
        text: `answered by ${name}`,
        rounds: 1,
        toolCalls: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}
const isChild = (request: { system: string }): boolean =>
  request.system.includes('You are a sub-agent delegated by a parent agent');
/**
 * A parent that delegates once and then answers.
 *
 * Which turn this is has to be tracked as state: the user prompt is itself the last message on the first round, so
 * "is the last message a tool result" would answer no forever and the parent would delegate on every round.
 */
const parentProvider = (tasks: unknown[]): Provider => {
  let delegated = false;
  return {
    async complete(request) {
      if (isChild(request))
        return {
          text: 'unused',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      if (delegated)
        return {
          text: 'done',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      delegated = true;
      return {
        text: 'Delegating',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'delegate-1', name: 'delegate_task', arguments: { tasks } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
};
/**
 * What the delegation tool told the parent.
 *
 * Read from the tool's own `tool.finished` frame — where the result's fields are spread onto `data`, so the text
 * is `data.content` — rather than from `RunResult.subagents`, because a task refused at admission never becomes a
 * summary: the refusal exists only in this result, which is exactly what the model reads.
 */
function delegationResult(events: readonly AgentEvent[]): string {
  const finished = events.find(
    (event) => event.type === 'tool.finished' && event.data.callId === 'delegate-1',
  );
  return String(finished?.data.content ?? '');
}
const childIds = (result: RunResult): string[] =>
  (result.subagents ?? []).map((summary) => summary.sessionId);

test('the provider a task names is the one that answers it', async (t) => {
  const started: string[] = [];
  const alt = stubProvider(
    'alternate',
    ['outputSchema', 'depthLimit', 'toolFilter', 'persona'],
    (task) => started.push(task.objective),
  );
  const { store, session, agent } = await fixture(
    t,
    parentProvider([{ objective: 'Investigate elsewhere', provider: 'alternate' }]),
    [alt],
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(started, ['Investigate elsewhere'], 'the named provider ran the task');
  // The built-in provider would have created a real child session; this one answers with an id no child could
  // have, so the id is the evidence that the task did not quietly fall back to it.
  assert.deepEqual(childIds(result), ['alternate-child']);
  assert.deepEqual(store.childSessions(session.id), []);
});

test('a task may name a provider while its sibling uses the default', async (t) => {
  const seen: string[] = [];
  const alt = stubProvider(
    'alternate',
    ['outputSchema', 'depthLimit', 'toolFilter', 'persona'],
    (task) => seen.push(task.objective),
  );
  const { store, session, agent } = await fixture(
    t,
    parentProvider([{ objective: 'Elsewhere', provider: 'alternate' }, { objective: 'Here' }]),
    [alt],
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, ['Elsewhere'], 'only the task that named the provider went to it');
  const ids = childIds(result);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes('alternate-child'), `expected the stub child among ${ids.join(', ')}`);
  // The sibling really ran through the built-in path: it has a real session in this store.
  const real = ids.filter((id) => id !== 'alternate-child');
  assert.equal(store.childSessions(session.id).length, real.length);
});

test('a task naming a capability the provider does not declare is refused before any child exists', async (t) => {
  /**
   * The provider answers, but declares no `persona` — and every delegated task asks for one, because the child
   * has to be told it is a sub-agent. The refusal is the point: a provider that accepted and ignored this would
   * run a child that believes it is the parent.
   */
  let started = 0;
  const alt = stubProvider('poor', ['outputSchema'], () => void started++);
  const { store, session, agent, events } = await fixture(
    t,
    parentProvider([{ objective: 'Investigate', provider: 'poor' }]),
    [alt],
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed');
  const told = delegationResult(events);
  assert.match(told, /UNSUPPORTED_CAPABILITY/);
  // Which missing capability is reported depends on the order the options are checked, so the assertion is about
  // the *shape* of the refusal — a named capability, refused rather than ignored — not one particular name.
  assert.match(told, /does not support \w+/);
  assert.match(told, /refused rather than run/);
  // Refused *before* scheduling: no child session, no summary, and the provider never asked to start.
  assert.deepEqual(store.childSessions(session.id), []);
  assert.equal(started, 0);
  assert.equal(result.subagents, undefined);
});

test('an unknown provider name is refused, by the schema the model was given', async (t) => {
  const alt = stubProvider('alternate', ['outputSchema', 'depthLimit', 'toolFilter', 'persona']);
  const { store, session, agent, events } = await fixture(
    t,
    parentProvider([{ objective: 'Investigate', provider: 'nope' }]),
    [alt],
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed');
  const told = delegationResult(events);
  /**
   * Refused by the task schema, not by the registry — and that ordering is the point.
   *
   * When the field is offered at all, its `enum` is the names that exist, so a name that does not is an invalid
   * *argument* and the model is told which values are allowed. The registry's `UnknownSubAgentProviderError` is
   * therefore unreachable from a model-driven call; it stays for host-driven paths (a coordinator configured with
   * a name that was never registered), where there is no schema to check against. Asserting the schema refusal
   * here is what keeps the two from silently swapping roles.
   */
  assert.match(told, /Invalid arguments/);
  assert.match(told, /provider must be equal to one of the allowed values/);
  assert.deepEqual(store.childSessions(session.id), []);
});

test('a provider name that was never registered is refused by the registry, for a host-driven path', async () => {
  // The other half of the refusal above: no schema is consulted when the *host* names the provider, so the
  // registry's own check is what a misconfigured deployment hits — and it names what does exist.
  const { SubAgentProviderRegistry } = await import('../packages/core/subagent-providers.ts');
  const registry = new SubAgentProviderRegistry();
  registry.register(stubProvider('alternate', ['outputSchema']));
  assert.throws(
    () => registry.resolve('nope', { outputSchema: {} }),
    /Unknown sub-agent provider "nope"; registered providers: alternate/,
  );
  assert.throws(
    () => registry.resolve('alternate', { outputSchema: {}, persona: 'x' }),
    /does not support persona \(UNSUPPORTED_CAPABILITY\)/,
  );
});

test('the provider choice is offered to the model only when there is a choice', async (t) => {
  const alt = stubProvider('alternate', ['outputSchema', 'depthLimit', 'toolFilter', 'persona']);
  /**
   * The task properties of the schema the model was actually sent.
   *
   * Read from the request rather than from the registry's own tool objects: what matters is what the model is
   * told, and a test that inspected the coordinator's internal schema would keep passing after the tool stopped
   * sending it.
   */
  const taskProperties = async (
    tools: ReturnType<typeof createTools>,
    subagentProviders: readonly SubAgentProvider[],
  ): Promise<Record<string, unknown>> => {
    let seen: Record<string, unknown> = {};
    const { session, agent } = await fixture(
      t,
      {
        async complete(request) {
          const spec = request.tools.find((tool) => tool.name === 'delegate_task');
          const schema = spec?.inputSchema as {
            properties?: { tasks?: { items?: { properties?: Record<string, unknown> } } };
          };
          seen = schema?.properties?.tasks?.items?.properties ?? {};
          return {
            text: 'no delegation',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
      subagentProviders,
    );
    await agent.run({ sessionId: session.id, prompt: 'Investigate' });
    void tools;
    return seen;
  };
  const soloTask = await taskProperties(createTools(process.cwd()), []);
  const chooserTask = await taskProperties(createTools(process.cwd()), [alt]);
  // A host with one provider must not advertise a field whose only possible answer is a name that cannot exist.
  assert.equal('provider' in soloTask, false);
  assert.equal('provider' in chooserTask, true);
  assert.deepEqual((chooserTask.provider as { enum?: string[] }).enum?.slice().sort(), [
    'alternate',
    'in-process',
  ]);
});

test('a task persona replaces the deployment persona for that child alone, and keeps the harness identity', async (t) => {
  /**
   * The `persona` capability, honoured rather than declared.
   *
   * Three things have to hold at once, and each is a way the wiring could be wrong: the child speaks with the
   * persona its delegation named, the *deployment's* persona is gone for that child (a persona replaces, it does
   * not accumulate), and the harness's own identity paragraph **survives** — which is the failure mode of sending
   * the role prompt through this slot, as the coordinator used to.
   */
  const childSystem: string[] = [];
  const parent = parentProvider([
    { objective: 'Investigate', persona: 'You are a security reviewer.' },
  ]);
  const { session, agent } = await fixture(
    t,
    {
      async complete(request) {
        // The child is the request whose system prompt says it is a sub-agent; capture those.
        if (isChild(request)) childSystem.push(request.system);
        return parent.complete(request);
      },
    },
    [],
    { deploymentPersona: 'You are the deployment default.' },
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed');
  assert.equal(childSystem.length, 1, `expected one child request, saw ${childSystem.length}`);
  const system = childSystem[0]!;
  assert.match(system, /You are a security reviewer\./);
  assert.doesNotMatch(system, /You are the deployment default\./);
  // The identity paragraph is the one that carries how to use tools and when to verify a deliverable: losing it
  // is silent, which is why it is asserted by content rather than by a section name.
  assert.match(system, /You are YuanTu, a coding agent/);
  assert.match(system, /Use tools to inspect the workspace before editing/);
  // The role is still the role, in its own additive slot.
  assert.match(system, /You are read-only/);
});

test('a child with no persona keeps the deployment persona', async (t) => {
  const childSystem: string[] = [];
  const parent = parentProvider([{ objective: 'Investigate' }]);
  const { session, agent } = await fixture(
    t,
    {
      async complete(request) {
        if (isChild(request)) childSystem.push(request.system);
        return parent.complete(request);
      },
    },
    [],
    { deploymentPersona: 'You are the deployment default.' },
  );
  await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(childSystem.length, 1);
  assert.match(childSystem[0]!, /You are the deployment default\./);
});

// What a host needs to decide whether delegation is configured the way it means; the capabilities are the same
// list the registry validates requests against, so a reader cannot be told about a promise nobody keeps.
test('the registered providers are discoverable, with what each one can honour', async (t) => {
  const alt = stubProvider('alternate', ['outputSchema', 'contextFork']);
  const { tools } = await fixture(t, parentProvider([{ objective: 'Investigate' }]), [alt]);
  void tools;
  const { SubAgentProviderRegistry } = await import('../packages/core/subagent-providers.ts');
  const registry = new SubAgentProviderRegistry();
  registry.register(alt);
  assert.deepEqual(registry.describe(), [
    {
      name: 'alternate',
      description: 'alternate for tests',
      capabilities: ['outputSchema', 'contextFork'],
    },
  ]);
  assert.deepEqual(registry.names(), ['alternate']);
  // A duplicate name is a programming error rather than a precedence puzzle.
  assert.throws(() => registry.register(alt), /Duplicate sub-agent provider/);
  // An unknown capability in a declaration is refused at registration, so `describe()` cannot report a promise
  // the validator would never check.
  assert.throws(
    () => registry.register({ ...alt, name: 'bad', capabilities: ['nonsense'] as never }),
    /Unknown sub-agent capability/,
  );
});
