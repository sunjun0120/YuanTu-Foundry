import test from 'node:test';
import assert from 'node:assert/strict';
import type { FileChange } from '../packages/protocol/index.ts';
import type { StoredFileChange } from '../packages/storage/session-schema.ts';
import type { TurnChangedFile, TurnChanges } from '../apps/desktop/turn-changes.ts';
import {
  groupTurnCards,
  transientPreview,
  turnCardReading,
  turnPreviewEntries,
  visibleTurnFiles,
  visibleTurns,
} from '../apps/desktop/ui/conversation/turn-changes-model.ts';

/**
 * The turn-changes card readings: a preview file the agent deleted again is not an edit it kept, a long list collapses
 * to three rows, two turns that end after the same message occupy one position together, and a preview says who made
 * a change and whether that journal row can still be restored.
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
function change(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: 'a.ts',
    kind: 'edit',
    patch: '',
    added: 1,
    removed: 0,
    truncated: false,
    ...overrides,
  };
}
function stored(overrides: Partial<StoredFileChange> = {}): StoredFileChange {
  return {
    id: 'change-1',
    sessionId: 'session',
    change: change(),
    status: 'applied',
    createdAt: '',
    ...overrides,
  };
}
function changedFile(entries: TurnChangedFile['entries']): TurnChangedFile {
  return { path: entries[0]?.change.path ?? 'a.ts', added: 1, removed: 0, entries };
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

test('a turn whose only file was a scratch preview leaves no card', () => {
  const remaining = visibleTurns([
    turn({
      key: 'preview-only',
      files: [{ ...file('报告.preview.html'), entries: [] }] as never,
    }),
    turn({ key: 'kept', files: [{ ...file('报告.docx'), entries: [] }] as never }),
  ]);
  assert.deepEqual(
    remaining.map((entry) => entry.key),
    ['kept'],
  );
  assert.deepEqual(
    remaining[0]?.files.map((entry) => entry.path),
    ['报告.docx'],
  );
});

test('a preview names the sub-agent and describes each journal row', () => {
  const create = stored({
    id: 'run-1',
    change: change({ kind: 'create', path: 'a.ts' }),
  });
  const entries = turnPreviewEntries(
    changedFile([
      {
        record: create,
        change: {
          ...create.change,
          subagent: { id: 's1', role: 'explore', objective: '检查报告' },
        },
      },
      // A batch row is flattened per path, so the same row can appear twice: it still offers one undo.
      { record: create, change: create.change },
      { record: stored({ id: 'legacy:4' }), change: create.change },
      { record: stored({ id: 'run-2', status: 'undone' }), change: change() },
    ]),
    'zh-CN',
  );
  assert.equal(entries[0]?.attribution, '子代理：检查报告');
  assert.equal(entries[0]?.notice, '可恢复修改前的文件内容');
  assert.equal(entries[0]?.undo?.label, '撤销此修改');
  assert.equal(entries[0]?.undo?.confirmLabel, '确认删除此新建文件');
  assert.equal(entries[1]?.undo, null, 'a repeated journal row offers only its first undo');
  assert.equal(entries[2]?.attribution, null);
  assert.equal(entries[2]?.notice, '这条记录没有恢复快照，仅可查看差异。');
  assert.equal(entries[2]?.undo, null, 'a legacy receipt has no snapshot to restore');
  assert.equal(entries[3]?.notice, '已撤销');
  assert.equal(entries[3]?.undo, null, 'an undone row offers nothing further');
});

test('a preview reads in the interface language', () => {
  const record = stored({ id: 'run-1', change: change({ kind: 'create' }) });
  const entries = turnPreviewEntries(changedFile([{ record, change: record.change }]), 'en-US');
  assert.equal(entries[0]?.notice, 'The previous file content can be restored');
  assert.equal(entries[0]?.undo?.label, 'Undo this change');
  assert.equal(entries[0]?.undo?.confirmLabel, 'Confirm deleting this new file');
  const attribution = turnPreviewEntries(
    changedFile([
      {
        record,
        change: { ...record.change, subagent: { id: 's1', role: 'general', objective: 'check' } },
      },
    ]),
    'en-US',
  );
  assert.equal(attribution[0]?.attribution, 'Sub-agent: check');
});
