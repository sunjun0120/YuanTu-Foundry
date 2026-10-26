import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  COMPAT_IDS,
  MIGRATION_COMPLETE,
  compatIdUsages,
} from '../apps/desktop/ui/legacy/compat-ids.ts';
import { withoutComments } from '../scripts/i18n-gate.mjs';
import { projectRoot } from './process-fixture.ts';

/**
 * The transitional id table, checked against the two things that can drift from it.
 *
 * A registry is only useful if it matches reality: an entry nobody renders is a leftover that will never be
 * deleted, and an id rendered through `compatId()` but not registered is a silent duplicate owner — the failure
 * this table exists to prevent. Both directions are checked here. The table is empty at T4, so the checks are
 * written to become meaningful the moment a region adds its first entry.
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

test('the usage scanner reads calls with a single-quoted literal', () => {
  assert.deepEqual(
    compatIdUsages(
      [
        "compatId('session-search');",
        'compatId( "double-quoted" )',
        'compatId(variable)',
        "compatId('second')",
      ].join('\n'),
    ),
    ['session-search', 'second'],
  );
});

test('every registered id names its region and what removes it', () => {
  const seen = new Set<string>();
  for (const entry of COMPAT_IDS) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/, entry.id);
    assert.ok(!seen.has(entry.id), `duplicate compatible id: ${entry.id}`);
    seen.add(entry.id);
    assert.match(entry.region, /^T\d+$/, entry.id);
    assert.ok(entry.reason.trim().length > 0, `${entry.id} has no reason`);
    assert.ok(entry.removal.trim().length > 0, `${entry.id} has no removal condition`);
  }
});

test('the table and the render sites agree in both directions', async () => {
  const rendered = new Set<string>();
  for (const file of await filesUnder(path.join(projectRoot, 'apps/desktop/ui'), /\.(?:ts|tsx)$/))
    for (const id of compatIdUsages(withoutComments(await readFile(file, 'utf8'))))
      rendered.add(id);
  const registered = new Set(COMPAT_IDS.map((entry) => entry.id));
  assert.deepEqual(
    [...rendered].sort(),
    [...registered].sort(),
    'every rendered compat id is registered, and every registration is rendered',
  );
});

test('a registered id is still read by a test', async () => {
  const sources: string[] = [];
  for (const file of await filesUnder(path.join(projectRoot, 'tests'), /\.(?:ts|mjs)$/))
    sources.push(await readFile(file, 'utf8'));
  const tests = sources.join('\n');
  for (const entry of COMPAT_IDS)
    assert.ok(tests.includes(entry.id), `nothing in tests/ reads ${entry.id}`);
});

test('the transitional table is empty once the migration is complete', () => {
  if (!MIGRATION_COMPLETE) return;
  assert.deepEqual(COMPAT_IDS, [], 'the migration is complete but some transitional ids remain');
});
