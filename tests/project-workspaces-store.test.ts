import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ProjectWorkspacesError,
  type ProjectWorkspacesFile,
} from '../apps/desktop/project-workspaces-contract.ts';
import { ProjectWorkspacesStore } from '../apps/desktop/project-workspaces-store.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-project-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'projects.json');
  return { root, file, store: new ProjectWorkspacesStore(file) };
}

test('the project group collapse survives restart independently of workspace collapse', async (t) => {
  const { file, store } = await fixture(t);
  const state = await store.initialize('/repo/one');
  const id = state.workspaces[0]!.id;
  await store.setProjectsCollapsed(true);
  await store.setCollapsed(id, false);
  const restored = await new ProjectWorkspacesStore(file).snapshot();
  assert.equal(restored.projectsCollapsed, true);
  assert.equal(restored.workspaces[0]?.collapsed, false);
});

test('a fresh registry initializes once, then keeps the list and the active entry', async (t) => {
  const { file, store } = await fixture(t);
  assert.deepEqual(await store.snapshot(), {
    schemaVersion: 1,
    initialized: false,
    activeWorkspaceId: null,
    workspaces: [],
  });
  const first = await store.initialize('/repo/one');
  assert.equal(first.initialized, true);
  assert.equal(first.workspaces.length, 1);
  assert.equal(first.workspaces[0]?.displayName, 'one');
  assert.equal(first.activeWorkspaceId, first.workspaces[0]?.id);
  // A second initialize is a no-op, not a reset.
  const again = await store.initialize('/repo/two');
  assert.equal(again.workspaces.length, 1);
  const reloaded = new ProjectWorkspacesStore(file);
  assert.equal((await reloaded.snapshot()).activeWorkspaceId, first.activeWorkspaceId);
});

test('add deduplicates by canonical path, selects, renames and restores removals', async (t) => {
  const { store } = await fixture(t);
  const first = await store.initialize('/repo/one');
  const one = first.workspaces[0]!;
  const second = await store.add('/repo/two');
  assert.equal(second.workspaces.length, 2);
  assert.equal(second.activeWorkspaceId, second.workspaces[1]?.id);
  const duplicate = await store.add('/repo/one', 'One again');
  assert.equal(duplicate.workspaces.length, 2);
  assert.equal(duplicate.activeWorkspaceId, one.id);
  assert.equal(duplicate.workspaces.find((entry) => entry.id === one.id)?.displayName, 'One again');

  const renamed = await store.rename(one.id, '  First  ');
  assert.equal(renamed.workspaces.find((entry) => entry.id === one.id)?.displayName, 'First');
  await assert.rejects(() => store.rename(one.id, '   '), /display name/i);

  const removed = await store.remove(one.id);
  assert.equal(removed.workspaces.find((entry) => entry.id === one.id)?.removed, true);
  assert.notEqual(removed.activeWorkspaceId, one.id);
  const restored = await store.add('/repo/one');
  assert.equal(restored.workspaces.find((entry) => entry.id === one.id)?.removed, false);
  assert.equal(restored.activeWorkspaceId, one.id);
});

test('collapsed and last-session state survive a reload', async (t) => {
  const { file, store } = await fixture(t);
  const state = await store.initialize('/repo/one');
  const id = state.workspaces[0]!.id;
  await store.setCollapsed(id, true);
  await store.setLastSession(id, 'session-1');
  const reloaded = new ProjectWorkspacesStore(file);
  const read = await reloaded.snapshot();
  assert.equal(read.workspaces[0]?.collapsed, true);
  assert.equal(read.workspaces[0]?.lastSessionId, 'session-1');
});

test('removing the last workspace leaves an initialized empty list, not a rebuilt default', async (t) => {
  const { file, store } = await fixture(t);
  const state = await store.initialize('/repo/one');
  const removed = await store.remove(state.workspaces[0]!.id);
  assert.equal(removed.activeWorkspaceId, null);
  assert.equal(removed.workspaces.length, 1);
  assert.equal(removed.workspaces[0]?.removed, true);
  const reloaded = new ProjectWorkspacesStore(file);
  const read = await reloaded.snapshot();
  assert.equal(read.initialized, true);
  assert.equal(read.activeWorkspaceId, null);
  assert.equal(read.workspaces.length, 1);
});

test('a corrupt or future registry is refused and left untouched', async (t) => {
  const { file, store } = await fixture(t);
  await writeFile(file, '{not json', 'utf8');
  await assert.rejects(
    () => store.snapshot(),
    (error: unknown) => error instanceof ProjectWorkspacesError && error.code === 'invalid',
  );
  assert.equal(await readFile(file, 'utf8'), '{not json');

  const future = {
    schemaVersion: 99,
    initialized: true,
    activeWorkspaceId: null,
    workspaces: [],
  } satisfies Record<string, unknown>;
  await writeFile(file, JSON.stringify(future), 'utf8');
  await assert.rejects(
    () => new ProjectWorkspacesStore(file).snapshot(),
    (error: unknown) => error instanceof ProjectWorkspacesError && error.code === 'future',
  );
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(future));
});

test('the persisted file is a complete, parseable registry', async (t) => {
  const { file, store } = await fixture(t);
  await store.initialize('/repo/one');
  const raw = JSON.parse(await readFile(file, 'utf8')) as ProjectWorkspacesFile;
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.initialized, true);
  assert.equal(raw.workspaces.length, 1);
  assert.match(raw.workspaces[0]!.id, /^[\w-]+$/u);
});
