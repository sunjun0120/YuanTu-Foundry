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
import { mkdtemp, rm, writeFile, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { Agent } from '../packages/core/agent.ts';
import { EXPLORE_TOOLS } from '../packages/core/subagents/delegation.ts';
import { contextMessageSize } from '../packages/protocol/images.ts';
import { validateImages } from '../packages/protocol/images.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { fileTools } from '../packages/tools/files.ts';
import { createTools } from '../packages/catalog/index.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  ToolContext,
} from '../packages/protocol/index.ts';
import { tempRoot } from './temp-fixture.ts';

/** A real 1×1 PNG: signature, IHDR, IDAT and IEND, so the sniffer and an endpoint both accept it. */
import { toolCall as call } from './provider-fixture.ts';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}
function fixturePng(color = 6, depth = 8): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = depth;
  header[9] = color;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const pixels = Buffer.alloc(1 + Math.ceil((channels[color]! * depth) / 8));
  return Buffer.concat([
    PNG.subarray(0, 8),
    pngChunk('IHDR', header),
    ...(color === 3 ? [pngChunk('PLTE', Buffer.alloc(3))] : []),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND'),
  ]);
}
const attachment = (bytes: Buffer) => ({
  mimeType: 'image/png' as const,
  data: bytes.toString('base64'),
});

// Trusted codec corpora and Chromium-encoded WebPs; see the fixture provenance README.
const imageFixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/image-containers/${name}`, import.meta.url));
const BASELINE_JPEG = imageFixture('baseline.jpg');
const PROGRESSIVE_JPEG = imageFixture('progressive.jpg');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const WEBP = imageFixture('vp8.webp');
function riff(...chunks: Buffer[]): Buffer {
  const data = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}
function webpChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2));
  chunk.write(type);
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  return chunk;
}
function codecChunk(bytes: Buffer): Buffer {
  for (let at = 12; at < bytes.length;) {
    const length = bytes.readUInt32LE(at + 4);
    const end = at + 8 + length + (length % 2);
    if (['VP8 ', 'VP8L'].includes(bytes.toString('ascii', at, at + 4)))
      return bytes.subarray(at, end);
    at = end;
  }
  throw new Error('fixture has no codec');
}
const SIMPLE_WEBP = riff(codecChunk(WEBP));
const LOSSLESS_WEBP = riff(codecChunk(imageFixture('vp8l.webp')));
const LOSSLESS_ALPHA_HINT_CLEARED = Buffer.from(imageFixture('vp8l-alpha.webp'));
const alphaCodec = codecChunk(LOSSLESS_ALPHA_HINT_CLEARED);
// VP8L's alpha_is_used is only an encoder hint; clearing it does not alter decoded pixels.
alphaCodec[12] = alphaCodec[12]! & 0xef;
const animationHeader = Buffer.from([2, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
const frameHeader = Buffer.alloc(16);
frameHeader[6] = frameHeader[9] = 1;
frameHeader[12] = 100;
const ANIMATED_WEBP = riff(
  webpChunk('VP8X', animationHeader),
  webpChunk('ANIM', Buffer.alloc(6)),
  webpChunk('ANMF', Buffer.concat([frameHeader, codecChunk(WEBP)])),
);
const metadataHeader = Buffer.from(animationHeader);
metadataHeader[0] = 12;
const METADATA_WEBP = riff(
  webpChunk('VP8X', metadataHeader),
  webpChunk('XMP ', Buffer.from('xmp')),
  webpChunk('JUNK', Buffer.from('unknown')),
  webpChunk('EXIF', Buffer.from('exif')),
  codecChunk(WEBP),
);
const EXTENDED_GIF = Buffer.concat([
  GIF.subarray(0, 19),
  Buffer.from([0x21, 0xfe, 3, 97, 98, 99, 0]),
  Buffer.from([0x21, 0xff, 11]),
  Buffer.from('NETSCAPE2.0'),
  Buffer.from([3, 1, 0, 0, 0]),
  Buffer.from([0x21, 1, 12, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 65, 0]),
  GIF.subarray(19),
]);
for (const [name, mimeType, bytes] of [
  ['baseline JPEG', 'image/jpeg', BASELINE_JPEG],
  ['progressive JPEG', 'image/jpeg', PROGRESSIVE_JPEG],
  ['restart-marker JPEG', 'image/jpeg', imageFixture('restarts.jpg')],
  ['GIF89a extensions', 'image/gif', EXTENDED_GIF],
  ['GIF87a', 'image/gif', Buffer.concat([Buffer.from('GIF87a'), GIF.subarray(6)])],
  ['VP8 WebP', 'image/webp', SIMPLE_WEBP],
  ['VP8L WebP', 'image/webp', LOSSLESS_WEBP],
  ['VP8L transparency with alpha hint cleared', 'image/webp', LOSSLESS_ALPHA_HINT_CLEARED],
  ['VP8X alpha WebP', 'image/webp', imageFixture('vp8x.webp')],
  ['animated WebP', 'image/webp', ANIMATED_WEBP],
  ['WebP metadata before image and odd unknown chunks', 'image/webp', METADATA_WEBP],
] as const) {
  test(`valid ${name} survives attachment validation and read_image`, async (t) => {
    const image = { mimeType, data: bytes.toString('base64') };
    assert.deepEqual(validateImages([image]), [image]);
    const root = await workspace(t);
    await writeFile(path.join(root, 'valid.image'), bytes);
    const tools = createTools(root);
    t.after(() => tools.close());
    const result = await tools.execute(
      { id: 'valid', name: 'read_image', arguments: { path: 'valid.image' } },
      context(),
    );
    assert.equal(result.isError, false, result.content);
    assert.equal(result.images?.[0]?.data, image.data);
  });
}
const badJpegLength = Buffer.from(BASELINE_JPEG);
badJpegLength.writeUInt16BE(0xffff, 4);
const badGifBlock = Buffer.from(GIF);
badGifBlock[38] = 255;
const badWebpSize = Buffer.from(SIMPLE_WEBP);
badWebpSize.writeUInt32LE(4, 4);
const badWebpChunk = Buffer.from(SIMPLE_WEBP);
badWebpChunk.writeUInt32LE(0xffffffff, 16);
const badWebpFrame = Buffer.from(SIMPLE_WEBP);
badWebpFrame[23] = 0;
const badWebpPartition = Buffer.from(SIMPLE_WEBP);
badWebpPartition.writeUIntLE(((SIMPLE_WEBP.length - 20 - 9) << 5) | 16, 20, 3);
for (const [name, mimeType, bytes] of [
  [
    'JPEG signature-only',
    'image/jpeg',
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(37)]),
  ],
  ['JPEG truncated', 'image/jpeg', BASELINE_JPEG.subarray(0, -1)],
  ['JPEG bad segment length', 'image/jpeg', badJpegLength],
  [
    'JPEG restart marker without restart interval',
    'image/jpeg',
    Buffer.concat([
      BASELINE_JPEG.subarray(0, -2),
      Buffer.from([0xff, 0xd0]),
      BASELINE_JPEG.subarray(-2),
    ]),
  ],
  ['JPEG missing frame and scan', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ['GIF signature-only', 'image/gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(34)])],
  ['GIF truncated', 'image/gif', GIF.subarray(0, -1)],
  ['GIF bad data block length', 'image/gif', badGifBlock],
  ['GIF no image data', 'image/gif', Buffer.concat([GIF.subarray(0, 19), Buffer.from([0x3b])])],
  ['GIF zero screen size', 'image/gif', Buffer.from(GIF).fill(0, 6, 8)],
  [
    'WebP signature-only',
    'image/webp',
    Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(28)]),
  ],
  ['WebP truncated', 'image/webp', SIMPLE_WEBP.subarray(0, -1)],
  ['WebP mismatched RIFF size', 'image/webp', badWebpSize],
  ['WebP bad chunk length', 'image/webp', badWebpChunk],
  ['WebP bad VP8 header', 'image/webp', badWebpFrame],
  ['WebP truncated VP8 control partition', 'image/webp', badWebpPartition],
  ['WebP no image chunk', 'image/webp', riff(webpChunk('JUNK', Buffer.alloc(4)))],
] as const) {
  test(`damaged ${name} is refused by attachment validation and read_image`, async (t) => {
    assert.throws(
      () => validateImages([{ mimeType, data: bytes.toString('base64') }]),
      /image|JPEG|GIF|WebP/i,
    );
    const root = await workspace(t);
    await writeFile(path.join(root, 'broken.image'), bytes);
    const tools = createTools(root);
    t.after(() => tools.close());
    const result = await tools.execute(
      { id: 'broken', name: 'read_image', arguments: { path: 'broken.image' } },
      context(),
    );
    assert.equal(result.isError, true, 'a malformed container cannot be attached');
    assert.equal(result.images, undefined);
  });
}

test('PNG integrity accepts grayscale, truecolor, indexed, alpha and consecutive data chunks', () => {
  for (const [color, depth] of [
    [0, 1],
    [0, 16],
    [2, 8],
    [3, 1],
    [4, 8],
    [6, 16],
  ]) {
    const image = attachment(fixturePng(color, depth));
    assert.deepEqual(validateImages([image]), [image]);
  }
  const multiple = Buffer.concat([PNG.subarray(0, 33), pngChunk('IDAT'), PNG.subarray(33)]);
  assert.deepEqual(validateImages([attachment(multiple)]), [attachment(multiple)]);
});

test('PNG integrity refuses nonconsecutive data even when its first data chunk is empty', () => {
  const bytes = Buffer.concat([
    PNG.subarray(0, 33),
    pngChunk('IDAT'),
    pngChunk('tEXt', Buffer.from('key\0value')),
    PNG.subarray(33),
  ]);
  assert.throws(() => validateImages([attachment(bytes)]), /PNG/);
});

test('PNG integrity refuses a palette after even an empty data chunk', () => {
  const bytes = Buffer.concat([
    PNG.subarray(0, 33),
    pngChunk('IDAT'),
    pngChunk('PLTE', Buffer.alloc(3)),
    PNG.subarray(33),
  ]);
  assert.throws(() => validateImages([attachment(bytes)]), /PNG/);
});

test('PNG integrity checks header values and chunk boundaries independently of their CRC', () => {
  for (const [offset, value] of [
    [3, 0],
    [8, 3],
    [10, 1],
    [11, 1],
    [12, 2],
  ]) {
    const header = Buffer.from(PNG.subarray(16, 29));
    header[offset!] = value!;
    const bytes = Buffer.concat([PNG.subarray(0, 8), pngChunk('IHDR', header), PNG.subarray(33)]);
    assert.throws(() => validateImages([attachment(bytes)]), /PNG/);
  }
  const oversized = Buffer.from(PNG);
  oversized.writeUInt32BE(0xffffffff, 33);
  assert.throws(() => validateImages([attachment(oversized)]), /PNG/);
  assert.throws(() => validateImages([attachment(Buffer.concat([PNG, Buffer.from([0])]))]), /PNG/);
});

for (const [name, bytes] of [
  ['signature-only', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(32)])],
  ['truncated', PNG.subarray(0, PNG.length - 1)],
  ['missing-data', Buffer.concat([PNG.subarray(0, 33), PNG.subarray(-12)])],
  ['bad-crc', Buffer.from(PNG).fill(0, 29, 33)],
] as const) {
  test(`damaged PNG ${name} is refused by both attachment validation and read_image`, async (t) => {
    const root = await workspace(t);
    await writeFile(path.join(root, 'broken.png'), bytes);
    const tools = createTools(root);
    t.after(() => tools.close());
    const result = await tools.execute(
      { id: 'broken', name: 'read_image', arguments: { path: 'broken.png' } },
      context(),
    );
    assert.equal(result.isError, true, 'a malformed PNG cannot be reported as an attached image');
    assert.equal(result.images, undefined);
    assert.match(result.content, /PNG|image/i);
    assert.throws(
      () => validateImages([{ mimeType: 'image/png', data: bytes.toString('base64') }]),
      /PNG|image/i,
    );
  });
}
const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
async function workspace(t: test.TestContext): Promise<string> {
  const root = await tempRoot(t, 'yuantu-image-');
  return root;
}
const reply = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
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

test('read_image completes short reads instead of returning zero-filled bytes', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'shot.png'), PNG);
  // Every read is capped below the buffer, which is a short read from the tool's point of view: `Buffer.alloc`
  // leaves the tail as NUL bytes, so a single unchecked `read` would report a truncated, zero-padded picture
  // that still passes the header sniff.
  const sample = await open(path.join(root, 'shot.png'), 'r');
  const prototype = Object.getPrototypeOf(sample);
  const original = prototype.read;
  await sample.close();
  t.mock.method(prototype, 'read', function (this: unknown, ...args: unknown[]) {
    if (Buffer.isBuffer(args[0])) args[2] = Math.min(3, Number(args[2]));
    return Reflect.apply(original, this, args);
  });
  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'img', name: 'read_image', arguments: { path: 'shot.png' } },
    context(),
  );
  assert.equal(result.isError, false, result.content);
  assert.deepEqual(Buffer.from(result.images![0]!.data, 'base64'), PNG);
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
