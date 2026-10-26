import test from 'node:test';
import assert from 'node:assert/strict';
import type { TurnChanges } from '../apps/desktop/turn-changes.ts';
import {
  groupTurnCards,
  transientPreview,
  turnCardReading,
  visibleTurnFiles,
} from '../apps/desktop/ui/conversation/turn-changes-model.ts';

/**
 * The turn-changes card readings: a preview file the agent deleted again is not an edit it kept, a long list collapses
 * to three rows, and two turns that end after the same message occupy one position together.
 */
function turn(overrides: Partial<TurnChanges> = {}): TurnChanges {
  return {
    key: 'turn-1',
    afterIndex: 4,
    files: [],
    ...overrides,
  } as TurnChanges;
}
function file(path: string): { path: string; added: number; removed: number } {
  return { path, added: 2, removed: 1 };
}

test('transient preview files are filtered out of the count', () => {
  assert.equal(transientPreview('收入报告.preview.html'), true);
  assert.equal(transientPreview('src/report.md'), false);
  const visible = visibleTurnFiles(
    turn({
      files: [
        { ...file('报告.preview.html'), entries: [] },
        { ...file('报告.docx'), entries: [] },
      ] as never,
    }),
  );
  assert.deepEqual(
    visible.map((entry) => entry.path),
    ['报告.docx'],
  );
});

test('a long list collapses to three rows and names the toggle', () => {
  const reading = turnCardReading(
    turn({
      files: ['a', 'b', 'c', 'd', 'e'].map((path) => ({
        ...file(path),
        entries: [],
      })) as never,
    }),
    false,
    'zh-CN',
  );
  assert.equal(reading.rows.length, 3);
  assert.equal(reading.hiddenRows, 2);
  assert.equal(reading.title, '已编辑 5 个文件');
  assert.equal(reading.toggleLabel, '全部 5 个文件');
  const open = turnCardReading(
    turn({
      files: ['a', 'b', 'c', 'd'].map((path) => ({ ...file(path), entries: [] })) as never,
    }),
    true,
    'en-US',
  );
  assert.equal(open.rows.length, 4);
  assert.equal(open.hiddenRows, 0);
  assert.equal(open.toggleLabel, 'Collapse file list');
  const short = turnCardReading(
    turn({ files: [{ ...file('a'), entries: [] }] as never }),
    false,
    'zh-CN',
  );
  assert.equal(short.toggleLabel, null);
});

test('turns ending after the same message are grouped, not replaced', () => {
  const grouped = groupTurnCards([
    turn({ key: 'one', afterIndex: 4 }),
    turn({ key: 'two', afterIndex: 4 }),
    turn({ key: 'three', afterIndex: 7 }),
  ]);
  assert.deepEqual([...grouped.keys()], [4, 7]);
  assert.deepEqual(
    grouped.get(4)?.map((entry) => entry.key),
    ['one', 'two'],
  );
});
