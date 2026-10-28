import test from 'node:test';
import assert from 'node:assert/strict';
import type { FilesReply } from '../apps/desktop/files-contract.ts';
import {
  createWorkspaceController,
  type WorkspaceController,
} from '../apps/desktop/ui/workspace/workspace-model.ts';

/**
 * The workspace strip without the DOM: the start and files tabs can be closed like every other tab, and closing the
 * last one folds the panel instead of leaving an empty strip.
 */
function controller(): WorkspaceController {
  const files = async (): Promise<FilesReply> => ({
    ok: true,
    listing: { path: '', entries: [], truncated: false },
  });
  const workspace = createWorkspaceController({ files, locale: () => 'zh-CN' });
  workspace.setWorkspace('/proj');
  workspace.setOpen(true);
  return workspace;
}

test('the start tab is open by default and the files tab appears when chosen', () => {
  const workspace = controller();
  const initial = workspace.store.getSnapshot();
  assert.equal(initial.startOpen, true);
  assert.equal(initial.filesOpen, false);
  assert.deepEqual(initial.active, { kind: 'new' });

  workspace.openFiles();
  const opened = workspace.store.getSnapshot();
  assert.equal(opened.filesOpen, true);
  assert.deepEqual(opened.active, { kind: 'files' });

  workspace.closeFiles();
  const closed = workspace.store.getSnapshot();
  assert.equal(closed.filesOpen, false);
  assert.equal(closed.open, true);
  assert.deepEqual(
    closed.active,
    { kind: 'new' },
    'closing the files tab returns to its neighbour',
  );
});

test('closing the only tab folds the right panel', () => {
  const workspace = controller();
  workspace.closeStart();
  const state = workspace.store.getSnapshot();
  assert.equal(state.open, false);
  assert.equal(state.startOpen, true, 'the next open starts on the start page');
  assert.deepEqual(state.active, { kind: 'new' });
});

test('closing a non-active start tab keeps the files tab selected', () => {
  const workspace = controller();
  workspace.openFiles();
  workspace.closeStart();
  const state = workspace.store.getSnapshot();
  assert.equal(state.startOpen, false);
  assert.equal(state.open, true);
  assert.deepEqual(state.active, { kind: 'files' });
});

test('closing the last remaining tab folds the panel and restores the start page', () => {
  const workspace = controller();
  workspace.openFiles();
  workspace.closeStart();
  assert.equal(workspace.store.getSnapshot().startOpen, false);

  workspace.closeFiles();
  const state = workspace.store.getSnapshot();
  assert.equal(state.filesOpen, false);
  assert.equal(state.open, false);
  assert.equal(state.startOpen, true);
  assert.deepEqual(state.active, { kind: 'new' });
});

test('the plus entry reopens a closed start tab without duplicating it', () => {
  const workspace = controller();
  workspace.openFiles();
  workspace.closeStart();
  assert.equal(workspace.store.getSnapshot().startOpen, false);

  workspace.openNewTab();
  const state = workspace.store.getSnapshot();
  assert.equal(state.startOpen, true);
  assert.deepEqual(state.active, { kind: 'new' });
  workspace.openNewTab();
  assert.equal(workspace.store.getSnapshot().startOpen, true);
});
