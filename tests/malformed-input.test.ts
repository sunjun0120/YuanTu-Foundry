/**
 * Parsers that read what someone else wrote, fed what someone else might write.
 *
 * Each of these takes bytes from outside the process — a web page, a model endpoint's stream, the far end of the
 * Host link — and each has had a defect that only a shape nobody wrote a fixture for could find: an unclosed
 * `<script>` that made the HTML stripper quadratic, a UTF-8 character split across two socket reads. These tests
 * generate inputs instead of listing them. The generator is seeded, so a failure names the seed that reproduces it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../packages/tools/web.ts';
import { readSse } from '../packages/providers/sse.ts';
import { lineFramer } from '../packages/client/host-transport.ts';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { OfficeFormat } from '../packages/office/automation.ts';
import { inspectOffice } from '../packages/office/inspect.ts';
import { runSpreadsheetOperation } from '../packages/office/spreadsheet.ts';
import { createDocx } from '../packages/office/document.ts';
import { createPptx } from '../packages/office/presentation.ts';
import { tempRoot } from './temp-fixture.ts';
import { translate } from '../apps/desktop/i18n.ts';

/** mulberry32: small, fast and deterministic, which is all a reproducible generator needs to be. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(next: () => number, items: readonly T[]): T =>
  items[Math.floor(next() * items.length)]!;
/** Cut `bytes` at random places, the way a socket or a fetch body delivers it. */
function chunks(next: () => number, bytes: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let at = 0; at < bytes.length;) {
    const size = 1 + Math.floor(next() * Math.min(64, bytes.length - at));
    parts.push(bytes.subarray(at, at + size));
    at += size;
  }
  return parts;
}
function stream(parts: Buffer[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new Uint8Array(part));
      controller.close();
    },
  });
}

const SEEDS = 300;

test('htmlToText survives arbitrary markup soup and never shows a closed script', () => {
  const pieces = [
    '<p>',
    '</p>',
    '<div a="1">',
    '</div>',
    '<br>',
    '<li>',
    '</li>',
    '<!--',
    '-->',
    '<',
    '>',
    '&amp;',
    '&#x1F600;',
    '&#99999999;',
    '<title>',
    '</title>',
    '<style>',
    '</style>',
    '<svg>',
    '</svg>',
    'text ',
    translate('general.languageZh', 'zh-CN'),
    '\u0000',
    '\r\n',
    '<a href="<script>">',
    '</SCRIPT >',
    '<script',
    '<!doctype html>',
    '"',
    "'",
    '=',
  ];
  const started = performance.now();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const next = random(seed);
    let html = '';
    const length = Math.floor(next() * 200);
    for (let index = 0; index < length; index++) html += pick(next, pieces);
    // A well-formed script whose body must never reach the text, wherever it lands in the soup.
    html += '<script>SECRET_SCRIPT_BODY</script>';
    for (let index = 0; index < length / 4; index++) html += pick(next, pieces);
    let text: string;
    try {
      text = htmlToText(html).text;
    } catch (error) {
      assert.fail(`seed ${seed} threw ${String(error)} on ${JSON.stringify(html)}`);
    }
    // A comment opened before the script can swallow it whole, which hides it too; only leaking it is wrong.
    assert.doesNotMatch(text, /SECRET_SCRIPT_BODY/, `seed ${seed}: ${JSON.stringify(html)}`);
  }
  assert.ok(performance.now() - started < 5_000, 'the soup took too long to strip');
});

test('readSse yields the same events however the stream is cut', async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const next = random(seed);
    const events = Array.from({ length: 1 + Math.floor(next() * 8) }, (_, index) => ({
      index,
      text: pick(next, ['plain', '中文和 emoji 😀', 'line\nbreak', '"quoted"', '']),
    }));
    const newline = pick(next, ['\n', '\r\n']);
    const wire =
      events
        .map((event) => `event: delta${newline}data: ${JSON.stringify(event)}${newline}${newline}`)
        .join('') + `data: [DONE]${newline}${newline}`;
    const received: unknown[] = [];
    for await (const event of readSse(
      stream(chunks(next, Buffer.from(wire, 'utf8'))),
      new AbortController().signal,
      true,
    ))
      received.push(event);
    // `[DONE]` is reported as the stream's end, after every event.
    assert.deepEqual(received, [...events, { type: 'stream.done' }], `seed ${seed}`);
  }
});

test('readSse refuses garbage with its own errors, never with a crash', async () => {
  const pieces = [
    'data: ',
    'data:',
    '{',
    '}',
    '[',
    ']',
    '"',
    'null',
    '1',
    'event: x',
    ':comment',
    '\n',
    '\r\n',
    '\n\n',
    'é',
    '\u0000',
  ];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const next = random(seed);
    let wire = '';
    for (let index = 0; index < 60; index++) wire += pick(next, pieces);
    try {
      for await (const event of readSse(
        stream(chunks(next, Buffer.from(wire, 'utf8'))),
        new AbortController().signal,
      ))
        assert.equal(typeof event, 'object', `seed ${seed}`);
    } catch (error) {
      assert.match(
        String((error as Error).message),
        /Invalid JSON in model stream|Invalid stream event|Incomplete model stream frame/,
        `seed ${seed}: ${JSON.stringify(wire)} -> ${String(error)}`,
      );
    }
  }
});

test('the Host link frames lines exactly, however the bytes arrive', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const next = random(seed);
    const lines = Array.from({ length: 1 + Math.floor(next() * 10) }, () =>
      JSON.stringify({
        text: pick(next, [
          'a',
          translate('general.languageZh', 'zh-CN'),
          '😀😀',
          'x'.repeat(200),
          ' spaced ',
        ]),
      }),
    );
    const received: string[] = [];
    const errors: Error[] = [];
    const framer = lineFramer({
      maxFrameBytes: 1_000,
      onLine: (line) => received.push(line),
      onError: (error) => errors.push(error),
    });
    // Blank lines between frames are padding, not frames.
    const wire = lines.join(pick(next, ['\n', '\n\n'])) + '\n';
    for (const part of chunks(next, Buffer.from(wire, 'utf8'))) framer.write(part);
    assert.deepEqual(errors, [], `seed ${seed}`);
    assert.deepEqual(received, lines, `seed ${seed}`);
    assert.equal(framer.buffered(), false, `seed ${seed}`);
  }
});

test('the Host link refuses an oversized line once and reads nothing after it', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const next = random(seed);
    const received: string[] = [];
    const errors: Error[] = [];
    const framer = lineFramer({
      maxFrameBytes: 100,
      onLine: (line) => received.push(line),
      onError: (error) => errors.push(error),
    });
    const wire = `{"ok":1}\n${'中'.repeat(40 + Math.floor(next() * 200))}\n{"after":1}\n`;
    for (const part of chunks(next, Buffer.from(wire, 'utf8'))) framer.write(part);
    assert.deepEqual(received, ['{"ok":1}'], `seed ${seed}`);
    assert.equal(errors.length, 1, `seed ${seed}`);
  }
});

/**
 * `office_inspect` hands a workspace file to readers this repository does not own. They run in a worker with a
 * time limit, so a hang costs a thread — but a reader that throws something other than an `Error`, or that answers
 * with something other than the JSON the tool promises, is still this tool's defect. Each case starts from a real
 * package of each format and damages it the three ways a file arrives damaged: cut short, bytes flipped, or a
 * well-formed zip whose XML is soup.
 */
test('office inspection answers or refuses damaged packages, never anything else', async (t) => {
  const root = await tempRoot(t, 'yuantu-office-malformed-');
  const originals: [OfficeFormat, Buffer][] = [];
  for (const format of ['docx', 'xlsx', 'pptx'] as const) {
    const outputPath = path.join(root, `seed.${format}`);
    if (format === 'xlsx')
      await runSpreadsheetOperation({
        operation: 'create',
        format,
        outputPath,
        sheets: [
          {
            name: 'Data',
            rows: [
              ['a', 1],
              ['b', '=SUM(B1:B1)'],
            ],
          },
        ],
      });
    else if (format === 'docx')
      await createDocx({ operation: 'create', format, outputPath, title: 'T', paragraphs: ['p'] });
    else
      await createPptx({
        operation: 'create',
        format,
        outputPath,
        slides: [{ title: 'S', body: ['one', 'two'] }],
      });
    originals.push([format, await readFile(outputPath)]);
  }
  const soup = [
    '<',
    '>',
    '</w:t>',
    '<w:p>',
    '&amp;',
    '&#xFFFF;',
    '<?xml?>',
    '"',
    '<!DOCTYPE x>',
    '中',
    ']]>',
  ];
  for (let seed = 1; seed <= 25; seed++) {
    const next = random(seed);
    for (const [format, original] of originals) {
      const zip = await JSZip.loadAsync(original);
      const entries = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
      const victim = pick(next, entries);
      zip.file(
        victim,
        Array.from({ length: 1 + Math.floor(next() * 200) }, () => pick(next, soup)).join(''),
      );
      const flipped = Buffer.from(original);
      for (let i = 0; i < 1 + Math.floor(next() * 20); i++)
        flipped[Math.floor(next() * flipped.length)] = Math.floor(next() * 256);
      const cases: [string, Buffer][] = [
        ['cut', original.subarray(0, 1 + Math.floor(next() * (original.length - 1)))],
        ['flipped', flipped],
        [`soup in ${victim}`, await zip.generateAsync({ type: 'nodebuffer' })],
      ];
      for (const [damage, bytes] of cases) {
        const file = path.join(root, `case.${format}`);
        await writeFile(file, bytes);
        const label = `seed ${seed}, ${format}, ${damage}`;
        try {
          const answer = await inspectOffice(file, format);
          assert.equal(typeof JSON.parse(answer), 'object', label);
        } catch (error) {
          assert.ok(error instanceof Error, `${label}: threw ${typeof error} ${String(error)}`);
        }
      }
    }
  }
});
