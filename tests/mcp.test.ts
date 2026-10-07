import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import type { ToolContext } from '../packages/protocol/index.ts';
import { mcpHttpFixture } from './mcp-http-fixture.ts';
import { mcpOAuthFixture } from './mcp-oauth-fixture.ts';
import { closeWithin, mcpTools } from '../packages/mcp/tools.ts';
import { parseMcpConfigs } from '../packages/mcp/config.ts';
import type { McpConfig } from '../packages/mcp/config.ts';
import {
  McpOAuthTokenStore,
  authorizeMcpServer,
  readMcpOAuthStatus,
  revokeMcpAuthorization,
} from '../packages/mcp/oauth.ts';
import { McpSettingsStore } from '../apps/desktop/mcp-settings.ts';
import { parseMcpCommand } from '../apps/desktop/mcp-contract.ts';

// ---- merged from mcp.test.ts ----

async function setup(t: test.TestContext, servers: Record<string, unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-'));
  const cleanups: (() => Promise<void>)[] = [];
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups = cleanups;
  t.after(async () => {
    for (const close of cleanups) await close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, '.yuantu'));
  await writeFile(path.join(root, '.yuantu/mcp.json'), JSON.stringify({ servers }));
  return root;
}
const fixture = path.resolve('tests/mcp-fixture.ts');
const ctx = (allow = true): ToolContext => ({
  signal: new AbortController().signal,
  approve: async (approval) => {
    assert.equal(approval.kind, 'external');
    return allow;
  },
});
/** Invokes a proxy tool from an `mcpTools()` bundle directly, mirroring registry dispatch. */
async function run(
  connection: {
    tools: {
      name: string;
      execute: (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ) => Promise<{ content: string; isError: boolean }>;
    }[];
  },
  name: string,
  args: Record<string, unknown> = {},
  context = ctx(),
) {
  const tool = connection.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute(args, context);
}
test('MCP configuration creates discover/call proxies and refuses plaintext authentication', async (t) => {
  const root = await setup(t, {
    local: { transport: 'stdio', command: process.execPath, args: [fixture] },
  });
  const tools = createTools(root);
  assert.ok(tools.specs().some((s) => s.name === 'mcp_local_list_tools'));
  await writeFile(
    path.join(root, '.yuantu/mcp.json'),
    JSON.stringify({
      servers: {
        bad: {
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer plaintext' },
        },
      },
    }),
  );
  assert.throws(() => createTools(root), /environment|placeholder/i);
});
test('MCP discovery refusal never starts a local server', async (t) => {
  const root = await setup(t, {
    local: { transport: 'stdio', command: process.execPath, args: [fixture, 'started.txt'] },
  });
  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'denied', name: 'mcp_local_list_tools', arguments: {} },
    ctx(false),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /denied/i);
  await assert.rejects(readFile(path.join(root, 'started.txt')), { code: 'ENOENT' });
});
test('stdio MCP discovers tools, validates arguments, calls and closes its process', async (t) => {
  const root = await setup(t, {
    local: { transport: 'stdio', command: process.execPath, args: [fixture, 'pid.txt'] },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const listed = await tools.execute(
    { id: 'list', name: 'mcp_local_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(listed.isError, false, listed.content);
  assert.match(listed.content, /echo/);
  const invalid = await tools.execute(
    {
      id: 'bad',
      name: 'mcp_local_call_tool',
      arguments: { name: 'echo', arguments: { text: 12 } },
    },
    ctx(),
  );
  assert.equal(invalid.isError, true);
  assert.match(invalid.content, /argument/i);
  const result = await tools.execute(
    {
      id: 'call',
      name: 'mcp_local_call_tool',
      arguments: { name: 'echo', arguments: { text: 'hello MCP' } },
    },
    ctx(),
  );
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /hello MCP/);
  const pid = Number(await readFile(path.join(root, 'pid.txt'), 'utf8'));
  await tools.close();
  assert.throws(() => process.kill(pid, 0));
});
test('a server that just failed is not handshaked again on the next call', async (t) => {
  /**
   * The cost this removes: every call to a server whose handshake fails paid the whole handshake again — up to
   * thirty seconds each — so a model that kept trying spent a run's budget on a server that is down,
   * misconfigured or refusing to authenticate. The counter file is the only place the *attempt* is visible: the
   * tool result reads the same whether one handshake was made or five.
   */
  const root = await setup(t, {});
  const attempts = path.join(root, 'attempts.txt');
  const failing = path.join(root, 'failing.cjs');
  await writeFile(
    failing,
    `require('node:fs').appendFileSync(${JSON.stringify(attempts)}, 'x');process.exit(1);`,
  );
  await writeFile(
    path.join(root, '.yuantu/mcp.json'),
    JSON.stringify({
      servers: { broken: { transport: 'stdio', command: process.execPath, args: [failing] } },
    }),
  );
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const first = await tools.execute(
    { id: 'first', name: 'mcp_broken_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(first.isError, true, first.content);
  const second = await tools.execute(
    { id: 'second', name: 'mcp_broken_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(second.isError, true);
  assert.match(second.content, /not being retried yet/, second.content);
  assert.match(
    second.content,
    /try again in \d+s/,
    'the refusal says how long, not just "not now"',
  );
  assert.equal(
    await readFile(attempts, 'utf8'),
    'x',
    'the second call did not start the server again',
  );
});

test('a close that never finishes is bounded rather than waited for', async () => {
  /**
   * The item's last step: `close()` awaited the transport's own promise, and a transport is the thing that can fail
   * to finish — an SSE stream whose endpoint stopped reading, a child that ignores the shutdown notification — so a
   * session being closed could stay unclosable and a process could stay awake. The mechanism is the bound itself,
   * so that is what this tests: a promise that never settles must not hold the caller, one that settles must be
   * waited for, and a close that *fails* must not turn a cleanup path into a reported failure.
   */
  const started = Date.now();
  assert.equal(
    await closeWithin(() => new Promise<void>(() => {}), 50),
    false,
    'the budget is what released the caller',
  );
  assert.ok(Date.now() - started < 2_000, 'and it was the budget, not the transport');
  let settled = false;
  assert.equal(
    await closeWithin(async () => {
      settled = true;
    }, 1_000),
    true,
    'a close that finishes is awaited',
  );
  assert.equal(settled, true);
  assert.equal(
    await closeWithin(async () => {
      throw new Error('transport died while closing');
    }, 1_000),
    true,
    'a close that throws is a cleanup failure, not the caller’s failure',
  );
  // A transport that throws *synchronously* is the same answer: there is nothing left to wait for.
  assert.equal(
    await closeWithin((): Promise<void> => {
      throw new Error('already gone');
    }, 1_000),
    true,
  );
});

test('MCP environment secrets are resolved only for execution and redacted from results', async (t) => {
  process.env.YUANTU_MCP_TEST_SECRET = 'private-mcp-"quoted\\secret';
  t.after(() => {
    delete process.env.YUANTU_MCP_TEST_SECRET;
  });
  const root = await setup(t, {
    local: {
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { MCP_SECRET: '${YUANTU_MCP_TEST_SECRET}' },
    },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  assert.doesNotMatch(JSON.stringify(tools.specs()), /private-mcp-secret/);
  const result = await tools.execute(
    { id: 'secret', name: 'mcp_local_call_tool', arguments: { name: 'secret', arguments: {} } },
    ctx(),
  );
  assert.equal(result.isError, false, result.content);
  assert.ok(!JSON.stringify(JSON.parse(result.content)).includes('private-mcp-'));
  assert.match(result.content, /redacted/);
});
test('concurrent MCP discovery shares one connection and one catalog request', async (t) => {
  let initializes = 0;
  let listings = 0;
  const url = await mcpHttpFixture(t, (body, res) => {
    if (body.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (body.method === 'initialize') initializes++;
    if (body.method === 'tools/list') listings++;
    const result =
      body.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'concurrent-fixture', version: '1' },
          }
        : {
            tools: [
              {
                name: 'echo',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
          };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const root = await setup(t, { remote: { transport: 'http', url } });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      tools.execute({ id: `list-${index}`, name: 'mcp_remote_list_tools', arguments: {} }, ctx()),
    ),
  );
  assert.ok(
    results.every((result) => !result.isError),
    results.map((result) => result.content).join('\n'),
  );
  assert.equal(initializes, 1);
  assert.equal(listings, 1);
});

for (const transport of ['http', 'sse'] as const)
  test(transport + ' MCP performs initialize, discovery and tool call', async (t) => {
    const methods: string[] = [];
    const url = await mcpHttpFixture(
      t,
      (body, res) => {
        methods.push(body.method);
        if (body.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        const result =
          body.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'http-fixture', version: '1' },
              }
            : body.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'echo',
                      inputSchema: {
                        type: 'object',
                        properties: { text: { type: 'string' } },
                        required: ['text'],
                      },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: body.params.arguments.text }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      },
      transport === 'sse',
    );
    const root = await setup(t, { remote: { transport, url } });
    const tools = createTools(root);
    (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
      tools.close(),
    );
    const result = await tools.execute(
      {
        id: 'http',
        name: 'mcp_remote_call_tool',
        arguments: { name: 'echo', arguments: { text: 'remote result' } },
      },
      ctx(),
    );
    assert.equal(result.isError, false, result.content);
    assert.match(result.content, /remote result/);
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('tools/list'));
    assert.ok(methods.includes('tools/call'));
  });

test('MCP cancellation closes a waiting stdio connection and its process', async (t) => {
  const root = await setup(t, {
    local: { transport: 'stdio', command: process.execPath, args: [fixture, 'pid.txt'] },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  await tools.execute({ id: 'list', name: 'mcp_local_list_tools', arguments: {} }, ctx());
  const pid = Number(await readFile(path.join(root, 'pid.txt'), 'utf8'));
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), 50);
  try {
    await assert.rejects(
      tools.execute(
        { id: 'wait', name: 'mcp_local_call_tool', arguments: { name: 'wait', arguments: {} } },
        { ...ctx(), signal: aborter.signal },
      ),
      /abort/i,
    );
  } finally {
    clearTimeout(timer);
    await tools.close();
  }
  assert.throws(() => process.kill(pid, 0));
});
test('MCP invalid configuration never reaches network or process execution', async (t) => {
  const root = await setup(t, {});
  const cases = [
    { bad: { transport: 'http', url: 'http://example.com/mcp' } },
    {
      bad: {
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer plaintext-${USERPROFILE}' },
      },
    },
    { bad: { transport: 'http', url: 'https://user:secret@example.com/mcp' } },
    { bad: { transport: 'stdio', command: 'node', cwd: '../' } },
    Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [
        'server' + i,
        { transport: 'http', url: 'https://example.com/mcp' },
      ]),
    ),
  ];
  for (const servers of cases) {
    await writeFile(path.join(root, '.yuantu/mcp.json'), JSON.stringify({ servers }));
    assert.throws(() => createTools(root));
  }
});

test('MCP rejects asynchronous schemas before any remote tool call', async (t) => {
  const methods: string[] = [];
  const url = await mcpHttpFixture(t, (body, res) => {
    methods.push(body.method);
    if (body.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const result =
      body.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'async-fixture', version: '1' },
          }
        : body.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'echo',
                  inputSchema: {
                    $async: true,
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                },
              ],
            }
          : { content: [{ type: 'text', text: 'executed' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const root = await setup(t, { remote: { transport: 'http', url } });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const result = await tools.execute(
    {
      id: 'async',
      name: 'mcp_remote_call_tool',
      arguments: { name: 'echo', arguments: { text: 'valid' } },
    },
    ctx(),
  );
  assert.equal(result.isError, true, result.content);
  assert.ok(!methods.includes('tools/call'));
});

test('MCP rejects overly complex schemas before compiling or calling tools', async (t) => {
  const deep: Record<string, unknown> = { type: 'string' };
  let cursor = deep;
  for (let index = 0; index < 40; index++) {
    const child: Record<string, unknown> = {};
    cursor.properties = { child };
    cursor = child;
  }
  const methods: string[] = [];
  const url = await mcpHttpFixture(t, (body, res) => {
    methods.push(body.method);
    if (body.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const result =
      body.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'complex-fixture', version: '1' },
          }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'echo', inputSchema: deep }] }
          : { content: [{ type: 'text', text: 'executed' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const root = await setup(t, { remote: { transport: 'http', url } });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const result = await tools.execute(
    { id: 'complex', name: 'mcp_remote_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(result.isError, true);
  assert.ok(!methods.includes('tools/call'));
});

test('MCP proxies resources and prompts and reports server capabilities', async (t) => {
  const root = await setup(t, {
    local: { transport: 'stdio', command: process.execPath, args: [fixture] },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const catalog = await tools.execute(
    { id: 'catalog', name: 'mcp_local_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(catalog.isError, false, catalog.content);
  const parsed = JSON.parse(catalog.content);
  // Four: the fixture also serves `refresh`, which is how a test asks it to announce a tool-list change.
  assert.equal(parsed.tools.length, 4);
  assert.ok(parsed.server.capabilities.resources);
  assert.ok(parsed.server.capabilities.prompts);
  const resources = await tools.execute(
    { id: 'resources', name: 'mcp_local_list_resources', arguments: {} },
    ctx(),
  );
  assert.equal(resources.isError, false, resources.content);
  assert.match(resources.content, /fixture:\/\/readme/);
  assert.match(resources.content, /fixture:\/\/item\/\{id\}/);
  const read = await tools.execute(
    {
      id: 'read',
      name: 'mcp_local_read_resource',
      arguments: { uri: 'fixture://readme' },
    },
    ctx(),
  );
  assert.equal(read.isError, false, read.content);
  assert.match(read.content, /Fixture resource body/);
  const prompts = await tools.execute(
    { id: 'prompts', name: 'mcp_local_list_prompts', arguments: {} },
    ctx(),
  );
  assert.equal(prompts.isError, false, prompts.content);
  assert.match(prompts.content, /greet/);
  const prompt = await tools.execute(
    {
      id: 'prompt',
      name: 'mcp_local_get_prompt',
      arguments: { name: 'greet', arguments: { name: 'Ada' } },
    },
    ctx(),
  );
  assert.equal(prompt.isError, false, prompt.content);
  assert.match(prompt.content, /Hello Ada/);
  const invalid = await tools.execute(
    {
      id: 'prompt-bad',
      name: 'mcp_local_get_prompt',
      arguments: { name: 'greet', arguments: { name: 7 } },
    },
    ctx(),
  );
  assert.equal(invalid.isError, true);
  assert.match(invalid.content, /Invalid arguments|prompt arguments/i);
});

test('a server that changes its tool list is re-read over the connection already open', async (t) => {
  /**
   * The catalog used to be read once per connection and never again, so a server that adds a tool mid-session was
   * described to the model by a list from before the change — and the model's next call to it was refused with
   * "Unknown MCP tool; list available tools first", which is exactly what it had just done. The fixture is a real
   * stdio server here, not a stub: it announces `notifications/tools/list_changed` and only then serves the extra
   * tool, so this is the protocol's own mechanism being exercised rather than a flag in the client.
   *
   * The pid file is the point of the second half: a re-read that reconnected would satisfy "the catalog is
   * current" while paying a handshake per change, and this asserts the process the catalog came from never
   * changed.
   */
  const root = await setup(t, {
    local: { transport: 'stdio', command: process.execPath, args: [fixture, 'pid.txt'] },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const before = await tools.execute(
    { id: 'before', name: 'mcp_local_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(before.isError, false, before.content);
  assert.match(before.content, /echo/);
  assert.doesNotMatch(
    before.content,
    /"name":"added"/,
    'the tool the server adds later is not in the first catalog',
  );
  // Each fixture process writes its own pid over this file, so a respawned connection would change it.
  const pidBefore = await readFile(path.join(root, 'pid.txt'), 'utf8');
  const announced = await tools.execute(
    {
      id: 'refresh',
      name: 'mcp_local_call_tool',
      arguments: { name: 'refresh', arguments: {} },
    },
    ctx(),
  );
  assert.equal(announced.isError, false, announced.content);
  const after = await tools.execute(
    { id: 'after', name: 'mcp_local_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(after.isError, false, after.content);
  assert.match(after.content, /"name":"added"/, 'the announced change was read back');
  // And the added tool is callable, which is the half a stale validator map would still refuse.
  const call = await tools.execute(
    { id: 'added', name: 'mcp_local_call_tool', arguments: { name: 'added', arguments: {} } },
    ctx(),
  );
  assert.equal(call.isError, false, call.content);
  assert.equal(
    await readFile(path.join(root, 'pid.txt'), 'utf8'),
    pidBefore,
    'the catalog was re-read over the same server process, not by reconnecting to a new one',
  );
});

test('MCP resource and prompt proxies refuse servers that do not advertise them', async (t) => {
  const root = await setup(t, {
    local: { transport: 'stdio', command: process.execPath, args: [fixture, '--tools-only'] },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  for (const [name, args] of [
    ['mcp_local_list_resources', {}],
    ['mcp_local_read_resource', { uri: 'fixture://readme' }],
    ['mcp_local_list_prompts', {}],
    ['mcp_local_get_prompt', { name: 'greet' }],
  ] as const) {
    const result = await tools.execute({ id: name, name, arguments: args }, ctx());
    assert.equal(result.isError, true, `${name} should not be available: ${result.content}`);
    assert.match(result.content, /MCP server does not advertise/);
  }
});

test('MCP resource contents are redacted and bounded like tool output', async (t) => {
  process.env.YUANTU_MCP_TEST_SECRET = 'private-resource-secret';
  t.after(() => {
    delete process.env.YUANTU_MCP_TEST_SECRET;
  });
  const root = await setup(t, {
    local: {
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { MCP_SECRET: '${YUANTU_MCP_TEST_SECRET}' },
    },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const result = await tools.execute(
    {
      id: 'secret',
      name: 'mcp_local_read_resource',
      arguments: { uri: 'fixture://secret' },
    },
    ctx(),
  );
  assert.equal(result.isError, false, result.content);
  assert.ok(!result.content.includes('private-resource-secret'));
  assert.match(result.content, /redacted/);
});

test('MCP resources and prompts work over Streamable HTTP', async (t) => {
  const methods: string[] = [];
  const url = await mcpHttpFixture(t, (body, res) => {
    methods.push(body.method);
    if (body.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const result =
      body.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'http-resources', version: '1' },
          }
        : body.method === 'tools/list'
          ? { tools: [] }
          : body.method === 'resources/list'
            ? { resources: [{ uri: 'fixture://one', name: 'one' }] }
            : body.method === 'resources/templates/list'
              ? { resourceTemplates: [] }
              : body.method === 'resources/read'
                ? { contents: [{ uri: body.params.uri, text: 'remote resource' }] }
                : body.method === 'prompts/list'
                  ? { prompts: [{ name: 'remote' }] }
                  : {
                      messages: [
                        { role: 'user', content: { type: 'text', text: 'remote prompt' } },
                      ],
                    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const root = await setup(t, { remote: { transport: 'http', url } });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const read = await tools.execute(
    { id: 'read', name: 'mcp_remote_read_resource', arguments: { uri: 'fixture://one' } },
    ctx(),
  );
  assert.equal(read.isError, false, read.content);
  assert.match(read.content, /remote resource/);
  const prompt = await tools.execute(
    { id: 'prompt', name: 'mcp_remote_get_prompt', arguments: { name: 'remote' } },
    ctx(),
  );
  assert.equal(prompt.isError, false, prompt.content);
  assert.match(prompt.content, /remote prompt/);
});

test('MCP rejects invalid OAuth configuration before any connection', async (t) => {
  const root = await setup(t, {});
  const cases = [
    { bad: { transport: 'stdio', command: 'node', oauth: {} } },
    {
      bad: {
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${TOKEN}' },
        oauth: {},
      },
    },
    {
      bad: {
        transport: 'http',
        url: 'https://example.com/mcp',
        oauth: { clientSecret: 'plaintext-secret' },
      },
    },
    {
      bad: {
        transport: 'http',
        url: 'https://example.com/mcp',
        oauth: { scopes: ['read write'] },
      },
    },
    {
      bad: {
        transport: 'http',
        url: 'https://example.com/mcp',
        oauth: { redirectPort: 80 },
      },
    },
    {
      bad: {
        transport: 'http',
        url: 'https://example.com/mcp',
        oauth: { unexpected: true },
      },
    },
  ];
  for (const servers of cases) {
    await writeFile(path.join(root, '.yuantu/mcp.json'), JSON.stringify({ servers }));
    assert.throws(() => createTools(root));
  }
});

test('MCP OAuth completes discovery, registration, authorization and token exchange', async (t) => {
  const fixtureSet = await mcpOAuthFixture(t, { scopesSupported: ['mcp.read'] });
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-oauth-'));
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-cred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new McpOAuthTokenStore({ directory });
  const config = parseMcpConfigs(
    root,
    JSON.stringify({
      servers: {
        remote: { transport: 'http', url: fixtureSet.mcpUrl, oauth: { scopes: ['mcp.read'] } },
      },
    }),
    false,
  )[0] as McpConfig;
  assert.equal(readMcpOAuthStatus(config, store).authorized, false);
  const opened: string[] = [];
  const result = await authorizeMcpServer({
    config,
    store,
    signal: new AbortController().signal,
    openUrl: async (url) => {
      opened.push(url.href);
      const redirect = await fetch(url, { redirect: 'manual' });
      const location = redirect.headers.get('location');
      assert.ok(location, 'authorization server must redirect back to the loopback callback');
      const callback = await fetch(location);
      assert.equal(callback.status, 200);
    },
  });
  assert.match(result.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(opened.length, 1);
  assert.match(opened[0]!, /code_challenge=/);
  assert.match(opened[0]!, /code_challenge_method=S256/);
  assert.ok(fixtureSet.log.some((entry) => entry.startsWith('issuer POST /register')));
  assert.equal(readMcpOAuthStatus(config, store).authorized, true);
  if (process.platform !== 'win32') {
    const file = path.join(
      directory,
      createHash('sha256').update(fixtureSet.mcpUrl).digest('hex') + '.json',
    );
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }

  const tools = mcpTools(root, [config], { store });
  try {
    const listed = await run(tools, 'mcp_remote_list_tools');
    assert.equal(listed.isError, false, listed.content);
    assert.match(listed.content, /echo/);
    // Losing the access token must silently refresh through the stored refresh token.
    fixtureSet.accessTokens.length = 0;
    const resources = await run(tools, 'mcp_remote_list_resources');
    assert.equal(resources.isError, false, resources.content);
    assert.match(resources.content, /fixture:\/\/oauth/);
    assert.ok(fixtureSet.log.some((entry) => entry.startsWith('issuer POST /token')));
  } finally {
    await tools.close();
  }
  await revokeMcpAuthorization(config, store);
  assert.equal(readMcpOAuthStatus(config, store).authorized, false);
});

test('MCP OAuth servers require authorization instead of opening a browser mid-run', async (t) => {
  const fixtureSet = await mcpOAuthFixture(t);
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-oauth-'));
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-cred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new McpOAuthTokenStore({ directory });
  const config = parseMcpConfigs(
    root,
    JSON.stringify({
      servers: { remote: { transport: 'http', url: fixtureSet.mcpUrl, oauth: {} } },
    }),
    false,
  )[0] as McpConfig;
  const tools = mcpTools(root, [config], { store });
  try {
    const result = await run(tools, 'mcp_remote_list_tools');
    assert.equal(result.isError, true);
    assert.match(result.content, /MCP authorization required for server remote/);
    assert.equal(fixtureSet.accessTokens.length, 0);
    assert.ok(!fixtureSet.log.some((entry) => entry.includes('/authorize')));
  } finally {
    await tools.close();
  }
});

test('MCP OAuth rejects a tampered authorization response state', async (t) => {
  const fixtureSet = await mcpOAuthFixture(t);
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-oauth-'));
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-cred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new McpOAuthTokenStore({ directory });
  const config = parseMcpConfigs(
    root,
    JSON.stringify({
      servers: { remote: { transport: 'http', url: fixtureSet.mcpUrl, oauth: {} } },
    }),
    false,
  )[0] as McpConfig;
  await assert.rejects(
    authorizeMcpServer({
      config,
      store,
      signal: new AbortController().signal,
      timeoutMs: 5000,
      openUrl: async (url) => {
        url.searchParams.set('state', 'tampered-state-value');
        const redirect = await fetch(url, { redirect: 'manual' });
        const location = redirect.headers.get('location');
        assert.ok(location);
        const callback = await fetch(location);
        assert.equal(callback.status, 200);
      },
    }),
    /Invalid MCP authorization response/,
  );
  assert.equal(readMcpOAuthStatus(config, store).authorized, false);
});

test('MCP rejects every request to a host other than the configured server', async (t) => {
  const root = await setup(t, { remote: { transport: 'http', url: 'https://example.com/mcp' } });
  const { McpFetchPolicy } = await import('../packages/mcp/oauth.ts');
  const policy = new McpFetchPolicy('https://example.com/mcp');
  await assert.rejects(policy.fetch('https://attacker.example/mcp'), /cannot change origin/);
  await assert.rejects(policy.fetch('http://example.com/mcp'), /cannot change origin/);
  await assert.rejects(
    policy.fetch('https://user:secret@example.com/mcp'),
    /credentials in the URL/,
  );
  assert.equal(root.length > 0, true);
});

test('MCP credential store fails closed on damaged or oversized entries', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-cred-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new McpOAuthTokenStore({ directory });
  const server = 'https://example.com/mcp';
  assert.deepEqual(store.readSync(server), { version: 1 });
  await store.write(server, {
    version: 1,
    tokens: { access_token: 'token-value', token_type: 'Bearer' },
  });
  assert.equal(store.readSync(server).tokens?.access_token, 'token-value');
  const file = path.join(directory, createHash('sha256').update(server).digest('hex') + '.json');
  await writeFile(file, '{ not json');
  assert.throws(() => store.readSync(server), /Invalid MCP credential file/);
  await writeFile(file, JSON.stringify({ payload: { version: 99 } }));
  assert.throws(() => store.readSync(server), /Unsupported MCP credential file version/);
  await writeFile(file, JSON.stringify({ version: 1, payload: 'x'.repeat(70_000) }));
  assert.throws(() => store.readSync(server), /exceeds 64KB/);
  await rm(file);
  await assert.doesNotReject(
    revokeMcpAuthorization({ id: 'remote', transport: 'http', url: server, oauth: {} }, store),
  );
  assert.equal(store.readSync(server).tokens, undefined);
});

// ---- merged from mcp-settings.test.ts ----

async function setup2(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-settings-'));
  const credentials = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(credentials, { recursive: true, force: true }));
  const tokens = new McpOAuthTokenStore({ directory: credentials });
  return { root, credentials, tokens, store: new McpSettingsStore(root, tokens) };
}
test('MCP settings save and delete preserve other servers and reject stale revisions', async (t) => {
  const { root, store } = await setup2(t);
  const empty = store.view();
  assert.deepEqual(empty.servers, []);
  const first = store.save(
    {
      id: 'one',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
    },
    empty.revision,
  );
  assert.equal(first.servers.length, 1);
  assert.throws(() =>
    store.save({ id: 'bad', transport: 'http', url: 'http://example.com' }, first.revision),
  );
  assert.throws(() =>
    store.save(
      {
        id: 'bad',
        transport: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'plaintext' },
      },
      first.revision,
    ),
  );
  assert.throws(() => store.delete('one', empty.revision), /changed|reload/i);
  const second = store.save(
    { id: 'two', transport: 'sse', url: 'https://example.org/sse', disabled: true },
    first.revision,
  );
  assert.equal(second.servers.length, 2);
  assert.equal(store.delete('one', second.revision).servers[0]!.id, 'two');
  assert.match(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8'), /MCP|two/);
});
test('testing an unsaved MCP server closes its process and never saves configuration', async (t) => {
  const { root, store } = await setup2(t);
  const result = await store.test(
    {
      id: 'local',
      transport: 'stdio',
      command: process.execPath,
      args: [path.resolve('tests/mcp-fixture.ts'), 'pid.txt'],
    },
    AbortSignal.timeout(5000),
  );
  assert.ok(result.count > 0);
  const pid = Number(await readFile(path.join(root, 'pid.txt'), 'utf8'));
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(readFile(path.join(root, '.yuantu/mcp.json')), { code: 'ENOENT' });
});
test('MCP IPC boundary rejects arbitrary paths and malformed actions', () => {
  for (const value of [
    { type: 'get', path: 'x' },
    { type: 'save', server: {}, revision: 'bad' },
    { type: 'delete', id: '../x', revision: 'a'.repeat(64) },
    { type: 'execute', server: {} },
  ])
    assert.throws(() => parseMcpCommand(value));
});
test('MCP IPC boundary accepts authorization commands and rejects malformed ones', () => {
  const revision = 'a'.repeat(64);
  assert.deepEqual(parseMcpCommand({ type: 'cancel-authorize' }), { type: 'cancel-authorize' });
  assert.equal(
    parseMcpCommand({
      type: 'authorize',
      server: { id: 'remote', transport: 'http', url: 'https://example.com/mcp' },
      revision,
    }).type,
    'authorize',
  );
  assert.equal(parseMcpCommand({ type: 'revoke', id: 'remote', revision }).type, 'revoke');
  for (const value of [
    { type: 'authorize', server: { id: 'remote' }, revision: 'bad' },
    { type: 'authorize', server: {}, revision },
    { type: 'authorize', server: { id: '../remote' }, revision },
    { type: 'authorize', revision },
    { type: 'revoke', id: '../remote', revision },
    { type: 'revoke', id: 'remote' },
    { type: 'revoke', id: 'remote', revision: 'bad' },
    { type: 'cancel-authorize', revision },
    { type: 'cancel-authorize', id: 'remote' },
    { type: 'authorize', server: { id: 'remote' }, revision, extra: true },
  ])
    assert.throws(() => parseMcpCommand(value));
});

test('MCP OAuth settings round-trip and reject plaintext client secrets', async (t) => {
  const { root, store } = await setup2(t);
  const oauth = {
    scopes: ['read', 'write'],
    clientId: 'client-id',
    clientSecret: '${MCP_CLIENT_SECRET}',
    clientName: 'Yuantu Test',
    redirectPort: 41234,
  };
  const saved = store.save(
    { id: 'remote', transport: 'http', url: 'https://example.com/mcp', oauth },
    store.view().revision,
  );
  assert.deepEqual(saved.servers[0]!.oauth, oauth);
  assert.equal(saved.servers[0]!.authorized, false);
  const written = JSON.parse(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8'));
  assert.deepEqual(written.servers.remote.oauth, oauth);
  assert.equal(Object.hasOwn(written.servers.remote, 'authorized'), false);
  const plain = store.save(
    { id: 'plain', transport: 'http', url: 'https://example.com/plain' },
    saved.revision,
  );
  assert.equal(plain.servers.find((server) => server.id === 'plain')!.authorized, false);
  assert.equal(
    Object.hasOwn(
      JSON.parse(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8')).servers.plain,
      'oauth',
    ),
    false,
  );
  assert.throws(
    () =>
      store.save(
        {
          id: 'bad',
          transport: 'http',
          url: 'https://example.com/bad',
          oauth: { clientSecret: 'plaintext' },
        },
        plain.revision,
      ),
    /placeholder/i,
  );
  assert.throws(
    () =>
      store.save(
        {
          id: 'bad',
          transport: 'http',
          url: 'https://example.com/bad',
          oauth: { redirectPort: 80 },
        },
        plain.revision,
      ),
    /redirect port/i,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(root, '.yuantu/mcp.json'), 'utf8')).servers.bad,
    undefined,
  );
});
test('MCP authorization status follows the credential store and revoke clears it', async (t) => {
  const { credentials, tokens, store } = await setup2(t);
  const saved = store.save(
    {
      id: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      oauth: { scopes: ['read'] },
    },
    store.view().revision,
  );
  assert.equal(saved.servers[0]!.authorized, false);
  assert.equal(saved.servers[0]!.expiresAt, undefined);
  await tokens.write('https://example.com/mcp', {
    version: 1,
    tokens: { access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600 },
  });
  const authorized = store.view();
  const row = authorized.servers[0]!;
  assert.equal(row.authorized, true);
  assert.ok(row.expiresAt);
  assert.deepEqual(row.scopes, ['read']);
  assert.equal(JSON.stringify(authorized).includes('access-secret'), false);
  const reopened = new McpSettingsStore(store.view().workspace, credentials);
  assert.equal(reopened.view().servers[0]!.authorized, true);
  const revoked = await store.revoke('remote', authorized.revision);
  assert.equal(revoked.servers[0]!.authorized, false);
  assert.equal(revoked.servers[0]!.expiresAt, undefined);
  assert.equal((await tokens.read('https://example.com/mcp')).tokens, undefined);
});
test('MCP revoke is a no-op without OAuth settings and rejects unknown servers', async (t) => {
  const { store } = await setup2(t);
  const saved = store.save(
    { id: 'plain', transport: 'http', url: 'https://example.com/plain' },
    store.view().revision,
  );
  const revoked = await store.revoke('plain', saved.revision);
  assert.deepEqual(
    revoked.servers.map((server) => server.id),
    ['plain'],
  );
  assert.equal(revoked.revision, saved.revision);
  await assert.rejects(store.revoke('missing', saved.revision), /unknown mcp server/i);
});
test('MCP authorize and revoke reject stale revisions and missing OAuth settings', async (t) => {
  const { store } = await setup2(t);
  const first = store.save(
    {
      id: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      oauth: { scopes: ['read'] },
    },
    store.view().revision,
  );
  const second = store.save(
    { id: 'other', transport: 'http', url: 'https://example.com/other' },
    first.revision,
  );
  await assert.rejects(
    store.authorize(
      {
        id: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp',
        oauth: { scopes: ['read'] },
      },
      first.revision,
      () => undefined,
      AbortSignal.timeout(5000),
    ),
    /changed|reload/i,
  );
  await assert.rejects(store.revoke('remote', first.revision), /changed|reload/i);
  await assert.rejects(
    store.authorize(
      { id: 'other', transport: 'http', url: 'https://example.com/other' },
      second.revision,
      () => undefined,
      AbortSignal.timeout(5000),
    ),
    /oauth/i,
  );
  assert.equal(second.servers.length, 2);
});

test('MCP revisions are bound to workspace even when files are identical', async (t) => {
  const a = await setup2(t),
    b = await setup2(t);
  const revision = a.store.view().revision;
  assert.notEqual(revision, b.store.view().revision);
  await assert.rejects(
    b.store.test(
      {
        id: 'local',
        transport: 'stdio',
        command: process.execPath,
        args: [path.resolve('tests/mcp-fixture.ts'), 'stale-pid.txt'],
      },
      AbortSignal.timeout(2000),
      revision,
    ),
    /changed|reload/i,
  );
  await assert.rejects(readFile(path.join(b.root, 'stale-pid.txt')), { code: 'ENOENT' });
  assert.throws(
    () => b.store.save({ id: 'local', transport: 'http', url: 'https://example.com' }, revision),
    /changed|reload/i,
  );
});
test('disabled MCP service with removed cwd remains editable and deletable', async (t) => {
  const { root, store } = await setup2(t);
  await mkdir(path.join(root, 'removed'));
  store.save(
    { id: 'local', transport: 'stdio', command: 'node', cwd: 'removed', disabled: true },
    store.view().revision,
  );
  await rm(path.join(root, 'removed'), { recursive: true });
  const view = store.view();
  assert.equal(view.servers[0]!.cwd, 'removed');
  assert.equal(store.delete('local', view.revision).servers.length, 0);
});
