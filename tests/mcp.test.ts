import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
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
import { tempRoot } from './temp-fixture.ts';

// ---- merged from mcp.test.ts ----

// Independent test keys keep OAuth protocol fixtures portable and out of the user's OS vault.
function testCipher() {
  const key = randomBytes(32);
  return {
    encrypt(text: string) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decrypt(bytes: Buffer) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

test(
  'MCP default OS cipher protects tokens and is shared by independent Node processes',
  { skip: process.platform !== 'win32' && 'needs Windows' },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-mcp-default-cipher-'));
    t.after(async () => {
      // Delete only the random vault entry created by this isolated fake-token fixture.
      try {
        const id = (await readFile(path.join(directory, '.secret-key-id'), 'utf8')).trim();
        const scope = createHash('sha256')
          .update(realpathSync(directory).toLowerCase())
          .digest('hex');
        const { Entry } = await import('@napi-rs/keyring');
        new Entry('YuanTu MCP OAuth:' + scope, id).deletePassword();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    const server = 'https://example.com/default-cipher';
    const file = path.join(
      directory,
      createHash('sha256').update(server).digest('hex') + '.protected.json',
    );
    const record = {
      version: 1 as const,
      tokens: {
        access_token: 'default-fixture-access',
        refresh_token: 'default-fixture-refresh',
        token_type: 'Bearer',
      },
    };
    const store = new McpOAuthTokenStore({ directory });
    await store.write(server, record);
    const raw = await readFile(file, 'utf8');
    assert.equal(raw.includes(record.tokens.access_token), false);
    assert.equal(raw.includes(record.tokens.refresh_token), false);
    assert.deepEqual(new McpOAuthTokenStore({ directory }).readSync(server), record);
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const { McpOAuthTokenStore } = await import(process.argv[1]); const record = new McpOAuthTokenStore({directory:process.argv[2]}).readSync(process.argv[3]); if(record.tokens?.access_token !== 'default-fixture-access' || record.tokens?.refresh_token !== 'default-fixture-refresh') throw new Error('round-trip failed'); process.stdout.write('OK');",
        pathToFileURL(path.resolve('packages/mcp/oauth.ts')).href,
        directory,
        server,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(output, 'OK');
    await rm(file);
    await writeFile(
      file.replace('.protected.json', '.json'),
      JSON.stringify({ version: 1, payload: record }),
    );
    assert.deepEqual(new McpOAuthTokenStore({ directory }).readSync(server), record);
    assert.equal((await readFile(file, 'utf8')).includes(record.tokens.access_token), false);
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    const encrypted = Buffer.from(envelope.payload, 'base64');
    encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
    await writeFile(file, JSON.stringify({ ...envelope, payload: encrypted.toString('base64') }));
    assert.throws(() => new McpOAuthTokenStore({ directory }).readSync(server));
  },
);

test('MCP credential reads migrate plaintext atomically with the supplied cipher', async (t) => {
  const directory = await tempRoot(t, 'yuantu-mcp-migration-');
  const server = 'https://example.com/migration';
  const file = path.join(directory, createHash('sha256').update(server).digest('hex') + '.json');
  const record = {
    version: 1 as const,
    tokens: {
      access_token: 'migration-fixture-access',
      refresh_token: 'migration-fixture-refresh',
      token_type: 'Bearer',
    },
  };
  const cipher = testCipher();
  const protectedFile = file.replace('.json', '.protected.json');
  for (const original of [
    record,
    { version: 1, payload: record },
    { version: 1, payload: cipher.encrypt(JSON.stringify(record)).toString('base64') },
  ]) {
    await rm(protectedFile, { force: true });
    await writeFile(file, JSON.stringify(original));
    const store = new McpOAuthTokenStore({ directory, cipher });
    assert.deepEqual(store.readSync(server), record);
    const raw = await readFile(protectedFile, 'utf8');
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(raw.includes(record.tokens.access_token), false);
    assert.equal(raw.includes(record.tokens.refresh_token), false);
    assert.equal(typeof JSON.parse(raw).payload, 'string');
    assert.deepEqual(new McpOAuthTokenStore({ directory, cipher }).readSync(server), record);
  }
});

test('MCP plaintext migration never overwrites credentials refreshed by another store', async (t) => {
  const directory = await tempRoot(t, 'yuantu-mcp-migration-race-');
  const server = 'https://example.com/migration-race';
  const file = path.join(directory, createHash('sha256').update(server).digest('hex') + '.json');
  await writeFile(
    file,
    JSON.stringify({ version: 1, tokens: { access_token: 'old-fixture', token_type: 'Bearer' } }),
  );
  const cipher = testCipher();
  const newer = {
    version: 1 as const,
    tokens: { access_token: 'new-fixture', token_type: 'Bearer' },
  };
  const writer = new McpOAuthTokenStore({ directory, cipher });
  let pending: Promise<void> | undefined;
  const migrating = new McpOAuthTokenStore({
    directory,
    cipher: {
      decrypt: cipher.decrypt,
      encrypt(text) {
        pending = writer.write(server, newer);
        return cipher.encrypt(text);
      },
    },
  });
  assert.deepEqual(migrating.readSync(server), newer);
  await pending;
  assert.deepEqual(writer.readSync(server), newer);
});

test('MCP credential migration fails closed and preserves the original file', async (t) => {
  const directory = await tempRoot(t, 'yuantu-mcp-migration-failure-');
  const server = 'https://example.com/migration';
  const file = path.join(directory, createHash('sha256').update(server).digest('hex') + '.json');
  const original = JSON.stringify({
    version: 1,
    tokens: { access_token: 'fixture', token_type: 'Bearer' },
  });
  await writeFile(file, original);
  const store = new McpOAuthTokenStore({
    directory,
    cipher: {
      encrypt() {
        throw new Error('secure storage unavailable');
      },
      decrypt() {
        throw new Error('secure storage unavailable');
      },
    },
  });
  assert.throws(() => store.readSync(server), /secure storage unavailable/);
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(store.write(server, { version: 1 }), /secure storage unavailable/);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('MCP damaged protected entries never fall back and removal cannot resurrect legacy tokens', async (t) => {
  const directory = await tempRoot(t, 'yuantu-mcp-legacy-removal-');
  const server = 'https://example.com/legacy-removal';
  const legacy = path.join(directory, createHash('sha256').update(server).digest('hex') + '.json');
  const protectedFile = legacy.replace('.json', '.protected.json');
  const raw = JSON.stringify({
    version: 1,
    tokens: { access_token: 'old-fixture', token_type: 'Bearer' },
  });
  const store = new McpOAuthTokenStore({ directory, cipher: testCipher() });
  await writeFile(legacy, raw);
  await writeFile(protectedFile, '{ invalid');
  assert.throws(() => store.readSync(server), /Invalid MCP credential file/);
  assert.equal(await readFile(legacy, 'utf8'), raw);
  await writeFile(protectedFile, raw);
  assert.throws(() => store.readSync(server), /Invalid encrypted MCP credential file/);
  for (const malformed of [
    { version: 99, revoked: true },
    { version: 1, revoked: true, tokens: {} },
    { version: 1, revoked: 'true' },
  ]) {
    await writeFile(protectedFile, JSON.stringify(malformed));
    assert.throws(() => store.readSync(server), /Invalid encrypted MCP credential file/);
  }
  await store.remove(server);
  assert.deepEqual(store.readSync(server), { version: 1 });
  await assert.rejects(readFile(legacy), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(protectedFile, 'utf8')), {
    version: 1,
    revoked: true,
  });
  const restored = {
    version: 1 as const,
    tokens: { access_token: 'reauthorized-fixture', token_type: 'Bearer' },
  };
  await store.write(server, restored);
  assert.deepEqual(store.readSync(server), restored);
});

test('MCP credential removal succeeds without a working system-vault cipher', async (t) => {
  const directory = await tempRoot(t, 'yuantu-mcp-unavailable-removal-');
  const server = 'https://example.com/unavailable-removal';
  const working = new McpOAuthTokenStore({ directory, cipher: testCipher() });
  await working.write(server, {
    version: 1,
    tokens: { access_token: 'fixture', token_type: 'Bearer' },
  });
  const unavailable = new McpOAuthTokenStore({
    directory,
    cipher: {
      encrypt() {
        throw new Error('vault unavailable');
      },
      decrypt() {
        throw new Error('vault unavailable');
      },
    },
  });
  await unavailable.remove(server);
  assert.deepEqual(unavailable.readSync(server), { version: 1 });
});

test('MCP removal during plaintext migration cannot restore revoked credentials', async (t) => {
  const directory = await tempRoot(t, 'yuantu-mcp-revoke-race-');
  const server = 'https://example.com/revoke-race';
  const legacy = path.join(directory, createHash('sha256').update(server).digest('hex') + '.json');
  await writeFile(
    legacy,
    JSON.stringify({
      version: 1,
      tokens: { access_token: 'revoked-fixture', token_type: 'Bearer' },
    }),
  );
  const cipher = testCipher();
  const remover = new McpOAuthTokenStore({ directory, cipher });
  let pending: Promise<void> | undefined;
  const migrating = new McpOAuthTokenStore({
    directory,
    cipher: {
      decrypt: cipher.decrypt,
      encrypt(text) {
        pending = remover.remove(server);
        return cipher.encrypt(text);
      },
    },
  });
  assert.deepEqual(migrating.readSync(server), { version: 1 });
  await pending;
  assert.deepEqual(remover.readSync(server), { version: 1 });
});

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
test('a stdio server that exits between calls is reconnected without a failed call', async (t) => {
  const root = await setup(t, {
    local: { transport: 'stdio', command: process.execPath, args: [fixture, 'pid.txt'] },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const call = (id: string) =>
    tools.execute(
      { id, name: 'mcp_local_call_tool', arguments: { name: 'echo', arguments: { text: id } } },
      ctx(),
    );
  assert.equal((await call('first')).isError, false);
  // Between two turns the server goes away — killed, crashed, or an editor restarted it.
  const first = Number(await readFile(path.join(root, 'pid.txt'), 'utf8'));
  process.kill(first);
  assert.ok(await waitForExit(first));
  // The connection noticed it close, so the next call opens a new one instead of failing once first.
  const second = await call('second');
  assert.equal(second.isError, false, second.content);
  assert.match(second.content, /second/);
  assert.notEqual(Number(await readFile(path.join(root, 'pid.txt'), 'utf8')), first);
});
/** Waits for a killed fixture to be gone, so "the server really exited" is an answer rather than a guess. */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
test('invalid tool parameters keep an established mcp session', async (t) => {
  /**
   * A request this process refused itself says nothing about the connection: the handshake succeeded and the
   * catalogue is in hand, so one argument that fails the tool's own schema must not throw the server away. The
   * catch that reports every failure closed the connection unconditionally, so the next call paid a whole new
   * handshake — and a model that mistyped a schema could spend a run's budget re-handshaking a healthy server.
   *
   * The counter is the server's own record of the conversation, because only it can tell a reused session from a
   * rebuilt one. The second half is the guard on the fix: "never close" would be as wrong as "always close", so
   * a server that really exits still has to be handshaked again.
   */
  const root = await setup(t, {});
  const marker = path.join(root, 'handshakes.txt');
  await writeFile(
    path.join(root, '.yuantu/mcp.json'),
    JSON.stringify({
      servers: {
        local: {
          transport: 'stdio',
          command: process.execPath,
          args: [fixture, 'pid.txt'],
          env: { MCP_HANDSHAKE_MARKER: marker },
        },
      },
    }),
  );
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const count = async (method: string): Promise<number> =>
    (await readFile(marker, 'utf8').catch(() => '')).split('\n').filter((line) => line === method)
      .length;

  const established = await tools.execute(
    { id: 'list', name: 'mcp_local_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(established.isError, false, established.content);
  assert.equal(await count('initialize'), 1);

  const refused = await tools.execute(
    {
      id: 'bad',
      name: 'mcp_local_call_tool',
      arguments: { name: 'echo', arguments: { text: 12 } },
    },
    ctx(),
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content, /argument/i);

  const accepted = await tools.execute(
    {
      id: 'good',
      name: 'mcp_local_call_tool',
      arguments: { name: 'echo', arguments: { text: 'still here' } },
    },
    ctx(),
  );
  assert.equal(accepted.isError, false, accepted.content);
  assert.match(accepted.content, /still here/);
  assert.equal(
    await count('initialize'),
    1,
    'the session that refused the bad argument answered the good one',
  );
  assert.equal(await count('tools/list'), 1, 'and its catalogue was not read again');

  // A server that is really gone is a different question, and it still has to be reconnected to.
  const pid = Number(await readFile(path.join(root, 'pid.txt'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  assert.equal(await waitForExit(pid), true, 'the fixture is gone, not merely detached');
  // The call that discovers the dead transport cannot succeed; the point is that the one after it reconnects.
  await tools.execute(
    {
      id: 'dead',
      name: 'mcp_local_call_tool',
      arguments: { name: 'echo', arguments: { text: 'x' } },
    },
    ctx(),
  );
  const reconnected = await tools.execute(
    {
      id: 'again',
      name: 'mcp_local_call_tool',
      arguments: { name: 'echo', arguments: { text: 'back' } },
    },
    ctx(),
  );
  assert.equal(reconnected.isError, false, reconnected.content);
  assert.match(reconnected.content, /back/);
  assert.equal(await count('initialize'), 2, 'a server that really exited is handshaked again');
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

test('a change announced during the catalogue load is read on the next request', async (t) => {
  /**
   * The notification arrives while the first `tools/list` response is being read, and the fixture only serves
   * the added tool on the next list. Recording the generation after the load would mark the old catalogue
   * current and swallow the change; the load must record the generation it started from.
   */
  const root = await setup(t, {
    local: {
      transport: 'stdio',
      command: process.execPath,
      args: [fixture, 'pid.txt', '--notify-during-list'],
    },
  });
  const tools = createTools(root);
  (t as test.TestContext & { mcpCleanups: (() => Promise<void>)[] }).mcpCleanups.push(() =>
    tools.close(),
  );
  const first = await tools.execute(
    { id: 'first', name: 'mcp_local_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(first.isError, false, first.content);
  assert.doesNotMatch(first.content, /"name":"added"/, 'the first response is the old catalogue');
  const second = await tools.execute(
    { id: 'second', name: 'mcp_local_list_tools', arguments: {} },
    ctx(),
  );
  assert.equal(second.isError, false, second.content);
  assert.match(
    second.content,
    /"name":"added"/,
    'the change announced during the load triggered a re-read',
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
  const store = new McpOAuthTokenStore({ directory, cipher: testCipher() });
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
      createHash('sha256').update(fixtureSet.mcpUrl).digest('hex') + '.protected.json',
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
  const store = new McpOAuthTokenStore({ directory, cipher: testCipher() });
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
  const store = new McpOAuthTokenStore({ directory, cipher: testCipher() });
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

test('MCP metadata observation is bounded and does not trust late body origins', async (t) => {
  const { McpFetchPolicy } = await import('../packages/mcp/oauth.ts');
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        {
          headers: {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer resource_metadata="https://header.example/metadata"',
          },
        },
      ),
  );
  const policy = new McpFetchPolicy('https://example.com/mcp', [], { metadataTimeoutMs: 30 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    policy.fetch('https://example.com/.well-known/oauth-protected-resource'),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 250);
    }),
  ]);
  clearTimeout(timer);
  // Complete the fixture even when the old unbounded implementation loses the race.
  stream.enqueue(new TextEncoder().encode('{"authorization_servers":["https://late.example"]}'));
  stream.close();
  assert.ok(outcome, 'observing a stalled metadata body must return within its bound');
  assert.equal(policy.allows('https://header.example/metadata'), true);
  assert.equal(policy.allows('https://late.example'), false);
  await outcome.body?.cancel();
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
  const directory = await tempRoot(t, 'yuantu-mcp-cred-');
  const cipher = testCipher();
  const store = new McpOAuthTokenStore({ directory, cipher });
  const server = 'https://example.com/mcp';
  assert.deepEqual(store.readSync(server), { version: 1 });
  await store.write(server, {
    version: 1,
    tokens: { access_token: 'token-value', token_type: 'Bearer' },
  });
  assert.equal(store.readSync(server).tokens?.access_token, 'token-value');
  const file = path.join(
    directory,
    createHash('sha256').update(server).digest('hex') + '.protected.json',
  );
  await writeFile(file, '{ not json');
  assert.throws(() => store.readSync(server), /Invalid MCP credential file/);
  await writeFile(
    file,
    JSON.stringify({ payload: cipher.encrypt(JSON.stringify({ version: 99 })).toString('base64') }),
  );
  assert.throws(() => store.readSync(server), /Unsupported MCP credential file version/);
  await writeFile(file, JSON.stringify({ version: 1, payload: 'x'.repeat(70_000) }));
  assert.throws(() => store.readSync(server), /exceeds 64KB/);
  await rm(file);
  await assert.doesNotReject(
    revokeMcpAuthorization({ id: 'remote', transport: 'http', url: server, oauth: {} }, store),
  );
  assert.equal(store.readSync(server).tokens, undefined);
});
