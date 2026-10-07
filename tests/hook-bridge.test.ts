/**
 * The external hook bridge.
 *
 * Every case here runs a *real* child process through the real tool pipeline, because the thing under test is
 * a contract with the outside world: exit codes, stderr, stdout JSON and a timeout are only meaningful when
 * something actually exits. The hook scripts are Node programs written into the test's workspace, so the
 * fixtures need no shell of their own and behave the same on every platform.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { HookRegistry } from '../packages/tools/registry.ts';
import {
  hookBridgeSettings,
  hookMatcherMatches,
  loadHookDeclarations,
} from '../packages/resources/hook-config.ts';
import { resolveRunLimits } from '../packages/protocol/settings.ts';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { ModelResponse, Provider, ToolContext } from '../packages/protocol/index.ts';

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
/** A Node command line the platform shell will accept, with both paths quoted. */
function nodeCommand(root: string, script: string): string {
  return `"${process.execPath}" "${path.join(root, script)}"`;
}
/** Reads the JSON payload off stdin and leaves it in the workspace, so a test can assert what a hook saw. */
const RECORD_PAYLOAD = `
import { writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync('seen.json', Buffer.concat(chunks).toString('utf8'));
`;
const SCRIPTS = {
  blocking: `${RECORD_PAYLOAD}
process.stderr.write('no writes to src/ without a review');
process.exit(2);
`,
  denying: `${RECORD_PAYLOAD}
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'denied by the fixture' },
}));
`,
  allowing: `${RECORD_PAYLOAD}
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
}));
`,
  broken: `
process.stderr.write('the fixture is deliberately broken');
process.exit(1);
`,
  // Long enough to outlive the 1s hook budget, short enough that a failed kill cannot stall the suite.
  hanging: `setTimeout(() => process.exit(0), 5000);
`,
} as const;
interface Fixture {
  root: string;
  tools: ReturnType<typeof createTools>;
  failures: string[];
  /** The calls the hook recorded, in order. Empty when no hook ran. */
  seen(): Promise<Record<string, unknown>[]>;
}
/**
 * A workspace with a hook config and the scripts it runs.
 *
 * `config` is a factory because a command line has to name the workspace, and the workspace is what this
 * function creates. `scope` is the session id, exactly as the Host passes it, so a hook sees a real session.
 */
async function fixture(
  t: test.TestContext,
  config: (root: string) => Record<string, unknown>,
  scripts: Record<string, string>,
  options: { enabled?: boolean; timeoutMs?: number; location?: string; scope?: string } = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-bridge-'));
  const location = options.location ?? '.claude/settings.json';
  await mkdir(path.join(root, path.dirname(location)), { recursive: true });
  await writeFile(path.join(root, location), JSON.stringify(config(root)));
  for (const [name, body] of Object.entries(scripts)) await writeFile(path.join(root, name), body);
  const failures: string[] = [];
  const tools = createTools(root, undefined, options.scope ?? 'session-1', new HookRegistry(), {
    ...hookBridgeSettings({}),
    enabled: options.enabled ?? true,
    timeoutMs: options.timeoutMs ?? 5000,
    onFailure: (message) => failures.push(message),
  });
  t.after(async () => {
    await tools.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    tools,
    failures,
    seen: async () =>
      existsSync(path.join(root, 'seen.json'))
        ? [
            JSON.parse(await readFile(path.join(root, 'seen.json'), 'utf8')) as Record<
              string,
              unknown
            >,
          ]
        : [],
  };
}
function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    signal: new AbortController().signal,
    approve: async () => true,
    sessionId: 'session-1',
    ...over,
  };
}
/** One `PreToolUse` declaration with the given matcher, running the given script. */
const preToolUse = (root: string, script: string, matcher = 'write_file') => ({
  hooks: {
    PreToolUse: [{ matcher, hooks: [{ type: 'command', command: nodeCommand(root, script) }] }],
  },
});

test('a PreToolUse hook that exits 2 blocks the call and its reason reaches the model', async (t) => {
  const { root, tools, failures, seen } = await fixture(t, (root) => preToolUse(root, 'hook.mjs'), {
    'hook.mjs': SCRIPTS.blocking,
  });
  const result = await tools.execute(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context(),
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /Operation denied by guard: no writes to src\/ without a review/);
  assert.equal(existsSync(path.join(root, 'a.txt')), false, 'a denied call changes nothing');
  assert.deepEqual(failures, [], 'a hook that decided is not a hook that failed');
  const payload = (await seen())[0]!;
  assert.equal(payload.hook_event_name, 'PreToolUse');
  assert.equal(payload.tool_name, 'write_file');
});

test('a permissionDecision on stdout decides, and the payload carries the call', async (t) => {
  const { root, tools } = await fixture(
    t,
    (root) => ({
      hooks: {
        PreToolUse: [
          {
            matcher: 'write_file',
            hooks: [{ type: 'command', command: nodeCommand(root, 'deny.mjs') }],
          },
          {
            matcher: 'delete_file',
            hooks: [{ type: 'command', command: nodeCommand(root, 'allow.mjs') }],
          },
        ],
      },
    }),
    { 'deny.mjs': SCRIPTS.denying, 'allow.mjs': SCRIPTS.allowing },
    { scope: 'session-7' },
  );
  const denied = await tools.execute(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context({ sessionId: 'session-7' }),
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content, /denied by the fixture/);
  assert.equal(existsSync(path.join(root, 'a.txt')), false);

  const allowed = await tools.execute(
    { id: 'c2', name: 'delete_file', arguments: { path: 'missing.txt' } },
    context({ sessionId: 'session-7' }),
  );
  // The point is that the hook permitted it: whatever the tool then reported is the tool's own business.
  assert.doesNotMatch(allowed.content, /denied by the fixture/);
  // The payload is the projection this runtime promised: the session, the workspace and the call.
  const payload = JSON.parse(await readFile(path.join(root, 'seen.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(payload.session_id, 'session-7');
  assert.equal(payload.cwd, root);
  assert.equal(payload.hook_event_name, 'PreToolUse');
  assert.equal(payload.tool_name, 'delete_file');
  assert.deepEqual(payload.tool_input, { path: 'missing.txt' });
});

test('a matcher that does not match is never run', async (t) => {
  const { root, tools, failures, seen } = await fixture(
    t,
    (root) => preToolUse(root, 'hook.mjs', 'run_command|Bash'),
    { 'hook.mjs': SCRIPTS.blocking },
  );
  const result = await tools.execute(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context(),
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(existsSync(path.join(root, 'a.txt')), true, 'the call ran normally');
  assert.deepEqual(await seen(), [], 'the hook must not have run at all');
  assert.deepEqual(failures, []);
});

test('a hook that fails for another reason does not block, and is reported', async (t) => {
  const { root, tools, failures } = await fixture(t, (root) => preToolUse(root, 'broken.mjs'), {
    'broken.mjs': SCRIPTS.broken,
  });
  const result = await tools.execute(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context(),
  );
  assert.equal(result.isError, false, 'a broken hook must not refuse the call');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'a');
  assert.equal(failures.length, 1, 'the failure is recorded exactly once');
  assert.match(failures[0]!, /\.claude\/settings\.json/);
  assert.match(failures[0]!, /the fixture is deliberately broken/);
});

test('a hook that overruns its timeout does not hang the run', async (t) => {
  const { root, tools, failures } = await fixture(
    t,
    (root) => ({
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: nodeCommand(root, 'hang.mjs'), timeout: 1 }],
          },
        ],
      },
    }),
    { 'hang.mjs': SCRIPTS.hanging },
  );
  const started = Date.now();
  const result = await tools.execute(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context(),
  );
  assert.ok(Date.now() - started < 20_000, 'the timeout must end the wait, not the run');
  assert.equal(result.isError, false, 'a hook that ran out of time decided nothing');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'a');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /timed out after 1000ms/);
});

test('a read-only or planning run does not run external hooks', async (t) => {
  const { tools, failures, seen } = await fixture(
    t,
    (root) => preToolUse(root, 'hook.mjs', 'job_list|write_file'),
    { 'hook.mjs': SCRIPTS.blocking },
  );
  const readOnly = await tools.execute(
    { id: 'c1', name: 'job_list', arguments: {} },
    context({ readOnly: true }),
  );
  assert.equal(readOnly.isError, false, readOnly.content);
  assert.deepEqual(await seen(), [], 'the hook must not have run');
  assert.deepEqual(failures, [], 'skipping for a read-only run is not a failure');

  const writable = await tools.execute(
    { id: 'c2', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context(),
  );
  assert.equal(writable.isError, true, 'a normal run does run it, so the same call is now refused');
});

test('a real Agent run refuses a gated write and shows the model the hook reason', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-bridge-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, 'hook.mjs'), SCRIPTS.blocking);
  await writeFile(
    path.join(root, '.claude/settings.json'),
    JSON.stringify(preToolUse(root, 'hook.mjs')),
  );
  const session = store.create(root);
  const provider: Provider = {
    async complete(request) {
      if (request.messages.some((message) => message.role === 'tool')) return reply('Stopped');
      return toolCall('w1', 'write_file', { path: 'blocked.txt', content: 'x' });
    },
  };
  const tools = createTools(root, undefined, session.id, new HookRegistry(), {
    enabled: true,
    timeoutMs: 5000,
  });
  const agent = new Agent({ store, provider, tools, approve: async () => true });
  const result = await agent.run({ sessionId: session.id, prompt: 'Write blocked.txt' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(existsSync(path.join(root, 'blocked.txt')), false);
  const toolMessage = store.messages(session.id).find((message) => message.role === 'tool');
  assert.ok(toolMessage, 'the model was told what happened');
  assert.match(String(toolMessage.content), /no writes to src\/ without a review/);
});

test('the bridge is off when the setting says so, and a workspace without config costs nothing', async (t) => {
  const { root, seen } = await fixture(t, (root) => preToolUse(root, 'hook.mjs', 'write_file'), {
    'hook.mjs': SCRIPTS.blocking,
  });
  const off = createTools(root, undefined, 'session-1', new HookRegistry(), {
    ...hookBridgeSettings({ YUANTU_HOOK_BRIDGE: '0' }),
    onFailure: () => undefined,
  });
  t.after(() => off.close().catch(() => undefined));
  assert.equal(off.extensions.size, 0, 'the setting is read from the table and obeyed');
  const result = await off.execute(
    { id: 'c2', name: 'write_file', arguments: { path: 'b.txt', content: 'b' } },
    context(),
  );
  assert.equal(result.isError, false, 'a disabled bridge is not a broken workspace');
  assert.deepEqual(await seen(), [], 'nothing ran, so nothing new was recorded');

  const bare = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-bridge-'));
  t.after(async () => {
    await rm(bare, { recursive: true, force: true });
  });
  const none = createTools(
    bare,
    undefined,
    'session-1',
    new HookRegistry(),
    hookBridgeSettings({}),
  );
  t.after(() => none.close().catch(() => undefined));
  assert.equal(none.extensions.size, 0, 'no declarations means no hook set at all');
});

test('malformed config names the offending file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-bridge-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  const write = (value: string) => writeFile(path.join(root, '.yuantu/hooks.json'), value);
  const load = () => loadHookDeclarations(root);

  await write('{ not json');
  assert.throws(load, /Invalid hook config \.yuantu\/hooks\.json: not valid JSON/);
  await write(JSON.stringify({ hooks: { PreCommit: [] } }));
  assert.throws(load, /unknown hook event "PreCommit"/);
  await write(JSON.stringify({ hooks: {}, extra: true }));
  assert.throws(load, /unknown key "extra"/);
  await write(JSON.stringify({ hooks: { PreToolUse: [{ matcher: 1, hooks: [] }] } }));
  assert.throws(load, /matcher must be a string/);
  await write(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [] }] } }));
  assert.throws(load, /needs a non-empty "hooks" array/);
  await write(JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: '' }] }] } }));
  assert.throws(load, /"command" must be a non-empty string/);
  await write(
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'x', timeout: 0 }] }] } }),
  );
  assert.throws(load, /"timeout" is seconds, between 1 and 600/);
  await write(
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'http', command: 'x' }] }] } }),
  );
  assert.throws(load, /unsupported hook type "http"/);
  await write(
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'x', when: 'y' }] }] } }),
  );
  assert.throws(load, /unknown key "when"/);
  // A file that is not an object at all is refused by name too, not by a JSON parse error.
  await write('[]');
  assert.throws(load, /expected a JSON object/);
});

test('the two config locations add up, and Claude’s seconds become our milliseconds', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-bridge-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(
    path.join(root, '.claude/settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'a|b', hooks: [{ type: 'command', command: 'first' }] }] },
    }),
  );
  await writeFile(
    path.join(root, '.yuantu/hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'second', timeout: 45 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'third' }] }],
      },
    }),
  );
  const declarations = loadHookDeclarations(root, 30_000);
  assert.deepEqual(
    declarations.map((entry) => [entry.file, entry.event, entry.command, entry.timeoutMs]),
    [
      ['.claude/settings.json', 'PreToolUse', 'first', 30_000],
      ['.yuantu/hooks.json', 'PreToolUse', 'second', 45_000],
      ['.yuantu/hooks.json', 'SessionEnd', 'third', 30_000],
    ],
  );
  assert.equal(declarations[0]!.matcher, 'a|b');
  assert.equal(hookBridgeSettings({ YUANTU_HOOK_TIMEOUT_MS: '1234' }).timeoutMs, 1234);
  assert.equal(hookBridgeSettings({}).timeoutMs, resolveRunLimits().hookTimeoutMs);
  assert.equal(hookBridgeSettings({ YUANTU_HOOK_BRIDGE: 'false' }).enabled, false);
  assert.equal(hookBridgeSettings({}).enabled, true);
  assert.throws(() => hookBridgeSettings({ YUANTU_HOOK_TIMEOUT_MS: 'nope' }), /must be a number/);
});

test('one hook set is installed per event, no matter how many declarations it holds', async (t) => {
  const { tools, seen } = await fixture(
    t,
    (root) => ({
      hooks: {
        PreToolUse: [
          {
            matcher: 'read_file',
            hooks: [{ type: 'command', command: nodeCommand(root, 'a.mjs') }],
          },
          {
            matcher: 'write_file',
            hooks: [{ type: 'command', command: nodeCommand(root, 'b.mjs') }],
          },
          { hooks: [{ type: 'command', command: nodeCommand(root, 'c.mjs') }] },
        ],
      },
    }),
    { 'a.mjs': SCRIPTS.allowing, 'b.mjs': SCRIPTS.allowing, 'c.mjs': SCRIPTS.allowing },
  );
  assert.equal(tools.extensions.size, 1, 'three declarations, one registration');
  const result = await tools.execute(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context(),
  );
  assert.equal(result.isError, false, result.content);
  // The unmatched first declaration is skipped, and the third runs because an absent matcher means "all".
  assert.equal((await seen()).length, 1);
});

test('somebody else’s settings.json is read for its hooks and left otherwise alone', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-bridge-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  // Every key here but `hooks` belongs to Claude Code, including a hook event this build does not
  // implement. Refusing to start over them would make the bridge useless in the projects that have hooks.
  await writeFile(
    path.join(root, '.claude/settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      model: 'claude-sonnet-4-5',
      env: { FOO: 'bar' },
      hooks: {
        PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'gated' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }],
      },
    }),
  );
  const declarations = loadHookDeclarations(root, 30_000);
  assert.deepEqual(
    declarations.map((entry) => [entry.file, entry.event, entry.command]),
    [['.claude/settings.json', 'PreToolUse', 'gated']],
  );
  // Our own file has no such licence: it exists for us, so an unknown key there is a typo.
  await mkdir(path.join(root, '.yuantu'), { recursive: true });
  await writeFile(
    path.join(root, '.yuantu/hooks.json'),
    JSON.stringify({ permission: true, hooks: {} }),
  );
  assert.throws(() => loadHookDeclarations(root, 30_000), /unknown key "permission"/);
});

test('a guard declared inside a hook set runs, and is taken back out with it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-bridge-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tools = createTools(root);
  t.after(() => tools.close().catch(() => undefined));
  const dispose = tools.extensions.register({ guard: () => ({ deny: 'not in this hook set' }) });
  const denied = await tools.execute(
    { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context(),
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content, /Operation denied by guard: not in this hook set/);
  assert.equal(existsSync(path.join(root, 'a.txt')), false);
  dispose();
  const allowed = await tools.execute(
    { id: 'c2', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
    context(),
  );
  assert.equal(allowed.isError, false, allowed.content);
});

test('a matcher is a pattern list over the subject, and an unknown subject never matches', () => {
  assert.equal(hookMatcherMatches(undefined, 'write_file'), true);
  assert.equal(hookMatcherMatches('*', 'anything'), true);
  assert.equal(hookMatcherMatches('write_file|run_command', 'run_command'), true);
  assert.equal(hookMatcherMatches('write_*', 'write_file'), true);
  assert.equal(hookMatcherMatches(' write_file ', 'write_file'), true);
  assert.equal(hookMatcherMatches('write_file', 'read_file'), false);
  assert.equal(hookMatcherMatches('write_file', undefined), false);
  // A regex metacharacter in the pattern is literal, not a second pattern language.
  assert.equal(hookMatcherMatches('write_file.v2', 'write_fileXv2'), false);
  assert.equal(hookMatcherMatches('write_file.v2', 'write_file.v2'), true);
});
