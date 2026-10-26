import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { ModelRequest, ToolSpec } from '../packages/protocol/index.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/catalog/index.ts';
import { httpFixture } from './http-fixture.ts';
import { storeFixture } from './temp-fixture.ts';

const readSpec: ToolSpec = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 } },
    required: ['path'],
    additionalProperties: false,
  },
};
// Literal protocol bytes from the observed failing route; expectations below are hand-derived.
const readCall = `<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="path" string="true">你好.py</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="start_line" string="false">36</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`;
const block = (calls = readCall) => `<｜｜DSML｜｜ calls>\n${calls}\n</｜｜DSML｜｜ calls>`;
function send(res: ServerResponse, text: string, finish = 'stop', native = false) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  event({ choices: [{ index: 0, delta: { reasoning_content: 'Inspect the file' } }] });
  // Split markers, parameter tags and unicode across SSE deltas.
  for (let i = 0; i < text.length; i += 3)
    event({ choices: [{ index: 0, delta: { content: text.slice(i, i + 3) } }] });
  if (native)
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'native-1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"native.py"}' },
              },
            ],
          },
        },
      ],
    });
  event({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  event({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  res.end('data: [DONE]\n\n');
}
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    system: 'Use the declared tools',
    messages: [{ role: 'user', content: 'Read the file' }],
    tools: [readSpec],
    maxOutputTokens: 1000,
    signal: new AbortController().signal,
    onText: () => {},
    ...overrides,
  };
}
async function endpoint(t: test.TestContext, text: string, finish = 'stop', native = false) {
  const url = await httpFixture(t, (_body, res) => send(res, text, finish, native));
  return new OpenAIProvider({ apiKey: 'fixture', model: 'DeepSeek-V4.1-Flash-1017', baseUrl: url });
}

test('DeepSeek fragmented DSML becomes a tool turn and streams only its prose prefix', async (t) => {
  const provider = await endpoint(t, 'Reading now.\n\n' + block());
  let shown = '';
  const result = await provider.complete(
    request({
      onText: (part) => {
        shown += part;
      },
    }),
  );
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.match(result.toolCalls[0]!.id, /^dsml_/);
  assert.equal(result.toolCalls[0]!.name, 'read_file');
  assert.deepEqual(result.toolCalls[0]!.arguments, { path: '你好.py', start_line: 36 });
  assert.equal(result.text, 'Reading now.\n\n');
  assert.equal(shown, result.text, 'DSML is never emitted as an answer delta');
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });
});

test('DSML preserves multiline string bytes and decodes nonstring JSON values', async (t) => {
  const spec: ToolSpec = {
    name: 'edit_file',
    description: 'Edit',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        options: { type: 'array', items: { type: 'boolean' } },
      },
      required: ['text', 'options'],
      additionalProperties: false,
    },
  };
  const provider = await endpoint(
    t,
    block(`<｜｜DSML｜｜ invoke name="edit_file">
<｜｜DSML｜｜ parameter name="text" string="true">    α &amp; <tag>\r\n\n    β  </｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="options" string="false">[true,false]</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`),
  );
  const result = await provider.complete(request({ tools: [spec] }));
  assert.deepEqual(
    result.toolCalls.map((c) => c.arguments),
    [{ text: '    α &amp; <tag>\r\n\n    β  ', options: [true, false] }],
  );
});

test('DSML validates every call before returning any executable batch', async (t) => {
  const valid = await endpoint(t, block(readCall + '\n' + readCall));
  const response = await valid.complete(request());
  assert.equal(response.toolCalls.length, 2);
  assert.notEqual(response.toolCalls[0]!.id, response.toolCalls[1]!.id);
  const invalids = [
    block(readCall + '\n' + readCall.replace('name="read_file"', 'name="undeclared"')),
    block(readCall.replace('>36<', '>0<')),
    block(readCall.replace('>36<', '>"36"<')),
    block(readCall.replace('>36<', '>not-json<')),
    block(readCall.replace('name="start_line"', 'name="path"')),
    block(readCall.replace('name="path"', 'name="unexpected"')),
    block(readCall.replace('name="path"', 'name="__proto__"')),
    block(readCall.replace('string="false"', 'string="maybe"')),
    block().replace('</｜｜DSML｜｜ calls>', ''),
    block() + '\nUnexpected trailing text',
    block(''),
  ];
  for (const text of invalids) {
    const provider = await endpoint(t, text);
    await assert.rejects(provider.complete(request()), (error: unknown) => {
      assert.ok(error instanceof RunFailure);
      assert.equal(error.code, 'unsupported');
      assert.match(error.message, /DSML/);
      assert.deepEqual(error.details?.usage, { inputTokens: 20, outputTokens: 10 });
      return true;
    });
  }
});

test('DSML never enables absent or disabled tools and refuses mixed native calls', async (t) => {
  for (const input of [request({ tools: [] }), request({ toolChoice: 'none' })]) {
    const provider = await endpoint(t, block());
    await assert.rejects(provider.complete(input), /DSML/);
  }
  const mixed = await endpoint(t, block(), 'tool_calls', true);
  await assert.rejects(mixed.complete(request()), /DSML/);
});

test('DSML examples and non-DeepSeek routes keep their text without executing it', async (t) => {
  for (const text of [
    'Example:\n\n```xml\n' + block() + '\n```',
    'Example:\n\n~~~xml\n' + block() + '\n~~~',
    'Inline: ' + block(),
    '> ' + block().replaceAll('\n', '\n> '),
    '```\ncode\n```\n\n' + block(),
    'ordinary <｜｜DSML',
  ]) {
    const provider = await endpoint(t, text);
    let shown = '';
    const result = await provider.complete(
      request({
        onText: (part) => {
          shown += part;
        },
      }),
    );
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.text, text);
    assert.equal(shown, text);
  }
  for (const config of [
    { model: 'other-model' },
    { model: 'DeepSeek-V4.1-Flash-1017', deepseekCompatibility: 'off' as const },
  ]) {
    const url = await httpFixture(t, (_body, res) => send(res, block()));
    const result = await new OpenAIProvider({
      apiKey: 'fixture',
      baseUrl: url,
      ...config,
    }).complete(request());
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.text, block());
  }
});

test('DSML output limits and content filtering never produce calls', async (t) => {
  for (const finish of ['length', 'content_filter']) {
    const provider = await endpoint(t, block(), finish);
    const result = await provider.complete(request());
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.finishReason, finish === 'length' ? 'length' : 'content-filter');
  }
});

test('normalized DSML native replay contains standard calls and retains reasoning', async (t) => {
  const bodies: any[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    send(res, bodies.length === 1 ? block() : 'Done');
  });
  const provider = new OpenAIProvider({
    apiKey: 'fixture',
    model: 'alias',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete(request());
  assert.equal(first.toolCalls.length, 1);
  const id = first.toolCalls[0]!.id;
  await provider.complete(
    request({
      messages: [
        ...request().messages,
        {
          role: 'assistant',
          content: first.text,
          toolCalls: first.toolCalls,
          providerState: first.providerState,
        },
        { role: 'tool', toolCallId: id, content: 'file body', isError: false },
      ],
    }),
  );
  const replay = bodies[1].messages.find((m: any) => m.role === 'assistant');
  assert.equal(replay.content, null);
  assert.equal(replay.reasoning_content, 'Inspect the file');
  assert.equal(replay.tool_calls[0].id, id);
  assert.equal(replay.tool_calls[0].function.arguments, '{"path":"你好.py","start_line":36}');
  assert.equal(bodies[1].messages.at(-1).tool_call_id, id);
});

test('DSML edits use the real registry and honor approval denial', async (t) => {
  for (const allowed of [true, false]) {
    const { root, store, session } = await storeFixture(t, 'yuantu-dsml-');
    await writeFile(path.join(root, 'a.txt'), 'before\n');
    const edit = block(`<｜｜DSML｜｜ invoke name="edit_file">
<｜｜DSML｜｜ parameter name="path" string="true">a.txt</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="old_text" string="true">before</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="new_text" string="true">after</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`);
    let rounds = 0,
      approvals = 0;
    const url = await httpFixture(t, (_body, res) => {
      const turn = rounds++;
      send(
        res,
        turn === 0 ? block(readCall.replace('你好.py', 'a.txt')) : turn === 1 ? edit : 'Done',
      );
    });
    const agent = new Agent({
      store,
      provider: new OpenAIProvider({
        apiKey: 'fixture',
        model: 'DeepSeek-V4.1-Flash-1017',
        baseUrl: url,
      }),
      tools: createTools(root),
      maxModelRetries: 0,
      approve: async () => {
        approvals++;
        return allowed;
      },
    });
    const result = await agent.run({
      sessionId: session.id,
      prompt: 'Change before to after in a.txt',
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(approvals, 1);
    assert.equal(
      await readFile(path.join(root, 'a.txt'), 'utf8'),
      allowed ? 'after\n' : 'before\n',
    );
    assert.ok(
      store.messages(session.id).some((m) => m.role === 'tool'),
      'the call travels through the normal tool pipeline',
    );
  }
});
