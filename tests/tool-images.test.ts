/**
 * Pictures a tool produced, from the file on disk to the message the model reads.
 *
 * The gap this closes is not "the model cannot see images" in the abstract: a user can already attach one. It is
 * that everything the *agent's own tools* look at was invisible — a screenshot, a rendered page, a chart — so
 * those tasks could only be done by describing a filename. What has to hold is the whole path: the tool reads
 * real bytes, the result carries them, the session log keeps them, and the next request hands them to the model
 * as an image rather than as a path or a blob of base64 text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { EXPLORE_TOOLS } from '../packages/core/subagents.ts';
import { contextMessageSize } from '../packages/protocol/images.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { fileTools } from '../packages/tools/files.ts';
import { createTools } from '../packages/tools/index.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  ToolContext,
} from '../packages/protocol/index.ts';

/** A real 1×1 PNG: signature, IHDR, IDAT and IEND, so the sniffer and an endpoint both accept it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const reply = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

test('read_image returns the file as an image the model can look at', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'shot.png'), PNG);
  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'img', name: 'read_image', arguments: { path: 'shot.png' } },
    context(),
  );
  assert.equal(result.isError, false);
  assert.equal(result.images?.length, 1);
  assert.equal(result.images![0]!.mimeType, 'image/png');
  assert.equal(result.images![0]!.name, 'shot.png');
  assert.deepEqual(Buffer.from(result.images![0]!.data, 'base64'), PNG);
  // The text has to say what the picture is, because a model that cannot see (a text-only endpoint) still
  // reads this line, and because it is what a person sees in a terminal.
  assert.match(result.content, /shot\.png/);
  assert.match(result.content, /image\/png/);
});

test('read_image refuses anything that is not really an image', async (t) => {
  const root = await workspace(t);
  // Text with an image extension is the case that matters: the endpoint would reject it one step later, in a
  // request, far from the file that caused it.
  await writeFile(path.join(root, 'notes.png'), 'this is not a picture');
  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'img', name: 'read_image', arguments: { path: 'notes.png' } },
    context(),
  );
  assert.equal(result.isError, true);
  assert.equal(result.images, undefined);
  assert.match(result.content, /PNG, JPEG, GIF or WebP/);
  // read_file refuses binary files, which is why this tool exists at all.
  const binary = await tools.execute(
    { id: 'read', name: 'read_file', arguments: { path: 'notes.png' } },
    context(),
  );
  assert.equal(binary.isError, false);
});

test('read_image refuses an oversized file instead of putting it in the context', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'img', name: 'read_image', arguments: { path: 'huge.png' } },
    context(),
  );
  assert.equal(result.isError, true);
  assert.equal(result.images, undefined);
  assert.match(result.content, /limit is 5MB/);
});

test('read_image cannot reach outside the workspace', async (t) => {
  const root = await workspace(t);
  const elsewhere = await workspace(t);
  await writeFile(path.join(elsewhere, 'secret.png'), PNG);
  const tools = createTools(root);
  for (const target of ['../secret.png', path.join(elsewhere, 'secret.png')]) {
    const result = await tools.execute(
      { id: 'img', name: 'read_image', arguments: { path: target } },
      context(),
    );
    assert.equal(result.isError, true, target);
    assert.match(result.content, /outside workspace/);
  }
});

test('read_image needs no permission, so a read-only run keeps it', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'nested', 'shot.png'), PNG);
  const tool = fileTools(root).find((entry) => entry.name === 'read_image');
  assert.ok(tool, 'read_image is registered');
  assert.equal(
    tool!.permission,
    undefined,
    'looking at a picture is not an effect on the workspace',
  );
  // And a child that may only investigate can do it: a UI investigation that cannot look at the page is not
  // an investigation.
  assert.ok((EXPLORE_TOOLS as readonly string[]).includes('read_image'));
  // The read-only trim is what removes permission-declaring tools, and the explore allowlist is a hard list:
  // both keep this tool, so the one place that could quietly lose it is covered.
  const tools = createTools(root);
  assert.ok(tools.specs({ readOnly: true }).some((entry) => entry.name === 'read_image'));
  assert.ok(
    tools
      .forRun({ allow: EXPLORE_TOOLS })
      .specs()
      .some((entry) => entry.name === 'read_image'),
  );
  assert.equal(
    tools.specs({ readOnly: true }).some((entry) => entry.name === 'write_file'),
    false,
    'the read-only trim is actually trimming',
  );
});

test('a tool result image reaches the model, the log and the next request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-image-'));
  await writeFile(path.join(root, 'shot.png'), PNG);
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  // One hook, closing before removing: a WAL file still open makes the directory removal fail on Windows.
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    async complete(request) {
      requests.push(request);
      const tool = request.messages.find((message) => message.role === 'tool');
      if (!tool) return call('shot', 'read_image', { path: 'shot.png' });
      return reply('I can see one red pixel.');
    },
  };
  const result = await new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
  }).run({
    sessionId: session.id,
    prompt: 'Look at shot.png',
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 2);
  // 1. The model gets an image, not a path and not base64 text.
  const tool = requests[1]!.messages.find((message) => message.role === 'tool')!;
  assert.ok(tool.role === 'tool');
  assert.deepEqual(tool.images, [
    { mimeType: 'image/png', data: PNG.toString('base64'), name: 'shot.png' },
  ]);
  // 2. The transcript that a reload rebuilds carries it too — the same message object the request was built
  //    from, because "model-visible ⇒ recorded" is the property the whole log rests on.
  const stored = store.messages(session.id).filter((message) => message.role === 'tool');
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]!.images, tool.images);
  // 3. And the durable event carries it, so a session reopened in another process still has the picture.
  const event = store.events(session.id).find((entry) => entry.type === 'message.tool')!;
  const logged = event.data.message as { images?: unknown };
  assert.deepEqual(logged.images, tool.images);
});

test('the context estimate does not scale with the size of an image', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
  const message = {
    role: 'tool' as const,
    toolCallId: 'c1',
    content: 'Image big.png attached',
    isError: false,
    images: [{ mimeType: 'image/png' as const, data: big.toString('base64'), name: 'big.png' }],
  };
  const size = contextMessageSize([message]);
  // The base64 is ~2.7MB of characters; the estimate is a fixed placeholder per image. Counting the base64
  // would make every screenshot look like it consumed the whole window and trigger a compaction that cannot
  // help, since the bytes go to the provider as a picture either way.
  assert.ok(size < 10_000, `estimate was ${size} for a ${big.length}-byte image`);
  assert.ok(big.toString('base64').length > 1_000_000);
});
