import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { COMPAT_IDS, MIGRATION_COMPLETE } from '../apps/desktop/ui/legacy/compat-ids.ts';
import { withoutComments } from '../scripts/i18n-gate.mjs';
import { projectRoot } from './process-fixture.ts';

/**
 * The migration's closing rules.
 *
 * The transitional table existed so a region could move to React without rewriting its smoke assertions in the same
 * commit. It is empty now, and the process assertions that maintained it (registration shape, render-site agreement,
 * still-read-by-a-test) are gone with it: they check a table that must never grow again. What remains is the end
 * state — the table is empty, and no component re-opens the transitional path.
 */
async function filesUnder(dir: string, pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full, pattern)));
    else if (pattern.test(entry.name)) found.push(full);
  }
  return found;
}

test('the transitional id table is empty now that the migration is complete', () => {
  assert.equal(MIGRATION_COMPLETE, true, 'the migration is recorded as complete');
  assert.deepEqual(COMPAT_IDS, [], 'a transitional id outlived the region that needed it');
});

test('no React module re-opens the transitional id path', async () => {
  const found: string[] = [];
  for (const file of await filesUnder(path.join(projectRoot, 'apps/desktop/ui'), /\.(?:ts|tsx)$/)) {
    const source = withoutComments(await readFile(file, 'utf8'));
    if (/\bcompatId\s*\(/.test(source)) found.push(path.relative(projectRoot, file));
  }
  assert.deepEqual(found, [], 'a component still renders an id through the retired helper');
});
