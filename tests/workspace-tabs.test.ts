import test from 'node:test';
import assert from 'node:assert/strict';
import type { FilesReply } from '../apps/desktop/files-contract.ts';
import type { BrowserCommand, BrowserReply } from '../apps/desktop/browser-contract.ts';
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

test('opening a deliverable routes HTML to a browser tab and documents to a file tab', async () => {
  const commands: BrowserCommand[] = [];
  const workspace = createWorkspaceController({
    files: async (command) => ({
      ok: true,
      preview: {
        path: (command as { path: string }).path,
        kind: 'text',
        bytes: 20,
        text: '<h1>Report</h1>',
      },
    }),
    locale: () => 'zh-CN',
    browser: async (command) => {
      commands.push(command);
      return { ok: true };
    },
  });
  workspace.setWorkspace('/one');
  await workspace.openPath('report.HTML');
  assert.deepEqual(workspace.store.getSnapshot().active, { kind: 'browser', id: 'browser-1' });
  assert.deepEqual(commands, [
    { type: 'create', id: 'browser-1' },
    { type: 'preview-html', id: 'browser-1', path: 'report.HTML', html: '<h1>Report</h1>' },
  ]);
  await workspace.openPath('report.HTML');
  assert.equal(
    commands.filter((command) => command.type === 'create').length,
    1,
    'opening the same report reuses its tab',
  );
  await workspace.openPath('notes.md');
  assert.deepEqual(workspace.store.getSnapshot().active, { kind: 'file', path: 'notes.md' });
  assert.equal(workspace.store.getSnapshot().open, true);
  workspace.setWorkspace('/two');
  await workspace.openPath('report.HTML');
  assert.equal(
    commands.filter((command) => command.type === 'create').length,
    2,
    'the same path in another workspace is a different report',
  );
});

test('a truncated HTML preview is refused before allocating a browser view', async () => {
  const commands: BrowserCommand[] = [];
  const workspace = createWorkspaceController({
    files: async () => ({
      ok: true,
      preview: { path: 'report.html', kind: 'text', bytes: 200, text: 'partial', truncated: true },
    }),
    locale: () => 'zh-CN',
    browser: async (command) => {
      commands.push(command);
      return { ok: true };
    },
  });
  workspace.setWorkspace('/one');
  await assert.rejects(workspace.openPath('report.html'));
  assert.deepEqual(commands, []);
});

test('a late HTML read from an earlier workspace cannot open a report in the next workspace', async () => {
  let resolve!: (reply: FilesReply) => void;
  const commands: BrowserCommand[] = [];
  const workspace = createWorkspaceController({
    files: async () =>
      new Promise<FilesReply>((done) => {
        resolve = done;
      }),
    locale: () => 'zh-CN',
    browser: async (command) => {
      commands.push(command);
      return { ok: true };
    },
  });
  workspace.setWorkspace('/one');
  const pending = workspace.openPath('report.html');
  workspace.setWorkspace('/two');
  resolve({
    ok: true,
    preview: { path: 'report.html', kind: 'text', bytes: 10, text: '<h1>old</h1>' },
  });
  await pending;
  assert.deepEqual(commands, []);
});

test('closing an HTML tab while its preview is loading prevents a late reply from reopening it', async () => {
  let finish!: (reply: BrowserReply) => void;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const workspace = createWorkspaceController({
    files: async () => ({
      ok: true,
      preview: { path: 'report.html', kind: 'text', bytes: 10, text: '<h1>Report</h1>' },
    }),
    locale: () => 'zh-CN',
    browser: async (command) => {
      if (command.type !== 'preview-html') return { ok: true };
      started();
      return new Promise<BrowserReply>((resolve) => {
        finish = resolve;
      });
    },
  });
  workspace.setWorkspace('/one');
  const opening = workspace.openPath('report.html');
  await loading;
  const previewState = {
    ...workspace.store.getSnapshot().browserTabs.get('browser-1')!,
    previewPath: 'report.html',
    url: 'report.html',
  };
  workspace.closeBrowserTab('browser-1');
  finish({ ok: true, state: previewState });
  await opening;
  assert.equal(workspace.store.getSnapshot().browserTabs.size, 0);
  assert.deepEqual(workspace.store.getSnapshot().active, { kind: 'new' });
});

for (const newer of ['second.html', 'notes.md']) {
  test(`a slow HTML read cannot replace the newer ${newer} selection`, async () => {
    let finish!: (reply: FilesReply) => void;
    const commands: BrowserCommand[] = [];
    const workspace = createWorkspaceController({
      files: async (command) => {
        const path = (command as { path: string }).path;
        if (path === 'first.html')
          return new Promise<FilesReply>((resolve) => {
            finish = resolve;
          });
        return { ok: true, preview: { path, kind: 'text', bytes: 10, text: '<h1>New</h1>' } };
      },
      locale: () => 'zh-CN',
      browser: async (command) => {
        commands.push(command);
        return { ok: true };
      },
    });
    workspace.setWorkspace('/one');
    const first = workspace.openPath('first.html');
    await workspace.openPath(newer);
    const active = workspace.store.getSnapshot().active;
    finish({ ok: true, preview: { path: 'first.html', kind: 'text', bytes: 10, text: 'old' } });
    await first;
    assert.deepEqual(workspace.store.getSnapshot().active, active);
    assert.equal(
      commands.some((command) => command.type === 'preview-html' && command.path === 'first.html'),
      false,
    );
  });
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
