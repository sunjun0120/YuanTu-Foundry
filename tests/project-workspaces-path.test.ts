import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectWorkspacesStore } from '../apps/desktop/project-workspaces-store.ts';
import {
  canonicalWorkspace,
  ProjectWorkspaces,
  resolveStartupWorkspace,
} from '../apps/desktop/main-project-workspaces.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-project-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectWorkspacesStore(path.join(root, 'projects.json'));
  const fallback = path.join(root, 'profile', 'workspace');
  return { root, store, fallback };
}

test('the first launch registers the fallback once and later launches restore it', async (t) => {
  const { root, store, fallback } = await fixture(t);
  const first = await resolveStartupWorkspace(store, { fallbackPath: fallback });
  assert.equal(first.workspace, fallback);
  assert.equal(first.registry.initialized, true);
  assert.equal(first.registry.workspaces.length, 1);
  const second = await resolveStartupWorkspace(store, { fallbackPath: fallback });
  assert.equal(second.workspace, fallback);
  assert.equal(second.registry.workspaces.length, 1);
  assert.ok(second.workspace.startsWith(root));
});

test('an explicit workspace wins and is added to an existing registry', async (t) => {
  const { root, store, fallback } = await fixture(t);
  const explicit = path.join(root, 'project');
  await mkdir(explicit);
  await resolveStartupWorkspace(store, { fallbackPath: fallback });
  const selected = await resolveStartupWorkspace(store, {
    fallbackPath: fallback,
    explicitPath: explicit,
  });
  assert.equal(selected.workspace, explicit);
  assert.equal(selected.registry.workspaces.length, 2);
  assert.equal(selected.registry.activeWorkspaceId, selected.registry.workspaces[1]?.id);
});

test('the application directory is refused as a workspace', async (t) => {
  const { root } = await fixture(t);
  const install = path.join(root, 'app');
  const inside = path.join(install, 'resources');
  await mkdir(inside, { recursive: true });
  assert.throws(
    () => canonicalWorkspace(inside, { installDirectory: install }),
    /application directory/i,
  );
});

test('an initialized empty registry keeps the fallback unregistered', async (t) => {
  const { store, fallback } = await fixture(t);
  const first = await resolveStartupWorkspace(store, { fallbackPath: fallback });
  await store.remove(first.registry.workspaces[0]!.id);
  const empty = await resolveStartupWorkspace(store, { fallbackPath: fallback });
  assert.equal(empty.workspace, fallback);
  assert.equal(empty.registry.initialized, true);
  assert.equal(empty.registry.workspaces.length, 1);
  assert.equal(empty.registry.workspaces[0]?.removed, true);
});

test('the manager canonicalizes paths and keeps removal soft', async (t) => {
  const { root, store, fallback } = await fixture(t);
  const projects = new ProjectWorkspaces(store);
  const first = await resolveStartupWorkspace(store, { fallbackPath: fallback });
  const id = first.registry.workspaces[0]!.id;
  await mkdir(path.join(root, 'second'));
  const added = await projects.add(path.join(root, 'second'));
  const second = added.workspaces.find((entry) => entry.displayName === 'second')!;
  assert.equal(second.canonicalPath, path.resolve(root, 'second'));
  const renamed = await projects.rename(second.id, '  Second  ');
  assert.equal(renamed.workspaces.find((entry) => entry.id === second.id)?.displayName, 'Second');
  const removed = await projects.remove(id);
  assert.equal(removed.workspaces.find((entry) => entry.id === id)?.removed, true);
  assert.equal(removed.activeWorkspaceId, second.id);
});
