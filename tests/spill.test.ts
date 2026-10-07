/**
 * Tool output too large to return.
 *
 * A result used to be cut at 24,000 characters and the rest was gone: the model saw a marker and could not
 * ask for the part it needed, and the user could not see it either. Now the whole output is written under
 * `.yuantu/spill/<session>/` and the result names the file, its size and its line count, which `read_file`
 * can page through. These tests are about the two halves that make that worth doing: *nothing is lost*, and
 * *the model can actually get it back*.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry, MAX_TOOL_OUTPUT, bounded } from '../packages/tools/registry.ts';
import { createTools } from '../packages/tools/index.ts';
import { SPILL_DIRECTORY, spillOutput, spillResult } from '../packages/tools/spill.ts';
import { Agent } from '../packages/core/agent.ts';
import type { Message, ModelResponse, ToolContext } from '../packages/protocol/index.ts';

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
  ...overrides,
});
const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});

test('output over the limit is written out whole and the result says where', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tools = new ToolRegistry();
  const long = Array.from({ length: 4000 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join(
    '\n',
  );
  tools.register({
    name: 'noisy',
    description: 'Produces more than a result can carry',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: long };
    },
  });
  const result = await tools.execute(
    { id: 'n1', name: 'noisy', arguments: {} },
    context({ spill: (input) => spillOutput({ workspace: root, sessionId: 's1', ...input }) }),
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.length < long.length, 'the result itself stays bounded');
  assert.ok(result.content.startsWith(long.slice(0, 100)), 'it keeps the beginning of the output');
  const notice = result.content.slice(MAX_TOOL_OUTPUT);
  assert.match(notice, /output truncated at 24000 characters/);
  assert.match(notice, /read_file/);
  const relative = /the full \d+ bytes \/ \d+ lines are in (.+?) —/.exec(notice)?.[1];
  assert.ok(relative, `the notice names the file: ${notice}`);
  assert.ok(relative.startsWith('.yuantu/spill/s1/'), relative);
  assert.equal(await readFile(path.join(root, relative), 'utf8'), long, 'nothing was lost');
  assert.match(notice, new RegExp(`${Buffer.byteLength(long, 'utf8')} bytes`));
  assert.match(notice, /4000 lines/);
});

test('a result a tool already truncated is not spilled as though it were complete', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-cut-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tools = new ToolRegistry();
  /**
   * The tool cuts its own output. This is what made the old length test wrong: `bounded` appends its marker
   * outside the budget, so the result came back at `MAX_TOOL_OUTPUT + marker.length` and the result stage read
   * that as "more output than I can carry" — it spilled the *already truncated* text and the notice promised a
   * complete file that was itself cut, which is the one thing the notice exists to rule out.
   */
  tools.register({
    name: 'self-cut',
    description: 'Truncates its own output before returning it',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: bounded('q'.repeat(MAX_TOOL_OUTPUT * 2)) };
    },
  });
  let spills = 0;
  const result = await tools.execute(
    { id: 'c1', name: 'self-cut', arguments: {} },
    context({
      spill: (input) => {
        spills++;
        return spillOutput({ workspace: root, sessionId: 's1', ...input });
      },
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(spills, 0, 'nothing was spilled, because nothing complete was withheld');
  assert.doesNotMatch(result.content, /the full .* are in/);
  assert.match(result.content, /\[output truncated\]$/);
});

test('a tool that says it cut its own output is spilled, and the notice says what the copy is', async (t) => {
  /**
   * The other half of the same distinction, and the one `run_command` is in.
   *
   * That tool bounds its output at two megabytes — deliberately above the inline budget, so the result stage has
   * something worth writing out — which means the text it hands over is itself short of what the command printed.
   * Skipping the spill would throw away the only copy of a build log; spilling it under "the full N bytes" was the
   * lie the item is about. The prose in the text could not say which case it was (nothing reads a sentence), so the
   * tool declares it and the notice repeats it.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-declared-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tools = new ToolRegistry();
  const captured = 'c'.repeat(MAX_TOOL_OUTPUT * 2);
  tools.register({
    name: 'bounded-by-itself',
    description: 'Bounds its own output far above the inline budget',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: captured, truncated: true };
    },
  });
  let spills = 0;
  const result = await tools.execute(
    { id: 'd1', name: 'bounded-by-itself', arguments: {} },
    context({
      spill: (input) => {
        spills++;
        return spillOutput({ workspace: root, sessionId: 's1', ...input });
      },
    }),
  );
  assert.equal(spills, 1, 'the captured text is the only copy, so it is written out');
  assert.equal(result.truncated, true, 'and the result still says the tool cut it');
  const notice = result.content.slice(MAX_TOOL_OUTPUT);
  assert.match(notice, /the captured \d+ bytes/);
  assert.match(notice, /the tool had already cut its own output/);
  assert.doesNotMatch(
    notice,
    /the full \d+ bytes/,
    'the notice no longer promises a tail the file does not have',
  );
  const relative = /are in (.+?),/.exec(notice)?.[1];
  assert.ok(relative, `the notice names the file: ${notice}`);
  assert.equal(await readFile(path.join(root, relative), 'utf8'), captured);
});

test('a spill is written the way the credential store is: private to the user', async (t) => {
  if (process.platform === 'win32')
    return t.skip('POSIX permission bits are not a Windows concept');
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-mode-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  // A spill is a copy of output a tool read — file contents, a command's stdout — so it is as private as the
  // credentials in `packages/mcp/oauth.ts`, which is where this 0700/0600 pair is already used.
  spillOutput({ workspace: root, sessionId: 's1', tool: 'run_command', content: 'secret output' });
  spillResult({ workspace: root, sessionId: 's1', key: 'call-1', content: 'shortened output' });
  const directory = path.join(root, SPILL_DIRECTORY, 's1');
  assert.equal(
    (await stat(directory)).mode & 0o777,
    0o700,
    'the spill directory is group/world readable',
  );
  for (const name of await readdir(directory))
    assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600, name);
});

test('the model can read a spilled output back with read_file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-read-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const tools = createTools(root);
  const long = Array.from({ length: 3000 }, (_, index) => `needle-${index}`).join('\n');
  // What a long tool output leaves behind once the result stage has spilled it.
  const spilled = spillOutput({
    workspace: root,
    sessionId: session.id,
    tool: 'run_command',
    content: long,
  })!;
  const read = await tools.execute(
    {
      id: 'r2',
      name: 'read_file',
      arguments: { path: spilled.path, start_line: 2999, end_line: 3000 },
    },
    context(),
  );
  assert.equal(read.isError, false, read.content);
  assert.match(read.content, /2999: needle-2998/);
  // Writing to the spill directory is still refused: the exception is for reads only.
  const write = await tools.execute(
    { id: 'w1', name: 'write_file', arguments: { path: spilled.path, content: 'tampered' } },
    context(),
  );
  assert.equal(write.isError, true);
  assert.equal(await readFile(path.join(root, spilled.path), 'utf8'), long);
  // And nothing else under `.yuantu` opened up: the session database stays unreachable.
  const database = await tools.execute(
    { id: 'r3', name: 'read_file', arguments: { path: '.yuantu/sessions.sqlite' } },
    context(),
  );
  assert.equal(database.isError, true);
});

test('a spill that cannot be written falls back to plain truncation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-fail-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tools = new ToolRegistry();
  tools.register({
    name: 'noisy',
    description: 'Produces more than a result can carry',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: 'y'.repeat(MAX_TOOL_OUTPUT + 5000) };
    },
  });
  const result = await tools.execute(
    { id: 'n1', name: 'noisy', arguments: {} },
    context({
      spill: () => {
        throw new Error('disk is full');
      },
    }),
  );
  // The tool already ran: its effect is recorded, and a result that could not be shortened is a smaller
  // problem than reporting the effect as a failure. The truncation marker is the honest fallback.
  assert.equal(result.isError, false);
  assert.equal(result.content.length, MAX_TOOL_OUTPUT + '\n[output truncated]'.length);
  assert.match(result.content, /\[output truncated\]$/);
});

test('a run spills through its own session, and the transcript points at the file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-run-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const long = 'z'.repeat(MAX_TOOL_OUTPUT * 2);
  const tools = createTools(root);
  // A tool whose output is longer than a result can carry: the run's own registry is what the pipeline
  // spills through, so this is the path a real tool takes.
  tools.register({
    name: 'noisy',
    description: 'Produces more than a result can carry',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: long };
    },
  });
  let turn = 0;
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete() {
        turn++;
        return turn === 1
          ? {
              text: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'noisy-1', name: 'noisy', arguments: {} }],
              usage: { inputTokens: 10, outputTokens: 5 },
            }
          : reply('done');
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Produce a lot' });
  assert.equal(result.status, 'completed', result.error);
  const tool = store.messages(session.id).find((message) => message.role === 'tool') as Message;
  const relative = /are in (.+?) —/.exec(String(tool.content))?.[1]!;
  assert.ok(
    relative.startsWith(`${SPILL_DIRECTORY.split(path.sep).join('/')}/${session.id}/`),
    relative,
  );
  assert.equal(await readFile(path.join(root, relative), 'utf8'), long);
});
