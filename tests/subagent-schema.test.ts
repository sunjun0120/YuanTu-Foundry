import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import type { SubAgentOptions } from '../packages/core/subagents.ts';
import type { ResolvedSubAgentStartRequest } from '../packages/core/subagent-providers.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';

/**
 * Per-task `outputSchema`: the caller decides the shape its sub-agent comes back with.
 *
 * The seam for this already existed and was inert: `SubAgentRequestOptions.outputSchema` was a declared capability
 * that the coordinator always filled in with the *fixed* report contract, so a caller could not ask for anything
 * else and a provider could not be handed anything else. What the tests pin, then, is that the declaration now
 * means something — on both ends:
 *
 * - the **caller's schema reaches the child** as the argument schema of the tool it submits through, which is what
 *   makes the answer validated rather than merely requested (the registry's Ajv pass is the same one every other
 *   tool call gets);
 * - the **object comes back as `data`**, not folded into the report shape and not left as prose the parent has to
 *   parse — while a task that asked for nothing still gets the report it always did.
 *
 * The refusals are as much a part of this as the success path: a schema that is not an object, does not compile, or
 * is too large is refused **before any child exists**, which is the same rule the capability checks follow.
 */

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const delegate = (tasks: unknown[]): ModelResponse => ({
  text: 'Delegating',
  finishReason: 'tool_calls',
  toolCalls: [{ id: 'delegate-1', name: 'delegate_task', arguments: { tasks } }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const submit = (id: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name: 'submit_report', arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
function isChild(request: ModelRequest): boolean {
  return request.system.includes('You are a sub-agent delegated by a parent agent');
}
function toolResults(store: SessionStore, sessionId: string): string {
  return store
    .messages(sessionId)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
    .join('\n');
}
/** The schema the child was actually handed, as it appears in the request it received. */
function submittedSchema(request: ModelRequest): Record<string, unknown> | undefined {
  return request.tools.find((tool) => tool.name === 'submit_report')?.inputSchema;
}
/** The files a caller wants back: a shape that has nothing to do with the report contract. */
const FILES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' }, description: 'Every path inspected.' },
    verdict: { type: 'string', enum: ['clean', 'suspect'], description: 'What you concluded.' },
  },
  required: ['files', 'verdict'],
  additionalProperties: false,
};

async function fixture(
  t: test.TestContext,
  provider: Provider,
  extra: { subagents?: SubAgentOptions } & Record<string, unknown> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-schema-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const { subagents, ...rest } = extra;
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true, ...subagents },
    ...rest,
  });
  return { root, store, session, agent };
}

test('a task’s schema reaches the child and its object comes back as the answer', async (t) => {
  const seen: (Record<string, unknown> | undefined)[] = [];
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        seen.push(submittedSchema(request));
        return submit('report-1', { files: ['a.ts', 'b.ts'], verdict: 'clean' });
      }
      if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
      return delegate([{ objective: 'List the files you checked', schema: FILES_SCHEMA }]);
    },
  };
  const { store, session, agent } = await fixture(t, provider);
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Check' })).status, 'completed');
  assert.deepEqual(
    seen,
    [FILES_SCHEMA],
    'the caller’s schema is the child’s submission tool schema — the answer is validated, not just requested',
  );
  const output = toolResults(store, session.id);
  // The answer is machine-readable, which is the whole reason the caller declared a shape: what it asked for is
  // what it can parse back, rather than prose it has to read.
  const rendered: unknown = JSON.parse(output.slice(output.indexOf('result:') + 'result:'.length));
  assert.deepEqual(rendered, { files: ['a.ts', 'b.ts'], verdict: 'clean' });
  assert.ok(
    !output.includes('findings:'),
    `the object replaces the report shape rather than extending it: ${output}`,
  );
  assert.ok(
    !output.includes('summary:'),
    'and the fixed report contract is not also rendered beside it',
  );
});

test('the caller’s schema is enforced where every other tool argument is', async (t) => {
  let childRound = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childRound++;
        // First call: missing `verdict` and carrying a field the schema forbids. The registry's Ajv pass rejects
        // it, so nothing reaches the tool — which is the point of making the schema the tool's schema.
        if (childRound === 1) return submit('bad', { files: ['a.ts'], extra: 'not allowed' });
        return submit('good', { files: ['a.ts'], verdict: 'suspect' });
      }
      if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
      return delegate([{ objective: 'List the files you checked', schema: FILES_SCHEMA }]);
    },
  };
  const { store, session, agent } = await fixture(t, provider);
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Check' })).status, 'completed');
  assert.equal(childRound, 2, 'the child got to correct itself');
  const childSession = store.subagents(session.id)[0]!.sessionId;
  const childOutput = toolResults(store, childSession);
  assert.match(
    childOutput,
    /Invalid arguments/,
    'the mismatched submission was refused as a tool error',
  );
  assert.match(childOutput, /verdict/, 'and the refusal names what was missing');
  const output = toolResults(store, session.id);
  assert.match(output, /"verdict": "suspect"/);
  assert.ok(!output.includes('"extra"'), 'nothing that violated the schema reached the parent');
});

test('a task with a schema and a task without one are answered in their own shapes', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        const prompt = String(
          [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '',
        );
        if (prompt.includes('shape')) return submit('r1', { files: ['a.ts'], verdict: 'clean' });
        return submit('r2', {
          summary: 'the report child',
          findings: [{ statement: 'it looked', evidence: 'ls' }],
        });
      }
      if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
      return delegate([
        { objective: 'Answer in my shape', schema: FILES_SCHEMA },
        { objective: 'Answer in the normal way' },
      ]);
    },
  };
  const { store, session, agent } = await fixture(t, provider);
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Check' })).status, 'completed');
  const output = toolResults(store, session.id);
  assert.match(output, /result:\n\{/, 'the schema task is rendered as the object it asked for');
  assert.match(output, /summary: the report child/, 'the other task keeps the report contract');
  assert.match(output, /findings:\n- it looked/, 'with its findings where they have always been');
});

test('a schema that is not an object, does not compile, or is too large is refused before any child exists', async (t) => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['an array schema', { type: 'array', items: { type: 'string' } }, /must describe an object/],
    [
      'a schema that is not valid JSON Schema',
      { type: 'object', properties: { a: { type: 'nonsense' } } },
      /must be a valid JSON Schema/,
    ],
    [
      'a schema with no properties',
      { type: 'object', properties: {} },
      /needs at least one property/,
    ],
    [
      'a schema that is too large',
      {
        type: 'object',
        properties: {
          a: { type: 'string', description: 'x'.repeat(4_500) },
        },
      },
      /must be under 4000 characters/,
    ],
  ];
  for (const [what, schema, expected] of cases) {
    let round = 0;
    let childStarted = false;
    const provider: Provider = {
      async complete(request) {
        if (isChild(request)) {
          childStarted = true;
          return reply('should never run');
        }
        round++;
        if (round === 1) return delegate([{ objective: 'Do it', schema }]);
        if (request.messages.some((message) => message.content.includes('schema')))
          return reply('Understood');
        return reply('Done');
      },
    };
    const { store, session, agent } = await fixture(t, provider);
    assert.equal(
      (await agent.run({ sessionId: session.id, prompt: 'Check' })).status,
      'completed',
      what,
    );
    const output = toolResults(store, session.id);
    assert.match(output, expected, what);
    assert.equal(childStarted, false, `${what}: no child was created`);
    assert.deepEqual(
      store.events(session.id).filter((event) => event.type === 'subagent.assigned'),
      [],
      `${what}: the refusal left nothing behind in the log`,
    );
  }
});

test('a provider is asked for the shape the caller declared, not the default one', async (t) => {
  // The assertion of the capability itself is unchanged (`outputSchema` is always requested); what this pins is
  // that the *value* now travels with the task, so a provider that only implements the fixed report contract can
  // be told apart by what the caller asked for rather than by a flag nobody set.
  const requests: Record<string, unknown>[] = [];
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) return submit('r1', { files: ['a.ts'], verdict: 'clean' });
      if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
      return delegate([{ objective: 'Shape it', schema: FILES_SCHEMA }]);
    },
  };
  const { session, agent } = await fixture(t, provider, {
    subagentProviders: [
      {
        name: 'recording',
        capabilities: ['outputSchema', 'depthLimit', 'persona', 'toolFilter'],
        start: async (request: ResolvedSubAgentStartRequest) => {
          requests.push(request.options as Record<string, unknown>);
          return {
            sessionId: session.id,
            status: 'completed',
            text: '',
            rounds: 0,
            toolCalls: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      },
    ],
    subagentProvider: 'recording',
  });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Check' })).status, 'completed');
  assert.deepEqual(
    requests[0]?.outputSchema,
    FILES_SCHEMA,
    'the provider is asked for the shape the caller declared, not for the default one',
  );
});
