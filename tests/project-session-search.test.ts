import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { parseProjectWorkspaceCommand } from '../apps/desktop/project-workspaces-contract.ts';
import { searchProjectSessions } from '../apps/desktop/project-session-search.ts';

test('global search finds titles and messages in unopened projects without changing their databases', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = [];
  for (const id of ['a', 'b', 'removed', 'missing']) {
    const canonicalPath = path.join(root, id);
    await mkdir(path.join(canonicalPath, '.yuantu'), { recursive: true });
    workspaces.push({ id, canonicalPath, displayName: id, removed: id === 'removed' });
    if (id === 'missing') continue;
    const store = new SessionStore(path.join(canonicalPath, '.yuantu', 'sessions.sqlite'));
    const session = store.create(canonicalPath);
    store.rename(session.id, id === 'a' ? 'needle in title' : 'Other title');
    store.append(session.id, {
      role: 'user',
      content: id === 'a' ? 'unrelated message' : 'needle in message',
    });
    const archived = store.create(canonicalPath);
    store.rename(archived.id, 'needle archived');
    store.setArchived(archived.id, true);
    store.close();
  }
  const file = path.join(workspaces[0]!.canonicalPath, '.yuantu', 'sessions.sqlite');
  const before = await stat(file);
  const result = searchProjectSessions(workspaces, 'needle');
  assert.deepEqual(
    result.hits.map((hit) => hit.workspaceId),
    ['a', 'b'],
  );
  assert.equal(result.hits[1]!.title, 'Other title');
  assert.deepEqual(result.errors, []);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  await assert.rejects(stat(path.join(root, 'missing', '.yuantu', 'sessions.sqlite')));
  assert.deepEqual(searchProjectSessions(workspaces, 'notfound').hits, []);
  assert.deepEqual(searchProjectSessions(workspaces, '').hits, []);
});

test('global search rejects oversized queries at the IPC boundary', () => {
  assert.deepEqual(parseProjectWorkspaceCommand({ type: 'search', query: 'needle' }), {
    type: 'search',
    query: 'needle',
  });
  assert.throws(() => parseProjectWorkspaceCommand({ type: 'search', query: 'x'.repeat(201) }));
});
