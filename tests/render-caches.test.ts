import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { markdownBlocks } from '../apps/desktop/markdown-blocks.ts';
import { StatCache, statKey } from '../packages/platform/stat-cache.ts';

test('a streaming answer splits into blocks at blank lines, and a fence keeps its own blank lines', () => {
  const text = [
    '# Title',
    '',
    'First paragraph',
    'continues here.',
    '',
    '',
    '```ts',
    'const a = 1;',
    '',
    'const b = 2;',
    '```',
    '',
    '- item',
  ].join('\n');
  assert.deepEqual(markdownBlocks(text), [
    '# Title',
    'First paragraph\ncontinues here.',
    '```ts\nconst a = 1;\n\nconst b = 2;\n```',
    '- item',
  ]);
  // A fence still open at the end of the stream holds everything after it in one growing block.
  assert.deepEqual(markdownBlocks('intro\n\n~~~\ncode\n\nmore'), ['intro', '~~~\ncode\n\nmore']);
  // Growing the last block leaves every earlier block byte-identical: that is what lets their nodes be kept.
  const before = markdownBlocks('one\n\ntwo');
  const after = markdownBlocks('one\n\ntwo three');
  assert.equal(before[0], after[0]);
  assert.deepEqual(markdownBlocks(''), []);
});

test('a stat cache answers an unchanged file without reading it, and sees a rewrite or a rename', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-stat-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'SKILL.md');
  await writeFile(file, 'one');
  const cache = new StatCache<string>(2);
  let reads = 0;
  const read = () => {
    reads++;
    return `read ${reads}`;
  };
  assert.equal(cache.get(file, statKey(statSync(file)), read), 'read 1');
  assert.equal(cache.get(file, statKey(statSync(file)), read), 'read 1');
  await writeFile(file, 'two!');
  assert.equal(cache.get(file, statKey(statSync(file)), read), 'read 2');
  // An editor's save by rename is a new inode even when size and time look alike.
  const replacement = path.join(directory, 'next.md');
  await writeFile(replacement, 'two!');
  await rename(replacement, file);
  assert.equal(cache.get(file, statKey(statSync(file)), read), 'read 3');
  // The bound evicts the least recently used entry.
  const key = statKey(statSync(file));
  cache.get('b', key, () => 'b');
  cache.get('c', key, () => 'c');
  assert.equal(
    cache.get(file, key, () => 'evicted'),
    'evicted',
  );
});
