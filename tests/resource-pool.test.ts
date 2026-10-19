/**
 * A session keeps its language servers, browser and MCP connections between runs, and gives them up when idle,
 * deleted, or shut down.
 *
 * They used to be built with each run's tool registry and closed with it, so every turn restarted its language
 * servers, lost its browser logins and handshaked every MCP server again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import {
  MAX_LIVE_BROWSERS,
  RESOURCE_IDLE_MS,
  acquireBrowserSession,
  acquireLspManager,
  browserProfileDirectory,
  closeAllToolResources,
  pooledResources,
  pooledScope,
  releaseSessionResources,
} from '../packages/catalog/resource-pool.ts';
import { tempRoot } from './temp-fixture.ts';

test.afterEach(() => closeAllToolResources());

test('a session gets the same language servers back on its next run, another session does not', async (t) => {
  const root = await tempRoot(t, 'yuantu-pool-');
  const first = acquireLspManager(root, 'session-a');
  first.release();
  // The run ended; the next one in the same session finds the servers it left.
  const again = acquireLspManager(root, 'session-a');
  assert.equal(again.value, first.value);
  // A different session never shares them: a server runs under the policy of the session that started it.
  const other = acquireLspManager(root, 'session-b');
  assert.notEqual(other.value, first.value);
  again.release();
  other.release();
});

test('only sessions are pooled; a delegated child or a one-shot command owns its own', () => {
  assert.equal(pooledScope('session-a'), true);
  assert.equal(pooledScope('subagent'), false);
  assert.equal(pooledScope('standalone'), false);
});

test('an entry nobody holds closes after the idle period, and one in use never does', async (t) => {
  const root = await tempRoot(t, 'yuantu-pool-');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const idle = acquireLspManager(root, 'session-idle');
  const busy = acquireLspManager(root, 'session-busy');
  idle.release();
  t.mock.timers.tick(RESOURCE_IDLE_MS.lsp - 1);
  assert.equal(pooledResources().length, 2, 'closed before its idle period ran out');
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    pooledResources().map((entry) => entry.scope),
    ['session-busy'],
  );
  // One a run still holds is never closed, however long it waits.
  t.mock.timers.tick(RESOURCE_IDLE_MS.lsp * 2);
  assert.equal(pooledResources().length, 1);
  busy.release();
});

test('the least recently used idle browser makes room past the cap', async (t) => {
  const root = await tempRoot(t, 'yuantu-pool-');
  for (let index = 0; index < MAX_LIVE_BROWSERS; index++)
    acquireBrowserSession(root, `session-${index}`).release();
  // A browser a run is holding is never the one closed.
  const held = acquireBrowserSession(root, 'session-held');
  await new Promise((resolve) => setImmediate(resolve));
  const browsers = pooledResources().filter((entry) => entry.kind === 'browser');
  assert.equal(browsers.length, MAX_LIVE_BROWSERS);
  assert.equal(
    browsers.some((entry) => entry.scope === 'session-0'),
    false,
    'the oldest idle browser was kept',
  );
  assert.ok(browsers.some((entry) => entry.scope === 'session-held'));
  held.release();
});

test('deleting a session closes what it kept and removes its browser profiles', async (t) => {
  const root = await tempRoot(t, 'yuantu-pool-');
  const browser = acquireBrowserSession(root, 'session-gone');
  acquireLspManager(root, 'session-gone').release();
  acquireLspManager(root, 'session-kept').release();
  // A profile written by this process and one an earlier process left for another directory of the session.
  const profile = browserProfileDirectory(root, 'session-gone');
  const earlier = browserProfileDirectory(path.join(root, 'elsewhere'), 'session-gone');
  for (const directory of [profile, earlier]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'Cookies'), 'synthetic');
  }
  await releaseSessionResources('session-gone');
  assert.deepEqual(
    pooledResources().map((entry) => entry.scope),
    ['session-kept'],
  );
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(earlier), false);
  browser.release();
});

test('a session registry borrows from the pool and returns on close; a child registry does not', async (t) => {
  const root = await tempRoot(t, 'yuantu-pool-');
  const session = createTools(root, undefined, 'session-tools');
  assert.deepEqual(
    pooledResources()
      .filter((entry) => entry.scope === 'session-tools')
      .map((entry) => [entry.kind, entry.refs])
      .sort(),
    [
      ['browser', 1],
      ['lsp', 1],
      ['mcp', 1],
    ],
  );
  await session.close();
  // Returned, not closed: the next run of the session finds them.
  assert.deepEqual(
    pooledResources()
      .filter((entry) => entry.scope === 'session-tools')
      .map((entry) => entry.refs),
    [0, 0, 0],
  );
  const child = createTools(root, undefined, 'subagent');
  assert.equal(
    pooledResources().some((entry) => entry.scope === 'subagent'),
    false,
  );
  await child.close();
});
