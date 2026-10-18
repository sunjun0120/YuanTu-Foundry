/**
 * Child process output as text.
 *
 * Two failures this pins: a character split across two pipe chunks became two U+FFFD, and a Windows console program
 * writing in the OEM code page (GBK on a Chinese system) was decoded as UTF-8 into mojibake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputDecoder } from '../packages/tools/output-decoder.ts';

function decodeAll(chunks: Buffer[], legacy: string | null): string {
  const decoder = createOutputDecoder(legacy);
  return chunks.map((chunk) => decoder.write(chunk)).join('') + decoder.end();
}

/** Every split point of `bytes` into two chunks. */
function splits(bytes: Buffer): Buffer[][] {
  return Array.from({ length: bytes.length + 1 }, (_, at) => [
    bytes.subarray(0, at),
    bytes.subarray(at),
  ]);
}

test('a UTF-8 character split across chunks is joined, wherever the split falls', () => {
  const text = 'ok 构建失败 😀 done\n';
  for (const chunks of splits(Buffer.from(text, 'utf8')))
    assert.equal(decodeAll(chunks, 'gbk'), text);
  // Byte by byte, the hardest case for carrying an unfinished sequence.
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(
    decodeAll(
      [...bytes].map((byte) => Buffer.from([byte])),
      'gbk',
    ),
    text,
  );
});

test('console output in the OEM code page is decoded in it, including across chunk splits', () => {
  const message = '系统找不到指定的路径。\r\n';
  // What cmd.exe writes on a Chinese Windows system.
  const gbk = Buffer.from('cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4c2b7beb6a1a30d0a', 'hex');
  assert.equal(decodeAll([gbk], 'gbk'), message);
  for (const chunks of splits(gbk)) assert.equal(decodeAll(chunks, 'gbk'), message);
  // An ASCII prefix decodes the same either way, so a late switch keeps it.
  assert.equal(decodeAll([Buffer.from('C:\\> dir\r\n'), gbk], 'gbk'), 'C:\\> dir\r\n' + message);
});

test('without a legacy encoding invalid bytes become replacement characters and valid text survives', () => {
  const decoder = createOutputDecoder(null);
  const text =
    decoder.write(Buffer.from([0x61, 0xff, 0x62])) +
    decoder.write(Buffer.from('构', 'utf8').subarray(0, 2)) +
    decoder.write(Buffer.from('构', 'utf8').subarray(2)) +
    decoder.end();
  assert.equal(text, 'a\ufffdb构');
});

test('an unfinished sequence at the end of the stream is flushed rather than dropped', () => {
  const decoder = createOutputDecoder(null);
  assert.equal(decoder.write(Buffer.from([0x61, 0xe6, 0x9e])), 'a');
  assert.equal(decoder.end(), '\ufffd');
});

test(
  'cmd.exe error text is readable on this machine',
  { skip: process.platform !== 'win32' && 'Windows console code pages only' },
  async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'dir "Z:\\yuantu-output-decoder-missing"'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const decoder = createOutputDecoder();
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => (text += decoder.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => (text += decoder.write(chunk)));
    await new Promise((resolve) => child.on('close', resolve));
    text += decoder.end();
    assert.ok(text.trim(), 'cmd.exe printed an error');
    assert.doesNotMatch(text, /\ufffd/, `decoded without replacement characters: ${text}`);
  },
);
