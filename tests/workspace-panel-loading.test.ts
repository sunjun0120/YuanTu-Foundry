import test from 'node:test';
import assert from 'node:assert/strict';
import type { FilesReply } from '../apps/desktop/files-contract.ts';
import type {
  WorkspaceEntry,
  WorkspaceListing,
  WorkspacePreview,
} from '../packages/protocol/rpc.ts';
import {
  createWorkspaceController,
  type WorkspaceController,
} from '../apps/desktop/ui/workspace/workspace-model.ts';

/**
 * The workspace tree's reads, without the DOM.
 *
 * Three identifiers decide which answer wins: the workspace (`generation`), the refresh round (`listingRound`) and a
 * per-path token. The legacy test drove the real `setupWorkspace` through a fake document because the failures were
 * drawn into the tree; the controller keeps the same rules, and a rejected promise is a failure like a refusal — not
 * an unhandled rejection that leaves the directory "reading" forever.
 */
function entry(name: string): WorkspaceEntry {
  return {
    name,
    path: name.replace(/\/$/, ''),
    kind: name.endsWith('/') ? 'directory' : 'file',
  } as never;
}

function listing(path: string, names: string[]): WorkspaceListing {
  return { path, entries: names.map(entry), truncated: false };
}

interface Pending {
  path: string;
  resolve(reply: FilesReply): void;
  reject(error: Error): void;
}

function bridge() {
  const requests: Pending[] = [];
  const controller: WorkspaceController = createWorkspaceController({
    files: (command) =>
      new Promise<FilesReply>((resolve, reject) => {
        const path =
          command && typeof command === 'object' && 'path' in command
            ? String((command as { path?: string }).path ?? '')
            : '';
        requests.push({ path, resolve, reject });
      }),
    locale: () => 'zh-CN',
  });
  return { controller, requests };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a rejected directory read is shown, and the directory can be read again', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  controller.setOpen(true);
  const first = controller.loadDirectory('');
  await flush();
  assert.equal(requests.length, 1);
  requests[0]!.reject(new Error('IPC 通道中断'));
  await first;
  assert.equal(controller.store.getSnapshot().failures.get(''), 'IPC 通道中断');
  controller.refresh();
  await flush();
  requests[1]!.resolve({ ok: true, listing: listing('', ['src/']) });
  await flush();
  assert.equal(controller.store.getSnapshot().listings.get('')?.entries[0]?.name, 'src/');
  assert.equal(controller.store.getSnapshot().failures.has(''), false);
});

test('a refusal and a rejection are reported through the same map', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  const pending = controller.loadDirectory('');
  await flush();
  requests[0]!.resolve({ ok: false, error: '目录不可读' });
  await pending;
  assert.equal(controller.store.getSnapshot().failures.get(''), '目录不可读');
});

test('an older answer for the same directory cannot overwrite a newer one', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  const root = controller.loadDirectory('');
  await flush();
  requests[0]!.resolve({ ok: true, listing: listing('', ['sub/']) });
  await root;
  controller.toggleDirectory('sub');
  await flush();
  controller.toggleDirectory('sub');
  await flush();
  controller.toggleDirectory('sub');
  await flush();
  assert.deepEqual(
    requests.map((request) => request.path),
    ['', 'sub', 'sub'],
  );
  requests[2]!.resolve({ ok: true, listing: listing('sub', ['new.txt']) });
  await flush();
  requests[1]!.resolve({ ok: true, listing: listing('sub', ['stale.txt']) });
  await flush();
  assert.equal(controller.store.getSnapshot().listings.get('sub')?.entries[0]?.name, 'new.txt');
});

test('answers for two directories may arrive in any order', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  const root = controller.loadDirectory('');
  await flush();
  requests[0]!.resolve({ ok: true, listing: listing('', ['a/', 'b/']) });
  await root;
  controller.toggleDirectory('a');
  await flush();
  controller.toggleDirectory('b');
  await flush();
  requests[2]!.resolve({ ok: true, listing: listing('b', ['b1.txt']) });
  await flush();
  requests[1]!.resolve({ ok: true, listing: listing('a', ['a1.txt']) });
  await flush();
  const state = controller.store.getSnapshot();
  assert.equal(state.listings.get('a')?.entries[0]?.name, 'a1.txt');
  assert.equal(state.listings.get('b')?.entries[0]?.name, 'b1.txt');
});

test('being told the same workspace again neither re-reads nor clears the tree', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  const pending = controller.loadDirectory('');
  await flush();
  requests[0]!.resolve({ ok: true, listing: listing('', ['a.txt']) });
  await pending;
  assert.equal(controller.setWorkspace('/proj'), false);
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(controller.store.getSnapshot().listings.get('')?.entries[0]?.name, 'a.txt');
});

test('an answer that arrives after a refresh or a workspace change is dropped', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  controller.setOpen(true);
  const first = controller.loadDirectory('');
  await flush();
  controller.refresh();
  await flush();
  requests[0]!.resolve({ ok: true, listing: listing('', ['before.txt']) });
  await first;
  assert.equal(controller.store.getSnapshot().listings.get('')?.entries.length ?? 0, 0);
  // The refresh's own request is still in flight; it belongs to the project that is gone.
  const oldRound = requests[1]!;
  controller.setWorkspace('/other');
  await flush();
  const fresh = requests[2]!;
  fresh.resolve({ ok: true, listing: listing('', ['after.txt']) });
  await flush();
  assert.equal(controller.store.getSnapshot().listings.get('')?.entries[0]?.name, 'after.txt');
  oldRound.resolve({ ok: true, listing: listing('', ['stale.txt']) });
  await flush();
  assert.equal(controller.store.getSnapshot().listings.get('')?.entries[0]?.name, 'after.txt');
});

test('closing and reopening a file drops the first read when it lands', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  const first = controller.showFile('a.txt');
  await flush();
  controller.closeTab('a.txt');
  const second = controller.showFile('a.txt');
  await flush();
  const text = (value: WorkspacePreview | null): string | undefined =>
    (value as { text?: string } | null)?.text;
  requests[1]!.resolve({
    ok: true,
    preview: { kind: 'text', text: 'newer', path: 'a.txt' } as unknown as WorkspacePreview,
  });
  await second;
  requests[0]!.resolve({
    ok: true,
    preview: { kind: 'text', text: 'older', path: 'a.txt' } as unknown as WorkspacePreview,
  });
  await first;
  assert.equal(text(controller.tab('a.txt')?.shown ?? null), 'newer');
});

test('a rejected preview read is reported on the tab, not left reading', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  const pending = controller.showFile('a.txt');
  await flush();
  requests[0]!.reject(new Error('预览不可读'));
  await pending;
  const tab = controller.tab('a.txt');
  assert.equal(tab?.reading, false);
  assert.equal(tab?.error, '预览不可读');
  assert.equal(tab?.shown, null);
});

test('a diff preview is shown without reading the file and can be replaced', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  const first = {} as Element;
  first.textContent = 'diff one';
  controller.previewChanges('a.txt', first, 'change-1');
  const state = controller.store.getSnapshot();
  assert.equal(state.open, true);
  assert.equal(state.selected, 'a.txt');
  assert.equal(requests.length, 0);
  assert.equal(controller.tab('a.txt')?.changeKey, 'change-1');

  const second = {} as Element;
  second.textContent = 'diff two';
  assert.equal(controller.refreshChangePreview('change-1', second), true);
  assert.equal(controller.tab('a.txt')?.changePreview, second);
  assert.equal(controller.refreshChangePreview('missing', second), false);
  // The same element is not a change; the pane keeps its scroll instead of being rebuilt.
  assert.equal(controller.refreshChangePreview('change-1', second), true);
  assert.equal(requests.length, 0);
});

test('clearing change previews removes those tabs and deselects the open one', async () => {
  const { controller } = bridge();
  controller.setWorkspace('/proj');
  controller.previewChanges('a.txt', {} as Element, 'change-1');
  controller.clearChangePreviews();
  assert.equal(controller.tab('a.txt'), undefined);
  assert.equal(controller.store.getSnapshot().selected, null);
});

test('closing the active tab activates its neighbour', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  const first = controller.showFile('a.txt');
  await flush();
  const second = controller.showFile('b.txt');
  await flush();
  requests[1]!.resolve({ ok: true, preview: { kind: 'text', text: 'b' } as never });
  requests[0]!.resolve({ ok: true, preview: { kind: 'text', text: 'a' } as never });
  await Promise.all([first, second]);
  controller.activate('a.txt');
  controller.closeTab('a.txt');
  assert.equal(controller.store.getSnapshot().selected, 'b.txt');
});

test('opening a path that showed a diff reads the file again', async () => {
  const { controller, requests } = bridge();
  controller.setWorkspace('/proj');
  controller.previewChanges('a.txt', {} as Element, 'change-1');
  const pending = controller.showFile('a.txt');
  await flush();
  assert.equal(requests.length, 1);
  requests[0]!.resolve({ ok: true, preview: { kind: 'text', text: 'current' } as never });
  await pending;
  assert.equal(controller.tab('a.txt')?.changePreview, undefined);
  assert.equal((controller.tab('a.txt')?.shown as { text?: string } | null)?.text, 'current');
});
